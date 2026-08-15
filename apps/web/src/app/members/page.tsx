/**
 * Users — the list at `/members`, and the app's spine.
 *
 * The route keeps the API's own vocabulary (`/members`, matching the detail
 * route below it) while the copy says "users", which is what a reader of the
 * page calls the people in it. `/` is a redirect to `/analytics`.
 *
 * Scope is §G8 option B: the people you may edit, plus yourself; admins see
 * everyone. That decision is made once, in SQL, by `visibleEmployees` — this
 * page never filters a wider set down in the browser. The narrower "may I edit
 * THIS person" answer is computed here too, per row, and travels with the row:
 * being visible and being editable are different questions, and the second one
 * is not derivable from the first.
 *
 * The numbers come from the local snapshot, so the render starts by giving the
 * sync a chance to catch up. `ensureFreshSync` is a no-op inside the staleness
 * window and holds a lock across concurrent renders, and it swallows API
 * failures: a page showing slightly old numbers is right, a 500 is not.
 */

import { inArray } from "drizzle-orm";

import { getDb, type AppDatabase } from "@/db/client";
import {
  MembersTable,
  type ManagerOption,
  type ManagerOptions,
  type MemberRow,
} from "@/components/members-table";
import { employees, type Employee } from "@/db/schema";
import { currentEmployee } from "@/lib/identity";
import { loadSnapshotIndex, pendingRequestUserIds, snapshotFor } from "@/lib/members";
import { authorityIdsOf, canEdit, loadEditRoles, visibleEmployees } from "@/lib/permissions";
import { ensureFreshSync } from "@/lib/sync-runner";

import Forbidden from "../forbidden";

export const dynamic = "force-dynamic";

/** The hierarchy columns the list offers as filters, in tier order. */
const TIER_COLUMNS = ["tier2_manager_id", "tier3_manager_id", "tier4_manager_id"] as const;

/**
 * The managers the filters may offer, derived ONLY from the rows already in
 * scope.
 *
 * This is the whole point of computing it here rather than in the component or
 * from an independent `employees` query: the dropdown can never name someone
 * the viewer's scope does not already put in front of them, so `visibleEmployees`
 * stays the single source of truth about who this person may see. Narrow the
 * scope rule and the filters narrow with it, for free.
 *
 * The only wider read is a name lookup, and its id set is fully determined by
 * the scoped rows — the same targeted `inArray` the member page uses to name a
 * reporting chain.
 */
function managerOptions(db: AppDatabase, visible: Employee[]): ManagerOptions {
  const idsByColumn = new Map<string, Set<string>>(
    TIER_COLUMNS.map((column) => [column, new Set<string>()]),
  );
  for (const employee of visible) {
    for (const column of TIER_COLUMNS) {
      const id = employee[column];
      if (id !== null) idsByColumn.get(column)!.add(id);
    }
  }

  const names = new Map(visible.map((employee) => [employee.id, employee.name]));
  const missing = [...new Set([...idsByColumn.values()].flatMap((ids) => [...ids]))].filter(
    (id) => !names.has(id),
  );
  if (missing.length > 0) {
    const rows = db
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, missing))
      .all();
    for (const row of rows) names.set(row.id, row.name);
  }

  const optionsFor = (column: (typeof TIER_COLUMNS)[number]): ManagerOption[] =>
    [...idsByColumn.get(column)!]
      // An id with no name is a roster row that vanished mid-render; show the
      // id rather than dropping a filter option on the floor.
      .map((id) => ({ id, name: names.get(id) ?? id }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    tier2: optionsFor("tier2_manager_id"),
    tier3: optionsFor("tier3_manager_id"),
    tier4: optionsFor("tier4_manager_id"),
  };
}

export default async function MembersPage() {
  const db = getDb();
  const actor = await currentEmployee(db);
  if (actor === null) return <Forbidden />;

  await ensureFreshSync(db);

  const editRoles = loadEditRoles(db);
  // Resolved once for the whole render: the scope query and all 250 per-row
  // `canEdit` calls answer to the same set (§Phase 9).
  const authority = authorityIdsOf(db, actor);
  const visible = visibleEmployees(db, actor, editRoles, authority);
  const snapshots = loadSnapshotIndex(db);
  const pending = pendingRequestUserIds(db);

  const rows: MemberRow[] = visible.map((employee) => {
    const snapshot = snapshotFor(snapshots, employee);
    const userId = snapshot?.user_id ?? employee.claude_user_id;

    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      amount: snapshot?.amount ?? null,
      currency: snapshot?.currency ?? null,
      sourceType: snapshot?.source_type ?? null,
      spend: snapshot?.period_to_date_spend ?? null,
      hasPendingRequest: userId !== null && pending.has(userId),
      synced: snapshot !== null,
      // Per row, and on the server: the visible set is "everyone you can edit,
      // PLUS yourself", and `canEdit(self, self)` is false — so a non-admin's
      // own row is in the list and is not theirs to change. The list cannot
      // infer that from anything it already has.
      canEdit: canEdit(actor, employee, editRoles, authority),
      tier2ManagerId: employee.tier2_manager_id,
      tier3ManagerId: employee.tier3_manager_id,
      tier4ManagerId: employee.tier4_manager_id,
    };
  });

  const managers = managerOptions(db, visible);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-slate-500">
          {actor.is_admin
            ? "Every user in the organization."
            : "People whose spend limit you can edit, plus yourself."}
        </p>
      </header>

      <MembersTable rows={rows} managers={managers} />
    </section>
  );
}
