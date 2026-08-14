/**
 * §G8 permission matrix, driven off the seed-42 fixtures.
 *
 * Actors and targets are read back out of SQLite rather than taken straight from
 * `FIXTURE`, so these tests exercise the same rows the app will: a seeding bug
 * that dropped a tier column would show up here as a permission failure.
 */

import { FIXTURE } from "@bsl/seed";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { APP_CONFIG_DEFAULTS, type EditRole } from "@/db/config-defaults";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { appConfig, employees, type Employee } from "@/db/schema";
import { seedDatabase } from "@/db/seed";

import { loadAppConfig } from "./config";
import {
  canActOnRequest,
  canEdit,
  canView,
  editRoleColumn,
  editorIdsOf,
  loadEditRoles,
  visibleEmployees,
} from "./permissions";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.$client.close();
});

/** The stored row for a fixture — what the app actually reasons about. */
function row(id: string): Employee {
  const found = db.select().from(employees).where(eq(employees.id, id)).get();
  if (!found) throw new Error(`no employee row for ${id}`);
  return found;
}

function setEditRoles(value: unknown): void {
  db.insert(appConfig)
    .values({ key: "edit_roles", value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: JSON.stringify(value) } })
    .run();
}

const DEFAULT_ROLES = APP_CONFIG_DEFAULTS.edit_roles;

describe("editRoleColumn", () => {
  it("maps every allowed role onto a real `employees` column", () => {
    for (const role of DEFAULT_ROLES) {
      expect(employees).toHaveProperty(editRoleColumn(role));
    }
    expect(editRoleColumn("aligned_ai_lead")).toBe("aligned_ai_lead_id");
    expect(editRoleColumn("tier3_manager")).toBe("tier3_manager_id");
  });
});

describe("loadEditRoles", () => {
  it("returns the seeded §G7 default", () => {
    expect(loadEditRoles(db)).toEqual(["tier3_manager", "tier4_manager", "aligned_ai_lead"]);
  });

  it("reflects a configured value", () => {
    setEditRoles(["direct_manager", "tier2_manager"]);
    expect(loadEditRoles(db)).toEqual(["direct_manager", "tier2_manager"]);
  });

  it("treats an empty array as valid — only admins may edit", () => {
    setEditRoles([]);
    expect(loadEditRoles(db)).toEqual([]);
    expect(canEdit(row(FIXTURE.tier3ManagerOfIc.id), row(FIXTURE.ic.id), loadEditRoles(db))).toBe(
      false,
    );
    expect(canEdit(row(FIXTURE.admin.id), row(FIXTURE.ic.id), loadEditRoles(db))).toBe(true);
  });

  it.each([
    ["unparseable JSON", "not json at all"],
    ["a non-array", JSON.stringify({ tier3_manager: true })],
    ["an unknown role name", JSON.stringify(["tier3_manager", "skip_level_manager"])],
    ["a non-string entry", JSON.stringify([3])],
  ])("falls back to the default on %s", (_label, stored) => {
    db.insert(appConfig)
      .values({ key: "edit_roles", value: stored })
      .onConflictDoUpdate({ target: appConfig.key, set: { value: stored } })
      .run();

    expect(loadEditRoles(db)).toEqual(DEFAULT_ROLES);
  });

  it("falls back to the default when the key is missing entirely", () => {
    db.delete(appConfig).where(eq(appConfig.key, "edit_roles")).run();
    expect(loadEditRoles(db)).toEqual(DEFAULT_ROLES);
  });

  it("deduplicates repeated roles", () => {
    setEditRoles(["tier3_manager", "tier3_manager"]);
    expect(loadEditRoles(db)).toEqual(["tier3_manager"]);
  });

  it("leaves the other config keys on their defaults", () => {
    expect(loadAppConfig(db)).toEqual(APP_CONFIG_DEFAULTS);
  });
});

describe("canEdit — default config, target = FIXTURE.ic", () => {
  it.each<[string, string, boolean]>([
    ["tier3ManagerOfIc", FIXTURE.tier3ManagerOfIc.id, true],
    ["tier4ManagerOfIc", FIXTURE.tier4ManagerOfIc.id, true],
    ["aiLeadOfIc", FIXTURE.aiLeadOfIc.id, true],
    ["directManagerOfIc", FIXTURE.directManagerOfIc.id, false],
    ["unrelatedPeer", FIXTURE.unrelatedPeer.id, false],
    ["admin", FIXTURE.admin.id, true],
    ["ic (self)", FIXTURE.ic.id, false],
  ])("%s → %s", (_label, actorId, expected) => {
    expect(canEdit(row(actorId), row(FIXTURE.ic.id), DEFAULT_ROLES)).toBe(expected);
  });

  it("grants the three editing roles to people who are not admins", () => {
    for (const id of [FIXTURE.tier3ManagerOfIc.id, FIXTURE.tier4ManagerOfIc.id, FIXTURE.aiLeadOfIc.id]) {
      expect(row(id).is_admin).toBe(false);
    }
  });
});

describe("canView — §G8 option B", () => {
  it("lets an IC view themselves but not edit themselves", () => {
    const ic = row(FIXTURE.ic.id);
    expect(canView(ic, ic, DEFAULT_ROLES)).toBe(true);
    expect(canEdit(ic, ic, DEFAULT_ROLES)).toBe(false);
  });

  it("hides an out-of-scope member from an unrelated peer", () => {
    expect(canView(row(FIXTURE.unrelatedPeer.id), row(FIXTURE.ic.id), DEFAULT_ROLES)).toBe(false);
  });

  it("follows canEdit for managers and admins", () => {
    expect(canView(row(FIXTURE.tier3ManagerOfIc.id), row(FIXTURE.ic.id), DEFAULT_ROLES)).toBe(true);
    expect(canView(row(FIXTURE.admin.id), row(FIXTURE.ic.id), DEFAULT_ROLES)).toBe(true);
  });
});

describe("config-driven roles", () => {
  it("swaps who may edit when edit_roles changes to [direct_manager]", () => {
    setEditRoles(["direct_manager"]);
    const roles = loadEditRoles(db);

    expect(canEdit(row(FIXTURE.directManagerOfIc.id), row(FIXTURE.ic.id), roles)).toBe(true);
    expect(canEdit(row(FIXTURE.tier3ManagerOfIc.id), row(FIXTURE.ic.id), roles)).toBe(false);
    expect(canEdit(row(FIXTURE.aiLeadOfIc.id), row(FIXTURE.ic.id), roles)).toBe(false);
  });

  it("still lets admins edit under any configuration", () => {
    setEditRoles(["direct_manager"]);
    expect(canEdit(row(FIXTURE.admin.id), row(FIXTURE.ic.id), loadEditRoles(db))).toBe(true);
  });
});

describe("null hierarchy columns are skipped, not matched", () => {
  it("handles the CEO, whose entire tier chain is null", () => {
    const ceo = row(FIXTURE.ceo.id);
    expect([ceo.direct_manager_id, ceo.tier2_manager_id, ceo.tier3_manager_id, ceo.tier4_manager_id]).toEqual(
      [null, null, null, null],
    );

    // Every configured role column is null, so only admin rights can apply.
    expect(canEdit(row(FIXTURE.tier3ManagerOfIc.id), ceo, DEFAULT_ROLES)).toBe(false);
    expect(canEdit(row(FIXTURE.unrelatedPeer.id), ceo, DEFAULT_ROLES)).toBe(false);
    expect(canEdit(row(FIXTURE.admin.id), ceo, DEFAULT_ROLES)).toBe(true);
    expect(canView(ceo, ceo, DEFAULT_ROLES)).toBe(true);
  });

  it("grants edit through the roles that DO survive on a partial chain", () => {
    // A VP has a direct manager (the CEO) but no tier2/3/4 above them.
    const vp = row(FIXTURE.tier4ManagerOfIc.id);
    expect(vp.tier2_manager_id).toBeNull();
    expect(vp.tier4_manager_id).toBeNull();

    // Nobody holds the null tier-4 slot, so that role grants nothing here...
    const nonAdmins = db
      .select()
      .from(employees)
      .all()
      .filter((employee) => !employee.is_admin);
    expect(nonAdmins.some((actor) => canEdit(actor, vp, ["tier4_manager"]))).toBe(false);

    // ...while the AI-lead alignment, which does exist, still does.
    const roles: EditRole[] = ["tier4_manager", "aligned_ai_lead"];
    const aiLead = row(vp.aligned_ai_lead_id!);
    expect(aiLead.is_admin).toBe(false);
    expect(canEdit(aiLead, vp, roles)).toBe(true);
  });

  it("never lets a null column match a null-ish actor id", () => {
    const target = { ...row(FIXTURE.ceo.id), aligned_ai_lead_id: null };
    const ghost = { id: null as unknown as string, is_admin: false };
    expect(canEdit(ghost, target, DEFAULT_ROLES)).toBe(false);
  });
});

describe("visibleEmployees", () => {
  it("gives an admin the whole organisation", () => {
    const [total] = db.select({ value: count() }).from(employees).all();
    expect(total?.value).toBe(250);
    expect(visibleEmployees(db, row(FIXTURE.admin.id)).length).toBe(250);
  });

  it("gives an unrelated IC exactly themselves", () => {
    const visible = visibleEmployees(db, row(FIXTURE.unrelatedPeer.id));
    expect(visible.map((employee) => employee.id)).toEqual([FIXTURE.unrelatedPeer.id]);
  });

  it("gives a tier-3 manager their scope, and nobody outside it", () => {
    const ids = visibleEmployees(db, row(FIXTURE.tier3ManagerOfIc.id)).map((e) => e.id);

    expect(ids).toContain(FIXTURE.ic.id);
    expect(ids).toContain(FIXTURE.tier3ManagerOfIc.id);
    expect(ids).not.toContain(FIXTURE.outsideTier3Scope.id);
    expect(ids).not.toContain(FIXTURE.unrelatedPeer.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.length).toBeLessThan(250);
  });

  it("agrees exactly with canView over the whole roster", () => {
    const roles = loadEditRoles(db);
    const all = db.select().from(employees).all();

    for (const actorId of [
      FIXTURE.admin.id,
      FIXTURE.tier3ManagerOfIc.id,
      FIXTURE.aiLeadOfIc.id,
      FIXTURE.unrelatedPeer.id,
      FIXTURE.ceo.id,
    ]) {
      const actor = row(actorId);
      const expected = all.filter((target) => canView(actor, target, roles)).map((e) => e.id).sort();
      const actual = visibleEmployees(db, actor, roles).map((e) => e.id).sort();
      expect(actual, `visible set for ${actorId}`).toEqual(expected);
    }
  });

  it("honours an explicit edit_roles argument", () => {
    const direct = visibleEmployees(db, row(FIXTURE.directManagerOfIc.id), ["direct_manager"]);
    expect(direct.map((e) => e.id)).toContain(FIXTURE.ic.id);

    const none = visibleEmployees(db, row(FIXTURE.directManagerOfIc.id), []);
    expect(none.map((e) => e.id)).toEqual([FIXTURE.directManagerOfIc.id]);
  });

  it("sorts by name", () => {
    const names = visibleEmployees(db, row(FIXTURE.admin.id)).map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("canActOnRequest", () => {
  it("follows canEdit on the requester", () => {
    const ic = row(FIXTURE.ic.id);
    expect(canActOnRequest(row(FIXTURE.tier3ManagerOfIc.id), ic, DEFAULT_ROLES)).toBe(true);
    expect(canActOnRequest(row(FIXTURE.unrelatedPeer.id), ic, DEFAULT_ROLES)).toBe(false);
    expect(canActOnRequest(ic, ic, DEFAULT_ROLES)).toBe(false);
  });

  it("restricts requests with no matching employee to admins", () => {
    expect(canActOnRequest(row(FIXTURE.admin.id), null, DEFAULT_ROLES)).toBe(true);
    expect(canActOnRequest(row(FIXTURE.tier3ManagerOfIc.id), null, DEFAULT_ROLES)).toBe(false);
  });
});

describe("editorIdsOf", () => {
  it("lists the configured role holders, admins excluded", () => {
    const ic = row(FIXTURE.ic.id);
    expect(editorIdsOf(ic, DEFAULT_ROLES)).toEqual([
      FIXTURE.tier3ManagerOfIc.id,
      FIXTURE.tier4ManagerOfIc.id,
      FIXTURE.aiLeadOfIc.id,
    ]);
    expect(editorIdsOf(ic, DEFAULT_ROLES)).not.toContain(FIXTURE.admin.id);
  });

  it("skips null columns", () => {
    expect(editorIdsOf(row(FIXTURE.ceo.id), ["tier3_manager", "tier4_manager"])).toEqual([]);
  });

  it("agrees with canEdit for everyone it names", () => {
    const ic = row(FIXTURE.ic.id);
    for (const id of editorIdsOf(ic, DEFAULT_ROLES)) {
      expect(canEdit(row(id), ic, DEFAULT_ROLES)).toBe(true);
    }
  });
});
