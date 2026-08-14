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
import { appConfig } from "@/db/schema";
import { seedDatabase } from "@/db/seed";

import { loadAppConfig, readRawConfig } from "./config";

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

    expect(loadAppConfig(db)).toEqual({
      edit_roles: APP_CONFIG_DEFAULTS.edit_roles,
      suppress_notification_default: false,
      near_limit_threshold: 0.65,
      sync_stale_after_minutes: 60,
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
