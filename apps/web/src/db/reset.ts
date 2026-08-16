/**
 * `npm run db:reset` — restore the public demo to its pristine state.
 *
 * The demo has no authentication (§G6 `AUTH_MODE=dev`), so any visitor can edit
 * config, replace the roster, delegate authority, and append to the audit log —
 * all of which persist on the Railway volume and survive a redeploy. This undoes
 * every persistent change a visitor can make, on a schedule (the `demo-reset`
 * Railway cron calls `POST /api/admin/reset`, which runs this) so a defaced or
 * cluttered demo heals on its own within the hour.
 *
 * What it restores:
 *
 * - **Roster** — reseeded to the canonical 250-person org (undoes any import).
 * - **Config** — every key forced back to its default (undoes a tampered
 *   `edit_roles` or a `sync_stale_after_minutes=1` amplification). `seedDatabase`
 *   only fills missing keys; a reset must overwrite.
 * - **Delegations** — cleared (undoes any AI-lead grant).
 * - **Audit log** — cleared.
 * - **Synced cache** — snapshots and `sync_state` dropped, so the next page view
 *   re-reads the API from a clean slate.
 *
 * It does NOT touch the mock API's in-memory limit state; that is separate
 * synthetic data, bounded by design, and resets when the mock service redeploys.
 */

import { pathToFileURL } from "node:url";

import { appConfigDefaultRows } from "./config-defaults";
import { closeDb, getDb, type AppDatabase } from "./client";
import {
  aiLeadAssignments,
  appConfig,
  auditLog,
  increaseRequestSnapshot,
  spendLimitSnapshot,
  syncState,
  userDailyCost,
} from "./schema";
import { seedDatabase, type SeedOptions } from "./seed";

export interface ResetResult {
  employees: number;
  configKeys: number;
  auditCleared: number;
  delegationsCleared: number;
}

/**
 * Reset the app's own tables to their seeded defaults and drop the synced cache.
 *
 * `seedDatabase` runs first (its own transaction) to restore the roster and
 * guarantee every config key exists; a second transaction then overwrites config
 * to defaults and clears the tables a visitor can grow. The two run back to back,
 * not nested — better-sqlite3 has no nested transactions.
 */
export function resetDatabase(db: AppDatabase, options: SeedOptions = {}): ResetResult {
  const seeded = seedDatabase(db, options);

  const cleared = db.transaction((tx) => {
    for (const row of appConfigDefaultRows()) {
      tx.insert(appConfig)
        .values(row)
        .onConflictDoUpdate({ target: appConfig.key, set: { value: row.value } })
        .run();
    }

    const delegationsCleared = tx.delete(aiLeadAssignments).run().changes;
    const auditCleared = tx.delete(auditLog).run().changes;

    // The synced cache is a mirror of the API (§G1); dropping it forces the next
    // render to re-read a clean copy rather than trust whatever was last stored.
    tx.delete(spendLimitSnapshot).run();
    tx.delete(increaseRequestSnapshot).run();
    tx.delete(userDailyCost).run();
    tx.delete(syncState).run();

    return { delegationsCleared, auditCleared };
  });

  return {
    employees: seeded.employees,
    configKeys: seeded.configKeys,
    auditCleared: cleared.auditCleared,
    delegationsCleared: cleared.delegationsCleared,
  };
}

/** True when the migrations have been applied. */
function schemaExists(db: AppDatabase): boolean {
  const found = db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'employees'")
    .get();
  return found !== undefined;
}

function main(): void {
  const db = getDb();

  if (!schemaExists(db)) {
    console.error("[db:reset] no `employees` table — run `npm run db:migrate` first.");
    process.exitCode = 1;
    return;
  }

  const result = resetDatabase(db);
  console.log(
    `[db:reset] roster=${result.employees} config=${result.configKeys} ` +
      `audit_cleared=${result.auditCleared} delegations_cleared=${result.delegationsCleared}`,
  );
  closeDb();
}

// Run only when executed directly (`tsx src/db/reset.ts`), never on import.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
