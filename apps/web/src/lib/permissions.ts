/**
 * The §G8 permission engine.
 *
 *   canEdit(actor, target) := actor.is_admin
 *                          OR actor.id === target.<role>_id for some configured role
 *   canView(actor, target) := canEdit(actor, target) OR actor.id === target.id
 *
 * The configured roles come from `app_config.edit_roles` and default to
 * `["tier3_manager", "tier4_manager", "aligned_ai_lead"]`. A role name maps onto
 * an `employees` column by appending `_id` — `"tier3_manager"` is
 * `employees.tier3_manager_id` — which is exactly why the schema keeps
 * snake_case property names (see `db/schema.ts`).
 *
 * Null columns are skipped, never matched: the CEO has an entirely null tier
 * chain, and a hierarchy role that does not exist must not grant access to
 * anybody.
 *
 * Everything here is deliberately pure except `loadEditRoles` and
 * `visibleEmployees`, which need the database. Actor and target are structural
 * types, so `@bsl/seed`'s `SyntheticEmployee` fixtures can be passed straight in
 * alongside real `employees` rows.
 */

import { eq, or } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import type { EditRole } from "@/db/config-defaults";
import { employees, type Employee } from "@/db/schema";

import { loadAppConfig } from "./config";

/** `"tier3_manager"` → `"tier3_manager_id"`; every one of these is an `employees` column. */
export type EditRoleColumn = `${EditRole}_id`;

/** The minimum an actor must supply: who they are, and whether they are an admin. */
export type PermissionActor = Pick<Employee, "id" | "is_admin">;

/** The minimum a target must supply: its id and the five hierarchy columns. */
export type PermissionTarget = Pick<Employee, "id" | EditRoleColumn>;

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
 * May `actor` change `target`'s spend limit (and act on their increase
 * requests)? Admins always may; otherwise the actor must occupy one of the
 * configured hierarchy roles for that specific person.
 */
export function canEdit(
  actor: PermissionActor,
  target: PermissionTarget,
  editRoles: EditRole[],
): boolean {
  if (actor.is_admin) return true;

  return editRoles.some((role) => {
    const holder = target[editRoleColumn(role)];
    // §G8: a null tier column is skipped, not treated as a match.
    return holder !== null && holder === actor.id;
  });
}

/**
 * View scope is §G8 option B: everyone you can edit, plus yourself. Admins see
 * the whole organisation by virtue of `canEdit`.
 */
export function canView(
  actor: PermissionActor,
  target: PermissionTarget,
  editRoles: EditRole[],
): boolean {
  return actor.id === target.id || canEdit(actor, target, editRoles);
}

/**
 * The people `actor` may view, name-sorted — `canView` pushed into SQL so the
 * members list never loads 250 rows to filter 3.
 *
 * Kept in step with `canView` by construction: self, plus one equality per
 * configured role column.
 */
export function visibleEmployees(
  db: AppDatabase,
  actor: PermissionActor,
  editRoles: EditRole[] = loadEditRoles(db),
): Employee[] {
  if (actor.is_admin) {
    return db.select().from(employees).orderBy(employees.name, employees.id).all();
  }

  const conditions = [
    eq(employees.id, actor.id),
    ...editRoles.map((role) => eq(employees[editRoleColumn(role)], actor.id)),
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
): boolean {
  return requester === null ? actor.is_admin : canEdit(actor, requester, editRoles);
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
