/**
 * `/api/requests/[id]` — approving and denying increase requests (§Phase 11).
 *
 * `POST {"action": "approve", "amount": "90000"}` or `POST {"action": "deny"}`,
 * both optionally carrying `suppressNotification` (defaulted from
 * `app_config.suppress_notification_default`).
 *
 * The order of operations mirrors the limit route deliberately:
 *
 *   identify → authorise → call the API → update the snapshot → audit
 *
 * Two things about approval are worth stating because they are surprising:
 *
 * - **The amount is the approver's, not the requester's.** §G4 requests carry no
 *   requested figure at all, so this endpoint requires one and validates it with
 *   the same `requireWireAmount` the limit route uses.
 * - **Approving writes the override too.** The API resolves the request AND
 *   writes the per-user limit in one call, so the member's `spend_limit_snapshot`
 *   row is refreshed here as well; otherwise the queue would say "approved"
 *   while the members list still showed the old cap.
 *
 * Permission is `canActOnRequest` (§G8) against the REQUESTER's employee record —
 * looked up from the stored snapshot, never taken from the request body.
 */

import { getDb, type AppDatabase } from "@/db/client";
import type { Employee, IncreaseRequestSnapshotRow } from "@/db/schema";
import { AnthropicApiError, createAnthropicClient } from "@/lib/anthropic/client";
import { writeAudit, type AuditAction } from "@/lib/audit";
import { loadAppConfig } from "@/lib/config";
import { BodyTooLargeError, bodyTooLargeResponse, enforceRateLimit, readLimitedJson } from "@/lib/http";
import { MUTATION_RATE_LIMIT } from "@/lib/rate-limit";
import { currentEmployee } from "@/lib/identity";
import { LimitWriteError, refreshMemberSnapshot, requireWireAmount } from "@/lib/member-limit";
import { authorityIdsOf, canActOnRequest } from "@/lib/permissions";
import { findRequest, PENDING_STATUS, upsertRequestSnapshot } from "@/lib/requests";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ActContext {
  db: AppDatabase;
  actor: Employee;
  request: IncreaseRequestSnapshotRow;
  requester: Employee | null;
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status });
}

async function resolveActContext(context: RouteContext): Promise<ActContext | Response> {
  const { id } = await context.params;
  const db = getDb();

  const actor = await currentEmployee(db);
  if (actor === null) return fail(403, "not_provisioned", "not provisioned");

  const found = findRequest(db, id);
  if (found === null) {
    return fail(404, "unknown_request", `no increase request with id ${JSON.stringify(id)}`);
  }

  const { edit_roles } = loadAppConfig(db);
  if (!canActOnRequest(actor, found.requester, edit_roles, authorityIdsOf(db, actor))) {
    return fail(403, "forbidden", "you are not allowed to act on this increase request");
  }

  return { db, actor, request: found.row, requester: found.requester };
}

/**
 * An upstream failure, as a status this app can mean.
 *
 * 409 is the interesting one: §G4 uses it for "this request is not pending any
 * more", which in a queue two people are working almost always means somebody
 * else got there first. That deserves "refresh and look again", not "something
 * went wrong" — so the message says so.
 *
 * A rejected credential is OUR misconfiguration and becomes a 502 rather than
 * being passed through as a 401 that would look like an expired session. (Same
 * mapping as `/api/members/[id]/limit`; the few lines are duplicated rather than
 * shared so the two write paths can diverge without one silently changing the
 * other's status codes.)
 */
function statusForApiError(error: AnthropicApiError): number {
  if (error.status === 429) return 429;
  if (error.status === 400) return 400;
  if (error.status === 404 || error.status === 409) return 409;
  return 502;
}

function messageForApiError(error: AnthropicApiError): string {
  if (error.status === 409 || error.status === 404) {
    return `This request has already been resolved — refresh the queue to see its current state. (${error.message})`;
  }
  return `The spend limits API rejected the change: ${error.message}`;
}

function apiFailure(
  { db, actor, request, requester }: ActContext,
  action: AuditAction,
  detail: Record<string, unknown>,
  error: unknown,
): Response {
  const api = error instanceof AnthropicApiError ? error : null;

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action,
    targetEmployeeId: requester?.id ?? null,
    targetUserId: request.actor_user_id,
    detail: {
      ...detail,
      outcome: "error",
      error_type: api?.errorType ?? "unknown_error",
      error_message: error instanceof Error ? error.message : String(error),
      // Only error envelopes carry `request_id` (§Phase 8), which is exactly
      // when it is worth recording.
      api_request_id: api?.requestId ?? null,
    },
  });

  return fail(
    api === null ? 502 : statusForApiError(api),
    api?.errorType ?? "upstream_error",
    api === null ? "The spend limits API could not be reached." : messageForApiError(api),
  );
}

/* -------------------------------------------------------------------------- */
/* POST — approve or deny                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(httpRequest: Request, context: RouteContext): Promise<Response> {
  const limited = enforceRateLimit(httpRequest, MUTATION_RATE_LIMIT, "request-action");
  if (limited) return limited;

  const resolved = await resolveActContext(context);
  if (resolved instanceof Response) return resolved;
  const { db, actor, request, requester } = resolved;

  let body: { action?: unknown; amount?: unknown; suppressNotification?: unknown } | null;
  try {
    body = (await readLimitedJson(httpRequest)) as typeof body;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return bodyTooLargeResponse(error);
    throw error;
  }

  const action = body?.action;
  if (action !== "approve" && action !== "deny") {
    return fail(400, "invalid_action", 'action must be either "approve" or "deny"');
  }

  const config = loadAppConfig(db);
  const suppressNotification =
    typeof body?.suppressNotification === "boolean"
      ? body.suppressNotification
      : config.suppress_notification_default;

  let amount: string | null = null;
  if (action === "approve") {
    try {
      amount = requireWireAmount(body?.amount);
    } catch (error) {
      if (error instanceof LimitWriteError) return fail(error.status, error.code, error.message);
      throw error;
    }
  }

  // A locally-stale row is worth catching before spending a call on it, but it
  // is NOT the authority: the API decides, and a request that went stale between
  // this check and the call comes back as the 409 handled above.
  if (request.status !== PENDING_STATUS) {
    return fail(
      409,
      "already_resolved",
      `This request has already been resolved (${request.status}) — refresh the queue to see its current state.`,
    );
  }

  const auditAction: AuditAction = action === "approve" ? "approve_request" : "deny_request";
  const baseDetail: Record<string, unknown> = {
    request_id: request.id,
    status_before: request.status,
    amount,
    suppress_notification: suppressNotification,
  };

  const client = createAnthropicClient();

  let updated;
  try {
    updated =
      action === "approve"
        ? await client.approveRequest(request.id, amount!, suppressNotification)
        : await client.denyRequest(request.id, suppressNotification);
  } catch (error) {
    return apiFailure(resolved, auditAction, baseDetail, error);
  }

  const row = upsertRequestSnapshot(db, updated);

  // Approval writes the per-user override as a side effect (§G4 endpoint 7), so
  // the member's limit row is now wrong locally until it is re-read.
  const limitRow =
    action === "approve" ? await refreshMemberSnapshot(db, client, request.actor_user_id) : null;

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action: auditAction,
    targetEmployeeId: requester?.id ?? null,
    targetUserId: request.actor_user_id,
    detail: {
      ...baseDetail,
      outcome: "success",
      status_after: row.status,
      resolved_at: row.resolved_at,
      new_source_type: limitRow?.source_type ?? null,
      spend_limit_id: limitRow?.spend_limit_id ?? null,
      api_request_id: null,
    },
  });

  return Response.json({
    ok: true,
    action: auditAction,
    id: row.id,
    status: row.status,
    resolvedAt: row.resolved_at,
    amount,
    limit:
      limitRow === null
        ? null
        : {
            amount: limitRow.amount,
            currency: limitRow.currency,
            sourceType: limitRow.source_type,
          },
  });
}
