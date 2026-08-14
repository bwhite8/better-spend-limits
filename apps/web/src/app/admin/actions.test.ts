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
import { appConfig, auditLog, employees } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { loadAppConfig } from "@/lib/config";
import { EMPLOYEE_CSV_HEADER } from "@/lib/import-employees";

import { importEmployees, updateConfig } from "./actions";
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
    ...overrides,
  };
}

const auditRows = () => db.select().from(auditLog).all();
const employeeCount = () => db.select().from(employees).all().length;

beforeAll(() => {
  runMigrations(db);
});

beforeEach(() => {
  db.delete(auditLog).run();
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

  it("saves without complaint when nothing actually changed", async () => {
    const answer = await updateConfig(formInput());

    expect(answer.ok).toBe(true);
    expect(answer.message).toContain("nothing changed");
    expect(JSON.parse(auditRows()[0].detail)).toMatchObject({ changed: {} });
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
    });
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
