/**
 * `app_config` is user-editable (Phase 13) and stored as JSON text, so every
 * read has to survive nonsense. The contract is: a bad value falls back to its
 * §G7 default, never throws.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { APP_CONFIG_DEFAULTS } from "@/db/config-defaults";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { appConfig, auditLog } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { parseAuditDetail } from "@/lib/audit";

import { loadAppConfig, migrateRetiredEditRoles, readRawConfig } from "./config";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.$client.close();
});

function put(key: string, rawJson: string): void {
  db.insert(appConfig)
    .values({ key, value: rawJson })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: rawJson } })
    .run();
}

describe("loadAppConfig", () => {
  it("returns the seeded §G7 defaults", () => {
    expect(loadAppConfig(db)).toEqual(APP_CONFIG_DEFAULTS);
  });

  it("returns the defaults for a completely empty table", () => {
    db.delete(appConfig).run();
    expect(readRawConfig(db).size).toBe(0);
    expect(loadAppConfig(db)).toEqual(APP_CONFIG_DEFAULTS);
  });

  it("reads valid configured values", () => {
    put("suppress_notification_default", "false");
    put("near_limit_threshold", "0.65");
    put("sync_stale_after_minutes", "60");
    put("show_org_wide_kpis", "false");

    expect(loadAppConfig(db)).toEqual({
      edit_roles: APP_CONFIG_DEFAULTS.edit_roles,
      suppress_notification_default: false,
      near_limit_threshold: 0.65,
      sync_stale_after_minutes: 60,
      show_org_wide_kpis: false,
    });
  });

  it.each([
    ["a string", '"true"'],
    ["a number", "1"],
    ["null", "null"],
    ["unparseable text", "yes"],
  ])("falls back for suppress_notification_default given %s", (_label, stored) => {
    put("suppress_notification_default", stored);
    expect(loadAppConfig(db).suppress_notification_default).toBe(
      APP_CONFIG_DEFAULTS.suppress_notification_default,
    );
  });

  it.each([
    ["above 1", "1.5"],
    ["negative", "-0.1"],
    ["a string", '"0.8"'],
    ["unparseable text", "0.8.1"],
  ])("falls back for near_limit_threshold given %s", (_label, stored) => {
    put("near_limit_threshold", stored);
    expect(loadAppConfig(db).near_limit_threshold).toBe(APP_CONFIG_DEFAULTS.near_limit_threshold);
  });

  it.each([
    ["0", "0"],
    ["negative", "-15"],
    ["fractional", "15.5"],
    ["a string", '"15"'],
  ])("falls back for sync_stale_after_minutes given %s", (_label, stored) => {
    put("sync_stale_after_minutes", stored);
    expect(loadAppConfig(db).sync_stale_after_minutes).toBe(
      APP_CONFIG_DEFAULTS.sync_stale_after_minutes,
    );
  });

  // Phase 8 acceptance criterion 1. `show_org_wide_kpis` decides whether a
  // non-admin sees organization-wide totals, so a corrupt value must not throw —
  // and must not accidentally read as "off" either.
  it("defaults show_org_wide_kpis to true on a freshly seeded database", () => {
    expect(APP_CONFIG_DEFAULTS.show_org_wide_kpis).toBe(true);
    expect(loadAppConfig(db).show_org_wide_kpis).toBe(true);
  });

  it("reads an explicit false for show_org_wide_kpis", () => {
    put("show_org_wide_kpis", "false");
    expect(loadAppConfig(db).show_org_wide_kpis).toBe(false);
  });

  it.each([
    ["a quoted string", '"banana"'],
    ["a number", "0"],
    ["null", "null"],
    ["unparseable text", "banana"],
  ])("falls back for show_org_wide_kpis given %s", (_label, stored) => {
    put("show_org_wide_kpis", stored);
    expect(() => loadAppConfig(db)).not.toThrow();
    expect(loadAppConfig(db).show_org_wide_kpis).toBe(APP_CONFIG_DEFAULTS.show_org_wide_kpis);
  });

  // The §G7 key set is pinned so adding or removing one is a deliberate edit:
  // `admin.spec.ts`'s `afterAll` restores config by iterating these keys, and a
  // key that quietly leaves the object stops being restored between e2e specs.
  it("covers exactly the five §G7 keys", () => {
    expect(Object.keys(APP_CONFIG_DEFAULTS).sort()).toEqual([
      "edit_roles",
      "near_limit_threshold",
      "show_org_wide_kpis",
      "suppress_notification_default",
      "sync_stale_after_minutes",
    ]);
  });

  it("accepts the boundary values 0 and 1 for near_limit_threshold", () => {
    put("near_limit_threshold", "0");
    expect(loadAppConfig(db).near_limit_threshold).toBe(0);
    put("near_limit_threshold", "1");
    expect(loadAppConfig(db).near_limit_threshold).toBe(1);
  });

  it("isolates a corrupt key from the rest", () => {
    put("near_limit_threshold", "garbage");
    put("sync_stale_after_minutes", "5");

    const config = loadAppConfig(db);
    expect(config.near_limit_threshold).toBe(APP_CONFIG_DEFAULTS.near_limit_threshold);
    expect(config.sync_stale_after_minutes).toBe(5);
  });

  it("ignores unknown keys", () => {
    put("future_setting", '"whatever"');
    expect(loadAppConfig(db)).toEqual(APP_CONFIG_DEFAULTS);
    expect(readRawConfig(db).get("future_setting")).toBe('"whatever"');
  });
});

/**
 * §Phase 9 acceptance criterion 8.
 *
 * A stored `edit_roles` naming `aligned_ai_lead` would otherwise be rejected
 * whole and served as the default — the right behaviour, arrived at silently,
 * with the admin form still showing whatever survived and nothing in the audit
 * log to explain it.
 */
describe("migrateRetiredEditRoles", () => {
  const storedRoles = (): unknown => JSON.parse(readRawConfig(db).get("edit_roles") ?? "null");
  const configEntries = () =>
    db.select().from(auditLog).all().filter((row) => row.action === "config_update");

  it("drops the retired role, keeps the rest, and records one audit entry", () => {
    put("edit_roles", '["tier3_manager","tier4_manager","aligned_ai_lead"]');

    expect(migrateRetiredEditRoles(db).changed).toBe(true);
    expect(storedRoles()).toEqual(["tier3_manager", "tier4_manager"]);
    expect(loadAppConfig(db).edit_roles).toEqual(["tier3_manager", "tier4_manager"]);

    const entries = configEntries();
    expect(entries).toHaveLength(1);
    const detail = parseAuditDetail(entries[0]!) as {
      reason: string;
      changed: { edit_roles: { from: string[]; to: string[] } };
    };
    expect(detail.reason).toBe("retired_edit_roles");
    expect(detail.changed.edit_roles.from).toContain("aligned_ai_lead");
    expect(detail.changed.edit_roles.to).toEqual(["tier3_manager", "tier4_manager"]);
  });

  it("keeps a non-default remainder rather than resetting the whole value", () => {
    put("edit_roles", '["direct_manager","aligned_ai_lead"]');

    migrateRetiredEditRoles(db);
    expect(storedRoles()).toEqual(["direct_manager"]);
  });

  it("falls back to the default when the retired role was the only one", () => {
    put("edit_roles", '["aligned_ai_lead"]');

    migrateRetiredEditRoles(db);
    // "Admins only" is a policy somebody chooses, not one a rewrite imposes.
    expect(storedRoles()).toEqual(APP_CONFIG_DEFAULTS.edit_roles);
  });

  it("is a no-op — and writes nothing — on a database that has no retired role", () => {
    expect(migrateRetiredEditRoles(db).changed).toBe(false);
    expect(configEntries()).toEqual([]);

    put("edit_roles", '["direct_manager"]');
    expect(migrateRetiredEditRoles(db).changed).toBe(false);
    expect(storedRoles()).toEqual(["direct_manager"]);
    expect(configEntries()).toEqual([]);
  });

  it("is idempotent: running it twice writes one entry", () => {
    put("edit_roles", '["tier3_manager","aligned_ai_lead"]');

    migrateRetiredEditRoles(db);
    migrateRetiredEditRoles(db);

    expect(configEntries()).toHaveLength(1);
    expect(storedRoles()).toEqual(["tier3_manager"]);
  });

  it("leaves a value that is not an array to the reader's own fallback", () => {
    put("edit_roles", '"aligned_ai_lead"');

    expect(migrateRetiredEditRoles(db).changed).toBe(false);
    expect(loadAppConfig(db).edit_roles).toEqual(APP_CONFIG_DEFAULTS.edit_roles);
  });
});
