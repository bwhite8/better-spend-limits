/**
 * §G8: every write goes through `writeAudit`. These tests cover the writer
 * itself; the flows that call it arrive in Phases 10, 11 and 13.
 */

import { FIXTURE } from "@bsl/seed";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { auditLog } from "@/db/schema";
import { seedDatabase } from "@/db/seed";

import { parseAuditDetail, writeAudit } from "./audit";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.$client.close();
});

const rows = () => db.select().from(auditLog).orderBy(asc(auditLog.id)).all();

describe("writeAudit", () => {
  it("inserts a retrievable row and round-trips the JSON detail", () => {
    const detail = {
      old_amount: null,
      new_amount: "75000",
      request_id: "req_01ABC",
      nested: { period: "monthly", tags: ["manual", "ui"] },
    };

    const written = writeAudit(db, {
      actor: { id: FIXTURE.tier3ManagerOfIc.id, email: FIXTURE.tier3ManagerOfIc.email },
      action: "set_limit",
      targetEmployeeId: FIXTURE.ic.id,
      targetUserId: FIXTURE.ic.claude_user_id,
      detail,
    });

    const [stored] = rows();
    expect(stored).toEqual(written);
    expect(stored?.action).toBe("set_limit");
    expect(stored?.actor_employee_id).toBe(FIXTURE.tier3ManagerOfIc.id);
    expect(stored?.actor_email).toBe(FIXTURE.tier3ManagerOfIc.email);
    expect(stored?.target_employee_id).toBe(FIXTURE.ic.id);
    expect(stored?.target_user_id).toBe(FIXTURE.ic.claude_user_id);
    expect(parseAuditDetail(stored!)).toEqual(detail);
  });

  it("records an actor with no employee row, keeping the email", () => {
    writeAudit(db, {
      actor: { email: "Contractor@Other.Example" },
      action: "config_update",
      detail: { key: "near_limit_threshold" },
    });

    const [stored] = rows();
    expect(stored?.actor_employee_id).toBeNull();
    expect(stored?.actor_email).toBe("contractor@other.example");
    expect(stored?.target_employee_id).toBeNull();
    expect(stored?.target_user_id).toBeNull();
  });

  it("defaults detail to an empty object and `at` to an ISO timestamp", () => {
    const before = Date.now();
    writeAudit(db, { actor: { email: FIXTURE.admin.email }, action: "import_employees" });
    const after = Date.now();

    const [stored] = rows();
    expect(stored?.detail).toBe("{}");
    expect(parseAuditDetail(stored!)).toEqual({});

    const at = Date.parse(stored!.at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(after + 1000);
    expect(stored?.at).toBe(new Date(at).toISOString());
  });

  it("accepts an injected timestamp", () => {
    const at = new Date("2026-08-13T09:30:00.000Z");
    writeAudit(db, { actor: { email: FIXTURE.admin.email }, action: "deny_request", at });
    expect(rows()[0]?.at).toBe("2026-08-13T09:30:00.000Z");
  });

  it("appends in call order with increasing ids", () => {
    for (const action of ["set_limit", "delete_limit", "approve_request"] as const) {
      writeAudit(db, { actor: { email: FIXTURE.admin.email }, action });
    }

    const stored = rows();
    expect(stored.map((row) => row.action)).toEqual(["set_limit", "delete_limit", "approve_request"]);
    expect(stored.map((row) => row.id)).toEqual([...stored.map((row) => row.id)].sort((a, b) => a - b));
    expect(new Set(stored.map((row) => row.id)).size).toBe(3);
  });
});

describe("parseAuditDetail", () => {
  it.each([
    ["malformed JSON", "{oops"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON null", "null"],
    ["a bare string", '"hello"'],
  ])("returns {} for %s", (_label, detail) => {
    expect(parseAuditDetail({ detail })).toEqual({});
  });
});
