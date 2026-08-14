/**
 * The increase-request queue, server side (plan §Phase 11).
 *
 * Two jobs live here, both shared by the page and the BFF route so the thing
 * that DECIDES a request is actionable is the same code in both places:
 *
 * 1. **Who may act.** A request names an Anthropic actor, not an employee, so
 *    every permission question starts with a join back to `employees`. That join
 *    is two-legged for the same reason `lib/members.ts` is: `claude_user_id` is
 *    authoritative once the sync has filled it, and the lowercased email (§G7's
 *    stated join key) is the fallback. An actor who matches nobody is not a
 *    reason to hide the request — it is a reason to show it to admins only
 *    (§G8), flagged, because a request from someone missing off the roster is
 *    precisely the thing an administrator needs to see.
 *
 * 2. **Recording the outcome.** Approve and deny are live pass-through writes
 *    (§G1), so the API's own answer — not our optimism — is what gets written
 *    back into `increase_request_snapshot`.
 *
 * The wire→row mapping duplicates `sync.ts`'s in miniature, deliberately and for
 * the same reason `member-limit.ts` duplicates the snapshot mapping: a targeted
 * one-row update after a write, rather than a full re-page of every request that
 * would burn the org's shared 60 req/min budget (§G4) on a button click. If the
 * snapshot columns change, both places move.
 */

import { desc, eq } from "drizzle-orm";

import type { IncreaseRequest } from "@bsl/shared";

import type { AppDatabase } from "@/db/client";
import type { EditRole } from "@/db/config-defaults";
import {
  employees,
  increaseRequestSnapshot,
  type Employee,
  type IncreaseRequestSnapshotRow,
  type NewIncreaseRequestSnapshotRow,
} from "@/db/schema";
import { loadSnapshotIndex, snapshotFor, type SnapshotIndex } from "@/lib/members";
import { canActOnRequest, type PermissionActor } from "@/lib/permissions";

/** The only status that can still be acted on (§G4). */
export const PENDING_STATUS = "pending";

/* -------------------------------------------------------------------------- */
/* Requester lookup                                                           */
/* -------------------------------------------------------------------------- */

export interface EmployeeIndex {
  byUserId: Map<string, Employee>;
  byEmail: Map<string, Employee>;
}

/** Every employee, indexed by both legs of the join key. */
export function loadEmployeeIndex(db: AppDatabase): EmployeeIndex {
  const rows = db.select().from(employees).all();
  const byUserId = new Map<string, Employee>();
  const byEmail = new Map<string, Employee>();

  for (const row of rows) {
    if (row.claude_user_id !== null) byUserId.set(row.claude_user_id, row);
    byEmail.set(row.email.toLowerCase(), row);
  }

  return { byUserId, byEmail };
}

/** The employee who raised this request, or `null` when nobody matches. */
export function requesterOf(
  index: EmployeeIndex,
  request: Pick<IncreaseRequestSnapshotRow, "actor_user_id" | "actor_email">,
): Employee | null {
  const byId = index.byUserId.get(request.actor_user_id);
  if (byId) return byId;

  const email = request.actor_email?.trim().toLowerCase();
  return email ? (index.byEmail.get(email) ?? null) : null;
}

/* -------------------------------------------------------------------------- */
/* Spend summary                                                              */
/* -------------------------------------------------------------------------- */

/** The live limit + spend §G4 attaches to pending rows only. */
export interface RequestSpendSummary {
  amount: string | null;
  currency: string | null;
  period: string | null;
  period_to_date_spend: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * `spend_summary` JSON as the card needs it, or `null`.
 *
 * Unreadable JSON is treated exactly like an absent summary: the card says the
 * reading is unavailable, which is honest, rather than throwing on a page whose
 * real job is to show Approve and Deny buttons.
 */
export function parseSpendSummary(raw: string | null): RequestSpendSummary | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const summary = parsed as Record<string, unknown>;
  return {
    // §G9: a null amount is UNLIMITED, and is not the same as an absent one.
    amount: "amount" in summary ? stringOrNull(summary.amount) : null,
    currency: stringOrNull(summary.currency),
    period: stringOrNull(summary.period),
    period_to_date_spend: stringOrNull(summary.period_to_date_spend),
  };
}

/* -------------------------------------------------------------------------- */
/* The queue                                                                  */
/* -------------------------------------------------------------------------- */

export interface QueueEntry {
  id: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  actorUserId: string;
  /** Falls back to the email, then the raw actor id — a card always has a name. */
  displayName: string;
  actorEmail: string | null;
  /** `null` when the API actor matches no employee record. */
  requester: Employee | null;
  summary: RequestSpendSummary | null;
  /** Whether the current actor may approve or deny it (§G8). */
  actionable: boolean;
}

export interface RequestQueue {
  pending: QueueEntry[];
  resolved: QueueEntry[];
}

/**
 * The member's CURRENT cap, read from the synced limit snapshot.
 *
 * §G4 gives a pending request a LIVE `spend_summary`; ours is a copy frozen at
 * the last `syncRequests`, and NO write path refreshes it —
 * `refreshMemberSnapshot` (§Phase 10/11) updates `spend_limit_snapshot` alone.
 * So after any limit change the cached summary is stale, and it is what both the
 * card and the approve field were reading: the queue showed a cap the member no
 * longer had, and approving at the prefilled figure silently REDUCED their real
 * limit. The snapshot is the reading every other screen already trusts, so
 * prefer it and keep the cached summary as the fallback.
 */
function summaryFromSnapshot(
  index: SnapshotIndex,
  row: IncreaseRequestSnapshotRow,
): RequestSpendSummary | null {
  const snapshot = snapshotFor(index, {
    claude_user_id: row.actor_user_id,
    email: row.actor_email ?? "",
  });
  if (snapshot === null) return null;

  return {
    amount: snapshot.amount,
    currency: snapshot.currency,
    period: snapshot.period,
    period_to_date_spend: snapshot.period_to_date_spend,
  };
}

function toEntry(
  row: IncreaseRequestSnapshotRow,
  requester: Employee | null,
  actionable: boolean,
  liveSummary: RequestSpendSummary | null = null,
): QueueEntry {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    actorUserId: row.actor_user_id,
    displayName: requester?.name ?? row.actor_name ?? row.actor_email ?? row.actor_user_id,
    actorEmail: requester?.email ?? row.actor_email,
    requester,
    summary: liveSummary ?? parseSpendSummary(row.spend_summary),
    actionable,
  };
}

/**
 * Everything `actor` may see, split by whether it still needs a decision.
 *
 * Visibility and actionability are the SAME rule here (§G8: "visible &
 * actionable iff canActOnRequest"), so a request nobody may act on is simply
 * absent rather than rendered with dead buttons. `actionable` is still carried
 * on the entry because resolved rows are read-only regardless.
 *
 * Newest first within each tab, matching the API's own ordering (§G4).
 */
export function loadRequestQueue(
  db: AppDatabase,
  actor: PermissionActor,
  editRoles: EditRole[],
): RequestQueue {
  const rows = db
    .select()
    .from(increaseRequestSnapshot)
    .orderBy(desc(increaseRequestSnapshot.created_at), desc(increaseRequestSnapshot.id))
    .all();

  const index = loadEmployeeIndex(db);
  // Only pending rows show spend context at all (§G4 gives resolved rows a null
  // summary), so only they need the fresher reading.
  const snapshots = loadSnapshotIndex(db);
  const pending: QueueEntry[] = [];
  const resolved: QueueEntry[] = [];

  for (const row of rows) {
    const requester = requesterOf(index, row);
    if (!canActOnRequest(actor, requester, editRoles)) continue;

    const isPending = row.status === PENDING_STATUS;
    const entry = toEntry(
      row,
      requester,
      isPending,
      isPending ? summaryFromSnapshot(snapshots, row) : null,
    );
    (entry.status === PENDING_STATUS ? pending : resolved).push(entry);
  }

  return { pending, resolved };
}

/** One request by id, with its requester resolved — the route's entry point. */
export function findRequest(
  db: AppDatabase,
  id: string,
): { row: IncreaseRequestSnapshotRow; requester: Employee | null } | null {
  const row = db
    .select()
    .from(increaseRequestSnapshot)
    .where(eq(increaseRequestSnapshot.id, id))
    .get();
  if (!row) return null;

  return { row, requester: requesterOf(loadEmployeeIndex(db), row) };
}

/* -------------------------------------------------------------------------- */
/* Writing the API's answer back                                              */
/* -------------------------------------------------------------------------- */

/** One wire request in the shape `increase_request_snapshot` stores. */
function toSnapshotRow(request: IncreaseRequest, syncedAt: string): NewIncreaseRequestSnapshotRow {
  return {
    id: request.id,
    status: request.status,
    actor_user_id: request.actor.user_id,
    actor_name: request.actor.name,
    actor_email: request.actor.email_address?.trim().toLowerCase() ?? null,
    created_at: request.created_at,
    resolved_at: request.resolved_at,
    spend_summary: request.spend_summary === null ? null : JSON.stringify(request.spend_summary),
    synced_at: syncedAt,
  };
}

/**
 * Store the request exactly as the API just returned it, and hand the stored row
 * back.
 *
 * Note this writes whatever `status` the API reported, including the one case
 * where that is NOT what the caller asked for: denying an already-denied request
 * is idempotent and answers 200 with the existing resource (§G4).
 */
export function upsertRequestSnapshot(
  db: AppDatabase,
  request: IncreaseRequest,
  options: { now?: () => Date } = {},
): IncreaseRequestSnapshotRow {
  const now = options.now ?? ((): Date => new Date());
  const values = toSnapshotRow(request, now().toISOString());

  db.insert(increaseRequestSnapshot)
    .values(values)
    .onConflictDoUpdate({ target: increaseRequestSnapshot.id, set: values })
    .run();

  return db
    .select()
    .from(increaseRequestSnapshot)
    .where(eq(increaseRequestSnapshot.id, request.id))
    .get()!;
}
