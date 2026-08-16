/**
 * `resetDatabase` is the demo's self-heal. These prove it undoes every
 * persistent change an anonymous visitor can make: a defaced roster, tampered
 * config, a granted delegation, and an appended audit log.
 */

import { FIXTURE } from "@bsl/seed";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import {
  aiLeadAssignments,
  appConfig,
  auditLog,
  employees,
  spendLimitSnapshot,
  syncState,
} from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { writeAudit } from "@/lib/audit";
import { loadAppConfig } from "@/lib/config";

import { resetDatabase } from "./reset";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.$client.close();
});

describe("resetDatabase", () => {
  it("restores the canonical roster after a wipe", () => {
    db.delete(employees).run();
    expect(db.select().from(employees).all()).toHaveLength(0);

    const result = resetDatabase(db);

    expect(result.employees).toBeGreaterThan(0);
    expect(db.select().from(employees).all()).toHaveLength(result.employees);
  });

  it("forces tampered config back to its default", () => {
    // The amplification from the sweep: make every render trigger a full sync.
    db.update(appConfig)
      .set({ value: JSON.stringify(1) })
      .where(eq(appConfig.key, "sync_stale_after_minutes"))
      .run();
    expect(loadAppConfig(db).sync_stale_after_minutes).toBe(1);

    resetDatabase(db);

    expect(loadAppConfig(db).sync_stale_after_minutes).toBe(15);
  });

  it("clears delegations, the audit log, and the synced cache", () => {
    db.insert(aiLeadAssignments)
      .values({
        lead_employee_id: FIXTURE.ic.id,
        leader_employee_id: FIXTURE.tier3ManagerOfIc.id,
        created_at: new Date("2026-08-16T00:00:00.000Z").toISOString(),
      })
      .run();
    writeAudit(db, { actor: { email: FIXTURE.admin.email }, action: "set_limit" });
    db.insert(spendLimitSnapshot)
      .values({ user_id: "usr_x", synced_at: new Date("2026-08-16T00:00:00.000Z").toISOString() })
      .run();
    db.insert(syncState).values({ resource: "effective", status: "idle" }).run();

    const result = resetDatabase(db);

    expect(result.delegationsCleared).toBe(1);
    expect(result.auditCleared).toBe(1);
    expect(db.select().from(aiLeadAssignments).all()).toHaveLength(0);
    expect(db.select().from(auditLog).all()).toHaveLength(0);
    expect(db.select().from(spendLimitSnapshot).all()).toHaveLength(0);
    expect(db.select().from(syncState).all()).toHaveLength(0);
  });
});
