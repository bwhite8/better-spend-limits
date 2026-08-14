/**
 * Joining `employees` to the synced API snapshot.
 *
 * The join key is deliberately two-legged. `employees.claude_user_id` is filled
 * in by the Phase-8 sync and is the authoritative link once it exists, but a
 * person who has never appeared in an `effective` page has a NULL there — so
 * the lowercased email (§G7's stated join key) is the fallback. Doing this in
 * one place keeps the members list and the member page from drifting apart on a
 * detail that decides whether somebody's limit is shown at all.
 *
 * Both indexes are built from a single pass over at most 250 rows; a SQL join
 * expressing "match on user id, else on email" is more machinery than the data
 * volume justifies.
 */

import { desc, eq } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import {
  increaseRequestSnapshot,
  spendLimitSnapshot,
  type Employee,
  type IncreaseRequestSnapshotRow,
  type SpendLimitSnapshotRow,
} from "@/db/schema";

/** The minimum needed to find somebody's snapshot row. */
export type SnapshotSubject = Pick<Employee, "claude_user_id" | "email">;

export interface SnapshotIndex {
  byUserId: Map<string, SpendLimitSnapshotRow>;
  byEmail: Map<string, SpendLimitSnapshotRow>;
}

/** Every `spend_limit_snapshot` row, indexed both ways. */
export function loadSnapshotIndex(db: AppDatabase): SnapshotIndex {
  const rows = db.select().from(spendLimitSnapshot).all();
  const byUserId = new Map<string, SpendLimitSnapshotRow>();
  const byEmail = new Map<string, SpendLimitSnapshotRow>();

  for (const row of rows) {
    byUserId.set(row.user_id, row);
    if (row.actor_email) byEmail.set(row.actor_email.toLowerCase(), row);
  }

  return { byUserId, byEmail };
}

/** This employee's snapshot row, or `null` when the sync has never seen them. */
export function snapshotFor(index: SnapshotIndex, employee: SnapshotSubject): SpendLimitSnapshotRow | null {
  const byId = employee.claude_user_id === null ? undefined : index.byUserId.get(employee.claude_user_id);
  return byId ?? index.byEmail.get(employee.email.toLowerCase()) ?? null;
}

/** API user ids with a `pending` increase request — one lookup for the whole list. */
export function pendingRequestUserIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ actor_user_id: increaseRequestSnapshot.actor_user_id })
    .from(increaseRequestSnapshot)
    .where(eq(increaseRequestSnapshot.status, "pending"))
    .all();

  return new Set(rows.map((row) => row.actor_user_id));
}

/**
 * This member's increase requests, newest first. `null` user id (never synced)
 * yields an empty list rather than every request in the table.
 */
export function requestsForUser(db: AppDatabase, userId: string | null): IncreaseRequestSnapshotRow[] {
  if (userId === null) return [];

  return db
    .select()
    .from(increaseRequestSnapshot)
    .where(eq(increaseRequestSnapshot.actor_user_id, userId))
    .orderBy(desc(increaseRequestSnapshot.created_at))
    .all();
}
