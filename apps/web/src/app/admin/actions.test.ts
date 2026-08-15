/**
 * The admin server actions, driven directly (plan §Phase 13).
 *
 * The browser test cannot reach these as a non-admin: the forms are only
 * rendered for admins, and a server action's endpoint id is a build hash that a
 * Playwright test has no way to forge. So the property that actually matters —
 * **the permission check is in the action, not in the page that renders the
 * form** — is proved here, by calling the exported functions with a non-admin
 * identity and asserting nothing moved.
 *
 * Identity comes from `next/headers`, which is mocked; everything else is real,
 * including the migrated database `getDb()` hands back (`:memory:` under
 * `NODE_ENV=test`, per `db/client.ts`).
 */

import { FIXTURE } from "@bsl/seed";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ email: null as string | null }));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) =>
      name === "bsl_impersonate" && identity.email !== null ? { value: identity.email } : undefined,
  }),
}));

import { getDb } from "@/db/client";
import { APP_CONFIG_DEFAULTS } from "@/db/config-defaults";
import { runMigrations } from "@/db/migrate";
import { aiLeadAssignments, appConfig, auditLog, employees } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { aiLeadDirectory } from "@/lib/ai-leads";
import { loadAppConfig } from "@/lib/config";
import { EMPLOYEE_CSV_HEADER } from "@/lib/import-employees";
import { authorityIdsOf, loadEditRoles, visibleEmployees } from "@/lib/permissions";

import { importEmployees, updateAiLeadAssignments, updateConfig } from "./actions";
import type { ConfigUpdateInput } from "./types";

const db = getDb();

const VALID_CSV = [
  EMPLOYEE_CSV_HEADER.join(","),
  "emp_1,Ada Lovelace,ada@example.net,,,,,emp_2,1",
  "emp_2,Grace Hopper,grace@example.net,emp_1,,,,emp_1,0",
].join("\n");

/** The form as the config editor submits it, with the §G7 defaults selected. */
function formInput(overrides: Partial<ConfigUpdateInput> = {}): ConfigUpdateInput {
  return {
    edit_roles: [...APP_CONFIG_DEFAULTS.edit_roles],
    near_limit_threshold: APP_CONFIG_DEFAULTS.near_limit_threshold,
    suppress_notification_default: APP_CONFIG_DEFAULTS.suppress_notification_default,
    sync_stale_after_minutes: APP_CONFIG_DEFAULTS.sync_stale_after_minutes,
    show_org_wide_kpis: APP_CONFIG_DEFAULTS.show_org_wide_kpis,
    ...overrides,
  };
}

const auditRows = () => db.select().from(auditLog).all();
const employeeCount = () => db.select().from(employees).all().length;
const assignmentRows = () => db.select().from(aiLeadAssignments).all();

/** The visible-set size the delegation tests measure movement against. */
function scopeSizeOf(employeeId: string): number {
  const actor = db.select().from(employees).all().find((row) => row.id === employeeId)!;
  return visibleEmployees(db, actor, loadEditRoles(db), authorityIdsOf(db, actor)).length;
}

beforeAll(() => {
  runMigrations(db);
});

beforeEach(() => {
  db.delete(auditLog).run();
  db.delete(aiLeadAssignments).run();
  db.delete(appConfig).run();
  seedDatabase(db);
  identity.email = FIXTURE.admin.email;
});

describe("the permission gate", () => {
  it("refuses both actions to an employee who is not an admin", async () => {
    identity.email = FIXTURE.ic.email;

    const config = await updateConfig(formInput({ edit_roles: ["direct_manager"] }));
    const roster = await importEmployees(VALID_CSV);

    expect(config.ok).toBe(false);
    expect(roster.ok).toBe(false);
    expect(loadAppConfig(db).edit_roles).toEqual(APP_CONFIG_DEFAULTS.edit_roles);
    expect(employeeCount()).toBe(250);
    // A refusal that never reached a write leaves no audit trail, exactly as the
    // Phase 10/11 routes decided.
    expect(auditRows()).toEqual([]);
  });

  it("refuses both actions to a caller with no employee record at all", async () => {
    identity.email = "nobody@example.net";

    expect((await updateConfig(formInput({ near_limit_threshold: 0.1 }))).ok).toBe(false);
    expect((await importEmployees(VALID_CSV)).ok).toBe(false);
    expect(loadAppConfig(db).near_limit_threshold).toBe(APP_CONFIG_DEFAULTS.near_limit_threshold);
    expect(employeeCount()).toBe(250);
  });
});

describe("updateConfig", () => {
  it("persists every key and audits only what changed", async () => {
    const answer = await updateConfig(
      formInput({ edit_roles: ["tier4_manager"], near_limit_threshold: 0.5 }),
    );

    expect(answer.ok).toBe(true);
    expect(loadAppConfig(db)).toMatchObject({
      edit_roles: ["tier4_manager"],
      near_limit_threshold: 0.5,
      sync_stale_after_minutes: APP_CONFIG_DEFAULTS.sync_stale_after_minutes,
    });

    const [entry] = auditRows();
    expect(entry.action).toBe("config_update");
    expect(entry.actor_email).toBe(FIXTURE.admin.email.toLowerCase());

    const detail = JSON.parse(entry.detail) as { changed: Record<string, unknown> };
    expect(Object.keys(detail.changed).sort()).toEqual(["edit_roles", "near_limit_threshold"]);
    expect(detail.changed.near_limit_threshold).toEqual({ from: 0.8, to: 0.5 });
  });

  it("rejects a configuration that would leave nobody but admins able to edit", async () => {
    const answer = await updateConfig(formInput({ edit_roles: [] }));

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain("at least one role");
    expect(loadAppConfig(db).edit_roles).toEqual(APP_CONFIG_DEFAULTS.edit_roles);
    expect(auditRows()).toEqual([]);
  });

  it("rejects values outside their documented range", async () => {
    for (const override of [
      { edit_roles: ["skip_level_manager"] },
      { near_limit_threshold: 1.5 },
      { near_limit_threshold: Number.NaN },
      { sync_stale_after_minutes: 0 },
      { sync_stale_after_minutes: 7.5 },
    ]) {
      const answer = await updateConfig(formInput(override as Partial<ConfigUpdateInput>));
      expect(answer.ok, JSON.stringify(override)).toBe(false);
    }

    expect(loadAppConfig(db)).toEqual(APP_CONFIG_DEFAULTS);
    expect(auditRows()).toEqual([]);
  });

  /**
   * `updateConfig` persists `Object.entries(validated)`, so a key `validateConfig`
   * forgets to return is never written and never audited — silently, with the
   * form still showing the value the admin chose. Every §G7 key therefore has to
   * survive a round trip through the action, not merely through the reader.
   */
  it("round-trips every §G7 key through the action, including show_org_wide_kpis", async () => {
    const answer = await updateConfig(formInput({ show_org_wide_kpis: false }));

    expect(answer.ok).toBe(true);
    expect(loadAppConfig(db).show_org_wide_kpis).toBe(false);

    const detail = JSON.parse(auditRows()[0].detail) as { changed: Record<string, unknown> };
    expect(detail.changed.show_org_wide_kpis).toEqual({ from: true, to: false });

    const stored = new Set(db.select().from(appConfig).all().map((row) => row.key));
    for (const key of Object.keys(APP_CONFIG_DEFAULTS)) expect(stored).toContain(key);
  });

  it("saves without complaint when nothing actually changed", async () => {
    const answer = await updateConfig(formInput());

    expect(answer.ok).toBe(true);
    expect(answer.message).toContain("nothing changed");
    expect(JSON.parse(auditRows()[0].detail)).toMatchObject({ changed: {} });
  });
});

/** §Phase 9. The action is the only thing standing between a form and a grant. */
describe("updateAiLeadAssignments", () => {
  const LEAD = FIXTURE.delegatedLead.id;
  const LEADER = FIXTURE.delegationLeader.id;

  it("refuses a caller who is not an admin, and writes nothing", async () => {
    identity.email = FIXTURE.tier3ManagerOfIc.email;

    const answer = await updateAiLeadAssignments({
      lead_employee_id: LEAD,
      leader_employee_ids: [LEADER],
    });

    expect(answer.ok).toBe(false);
    expect(assignmentRows()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  // Criterion 10.
  it("stores the assignment and audits both employee ids", async () => {
    const before = scopeSizeOf(LEAD);

    const answer = await updateAiLeadAssignments({
      lead_employee_id: LEAD,
      leader_employee_ids: [LEADER],
    });

    expect(answer.ok).toBe(true);
    expect(assignmentRows()).toMatchObject([
      { lead_employee_id: LEAD, leader_employee_id: LEADER },
    ]);
    expect(scopeSizeOf(LEAD)).toBeGreaterThan(before);

    const [entry] = auditRows();
    expect(entry.action).toBe("assign_ai_lead");
    expect(entry.actor_email).toBe(FIXTURE.admin.email.toLowerCase());
    expect(entry.target_employee_id).toBe(LEAD);
    expect(JSON.parse(entry.detail)).toMatchObject({
      lead_employee_id: LEAD,
      leader_employee_ids: [LEADER],
      added: [LEADER],
      removed: [],
    });
  });

  // Criterion 5.
  it("refuses an administrator as a leader, naming the constraint", async () => {
    const before = scopeSizeOf(LEAD);

    const answer = await updateAiLeadAssignments({
      lead_employee_id: LEAD,
      leader_employee_ids: [FIXTURE.admin.id],
    });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain("administrator");
    expect(answer.message).toContain("whole organization");
    expect(assignmentRows()).toEqual([]);
    expect(scopeSizeOf(LEAD)).toBe(before);
    expect(auditRows()).toEqual([]);
  });

  it("refuses somebody who leads nobody, and refuses a self-assignment", async () => {
    const nobody = await updateAiLeadAssignments({
      lead_employee_id: LEAD,
      leader_employee_ids: [FIXTURE.unrelatedPeer.id],
    });
    expect(nobody.ok).toBe(false);
    expect(nobody.message).toContain("tier-2, tier-3 or tier-4");

    const self = await updateAiLeadAssignments({
      lead_employee_id: LEADER,
      leader_employee_ids: [LEADER],
    });
    expect(self.ok).toBe(false);
    expect(self.message).toContain("themselves");

    expect(assignmentRows()).toEqual([]);
  });

  it("refuses an id that is on no roster row", async () => {
    expect(
      (await updateAiLeadAssignments({ lead_employee_id: "emp_nope", leader_employee_ids: [] })).ok,
    ).toBe(false);
    expect(
      (await updateAiLeadAssignments({ lead_employee_id: LEAD, leader_employee_ids: ["emp_nope"] }))
        .ok,
    ).toBe(false);
    expect(assignmentRows()).toEqual([]);
  });

  it("replaces the whole set, and an empty list removes the delegation", async () => {
    const second = aiLeadDirectory(db).leaders.find((leader) => leader.id !== LEADER)!;

    await updateAiLeadAssignments({ lead_employee_id: LEAD, leader_employee_ids: [LEADER] });
    await updateAiLeadAssignments({ lead_employee_id: LEAD, leader_employee_ids: [second.id] });

    expect(assignmentRows().map((row) => row.leader_employee_id)).toEqual([second.id]);
    expect(JSON.parse(auditRows()[1].detail)).toMatchObject({
      added: [second.id],
      removed: [LEADER],
    });

    const cleared = await updateAiLeadAssignments({
      lead_employee_id: LEAD,
      leader_employee_ids: [],
    });
    expect(cleared.ok).toBe(true);
    expect(cleared.message).toContain("removed");
    expect(assignmentRows()).toEqual([]);
    expect(scopeSizeOf(LEAD)).toBe(1);
  });
});

describe("importEmployees", () => {
  it("replaces the roster and records the counts", async () => {
    const answer = await importEmployees(VALID_CSV);

    expect(answer.ok).toBe(true);
    expect(employeeCount()).toBe(2);

    const [entry] = auditRows();
    expect(entry.action).toBe("import_employees");
    expect(JSON.parse(entry.detail)).toMatchObject({
      outcome: "success",
      imported: 2,
      replaced: 250,
      admins: 1,
      delegationsRemoved: 0,
    });
  });

  /**
   * §Phase 9 criterion 11. `employees` is deleted wholesale inside the import
   * transaction, so a delegation naming somebody who is not on the new roster
   * would fail the deferred foreign-key check at COMMIT and surface as "the
   * roster could not be replaced". It is dropped instead — and said out loud,
   * because it is a permission that just went away.
   */
  it("drops delegations whose people are no longer on the roster, and says so", async () => {
    await updateAiLeadAssignments({
      lead_employee_id: FIXTURE.delegatedLead.id,
      leader_employee_ids: [FIXTURE.delegationLeader.id],
    });
    expect(assignmentRows()).toHaveLength(1);

    const answer = await importEmployees(VALID_CSV);

    expect(answer.ok).toBe(true);
    expect(answer.message).toContain("Removed 1 AI-lead delegation");
    expect(assignmentRows()).toEqual([]);

    const entry = auditRows().find((row) => row.action === "import_employees")!;
    expect(JSON.parse(entry.detail)).toMatchObject({ delegationsRemoved: 1 });
  });

  it("re-validates the file rather than trusting the browser's verdict", async () => {
    const dangling = [
      EMPLOYEE_CSV_HEADER.join(","),
      "emp_1,Ada,ada@example.net,emp_999,,,,,1",
    ].join("\n");

    const answer = await importEmployees(dangling);

    expect(answer.ok).toBe(false);
    expect(answer.issues?.[0].line).toBe(2);
    expect(employeeCount()).toBe(250);
    expect(auditRows()).toEqual([]);
  });

  it("refuses a roster with no administrator on it", async () => {
    const headless = [
      EMPLOYEE_CSV_HEADER.join(","),
      "emp_1,Ada,ada@example.net,,,,,,0",
    ].join("\n");

    const answer = await importEmployees(headless);

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain("is_admin=1");
    expect(employeeCount()).toBe(250);
  });

  it("refuses an empty file", async () => {
    expect((await importEmployees("")).ok).toBe(false);
    expect(employeeCount()).toBe(250);
  });
});
