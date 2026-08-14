/**
 * The server side of an edit-limit write (plan §Phase 10).
 *
 * Writes are LIVE PASS-THROUGH (§G1): the Anthropic API is the source of truth,
 * so a limit change is a real `POST`/`DELETE` against it, and only afterwards is
 * the local snapshot brought into line. Nothing here writes a limit into SQLite
 * that the API has not already accepted — a cache that disagrees with the API is
 * worse than a cache that is a few seconds behind.
 *
 * The re-read after a write is TARGETED: one member, one `effective` row. A full
 * `syncEffective` would page 250 rows and rewrite `sync_state` for what is
 * really a one-row change, and it would burn the org's shared 60 req/min budget
 * (§G4) on every button click. The wire→row mapping is therefore duplicated from
 * `sync.ts` in miniature; if the snapshot columns change, both places move.
 */

import { and, eq } from "drizzle-orm";

import type { EffectiveSpendLimitRow } from "@bsl/shared";

import type { AppDatabase } from "@/db/client";
import {
  increaseRequestSnapshot,
  spendLimitSnapshot,
  type NewSpendLimitSnapshotRow,
  type SpendLimitSnapshotRow,
} from "@/db/schema";
import type { AnthropicClient } from "@/lib/anthropic/client";

/** Amounts on the wire are non-negative decimal minor units (§G9). */
const WIRE_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

/**
 * A refusal the caller should turn into an HTTP response verbatim.
 *
 * `status` and `code` are carried separately so the route does not have to
 * pattern-match on message text to decide what to send.
 */
export class LimitWriteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LimitWriteError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Validate a request body's `amount`.
 *
 * The wire value is minor units, not dollars — the dollars→cents conversion
 * happens in the form (`dollarsInputToMinorUnits`, §G9) so that what the user
 * sees and what is sent are converted exactly once, in one place. This is the
 * server's independent check of the same rule: a hand-rolled `curl` must not be
 * able to write `"-500"` or `"1e5"` just because the browser would not.
 */
export function requireWireAmount(value: unknown): string {
  if (typeof value !== "string" || !WIRE_AMOUNT_PATTERN.test(value.trim())) {
    throw new LimitWriteError(
      400,
      "invalid_amount",
      "amount must be a non-negative decimal string in minor units, e.g. \"75000\" for $750.00",
    );
  }
  return value.trim();
}

/** Does this member have an unresolved increase request? (§G4: at most one.) */
export function pendingRequestExists(db: AppDatabase, userId: string | null): boolean {
  if (userId === null) return false;

  const row = db
    .select({ id: increaseRequestSnapshot.id })
    .from(increaseRequestSnapshot)
    .where(
      and(
        eq(increaseRequestSnapshot.actor_user_id, userId),
        eq(increaseRequestSnapshot.status, "pending"),
      ),
    )
    .get();

  return row !== undefined;
}

/** One `effective` row in the shape `spend_limit_snapshot` stores. */
function toSnapshotRow(row: EffectiveSpendLimitRow, syncedAt: string): NewSpendLimitSnapshotRow {
  return {
    user_id: row.actor.user_id,
    actor_name: row.actor.name,
    actor_email: row.actor.email_address?.trim().toLowerCase() ?? null,
    actor_deleted: row.actor.deleted,
    amount: row.amount,
    currency: row.currency,
    period: row.period,
    source_type: row.source?.type ?? null,
    // The whole source object, so an unrecognised source kind survives the round
    // trip rather than being flattened to its `type` (§G4 open set).
    source_detail: row.source === null ? null : JSON.stringify(row.source),
    spend_limit_id: row.spend_limit_id,
    period_to_date_spend: row.period_to_date_spend,
    synced_at: syncedAt,
  };
}

/**
 * Re-read one member's effective limit from the API and update their snapshot
 * row. Returns the stored row, or `null` when the API no longer lists them.
 *
 * A member who has vanished from `effective` keeps their existing row: this is a
 * one-member read, and deleting on its say-so would let a filtered response
 * quietly erase a record that a full `syncEffective` is the proper owner of.
 */
export async function refreshMemberSnapshot(
  db: AppDatabase,
  client: AnthropicClient,
  userId: string,
  options: { now?: () => Date } = {},
): Promise<SpendLimitSnapshotRow | null> {
  const now = options.now ?? ((): Date => new Date());

  const envelope = await client.listEffective({ user_ids: [userId], limit: 1 });
  const wireRow = envelope.data.find((row) => row.actor.user_id === userId) ?? null;
  if (wireRow === null) return null;

  const values = toSnapshotRow(wireRow, now().toISOString());
  db.insert(spendLimitSnapshot)
    .values(values)
    .onConflictDoUpdate({ target: spendLimitSnapshot.user_id, set: values })
    .run();

  return db.select().from(spendLimitSnapshot).where(eq(spendLimitSnapshot.user_id, userId)).get() ?? null;
}
