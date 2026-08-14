import { FIXTURE, generateOrg } from "@bsl/seed";
import { count, eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "./client";
import { APP_CONFIG_DEFAULTS } from "./config-defaults";
import { runMigrations } from "./migrate";
import { IN_MEMORY_DATABASE } from "./paths";
import { seedDatabase } from "./seed";
import {
  appConfig,
  auditLog,
  employees,
  increaseRequestSnapshot,
  spendLimitSnapshot,
  syncState,
  userDailyCost,
} from "./schema";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
});

/** Raw column values, bypassing drizzle's boolean mapping. */
function raw<T = Record<string, unknown>>(query: string): T[] {
  return db.$client.prepare(query).all() as T[];
}

describe("migrations", () => {
  it("creates all seven §G7 tables", () => {
    const tables = raw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "app_config",
        "audit_log",
        "employees",
        "increase_request_snapshot",
        "spend_limit_snapshot",
        "sync_state",
        "user_daily_cost",
      ]),
    );
  });

  it("leaves every table empty and queryable", () => {
    for (const table of [
      employees,
      appConfig,
      auditLog,
      spendLimitSnapshot,
      increaseRequestSnapshot,
      userDailyCost,
      syncState,
    ]) {
      const [row] = db.select({ value: count() }).from(table).all();
      expect(row?.value).toBe(0);
    }
  });

  it("is idempotent", () => {
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("gives `user_daily_cost` a composite (user_id, date) primary key", () => {
    const pk = raw<{ name: string; pk: number }>("PRAGMA table_info('user_daily_cost')")
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    expect(pk).toEqual(["user_id", "date"]);
  });

  it("defaults `sync_state.status` to 'idle'", () => {
    db.insert(syncState).values({ resource: "effective" }).run();
    const [row] = db.select().from(syncState).all();
    expect(row?.status).toBe("idle");
  });
});

// The rest of the suite exercises the MIGRATED database, so on its own it would
// not notice `schema.ts` drifting away from `drizzle/`. Every later phase writes
// queries against `schema.ts`, so the two have to be checked against each other.
describe("schema.ts matches the generated migration", () => {
  const tables = [
    employees,
    appConfig,
    auditLog,
    spendLimitSnapshot,
    increaseRequestSnapshot,
    userDailyCost,
    syncState,
  ];

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    "%s",
    (_name, table) => {
      const config = getTableConfig(table);
      const actual = raw<{ name: string; notnull: number; pk: number }>(
        `PRAGMA table_info('${config.name}')`,
      );

      expect(actual.length, `table ${config.name} is missing from the migration`).toBeGreaterThan(0);

      // Column names and NOT NULL flags.
      expect(new Map(actual.map((column) => [column.name, column.notnull === 1]))).toEqual(
        new Map(config.columns.map((column) => [column.name, column.notNull])),
      );

      // Primary key, in declared order.
      const declaredPk =
        config.primaryKeys[0]?.columns.map((column) => column.name) ??
        config.columns.filter((column) => column.primary).map((column) => column.name);
      const migratedPk = actual
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);

      expect(migratedPk).toEqual(declaredPk);
    },
  );
});

describe("db:seed", () => {
  beforeEach(() => {
    seedDatabase(db);
  });

  // Acceptance criterion 2.
  it("inserts 250 employees", () => {
    const [row] = db.select({ value: count() }).from(employees).all();
    expect(row?.value).toBe(250);
  });

  // Acceptance criterion 3.
  it("flags at least one admin, stored as INTEGER 1", () => {
    const [row] = raw<{ n: number }>("SELECT COUNT(*) AS n FROM employees WHERE is_admin = 1");
    expect(row?.n).toBeGreaterThanOrEqual(1);
  });

  // Acceptance criterion 4.
  it("seeds the §G7 app_config defaults", () => {
    const rows = db.select().from(appConfig).all();
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

    expect(values.edit_roles).toBe('["tier3_manager","tier4_manager","aligned_ai_lead"]');
    expect(values.suppress_notification_default).toBe("true");
    expect(values.near_limit_threshold).toBe("0.8");
    expect(values.sync_stale_after_minutes).toBe("15");
    expect(Object.keys(values).sort()).toEqual(Object.keys(APP_CONFIG_DEFAULTS).sort());
  });

  // Acceptance criterion 5: the denormalised hierarchy survives the round trip.
  it("stores FIXTURE.ic's tier-3 manager as FIXTURE.tier3ManagerOfIc", () => {
    const [ic] = db.select().from(employees).where(eq(employees.id, FIXTURE.ic.id)).all();

    expect(ic).toBeDefined();
    expect(ic?.tier3_manager_id).toBe(FIXTURE.tier3ManagerOfIc.id);
    expect(ic?.tier4_manager_id).toBe(FIXTURE.tier4ManagerOfIc.id);
    expect(ic?.direct_manager_id).toBe(FIXTURE.directManagerOfIc.id);
    expect(ic?.aligned_ai_lead_id).toBe(FIXTURE.aiLeadOfIc.id);
  });

  it("copies every column of the synthetic roster faithfully", () => {
    const org = generateOrg(42);
    const stored = new Map(db.select().from(employees).all().map((row) => [row.id, row]));

    for (const person of org.employees) {
      const row = stored.get(person.id);
      expect(row, `missing employee ${person.id}`).toBeDefined();
      expect({
        name: row?.name,
        email: row?.email,
        direct_manager_id: row?.direct_manager_id,
        tier2_manager_id: row?.tier2_manager_id,
        tier3_manager_id: row?.tier3_manager_id,
        tier4_manager_id: row?.tier4_manager_id,
        aligned_ai_lead_id: row?.aligned_ai_lead_id,
        is_admin: row?.is_admin,
      }).toEqual({
        name: person.name,
        email: person.email.toLowerCase(),
        direct_manager_id: person.direct_manager_id,
        tier2_manager_id: person.tier2_manager_id,
        tier3_manager_id: person.tier3_manager_id,
        tier4_manager_id: person.tier4_manager_id,
        aligned_ai_lead_id: person.aligned_ai_lead_id,
        is_admin: person.is_admin,
      });
    }
  });

  it("leaves claude_user_id NULL for the Phase-8 sync to fill", () => {
    const [row] = raw<{ n: number }>(
      "SELECT COUNT(*) AS n FROM employees WHERE claude_user_id IS NOT NULL",
    );
    expect(row?.n).toBe(0);
  });

  it("stamps created_at and updated_at on every row", () => {
    const [row] = raw<{ n: number }>(
      "SELECT COUNT(*) AS n FROM employees WHERE created_at IS NULL OR updated_at IS NULL",
    );
    expect(row?.n).toBe(0);
  });

  it("satisfies the employees self-referential foreign keys", () => {
    expect(raw("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("replaces the roster rather than duplicating it when re-run", () => {
    db.update(employees).set({ name: "stale" }).where(eq(employees.id, FIXTURE.ic.id)).run();

    seedDatabase(db);

    const [total] = db.select({ value: count() }).from(employees).all();
    expect(total?.value).toBe(250);

    const [ic] = db.select().from(employees).where(eq(employees.id, FIXTURE.ic.id)).all();
    expect(ic?.name).toBe(FIXTURE.ic.name);
  });

  it("does not clobber an administrator's config changes on re-seed", () => {
    db.update(appConfig)
      .set({ value: '["direct_manager"]' })
      .where(eq(appConfig.key, "edit_roles"))
      .run();

    seedDatabase(db);

    const [row] = db.select().from(appConfig).where(eq(appConfig.key, "edit_roles")).all();
    expect(row?.value).toBe('["direct_manager"]');
  });

  it("enforces the unique email index", () => {
    expect(() =>
      db
        .insert(employees)
        .values({
          id: "emp_dupe",
          name: "Dupe",
          email: FIXTURE.ic.email,
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });
});

describe("snapshot tables", () => {
  it("round-trips a spend_limit_snapshot row including a null amount", () => {
    db.insert(spendLimitSnapshot)
      .values({
        user_id: "user_01",
        actor_name: "Jane Smith",
        actor_email: "jane@example.com",
        amount: null,
        currency: "USD",
        period: "monthly",
        source_type: "seat_tier",
        source_detail: JSON.stringify({ type: "seat_tier", seat_tier: "enterprise_standard" }),
        spend_limit_id: "spl_01",
        period_to_date_spend: "31402.5",
        synced_at: "2026-08-13T00:00:00.000Z",
      })
      .run();

    const [row] = db.select().from(spendLimitSnapshot).all();
    expect(row?.amount).toBeNull();
    expect(row?.actor_deleted).toBe(false);
    expect(row?.period_to_date_spend).toBe("31402.5");
  });

  it("stores `provisional` as INTEGER 0/1 under the composite key", () => {
    db.insert(userDailyCost)
      .values([
        {
          user_id: "user_01",
          date: "2026-08-12",
          amount: "10447.000000",
          provisional: false,
          synced_at: "2026-08-13T00:00:00.000Z",
        },
        {
          user_id: "user_01",
          date: "2026-08-13",
          amount: "8000.000000",
          provisional: true,
          synced_at: "2026-08-13T00:00:00.000Z",
        },
      ])
      .run();

    const [row] = raw<{ n: number }>("SELECT COUNT(*) AS n FROM user_daily_cost WHERE provisional = 1");
    expect(row?.n).toBe(1);

    expect(() =>
      db
        .insert(userDailyCost)
        .values({
          user_id: "user_01",
          date: "2026-08-13",
          amount: "9000.000000",
          synced_at: "2026-08-13T00:00:00.000Z",
        })
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });

  it("auto-increments audit_log ids", () => {
    const rows = [1, 2].map((n) => ({
      at: `2026-08-13T00:00:0${n}.000Z`,
      actor_email: "admin@example.com",
      action: "set_limit",
      detail: JSON.stringify({ new_amount: `${n}0000` }),
    }));
    db.insert(auditLog).values(rows).run();

    const ids = db.select({ id: auditLog.id }).from(auditLog).orderBy(auditLog.id).all();
    expect(ids.map((row) => row.id)).toEqual([1, 2]);
  });

  it("round-trips an increase_request_snapshot row", () => {
    db.insert(increaseRequestSnapshot)
      .values({
        id: "slir_01",
        status: "pending",
        actor_user_id: "user_01",
        actor_name: "Jane Smith",
        actor_email: "jane@example.com",
        created_at: "2026-08-01T00:00:00.000Z",
        resolved_at: null,
        spend_summary: JSON.stringify({ amount: "50000", period_to_date_spend: "31402.5" }),
        synced_at: "2026-08-13T00:00:00.000Z",
      })
      .run();

    const [row] = db.select().from(increaseRequestSnapshot).all();
    expect(row?.resolved_at).toBeNull();
    expect(JSON.parse(row?.spend_summary ?? "{}")).toMatchObject({ amount: "50000" });
  });
});

describe("client", () => {
  it("enables foreign key enforcement", () => {
    const [row] = db.$client.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(row?.foreign_keys).toBe(1);
  });

  it("rejects an employee pointing at a manager who does not exist", () => {
    expect(() =>
      db
        .insert(employees)
        .values({
          id: "emp_orphan",
          name: "Orphan",
          email: "orphan@example.com",
          direct_manager_id: "emp_nope",
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("resets deferred foreign keys after the seed transaction", () => {
    seedDatabase(db);
    const [row] = db.$client.pragma("defer_foreign_keys") as { defer_foreign_keys: number }[];
    expect(row?.defer_foreign_keys).toBe(0);
    expect(raw("PRAGMA foreign_key_check")).toEqual([]);
  });
});
