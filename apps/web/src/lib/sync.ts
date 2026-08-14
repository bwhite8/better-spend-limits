/**
 * The sync engine (plan §Phase 8).
 *
 * The API is the source of truth; the `*_snapshot` and `user_daily_cost` tables
 * are a local cache of it (§G1 hybrid model). Everything the UI reads comes from
 * that cache, which is what makes a members list one SQL query instead of 250
 * round trips — and what makes freshness an explicit, visible property rather
 * than an assumption.
 *
 * Four rules shape the code below:
 *
 * 1. **Sequential paging at `limit=100`.** The whole org shares 60 req/min
 *    across every spend-limits endpoint (§G4), so there is no parallel fan-out
 *    anywhere in this file. Fetching is deliberately boring.
 * 2. **Fetch first, write once.** Every resource pages to exhaustion in memory
 *    and then commits in a single transaction, so a failure halfway through a
 *    sync leaves the previous snapshot intact rather than a half-replaced one.
 * 3. **Failures are recorded, not swallowed.** A resource that fails writes its
 *    message to `sync_state` and re-throws; {@link syncAll} catches per resource
 *    so one broken surface cannot hide the other two.
 * 4. **Costs are never final.** A date's value can be revised for up to 30 days
 *    (§G5), so costs re-read a 35-day window every time and re-derive the
 *    provisional flag from the watermark the API just reported.
 */

import { and, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import type { AppConfigDefaults } from "@/db/config-defaults";
import {
  employees,
  increaseRequestSnapshot,
  spendLimitSnapshot,
  syncState,
  userDailyCost,
  type NewIncreaseRequestSnapshotRow,
  type NewSpendLimitSnapshotRow,
  type NewUserDailyCostRow,
  type SyncStateRow,
} from "@/db/schema";
import { loadAppConfig } from "@/lib/config";
import { PENDING_STATUS } from "@/lib/requests";
import { MAX_PAGE_LIMIT, type AnthropicClient } from "@/lib/anthropic/client";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The three synced resources, each with its own `sync_state` row (§G7). */
export const SYNC_RESOURCES = ["effective", "requests", "costs"] as const;
export type SyncResource = (typeof SYNC_RESOURCES)[number];

/**
 * The whole-run lock lives in its own `sync_state` row.
 *
 * A fourth row rather than a new column, because §G7 is fixed and the resource
 * column is a free-text key. While the lock is held `last_synced_at` means "lock
 * taken at"; once released it means "run finished at".
 */
export const SYNC_LOCK_RESOURCE = "all";

/** A `running` lock older than this is assumed to belong to a crashed process. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * How far back costs are re-read on every sync. Wider than §G5's 30-day
 * revision window, so a value that changes on day 30 is still picked up.
 */
export const COST_LOOKBACK_DAYS = 35;

/** Rows per INSERT. Keeps the bound-parameter count far below SQLite's ceiling. */
const INSERT_CHUNK_ROWS = 100;

/**
 * Safety valve on the paging loops: an API that returned a self-referential
 * cursor would otherwise spin forever. 1000 pages of 100 rows is far beyond any
 * real org and still terminates in seconds.
 */
const MAX_PAGES = 1000;

const MS_PER_DAY = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Result shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface SyncOptions {
  /** Injectable clock; defaults to the real one. */
  now?: () => Date;
}

export interface EffectiveSyncResult {
  rows: number;
  /** Actors whose `email_address` matched an employee row. */
  matched: number;
  /** Actor emails with no employee row — the Phase-13 "unmatched members" list. */
  unmatched: string[];
}

export interface RequestsSyncResult {
  rows: number;
  pending: number;
  /** Pending rows deleted because the API no longer lists them (ex-members, §G4). */
  retired: number;
}

export interface CostsSyncResult {
  rows: number;
  /** Rows dated after the watermark, i.e. still subject to revision (§G5). */
  provisional: number;
  dataRefreshedAt: string | null;
  startingAt: string;
}

export interface SyncResourceOutcome {
  resource: SyncResource;
  ok: boolean;
  error: string | null;
  detail: EffectiveSyncResult | RequestsSyncResult | CostsSyncResult | null;
}

export interface SyncAllResult {
  /** `false` when another run held the lock — nothing was fetched. */
  ran: boolean;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  outcomes: SyncResourceOutcome[];
}

/* -------------------------------------------------------------------------- */
/* sync_state helpers                                                         */
/* -------------------------------------------------------------------------- */

type SyncStatePatch = Partial<Omit<SyncStateRow, "resource">>;

function writeSyncState(db: AppDatabase, resource: string, patch: SyncStatePatch): void {
  const values = { resource, status: "idle", ...patch };
  db.insert(syncState)
    .values(values)
    .onConflictDoUpdate({ target: syncState.resource, set: patch })
    .run();
}

export function readSyncState(db: AppDatabase): SyncStateRow[] {
  return db.select().from(syncState).all();
}

/** The `sync_state` row for one resource, or `null` if it has never run. */
export function getSyncState(db: AppDatabase, resource: string): SyncStateRow | null {
  return db.select().from(syncState).where(eq(syncState.resource, resource)).get() ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one resource's sync, keeping its `sync_state` row honest either way.
 *
 * On failure `last_synced_at` is deliberately left alone: the snapshot really is
 * as old as it was, and moving the timestamp would make a broken sync look
 * fresh to {@link isStale}.
 */
async function withResourceState<TResult>(
  db: AppDatabase,
  resource: SyncResource,
  now: () => Date,
  run: () => Promise<{ result: TResult; dataRefreshedAt?: string | null }>,
): Promise<TResult> {
  writeSyncState(db, resource, { status: "running", error: null });
  try {
    const { result, dataRefreshedAt } = await run();
    writeSyncState(db, resource, {
      status: "idle",
      error: null,
      last_synced_at: now().toISOString(),
      ...(dataRefreshedAt === undefined ? {} : { data_refreshed_at: dataRefreshedAt }),
    });
    return result;
  } catch (error) {
    writeSyncState(db, resource, { status: "error", error: messageOf(error) });
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Paging                                                                     */
/* -------------------------------------------------------------------------- */

interface Page {
  data: unknown[];
  next_page: string | null;
}

/**
 * Follow `next_page` to exhaustion, one request at a time.
 *
 * Cursors are opaque and bound to the filters that issued them (§G4), so they
 * are passed straight back and the filters never change mid-sequence.
 *
 * Every envelope is returned alongside the flattened rows, because the analytics
 * envelope carries `data_refreshed_at` and the caller needs the first page's
 * value — the freshness of the read it is about to store.
 */
async function collectPages<TPage extends Page>(
  fetchPage: (page: string | null) => Promise<TPage>,
): Promise<{ rows: TPage["data"]; pages: TPage[] }> {
  const rows: unknown[] = [];
  const pages: TPage[] = [];
  let cursor: string | null = null;

  for (let index = 0; index < MAX_PAGES; index += 1) {
    const page = await fetchPage(cursor);
    pages.push(page);
    rows.push(...page.data);
    if (page.next_page === null || page.next_page === "") {
      return { rows: rows as TPage["data"], pages };
    }
    cursor = page.next_page;
  }

  throw new Error(
    `sync: pagination did not terminate after ${MAX_PAGES} pages — the API returned a repeating cursor`,
  );
}

function insertChunks<TRow>(rows: readonly TRow[], write: (chunk: TRow[]) => void): void {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    write(rows.slice(start, start + INSERT_CHUNK_ROWS));
  }
}

function lowercase(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/* -------------------------------------------------------------------------- */
/* Effective spend limits                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Replace `spend_limit_snapshot` with the current `GET /effective` result and
 * backfill `employees.claude_user_id` from the actor emails.
 *
 * The table is REPLACED, not merged: a member who left the org must disappear
 * from the snapshot, and the endpoint returns exactly the current membership.
 */
export async function syncEffective(
  db: AppDatabase,
  client: AnthropicClient,
  options: SyncOptions = {},
): Promise<EffectiveSyncResult> {
  const now = options.now ?? ((): Date => new Date());

  return withResourceState(db, "effective", now, async () => {
    const { rows: wireRows } = await collectPages((page) =>
      client.listEffective({ limit: MAX_PAGE_LIMIT, page }),
    );

    const syncedAt = now().toISOString();

    // Last row wins if the API ever repeats a user across pages; the primary key
    // would otherwise reject the whole insert.
    const byUserId = new Map<string, NewSpendLimitSnapshotRow>();
    for (const row of wireRows) {
      byUserId.set(row.actor.user_id, {
        user_id: row.actor.user_id,
        actor_name: row.actor.name,
        actor_email: lowercase(row.actor.email_address),
        actor_deleted: row.actor.deleted,
        amount: row.amount,
        currency: row.currency,
        period: row.period,
        source_type: row.source?.type ?? null,
        // The whole source object, so an unrecognised source kind survives the
        // round trip instead of being flattened to its `type` (§G4 open set).
        source_detail: row.source === null ? null : JSON.stringify(row.source),
        spend_limit_id: row.spend_limit_id,
        period_to_date_spend: row.period_to_date_spend,
        synced_at: syncedAt,
      });
    }
    const rows = [...byUserId.values()];

    const result = db.transaction((tx): EffectiveSyncResult => {
      tx.delete(spendLimitSnapshot).run();
      insertChunks(rows, (chunk) => {
        tx.insert(spendLimitSnapshot).values(chunk).run();
      });

      const roster = new Set(
        tx
          .select({ email: employees.email })
          .from(employees)
          .all()
          .map((row) => row.email),
      );

      let matched = 0;
      const unmatched: string[] = [];
      for (const row of rows) {
        const email = row.actor_email;
        if (!email) continue;
        if (!roster.has(email)) {
          unmatched.push(email);
          continue;
        }
        matched += 1;
        // Only touch rows that would actually change, so `updated_at` stays a
        // record of real changes rather than of every sync.
        tx.update(employees)
          .set({ claude_user_id: row.user_id, updated_at: syncedAt })
          .where(
            and(
              eq(employees.email, email),
              or(isNull(employees.claude_user_id), ne(employees.claude_user_id, row.user_id)),
            ),
          )
          .run();
      }

      return { rows: rows.length, matched, unmatched };
    });

    return { result };
  });
}

/* -------------------------------------------------------------------------- */
/* Increase requests                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Upsert every increase request, all statuses, then retire any pending row the
 * API no longer lists.
 *
 * Upsert rather than wholesale replace: the endpoint omits requests from
 * ex-members (§G4), and dropping those rows would erase the record of a decision
 * an approver actually made. A vanished RESOLVED request therefore keeps its
 * last known state.
 *
 * A vanished PENDING request is different, and leaving it in place was a bug: it
 * records no decision, yet it stayed actionable in the queue forever. Approving
 * or denying it called an API that answers 404, which the route reports as "this
 * request has already been resolved — refresh the queue", and refreshing never
 * cleared it. Since nothing was decided, deleting loses nothing and the row stops
 * offering an action that cannot succeed.
 *
 * This reconciliation is only sound because `collectPages` pages to exhaustion
 * with NO status filter, and throws rather than returning a partial list — so
 * "absent from `seenIds`" genuinely means "the API no longer lists it", never
 * "we stopped reading early".
 */
export async function syncRequests(
  db: AppDatabase,
  client: AnthropicClient,
  options: SyncOptions = {},
): Promise<RequestsSyncResult> {
  const now = options.now ?? ((): Date => new Date());

  return withResourceState(db, "requests", now, async () => {
    const { rows: wireRows } = await collectPages((page) =>
      client.listIncreaseRequests({ limit: MAX_PAGE_LIMIT, page }),
    );

    const syncedAt = now().toISOString();
    const byId = new Map<string, NewIncreaseRequestSnapshotRow>();
    for (const row of wireRows) {
      byId.set(row.id, {
        id: row.id,
        status: row.status,
        actor_user_id: row.actor.user_id,
        actor_name: row.actor.name,
        actor_email: lowercase(row.actor.email_address),
        created_at: row.created_at,
        resolved_at: row.resolved_at,
        // Live limit + spend, present on pending rows only (§G4).
        spend_summary: row.spend_summary === null ? null : JSON.stringify(row.spend_summary),
        synced_at: syncedAt,
      });
    }
    const rows = [...byId.values()];

    const seenIds = [...byId.keys()];

    const retired = db.transaction((tx): number => {
      insertChunks(rows, (chunk) => {
        tx.insert(increaseRequestSnapshot)
          .values(chunk)
          .onConflictDoUpdate({
            target: increaseRequestSnapshot.id,
            set: {
              status: sql`excluded.status`,
              actor_user_id: sql`excluded.actor_user_id`,
              actor_name: sql`excluded.actor_name`,
              actor_email: sql`excluded.actor_email`,
              created_at: sql`excluded.created_at`,
              resolved_at: sql`excluded.resolved_at`,
              spend_summary: sql`excluded.spend_summary`,
              synced_at: sql`excluded.synced_at`,
            },
          })
          .run();
      });

      // `notInArray` with an empty list is not portable, and the empty case is
      // meaningful here — the API listing nothing at all means every pending row
      // we hold is gone.
      const stale =
        seenIds.length === 0
          ? eq(increaseRequestSnapshot.status, PENDING_STATUS)
          : and(
              eq(increaseRequestSnapshot.status, PENDING_STATUS),
              notInArray(increaseRequestSnapshot.id, seenIds),
            );

      return tx.delete(increaseRequestSnapshot).where(stale).run().changes;
    });

    return {
      result: {
        rows: rows.length,
        pending: rows.filter((row) => row.status === PENDING_STATUS).length,
        retired,
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Costs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A day is provisional when it falls after the freshness watermark (§G5).
 *
 * The comparison is a plain string compare between `YYYY-MM-DD` and an ISO
 * timestamp, which is exact: any timestamp on the watermark's own day shares
 * that day's prefix and is therefore longer-and-greater, so the day is NOT
 * marked provisional, while any later day differs in the date portion.
 */
export function isProvisionalDate(date: string, dataRefreshedAt: string | null): boolean {
  if (dataRefreshedAt === null) return false;
  return date > dataRefreshedAt;
}

/**
 * Re-read the trailing {@link COST_LOOKBACK_DAYS} of daily cost and upsert it.
 *
 * Revisions overwrite: a date already stored is updated with whatever the API
 * reports now, and its provisional flag is re-derived — that is the entire point
 * of re-reading a window instead of only fetching new days.
 */
export async function syncCosts(
  db: AppDatabase,
  client: AnthropicClient,
  options: SyncOptions = {},
): Promise<CostsSyncResult> {
  const now = options.now ?? ((): Date => new Date());

  return withResourceState(db, "costs", now, async () => {
    const startingAt = new Date(now().getTime() - COST_LOOKBACK_DAYS * MS_PER_DAY).toISOString();

    const { rows: wireRows, pages } = await collectPages((page) =>
      client.userCostReport({
        starting_at: startingAt,
        bucket_width: "1d",
        limit: MAX_PAGE_LIMIT,
        page,
      }),
    );

    const syncedAt = now().toISOString();
    // The watermark from the FIRST page: it describes the freshness of the read
    // we are about to store. A later page's value would classify rows we already
    // classified under a different one.
    const watermark: string | null = pages[0]?.data_refreshed_at ?? null;

    const byKey = new Map<string, NewUserDailyCostRow>();
    for (const row of wireRows) {
      // `bucket_width=1d` always carries a date; a row without one is a totals
      // row and has no place in a per-day table.
      if (row.date === undefined) continue;
      byKey.set(`${row.actor.user_id} ${row.date}`, {
        user_id: row.actor.user_id,
        date: row.date,
        amount: row.amount,
        provisional: isProvisionalDate(row.date, watermark),
        synced_at: syncedAt,
      });
    }
    const rows = [...byKey.values()];

    db.transaction((tx) => {
      insertChunks(rows, (chunk) => {
        tx.insert(userDailyCost)
          .values(chunk)
          .onConflictDoUpdate({
            target: [userDailyCost.user_id, userDailyCost.date],
            set: {
              amount: sql`excluded.amount`,
              provisional: sql`excluded.provisional`,
              synced_at: sql`excluded.synced_at`,
            },
          })
          .run();
      });
    });

    return {
      result: {
        rows: rows.length,
        provisional: rows.filter((row) => row.provisional).length,
        dataRefreshedAt: watermark,
        startingAt,
      },
      dataRefreshedAt: watermark,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Take the whole-run lock, or report that somebody else holds it.
 *
 * Read and write happen in one transaction so two concurrent callers in the
 * same process cannot both win. A lock older than {@link STALE_LOCK_MS} is
 * broken rather than waited on — the process that took it is gone, and a stuck
 * lock would silently freeze the snapshot forever.
 */
function acquireLock(db: AppDatabase, at: Date): boolean {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(syncState)
      .where(eq(syncState.resource, SYNC_LOCK_RESOURCE))
      .get();

    if (existing?.status === "running") {
      const heldSince = existing.last_synced_at ? Date.parse(existing.last_synced_at) : Number.NaN;
      const heldFor = at.getTime() - heldSince;
      if (!Number.isNaN(heldSince) && heldFor < STALE_LOCK_MS) return false;
    }

    const patch = { status: "running", last_synced_at: at.toISOString(), error: null };
    tx.insert(syncState)
      .values({ resource: SYNC_LOCK_RESOURCE, ...patch })
      .onConflictDoUpdate({ target: syncState.resource, set: patch })
      .run();
    return true;
  });
}

/**
 * Sync all three resources, one after another.
 *
 * A failing resource is recorded and the run continues: an expired Analytics key
 * must not stop limits from syncing. The lock ensures a Refresh click and a
 * staleness-triggered page render cannot stampede the API together.
 */
export async function syncAll(
  db: AppDatabase,
  client: AnthropicClient,
  options: SyncOptions = {},
): Promise<SyncAllResult> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();

  if (!acquireLock(db, startedAt)) {
    const at = startedAt.toISOString();
    return { ran: false, ok: true, startedAt: at, finishedAt: at, outcomes: [] };
  }

  const steps: [SyncResource, () => Promise<SyncResourceOutcome["detail"]>][] = [
    ["effective", () => syncEffective(db, client, { now })],
    ["requests", () => syncRequests(db, client, { now })],
    ["costs", () => syncCosts(db, client, { now })],
  ];

  const outcomes: SyncResourceOutcome[] = [];
  for (const [resource, run] of steps) {
    try {
      outcomes.push({ resource, ok: true, error: null, detail: await run() });
    } catch (error) {
      outcomes.push({ resource, ok: false, error: messageOf(error), detail: null });
    }
  }

  const ok = outcomes.every((outcome) => outcome.ok);
  const finishedAt = now();
  writeSyncState(db, SYNC_LOCK_RESOURCE, {
    status: ok ? "idle" : "error",
    last_synced_at: finishedAt.toISOString(),
    error: ok
      ? null
      : outcomes
          .filter((outcome) => !outcome.ok)
          .map((outcome) => `${outcome.resource}: ${outcome.error ?? "failed"}`)
          .join("; "),
  });

  return {
    ran: true,
    ok,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    outcomes,
  };
}

/* -------------------------------------------------------------------------- */
/* Freshness                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Is any resource older than `sync_stale_after_minutes` (§G7)?
 *
 * A resource that has never synced counts as stale — that is the state a fresh
 * clone is in, and it is exactly when a sync should fire.
 */
export function isStale(
  db: AppDatabase,
  config: AppConfigDefaults = loadAppConfig(db),
  now: Date = new Date(),
): boolean {
  const rows = new Map(readSyncState(db).map((row) => [row.resource, row]));
  const cutoff = now.getTime() - config.sync_stale_after_minutes * 60 * 1000;

  return SYNC_RESOURCES.some((resource) => {
    const row = rows.get(resource);
    if (!row?.last_synced_at) return true;
    const at = Date.parse(row.last_synced_at);
    return Number.isNaN(at) || at < cutoff;
  });
}

/** Oldest `last_synced_at` across the three resources — what the UI displays. */
export function oldestSyncedAt(db: AppDatabase): string | null {
  const rows = readSyncState(db).filter((row) =>
    (SYNC_RESOURCES as readonly string[]).includes(row.resource),
  );
  if (rows.length < SYNC_RESOURCES.length) return null;

  let oldest: string | null = null;
  for (const row of rows) {
    if (!row.last_synced_at) return null;
    if (oldest === null || row.last_synced_at < oldest) oldest = row.last_synced_at;
  }
  return oldest;
}
