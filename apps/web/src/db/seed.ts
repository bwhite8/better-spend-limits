/**
 * `npm run db:seed` — load the synthetic org's people and the §G7 config
 * defaults into SQLite.
 *
 * Only EMPLOYEES come from the seed. Limits, increase requests and costs live
 * behind the Anthropic API (the mock, in dev) and reach the database through the
 * Phase-8 sync — seeding them here would defeat the point of the hybrid model.
 * `claude_user_id` is likewise left NULL for the sync to fill in.
 */

import { pathToFileURL } from "node:url";

import { sql } from "drizzle-orm";
import { DEFAULT_SEED, generateOrg } from "@bsl/seed";

import type { AppDatabase } from "./client";
import { closeDb, getDb } from "./client";
import { appConfigDefaultRows } from "./config-defaults";
import { appConfig, employees, type NewEmployee } from "./schema";

export interface SeedResult {
  employees: number;
  configKeys: number;
}

export interface SeedOptions {
  /** Which synthetic universe to load. Defaults to the canonical seed 42. */
  seed?: number;
  /** Timestamp written to `created_at`/`updated_at`. Defaults to now. */
  now?: Date;
}

/**
 * Replace the employee roster and ensure the config defaults exist.
 *
 * Employees are wiped and reinserted (the HRIS export is authoritative), while
 * config is inserted only where a key is missing, so re-seeding a demo does not
 * silently revert an administrator's changes.
 */
export function seedDatabase(db: AppDatabase, options: SeedOptions = {}): SeedResult {
  const org = generateOrg(options.seed ?? DEFAULT_SEED);
  const timestamp = (options.now ?? new Date()).toISOString();

  const rows: NewEmployee[] = org.employees.map((employee) => ({
    id: employee.id,
    name: employee.name,
    email: employee.email.toLowerCase(),
    // Left NULL on purpose: the Phase-8 sync matches actors by email and fills it.
    claude_user_id: null,
    direct_manager_id: employee.direct_manager_id,
    tier2_manager_id: employee.tier2_manager_id,
    tier3_manager_id: employee.tier3_manager_id,
    tier4_manager_id: employee.tier4_manager_id,
    aligned_ai_lead_id: employee.aligned_ai_lead_id,
    is_admin: employee.is_admin,
    created_at: timestamp,
    updated_at: timestamp,
  }));

  db.transaction((tx) => {
    // The self-references in `employees` are not insertable in any single order:
    // an employee's aligned AI lead can be an IC who sorts after them. Deferring
    // the checks to COMMIT validates the finished roster instead of each row.
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);

    tx.delete(employees).run();

    // Chunked to stay well clear of SQLite's bound-parameter ceiling.
    for (let i = 0; i < rows.length; i += 100) {
      tx.insert(employees).values(rows.slice(i, i + 100)).run();
    }

    for (const row of appConfigDefaultRows()) {
      tx.insert(appConfig).values(row).onConflictDoNothing().run();
    }
  });

  return { employees: rows.length, configKeys: appConfigDefaultRows().length };
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
    console.error("[db:seed] no `employees` table — run `npm run db:migrate` first.");
    process.exitCode = 1;
    return;
  }

  const result = seedDatabase(db);
  console.log(
    `[db:seed] ${result.employees} employees, ${result.configKeys} app_config defaults ensured.`,
  );
  closeDb();
}

// Run only when executed directly (`tsx src/db/seed.ts`), never on import.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
