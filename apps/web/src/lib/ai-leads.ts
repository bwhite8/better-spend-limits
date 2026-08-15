/**
 * AI-lead delegation: who may be delegated to whom, and the write that does it
 * (§Phase 9).
 *
 * The permission engine consumes the result of this module through
 * `authorityIdsOf`; everything about *choosing* an assignment lives here, so the
 * admin form and the server action agree on one definition of "eligible" rather
 * than two.
 *
 * Two constraints are load-bearing and are enforced on the server, not in the
 * dropdown:
 *
 * - **Never an admin.** An admin's scope is the whole organization, so a lead
 *   who inherited it would be an admin in everything but name — and the audit
 *   trail would say "assigned a lead", not "granted admin".
 * - **Never yourself.** Delegating a lead to themselves would grant nothing new
 *   and would read, wrongly, as if it had.
 *
 * Eligible leaders are the people who actually hold a tier-2/3/4 slot over
 * somebody. Tier 1 is excluded for the same reason the members list excludes it
 * from its filters: with 250 people it is a ~60-entry list of managers with one
 * report each, and delegating a lead to one of them says nothing an assignment
 * to their director does not already say.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import { aiLeadAssignments, employees, type Employee } from "@/db/schema";

/** The hierarchy slots that make somebody a delegable leader, in tier order. */
const LEADER_COLUMNS = ["tier2_manager_id", "tier3_manager_id", "tier4_manager_id"] as const;

/** Enough of an employee to show in a list and pick from a dropdown. */
export interface AiLeadPerson {
  id: string;
  name: string;
  email: string;
}

/** One AI lead and the leaders currently delegated to them. */
export interface AiLeadEntry extends AiLeadPerson {
  /** Leader employee ids, name-sorted like {@link AiLeadDirectory.leaders}. */
  assignedLeaderIds: string[];
}

export interface AiLeadDirectory {
  /** Everyone the roster calls an AI lead, plus anyone already delegated to. */
  leads: AiLeadEntry[];
  /** Non-admin holders of a tier-2/3/4 slot — the assignable set. */
  leaders: AiLeadPerson[];
}

const person = (row: Employee): AiLeadPerson => ({ id: row.id, name: row.name, email: row.email });

const byName = (a: AiLeadPerson, b: AiLeadPerson): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;

/** Every stored assignment, grouped by lead. */
export function assignmentsByLead(db: AppDatabase): Map<string, string[]> {
  const rows = db.select().from(aiLeadAssignments).all();
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    grouped.set(row.lead_employee_id, [
      ...(grouped.get(row.lead_employee_id) ?? []),
      row.leader_employee_id,
    ]);
  }

  return grouped;
}

/**
 * Everything the admin section renders: the leads, and the leaders they may be
 * assigned to.
 *
 * The lead list is the union of the HRIS fact (`aligned_ai_lead_id` names you)
 * and the app's own state (something is already assigned to you). The second
 * half matters: an admin who removed somebody from the HRIS column must still be
 * able to see — and undo — a delegation that is still granting access.
 */
export function aiLeadDirectory(db: AppDatabase): AiLeadDirectory {
  const roster = db.select().from(employees).all();
  const assigned = assignmentsByLead(db);

  const leadIds = new Set<string>(assigned.keys());
  const leaderIds = new Set<string>();
  for (const row of roster) {
    if (row.aligned_ai_lead_id !== null) leadIds.add(row.aligned_ai_lead_id);
    for (const column of LEADER_COLUMNS) {
      const id = row[column];
      if (id !== null) leaderIds.add(id);
    }
  }

  const leaders = roster
    .filter((row) => leaderIds.has(row.id) && !row.is_admin)
    .map(person)
    .sort(byName);
  const leaderOrder = new Map(leaders.map((leader, index) => [leader.id, index]));

  const leads = roster
    .filter((row) => leadIds.has(row.id))
    .map((row) => ({
      ...person(row),
      assignedLeaderIds: (assigned.get(row.id) ?? [])
        .slice()
        .sort((a, b) => (leaderOrder.get(a) ?? Infinity) - (leaderOrder.get(b) ?? Infinity)),
    }))
    .sort(byName);

  return { leads, leaders };
}

export interface AssignmentChange {
  added: string[];
  removed: string[];
}

/**
 * Replace one lead's assignments with `leaderIds`, and report what moved.
 *
 * A whole-set replace rather than add/remove calls: the form shows the complete
 * list and the admin edits it as a whole, so anything else would need the two
 * sides to agree on a diff they cannot both see.
 *
 * Validation is the caller's job for identity (`is_admin`) and this function's
 * job for existence, which it gets from the foreign keys — but it checks first
 * anyway, because "FOREIGN KEY constraint failed" is not a sentence to show an
 * administrator.
 */
export function setAiLeadAssignments(
  db: AppDatabase,
  leadId: string,
  leaderIds: readonly string[],
  options: { now?: Date } = {},
): AssignmentChange {
  const next = [...new Set(leaderIds)];
  const timestamp = (options.now ?? new Date()).toISOString();

  const current = db
    .select()
    .from(aiLeadAssignments)
    .where(eq(aiLeadAssignments.lead_employee_id, leadId))
    .all()
    .map((row) => row.leader_employee_id);

  const added = next.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !next.includes(id));

  db.transaction((tx) => {
    tx.delete(aiLeadAssignments).where(eq(aiLeadAssignments.lead_employee_id, leadId)).run();
    if (next.length > 0) {
      tx.insert(aiLeadAssignments)
        .values(
          next.map((leaderId) => ({
            lead_employee_id: leadId,
            leader_employee_id: leaderId,
            created_at: timestamp,
          })),
        )
        .run();
    }
  });

  return { added, removed };
}

/**
 * The two statements {@link pruneOrphanedAssignments} needs, and nothing more —
 * so it can be handed a `db` or the `tx` of a transaction already in progress,
 * which is how the roster import uses it.
 */
export type AssignmentStore = Pick<AppDatabase, "select" | "delete">;

/** Rows whose lead or leader is no longer on the roster. */
const ORPHANED = sql`${aiLeadAssignments.lead_employee_id} NOT IN (SELECT ${employees.id} FROM ${employees})
  OR ${aiLeadAssignments.leader_employee_id} NOT IN (SELECT ${employees.id} FROM ${employees})`;

/**
 * Drop assignments that reference somebody the roster no longer has, and say how
 * many went (§Phase 9).
 *
 * The roster import deletes every employee row and reinserts the new file inside
 * one transaction with `PRAGMA defer_foreign_keys = ON`. Neither of the two
 * obvious schema answers is acceptable there: `ON DELETE CASCADE` would wipe
 * every delegation on every import, silently, and no cascade at all would fail
 * the deferred check at COMMIT and surface as "the roster could not be
 * replaced". So the import calls this instead, inside the same transaction and
 * after the insert, and reports the number to the admin who pressed the button.
 *
 * Written as a correlated subquery rather than a `NOT IN (…250 ids…)` so it
 * costs the same for a five-person roster and a five-thousand-person one.
 */
export function pruneOrphanedAssignments(db: AssignmentStore): number {
  const orphaned = db.select().from(aiLeadAssignments).where(ORPHANED).all().length;
  if (orphaned > 0) db.delete(aiLeadAssignments).where(ORPHANED).run();
  return orphaned;
}

export interface AssignmentRejection {
  ok: false;
  message: string;
}

export type AssignmentValidation = { ok: true; leadId: string; leaderIds: string[] } | AssignmentRejection;

/**
 * Check an assignment the way the server must: without trusting that the form
 * offered only the options it was supposed to.
 */
export function validateAssignment(
  db: AppDatabase,
  leadId: unknown,
  leaderIds: unknown,
): AssignmentValidation {
  if (typeof leadId !== "string" || leadId === "") {
    return { ok: false, message: "Choose an AI lead to assign." };
  }
  if (!Array.isArray(leaderIds) || leaderIds.some((id) => typeof id !== "string")) {
    return { ok: false, message: "The list of leaders was not readable." };
  }

  const wanted = [...new Set(leaderIds as string[])];
  const lead = db.select().from(employees).where(eq(employees.id, leadId)).get();
  if (!lead) return { ok: false, message: `No employee with id ${JSON.stringify(leadId)}.` };

  if (wanted.length === 0) return { ok: true, leadId, leaderIds: [] };

  if (wanted.includes(leadId)) {
    return {
      ok: false,
      message: `${lead.name} cannot be delegated to themselves — an assignment grants somebody ELSE's scope.`,
    };
  }

  const rows = db.select().from(employees).where(inArray(employees.id, wanted)).orderBy(asc(employees.id)).all();
  const found = new Map(rows.map((row) => [row.id, row]));

  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return { ok: false, message: `No employee with id ${missing.map((id) => JSON.stringify(id)).join(", ")}.` };
  }

  const admins = rows.filter((row) => row.is_admin);
  if (admins.length > 0) {
    return {
      ok: false,
      message: `${admins.map((row) => row.name).join(", ")} ${admins.length === 1 ? "is an administrator" : "are administrators"}, and an administrator's scope is the whole organization — delegating it would grant admin rights by another name. Pick a tier-2, tier-3 or tier-4 leader who is not an admin.`,
    };
  }

  const eligible = new Set(aiLeadDirectory(db).leaders.map((leader) => leader.id));
  const ineligible = rows.filter((row) => !eligible.has(row.id));
  if (ineligible.length > 0) {
    return {
      ok: false,
      message: `${ineligible.map((row) => row.name).join(", ")} ${ineligible.length === 1 ? "holds" : "hold"} no tier-2, tier-3 or tier-4 leadership slot, so there would be nothing to delegate.`,
    };
  }

  return { ok: true, leadId, leaderIds: wanted };
}
