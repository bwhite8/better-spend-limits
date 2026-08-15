/**
 * The §G8 permission engine.
 *
 *   canEdit(actor, target) := actor.is_admin
 *                          OR target.<role>_id ∈ authority(actor), for some configured role
 *   canView(actor, target) := canEdit(actor, target) OR actor.id === target.id
 *
 * The configured roles come from `app_config.edit_roles` and default to
 * `["tier3_manager", "tier4_manager"]`. A role name maps onto an `employees`
 * column by appending `_id` — `"tier3_manager"` is `employees.tier3_manager_id`
 * — which is exactly why the schema keeps snake_case property names (see
 * `db/schema.ts`).
 *
 * Null columns are skipped, never matched: the CEO has an entirely null tier
 * chain, and a hierarchy role that does not exist must not grant access to
 * anybody.
 *
 * **The authority set** (§Phase 9) is the one thing here that is not simply the
 * actor's own id. An AI lead delegated to a leader inherits that leader's
 * hierarchy scope, so the rule is resolved ONCE into
 * `[actor.id, ...assignedLeaderIds]` and the column comparison becomes a set
 * membership test. Deliberately *not* a two-hop `canEdit`: `canActOnRequest` is
 * called inside a per-request loop (`lib/requests.ts`), and a rule that went
 * back to the database per comparison would issue one query per pending request.
 *
 * Three things stay bound to the actor alone, and widening any of them would
 * undo the point of the phase:
 *
 * - the self clause of `canView` and of `visibleEmployees` — a lead must not see
 *   the leaders they are assigned to, only those leaders' people;
 * - the `is_admin` leg of `canEdit` — delegation never confers admin rights;
 * - the actor's own row — nobody edits their own limit, however they got there.
 *
 * Everything is deliberately pure except `loadEditRoles`, `authorityIdsOf`,
 * `visibleEmployees` and `delegatedEditorsOf`, which need the database. Actor
 * and target are structural types, so `@bsl/seed`'s `SyntheticEmployee` fixtures
 * can be passed straight in alongside real `employees` rows.
 */

import { eq, inArray, or } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import type { EditRole } from "@/db/config-defaults";
import { aiLeadAssignments, employees, type Employee } from "@/db/schema";

import { loadAppConfig } from "./config";

/** `"tier3_manager"` → `"tier3_manager_id"`; every one of these is an `employees` column. */
export type EditRoleColumn = `${EditRole}_id`;

/** The minimum an actor must supply: who they are, and whether they are an admin. */
export type PermissionActor = Pick<Employee, "id" | "is_admin">;

/** The minimum a target must supply: its id and the five hierarchy columns. */
export type PermissionTarget = Pick<Employee, "id" | EditRoleColumn>;

/**
 * Whose hierarchy roles an actor may exercise: themselves, plus every leader
 * delegated to them. See {@link authorityIdsOf}.
 */
export type AuthoritySet = readonly string[];

/** The `employees` column a configured role refers to. */
export function editRoleColumn(role: EditRole): EditRoleColumn {
  return `${role}_id`;
}

/**
 * The configured edit roles, validated against the allowed set and falling back
 * to the §G7 default when the stored value is missing or corrupt.
 */
export function loadEditRoles(db: AppDatabase): EditRole[] {
  return loadAppConfig(db).edit_roles;
}

/**
 * `[actor.id, ...leaders delegated to them]` — resolve once per request or
 * render and thread it down (§Phase 9).
 *
 * Exactly one hop, by construction rather than by a guard: this reads the
 * assignment table for THIS actor and stops. A leader who is themselves an
 * assigned lead never contributes their own delegations, so authority cannot
 * chain across the organization.
 */
export function authorityIdsOf(db: AppDatabase, actor: PermissionActor): string[] {
  const rows = db
    .select({ leader: aiLeadAssignments.leader_employee_id })
    .from(aiLeadAssignments)
    .where(eq(aiLeadAssignments.lead_employee_id, actor.id))
    .all();

  return [...new Set([actor.id, ...rows.map((row) => row.leader)])];
}

/**
 * May `actor` change `target`'s spend limit (and act on their increase
 * requests)? Admins always may; otherwise somebody in the actor's authority set
 * must occupy one of the configured hierarchy roles for that specific person.
 *
 * `authority` defaults to the actor alone, which is the pre-delegation rule and
 * the strictly narrower answer — a caller that forgets to resolve it under-grants
 * rather than over-grants. The database-backed callers pass the real set.
 */
export function canEdit(
  actor: PermissionActor,
  target: PermissionTarget,
  editRoles: EditRole[],
  authority: AuthoritySet = [actor.id],
): boolean {
  if (actor.is_admin) return true;

  // §G8: nobody edits their own limit. It used to be true by accident — nobody
  // is their own manager — and delegation would have broken it, because a lead
  // assigned to their OWN tier-3 manager is the most natural assignment there
  // is, and it would have handed them their own budget. Stated outright now.
  if (actor.id === target.id) return false;

  return editRoles.some((role) => {
    const holder = target[editRoleColumn(role)];
    // §G8: a null tier column is skipped, not treated as a match.
    return holder !== null && authority.includes(holder);
  });
}

/**
 * View scope is §G8 option B: everyone you can edit, plus yourself. Admins see
 * the whole organization by virtue of `canEdit`.
 *
 * The self leg is `actor.id`, never the authority set: a delegated lead sees the
 * leader's people, not the leader.
 */
export function canView(
  actor: PermissionActor,
  target: PermissionTarget,
  editRoles: EditRole[],
  authority: AuthoritySet = [actor.id],
): boolean {
  return actor.id === target.id || canEdit(actor, target, editRoles, authority);
}

/**
 * The people `actor` may view, name-sorted — `canView` pushed into SQL so the
 * members list never loads 250 rows to filter 3.
 *
 * Kept in step with `canView` by construction: self (`eq`, the actor alone),
 * plus one set membership per configured role column (`inArray`, the authority
 * set). `authority` resolves itself from the database when the caller has not
 * already done so — a page that also needs it per row should resolve it once and
 * pass it in rather than paying for the query twice.
 */
export function visibleEmployees(
  db: AppDatabase,
  actor: PermissionActor,
  editRoles: EditRole[] = loadEditRoles(db),
  authority: AuthoritySet = authorityIdsOf(db, actor),
): Employee[] {
  if (actor.is_admin) {
    return db.select().from(employees).orderBy(employees.name, employees.id).all();
  }

  const conditions = [
    // Deliberately NOT the authority set: yourself means yourself.
    eq(employees.id, actor.id),
    ...editRoles.map((role) => inArray(employees[editRoleColumn(role)], [...authority])),
  ];

  return db
    .select()
    .from(employees)
    .where(or(...conditions))
    .orderBy(employees.name, employees.id)
    .all();
}

/**
 * Whether `actor` may see and resolve an increase request, given the employee
 * record of whoever raised it.
 *
 * A `null` requester means the API actor matched no row in `employees` (they
 * left the company, or the roster is stale). Those requests are admin-only:
 * nobody else has a hierarchy relationship to reason about (§G8).
 */
export function canActOnRequest(
  actor: PermissionActor,
  requester: PermissionTarget | null,
  editRoles: EditRole[],
  authority: AuthoritySet = [actor.id],
): boolean {
  return requester === null ? actor.is_admin : canEdit(actor, requester, editRoles, authority);
}

/**
 * The employee ids that hold an editing role over `target`, in `editRoles`
 * order. Admins are NOT included — they can edit everybody, so listing them
 * here would say nothing about this particular person.
 *
 * Exists so the member page's "Edit access" line does not have to re-derive the
 * role→column mapping.
 */
export function editorIdsOf(target: PermissionTarget, editRoles: EditRole[]): string[] {
  const ids = editRoles
    .map((role) => target[editRoleColumn(role)])
    .filter((id): id is string => id !== null);

  return [...new Set(ids)];
}

/** An AI lead who may edit a target only because a leader was delegated to them. */
export interface DelegatedEditor {
  /** The lead's employee id. */
  id: string;
  /** The leaders whose role over the target the lead is exercising, in `editorIdsOf` order. */
  viaLeaderIds: string[];
}

/**
 * The delegated leads who may edit `target` (§Phase 9).
 *
 * `editorIdsOf` is pure over the TARGET's columns, which is all the member
 * page's "Edit access" card ever needed — until a lead's authority started
 * living in a join table keyed on the LEADER. Without this, a lead who genuinely
 * can edit somebody could never appear in the list of who to ask, and no
 * assertion in the suite would have noticed: the existing test only checks the
 * direction that still holds ("everyone named can indeed edit"). The reverse
 * direction is asserted in `permissions.test.ts` alongside this.
 *
 * The target themselves is excluded even when they are a lead assigned to their
 * own manager — `canEdit` refuses self-edits, so listing them would be a lie.
 */
export function delegatedEditorsOf(
  db: AppDatabase,
  target: PermissionTarget,
  editRoles: EditRole[],
): DelegatedEditor[] {
  const leaderIds = editorIdsOf(target, editRoles);
  if (leaderIds.length === 0) return [];

  const rows = db
    .select()
    .from(aiLeadAssignments)
    .where(inArray(aiLeadAssignments.leader_employee_id, leaderIds))
    .all();

  const byLead = new Map<string, string[]>();
  // `leaderIds` order, so the card reads in the same order as the roles above it.
  for (const leaderId of leaderIds) {
    for (const row of rows.filter((entry) => entry.leader_employee_id === leaderId)) {
      if (row.lead_employee_id === target.id) continue;
      byLead.set(row.lead_employee_id, [...(byLead.get(row.lead_employee_id) ?? []), leaderId]);
    }
  }

  return [...byLead.entries()].map(([id, viaLeaderIds]) => ({ id, viaLeaderIds }));
}
