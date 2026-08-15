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
import { APP_CONFIG_DEFAULTS, EDIT_ROLE_VALUES, type EditRole } from "@/db/config-defaults";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { aiLeadAssignments, appConfig, employees, type Employee } from "@/db/schema";
import { seedDatabase } from "@/db/seed";

import { loadAppConfig } from "./config";
import {
  authorityIdsOf,
  canActOnRequest,
  canEdit,
  canView,
  delegatedEditorsOf,
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

/** Delegate `leaderId` to `leadId`, the way the admin action would. */
function assign(leadId: string, leaderId: string): void {
  db.insert(aiLeadAssignments)
    .values({
      lead_employee_id: leadId,
      leader_employee_id: leaderId,
      created_at: "2026-08-14T00:00:00.000Z",
    })
    .run();
}

describe("editRoleColumn", () => {
  it("maps every allowed role onto a real `employees` column", () => {
    for (const role of EDIT_ROLE_VALUES) {
      expect(employees).toHaveProperty(editRoleColumn(role));
    }
    expect(editRoleColumn("tier4_manager")).toBe("tier4_manager_id");
    expect(editRoleColumn("tier3_manager")).toBe("tier3_manager_id");
  });

  /**
   * §Phase 9 acceptance criterion 7. Removing the role is what makes the
   * delegation table the only way an AI lead gets authority; leaving it legal
   * would have left two mechanisms granting the same thing with different
   * scopes. The COLUMN stays — it is real HRIS data and the member page shows it.
   */
  it("no longer offers `aligned_ai_lead` as a grantable role", () => {
    expect(EDIT_ROLE_VALUES).toHaveLength(4);
    expect(EDIT_ROLE_VALUES as readonly string[]).not.toContain("aligned_ai_lead");
    expect(employees).toHaveProperty("aligned_ai_lead_id");
    expect(row(FIXTURE.ic.id).aligned_ai_lead_id).toBe(FIXTURE.aiLeadOfIc.id);
  });
});

describe("loadEditRoles", () => {
  it("returns the seeded §G7 default", () => {
    expect(loadEditRoles(db)).toEqual(["tier3_manager", "tier4_manager"]);
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
    // §Phase 9: the HRIS column no longer grants anything on its own.
    ["aiLeadOfIc", FIXTURE.aiLeadOfIc.id, false],
    ["directManagerOfIc", FIXTURE.directManagerOfIc.id, false],
    ["unrelatedPeer", FIXTURE.unrelatedPeer.id, false],
    ["admin", FIXTURE.admin.id, true],
    ["ic (self)", FIXTURE.ic.id, false],
  ])("%s → %s", (_label, actorId, expected) => {
    expect(canEdit(row(actorId), row(FIXTURE.ic.id), DEFAULT_ROLES)).toBe(expected);
  });

  it("grants the two editing roles to people who are not admins", () => {
    for (const id of [FIXTURE.tier3ManagerOfIc.id, FIXTURE.tier4ManagerOfIc.id]) {
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

    // ...while on a chain that runs out one level lower, the roles that DO
    // resolve still grant. A senior manager has no tier-4 above them (their
    // tier-3 is the CEO), and their tier-2 is a VP who is not an admin.
    const roles: EditRole[] = ["tier4_manager", "tier2_manager"];
    const partial = nonAdmins.find(
      (employee) =>
        employee.tier4_manager_id === null &&
        employee.tier2_manager_id !== null &&
        !row(employee.tier2_manager_id).is_admin,
    );
    expect(partial, "seed 42 has a target with a partial chain").toBeDefined();

    const holder = row(partial!.tier2_manager_id!);
    expect(holder.is_admin).toBe(false);
    expect(canEdit(holder, partial!, roles)).toBe(true);
    expect(canEdit(holder, partial!, ["tier4_manager"])).toBe(false);
  });

  it("never lets a null column match a null-ish actor id", () => {
    const target = { ...row(FIXTURE.ceo.id), aligned_ai_lead_id: null };
    const ghost = { id: null as unknown as string, is_admin: false };
    expect(canEdit(ghost, target, DEFAULT_ROLES)).toBe(false);
  });
});

describe("visibleEmployees", () => {
  it("gives an admin the whole organization", () => {
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
    ]);
    expect(editorIdsOf(ic, DEFAULT_ROLES)).not.toContain(FIXTURE.admin.id);
    // The HRIS AI lead is on the row and is no longer an editor (§Phase 9).
    expect(editorIdsOf(ic, DEFAULT_ROLES)).not.toContain(FIXTURE.aiLeadOfIc.id);
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

/**
 * §Phase 9. An AI lead's authority is a delegation from one or more LEADERS,
 * resolved once into `[actor.id, ...leaders]` and compared against the target's
 * role columns. The fixtures are chosen so that nothing here can pass on a
 * relationship that already existed: `delegatedLead` holds no tier-2/3/4 slot
 * over anybody, so without an assignment their whole world is themselves.
 */
describe("AI-lead delegation", () => {
  const L = () => row(FIXTURE.delegatedLead.id);
  const M = () => row(FIXTURE.delegationLeader.id);

  /** Everyone `M`'s configured roles reach — the set `L` should inherit. */
  const reportsOfLeader = (): string[] =>
    db
      .select()
      .from(employees)
      .all()
      .filter(
        (employee) =>
          employee.tier3_manager_id === FIXTURE.delegationLeader.id ||
          employee.tier4_manager_id === FIXTURE.delegationLeader.id,
      )
      .map((employee) => employee.id);

  it("starts from nothing: an unassigned lead sees only themselves", () => {
    expect(authorityIdsOf(db, L())).toEqual([FIXTURE.delegatedLead.id]);
    expect(visibleEmployees(db, L(), DEFAULT_ROLES).map((e) => e.id)).toEqual([
      FIXTURE.delegatedLead.id,
    ]);
    expect(canEdit(L(), row(FIXTURE.delegatedReport.id), DEFAULT_ROLES)).toBe(false);
  });

  it("resolves the authority set to the actor plus their leaders", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);

    expect(authorityIdsOf(db, L()).sort()).toEqual(
      [FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id].sort(),
    );
    // Nobody else's authority moves.
    expect(authorityIdsOf(db, M())).toEqual([FIXTURE.delegationLeader.id]);
  });

  // Criterion 3.
  it("gives the lead exactly the leader's people, plus themselves, and NOT the leader", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);

    const expected = [...new Set([FIXTURE.delegatedLead.id, ...reportsOfLeader()])].sort();
    const visible = visibleEmployees(db, L(), DEFAULT_ROLES).map((e) => e.id);

    expect(visible.length).toBeGreaterThan(1);
    expect([...visible].sort()).toEqual(expected);
    expect(visible).toContain(FIXTURE.delegatedReport.id);
    expect(visible).not.toContain(FIXTURE.delegationLeader.id);
  });

  // Criterion 4 — and the reason the self clause stays bound to the actor.
  it("does not let the lead edit or view the leader they were assigned to", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);
    const authority = authorityIdsOf(db, L());

    expect(canEdit(L(), M(), DEFAULT_ROLES, authority)).toBe(false);
    expect(canView(L(), M(), DEFAULT_ROLES, authority)).toBe(false);
    // ...while the leader's reports are fully theirs.
    expect(canEdit(L(), row(FIXTURE.delegatedReport.id), DEFAULT_ROLES, authority)).toBe(true);
  });

  it("carries the same answer into the request queue", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);
    const authority = authorityIdsOf(db, L());

    expect(
      canActOnRequest(L(), row(FIXTURE.delegatedReport.id), DEFAULT_ROLES, authority),
    ).toBe(true);
    expect(canActOnRequest(L(), M(), DEFAULT_ROLES, authority)).toBe(false);
    // A requester with no employee record stays admin-only, delegation or not.
    expect(canActOnRequest(L(), null, DEFAULT_ROLES, authority)).toBe(false);
  });

  it("never grants admin rights, whoever is delegated", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);
    const authority = authorityIdsOf(db, L());

    // The CEO is outside the leader's scope, and no delegation reaches them.
    expect(canView(L(), row(FIXTURE.ceo.id), DEFAULT_ROLES, authority)).toBe(false);
    expect(visibleEmployees(db, L(), DEFAULT_ROLES).length).toBeLessThan(250);
    expect(L().is_admin).toBe(false);
  });

  // Criterion 6.
  it("is non-transitive: a leader's own delegations do not chain onward", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);
    // The leader is themselves a lead, assigned to a third leader.
    assign(FIXTURE.delegationLeader.id, FIXTURE.tier3ManagerOfIc.id);

    const authority = authorityIdsOf(db, L());
    expect(authority).not.toContain(FIXTURE.tier3ManagerOfIc.id);

    const visible = visibleEmployees(db, L(), DEFAULT_ROLES).map((e) => e.id);
    const secondHop = db
      .select()
      .from(employees)
      .all()
      .filter((employee) => employee.tier3_manager_id === FIXTURE.tier3ManagerOfIc.id)
      .map((employee) => employee.id);

    expect(secondHop.length).toBeGreaterThan(0);
    for (const id of secondHop) expect(visible).not.toContain(id);
    expect(visible).not.toContain(FIXTURE.ic.id);
  });

  it("refuses a self-edit that delegation would otherwise have granted", () => {
    // The most natural assignment there is: a lead embedded in the org they
    // support, delegated to their OWN tier-3 manager. That must not hand them
    // their own budget.
    const ownManagerId = FIXTURE.delegatedLead.tier3_manager_id!;
    expect(ownManagerId).not.toBeNull();
    assign(FIXTURE.delegatedLead.id, ownManagerId);

    const authority = authorityIdsOf(db, L());
    expect(authority).toContain(ownManagerId);
    expect(canEdit(L(), L(), DEFAULT_ROLES, authority)).toBe(false);
    // They can still see themselves, and still edit their new peers.
    expect(canView(L(), L(), DEFAULT_ROLES, authority)).toBe(true);
    expect(visibleEmployees(db, L(), DEFAULT_ROLES).map((e) => e.id)).toContain(
      FIXTURE.delegatedLead.id,
    );
  });

  it("stays in step with canView over the whole roster", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);

    const actor = L();
    const authority = authorityIdsOf(db, actor);
    const all = db.select().from(employees).all();

    const expected = all
      .filter((target) => canView(actor, target, DEFAULT_ROLES, authority))
      .map((e) => e.id)
      .sort();
    expect(visibleEmployees(db, actor, DEFAULT_ROLES, authority).map((e) => e.id).sort()).toEqual(
      expected,
    );
  });
});

describe("delegatedEditorsOf", () => {
  it("is empty until something is delegated", () => {
    expect(delegatedEditorsOf(db, row(FIXTURE.delegatedReport.id), DEFAULT_ROLES)).toEqual([]);
  });

  // Criterion 9, first half.
  it("names the lead, and says which leader they are speaking for", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);

    expect(delegatedEditorsOf(db, row(FIXTURE.delegatedReport.id), DEFAULT_ROLES)).toEqual([
      { id: FIXTURE.delegatedLead.id, viaLeaderIds: [FIXTURE.delegationLeader.id] },
    ]);
    // Somebody outside the leader's scope is unaffected.
    expect(delegatedEditorsOf(db, row(FIXTURE.ic.id), DEFAULT_ROLES)).toEqual([]);
  });

  it("does not name the target themselves", () => {
    const ownManagerId = FIXTURE.delegatedLead.tier3_manager_id!;
    assign(FIXTURE.delegatedLead.id, ownManagerId);

    const lead = row(FIXTURE.delegatedLead.id);
    expect(editorIdsOf(lead, DEFAULT_ROLES)).toContain(ownManagerId);
    expect(delegatedEditorsOf(db, lead, DEFAULT_ROLES).map((editor) => editor.id)).not.toContain(
      FIXTURE.delegatedLead.id,
    );
  });

  /**
   * Criterion 9, second half — the direction nothing asserted before.
   *
   * `editorIdsOf` is pure over the target's own columns, so a delegated lead
   * could never appear in it however correct it looked. The card that tells a
   * user who to ask would simply have left them out.
   */
  it("completes the editor list: everyone canEdit allows is named", () => {
    assign(FIXTURE.delegatedLead.id, FIXTURE.delegationLeader.id);

    const all = db.select().from(employees).all();
    const targets = [
      row(FIXTURE.delegatedReport.id),
      row(FIXTURE.ic.id),
      row(FIXTURE.ceo.id),
      row(FIXTURE.unrelatedPeer.id),
      row(FIXTURE.delegatedLead.id),
    ];

    for (const target of targets) {
      const named = new Set([
        ...editorIdsOf(target, DEFAULT_ROLES),
        ...delegatedEditorsOf(db, target, DEFAULT_ROLES).map((editor) => editor.id),
      ]);

      for (const actor of all) {
        if (actor.is_admin) continue; // Admins edit everyone and are listed nowhere.
        const allowed = canEdit(actor, target, DEFAULT_ROLES, authorityIdsOf(db, actor));
        expect(
          allowed ? named.has(actor.id) : true,
          `${actor.id} may edit ${target.id} but is not named as an editor`,
        ).toBe(true);
      }
    }
  });
});
