/**
 * `/api/members/[id]/limit` — the BFF behind the edit-limit controls (§Phase 10).
 *
 * - `POST   {"amount": "75000"}` sets (upserts) the member's per-user override.
 * - `DELETE` removes it, so the member falls back to what they inherit.
 *
 * `[id]` is the EMPLOYEE id, the same one `/members/[id]` uses. The Anthropic
 * `user_id` is never accepted from the client: it is looked up from the synced
 * snapshot for the employee the permission check was actually run against.
 * Taking it from the request body would make the permission check decorative —
 * anyone could pass their own employee id and somebody else's user id.
 *
 * The order of operations is deliberate and is the same for both verbs:
 *
 *   identify → authorise → call the API → update the snapshot → audit
 *
 * The API call comes before any local write because the API is the source of
 * truth (§G1); the audit row is written for the ATTEMPT either way, because "who
 * tried to raise this limit and was refused" is exactly the kind of thing an
 * audit log exists to answer. Only requests that never reached the API — an
 * unknown identity, a failed permission check, a malformed amount — go
 * unrecorded.
 *
 * §G4 note surfaced to the UI: setting a limit directly does NOT resolve a
 * pending increase request, so every response carries `hasPendingRequest` and
 * the dialog says so.
 */

import { eq } from "drizzle-orm";

import { getDb, type AppDatabase } from "@/db/client";
import { employees, type Employee, type SpendLimitSnapshotRow } from "@/db/schema";
import { AnthropicApiError, createAnthropicClient } from "@/lib/anthropic/client";
import { writeAudit, type AuditAction } from "@/lib/audit";
import { currentEmployee } from "@/lib/identity";
import {
  LimitWriteError,
  pendingRequestExists,
  refreshMemberSnapshot,
  requireWireAmount,
} from "@/lib/member-limit";
import { loadSnapshotIndex, snapshotFor } from "@/lib/members";
import { authorityIdsOf, canEdit, loadEditRoles } from "@/lib/permissions";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Everything both verbs need, once identity and permission have been settled. */
interface WriteContext {
  db: AppDatabase;
  actor: Employee;
  target: Employee;
  snapshot: SpendLimitSnapshotRow;
  userId: string;
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status });
}

/**
 * Resolve and authorise, or answer with the refusal.
 *
 * A member the sync has never seen has no Anthropic `user_id` and therefore
 * nothing to write against; that is a 409 rather than a 404, because the member
 * exists — the snapshot is just not there yet.
 */
async function resolveWriteContext(context: RouteContext): Promise<WriteContext | Response> {
  const { id } = await context.params;
  const db = getDb();

  const actor = await currentEmployee(db);
  if (actor === null) return fail(403, "not_provisioned", "not provisioned");

  const target = db.select().from(employees).where(eq(employees.id, id)).get();
  if (!target) return fail(404, "unknown_member", `no employee with id ${JSON.stringify(id)}`);

  if (!canEdit(actor, target, loadEditRoles(db), authorityIdsOf(db, actor))) {
    return fail(403, "forbidden", "you are not allowed to edit this member's spend limit");
  }

  const snapshot = snapshotFor(loadSnapshotIndex(db), target);
  if (snapshot === null) {
    return fail(
      409,
      "not_synced",
      "this member has not been synced from the API yet, so there is no account to write to",
    );
  }

  return { db, actor, target, snapshot, userId: snapshot.user_id };
}

/** What the dialog needs to re-render itself after a write. */
function successBody(
  action: AuditAction,
  row: SpendLimitSnapshotRow | null,
  hasPendingRequest: boolean,
): Response {
  return Response.json({
    ok: true,
    action,
    amount: row?.amount ?? null,
    currency: row?.currency ?? null,
    sourceType: row?.source_type ?? null,
    spendLimitId: row?.spend_limit_id ?? null,
    periodToDateSpend: row?.period_to_date_spend ?? null,
    hasPendingRequest,
  });
}

/**
 * An upstream failure, as a status this app can mean.
 *
 * A rejected credential is OUR misconfiguration, not the user's mistake, so it
 * becomes a 502 rather than being passed through as a 401 that would look like
 * the user's session expired.
 */
function statusForApiError(error: AnthropicApiError): number {
  if (error.status === 429) return 429;
  if (error.status === 400) return 400;
  if (error.status === 404 || error.status === 409) return 409;
  return 502;
}

function apiFailure(
  { db, actor, target, userId }: WriteContext,
  action: AuditAction,
  detail: Record<string, unknown>,
  error: unknown,
): Response {
  const api = error instanceof AnthropicApiError ? error : null;

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action,
    targetEmployeeId: target.id,
    targetUserId: userId,
    detail: {
      ...detail,
      outcome: "error",
      error_type: api?.errorType ?? "unknown_error",
      error_message: error instanceof Error ? error.message : String(error),
      // The mock (and the real API) only carry `request_id` on error envelopes,
      // which is exactly when it is worth recording (§Phase 8).
      api_request_id: api?.requestId ?? null,
    },
  });

  const status = api === null ? 502 : statusForApiError(api);
  const message =
    api === null
      ? "The spend limits API could not be reached."
      : `The spend limits API rejected the change: ${api.message}`;

  return fail(status, api?.errorType ?? "upstream_error", message);
}

/* -------------------------------------------------------------------------- */
/* POST — set (upsert) the per-user override                                  */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const resolved = await resolveWriteContext(context);
  if (resolved instanceof Response) return resolved;
  const { db, actor, target, snapshot, userId } = resolved;

  let amount: string;
  try {
    const body: unknown = await request.json().catch(() => null);
    amount = requireWireAmount((body as { amount?: unknown } | null)?.amount);
  } catch (error) {
    if (error instanceof LimitWriteError) return fail(error.status, error.code, error.message);
    throw error;
  }

  const client = createAnthropicClient();
  const baseDetail = {
    old_amount: snapshot.amount,
    new_amount: amount,
    old_source_type: snapshot.source_type,
  };

  let spendLimitId: string;
  try {
    spendLimitId = (await client.setUserLimit(userId, amount)).id;
  } catch (error) {
    return apiFailure(resolved, "set_limit", baseDetail, error);
  }

  const row = await refreshMemberSnapshot(db, client, userId);
  const hasPendingRequest = pendingRequestExists(db, userId);

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action: "set_limit",
    targetEmployeeId: target.id,
    targetUserId: userId,
    detail: {
      ...baseDetail,
      outcome: "success",
      new_source_type: row?.source_type ?? null,
      spend_limit_id: spendLimitId,
      api_request_id: null,
      // §G4: a direct write leaves any pending request pending.
      pending_request_unresolved: hasPendingRequest,
    },
  });

  return successBody("set_limit", row, hasPendingRequest);
}

/* -------------------------------------------------------------------------- */
/* DELETE — remove the per-user override                                      */
/* -------------------------------------------------------------------------- */

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const resolved = await resolveWriteContext(context);
  if (resolved instanceof Response) return resolved;
  const { db, actor, target, snapshot, userId } = resolved;

  // Only a per-user override is deletable (§G4); the id on an inherited row
  // belongs to a group/seat-tier/org row that this endpoint must not touch.
  if (snapshot.source_type !== "user" || snapshot.spend_limit_id === null) {
    return fail(
      409,
      "no_override",
      "this member has no per-user override to remove — their limit is inherited",
    );
  }

  const client = createAnthropicClient();
  const baseDetail = {
    old_amount: snapshot.amount,
    old_source_type: snapshot.source_type,
    spend_limit_id: snapshot.spend_limit_id,
  };

  try {
    await client.deleteSpendLimit(snapshot.spend_limit_id);
  } catch (error) {
    return apiFailure(resolved, "delete_limit", baseDetail, error);
  }

  const row = await refreshMemberSnapshot(db, client, userId);
  const hasPendingRequest = pendingRequestExists(db, userId);

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action: "delete_limit",
    targetEmployeeId: target.id,
    targetUserId: userId,
    detail: {
      ...baseDetail,
      outcome: "success",
      // What they fell back to — the whole point of removing an override.
      new_amount: row?.amount ?? null,
      new_source_type: row?.source_type ?? null,
      api_request_id: null,
      pending_request_unresolved: hasPendingRequest,
    },
  });

  return successBody("delete_limit", row, hasPendingRequest);
}
