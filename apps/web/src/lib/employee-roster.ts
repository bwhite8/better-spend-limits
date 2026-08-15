/**
 * Replacing the employee roster (plan §Phase 13).
 *
 * The server-only half of the CSV import: `lib/import-employees.ts` decides
 * whether a file is admissible, this decides what the database looks like
 * afterwards. They are separate modules so the parser stays importable from the
 * browser (see that file's header).
 *
 * The replace is a full one, in a single transaction, because an HRIS export is
 * the whole truth about who works here — merging row by row would leave leavers
 * behind and quietly preserve permissions that the export says are gone.
 *
 * Two things survive the replace for an email that appears in both rosters:
 *
 * - **`claude_user_id`**, because it is the Phase-8 sync's hard-won match
 *   between an employee and an Anthropic actor. Dropping it would leave every
 *   returning member relying on the email fallback until the next sync.
 * - **`created_at`**, because "on the roster since" is a fact about the person,
 *   not about when somebody last uploaded a file.
 */

import { sql } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import { employees, type NewEmployee } from "@/db/schema";
import { pruneOrphanedAssignments } from "@/lib/ai-leads";
import type { EmployeeCsvRow } from "@/lib/import-employees";

/** SQLite's bound-parameter ceiling is well clear of this; §G7 has 11 columns. */
const INSERT_CHUNK = 100;

export interface ImportSummary {
  /** Rows written. */
  imported: number;
  /** Rows the previous roster had. */
  replaced: number;
  /** How many kept an already-matched `claude_user_id`. */
  preserved: number;
  /** How many of the new rows can administer the app. */
  admins: number;
  /** AI-lead delegations dropped because their lead or leader has left (§Phase 9). */
  delegationsRemoved: number;
}

/**
 * Replace `employees` with `rows`, transactionally.
 *
 * Callers must have checked that the parse produced no errors; this function
 * validates nothing beyond refusing an empty roster, which would lock every
 * user — including whoever is uploading — out of an app whose entire identity
 * model is "look the email up in `employees`" (§G8).
 */
export function applyEmployeeImport(
  db: AppDatabase,
  rows: EmployeeCsvRow[],
  options: { now?: Date } = {},
): ImportSummary {
  if (rows.length === 0) {
    throw new Error("applyEmployeeImport: refusing to replace the roster with an empty one");
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const previous = db.select().from(employees).all();
  const priorByEmail = new Map(previous.map((row) => [row.email.toLowerCase(), row]));

  const values: NewEmployee[] = rows.map((row) => {
    const prior = priorByEmail.get(row.email);

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      claude_user_id: prior?.claude_user_id ?? null,
      direct_manager_id: row.direct_manager_id,
      tier2_manager_id: row.tier2_manager_id,
      tier3_manager_id: row.tier3_manager_id,
      tier4_manager_id: row.tier4_manager_id,
      aligned_ai_lead_id: row.aligned_ai_lead_id,
      is_admin: row.is_admin,
      created_at: prior?.created_at ?? timestamp,
      updated_at: timestamp,
    };
  });

  let delegationsRemoved = 0;

  db.transaction((tx) => {
    // §G7's self-references are not insertable in any single order — an aligned
    // AI lead may be an IC further down the file. Deferring the checks to COMMIT
    // validates the finished roster instead of each row, exactly as `db:seed`
    // does for the same reason.
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);

    tx.delete(employees).run();

    for (let i = 0; i < values.length; i += INSERT_CHUNK) {
      tx.insert(employees).values(values.slice(i, i + INSERT_CHUNK)).run();
    }

    // AFTER the insert, and inside the same transaction. `ai_lead_assignments`
    // points at `employees`, so the deferred check runs at COMMIT: a delegation
    // naming somebody the new roster does not have would abort the whole import
    // with an opaque foreign-key error. Dropping those rows here is the honest
    // reading of the file anyway — a lead or leader who has left the company
    // does not keep their delegated access — and the count is reported back so
    // it is a fact the admin is told, not one they discover.
    delegationsRemoved = pruneOrphanedAssignments(tx);
  });

  return {
    imported: values.length,
    replaced: previous.length,
    preserved: values.filter((row) => row.claude_user_id !== null).length,
    admins: values.filter((row) => row.is_admin === true).length,
    delegationsRemoved,
  };
}
