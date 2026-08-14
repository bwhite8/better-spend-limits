/**
 * Staleness-triggered sync for server components (plan §Phase 8).
 *
 * Pages render from the local snapshot, so something has to keep it current.
 * That something is this: before a page reads the snapshot it calls
 * {@link ensureFreshSync}, which syncs only when `sync_stale_after_minutes` has
 * elapsed (§G7) and otherwise returns immediately.
 *
 * Two properties matter and are both delegated rather than reimplemented:
 *
 * - **No stampede.** Concurrent renders all call this; the whole-run lock in
 *   `syncAll` means exactly one of them talks to the API and the rest return at
 *   once. That is why the call is awaited rather than fired and forgotten — the
 *   wait is bounded and the caller then reads a snapshot it knows is current.
 * - **A sync failure is not a page failure.** An expired key or an API outage
 *   must degrade to slightly stale numbers, never to a 500. Errors are reported
 *   through `sync_state` (which the UI surfaces) and swallowed here.
 */

import { getDb, type AppDatabase } from "@/db/client";
import { loadAppConfig } from "@/lib/config";
import { createAnthropicClient, type AnthropicClient } from "@/lib/anthropic/client";
import { isStale, syncAll, type SyncAllResult, type SyncOptions } from "@/lib/sync";

export interface EnsureFreshSyncOptions extends SyncOptions {
  /** Defaults to the environment-configured client (§G6). */
  client?: AnthropicClient;
  /** Sync regardless of staleness — what the Refresh button does. */
  force?: boolean;
}

/**
 * The sync this process currently has in flight, if any.
 *
 * `syncAll`'s database lock stops a second run from STARTING, which is what
 * protects the API's rate-limit budget — but it returns immediately rather than
 * waiting, so without this a second caller would sail past and read the
 * snapshot mid-refresh. That is not hypothetical: Next renders a layout and its
 * page in PARALLEL, so the sidebar and the members table call this at the same
 * moment on every cold load. Coalescing onto one promise makes both of them
 * read the same, finished snapshot.
 */
let inFlight: Promise<SyncAllResult | null> | null = null;

/**
 * Sync if the snapshot is stale (or `force` is set). Returns `null` when
 * nothing was attempted, so a caller can tell "fresh already" from "ran".
 *
 * Concurrent callers within this process join the run already underway instead
 * of returning early; a caller that awaits this can therefore rely on the
 * snapshot being current when it comes back.
 */
export async function ensureFreshSync(
  db: AppDatabase = getDb(),
  options: EnsureFreshSyncOptions = {},
): Promise<SyncAllResult | null> {
  // Everything before the first `await` runs in one synchronous turn, so two
  // callers cannot both observe `inFlight === null` and start two runs.
  if (inFlight !== null) return inFlight;

  const now = options.now ?? ((): Date => new Date());
  if (!options.force && !isStale(db, loadAppConfig(db), now())) return null;

  const run = (async (): Promise<SyncAllResult | null> => {
    try {
      return await syncAll(db, options.client ?? createAnthropicClient(), { now });
    } catch (error) {
      // syncAll already records per-resource failures; reaching here means
      // something more structural (a missing key, an unopenable database). Log it
      // and let the page render whatever the snapshot still holds.
      console.error("[sync] background refresh failed:", error);
      return null;
    }
  })();

  inFlight = run;
  // Cleared through the settled promise rather than a `finally` inside the run,
  // so the clear can never happen before the assignment above. The identity
  // check keeps a late clear from discarding a newer run.
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });

  return run;
}
