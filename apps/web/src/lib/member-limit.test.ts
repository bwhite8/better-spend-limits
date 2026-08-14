/**
 * Phase 10, the half a browser cannot see: amount validation, the targeted
 * snapshot refresh, and the pending-request lookup.
 *
 * The write path is exercised against the REAL mock over real HTTP, the same
 * harness Phase 8 uses. A stub client would happily agree that a member's source
 * flips to `"user"` after a write; only the actual API decides that, and this
 * phase's whole job is to keep the local snapshot honest about it.
 */

import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import { createApp, DEFAULT_ADMIN_KEY, DEFAULT_ANALYTICS_KEY, MockState } from "mock-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { seedDatabase } from "@/db/seed";
import { employees, type Employee } from "@/db/schema";
import { AnthropicClient } from "@/lib/anthropic/client";
import { minorUnitsToDollarsInput } from "@/lib/dollars";
import {
  LimitWriteError,
  pendingRequestExists,
  refreshMemberSnapshot,
  requireWireAmount,
} from "@/lib/member-limit";
import { loadSnapshotIndex, snapshotFor } from "@/lib/members";
import { syncEffective, syncRequests } from "@/lib/sync";

import { eq } from "drizzle-orm";

/* -------------------------------------------------------------------------- */
/* Pure rules                                                                 */
/* -------------------------------------------------------------------------- */

describe("requireWireAmount", () => {
  it("accepts non-negative decimal minor units (§G9)", () => {
    expect(requireWireAmount("75000")).toBe("75000");
    expect(requireWireAmount("0")).toBe("0");
    expect(requireWireAmount(" 41280.125 ")).toBe("41280.125");
  });

  it("rejects what the browser would never send", () => {
    for (const value of ["-500", "1e5", "750.00abc", "", "$750", null, undefined, 75000]) {
      expect(() => requireWireAmount(value)).toThrow(LimitWriteError);
    }
  });

  it("reports 400 so the route does not have to guess a status", () => {
    try {
      requireWireAmount("-5");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LimitWriteError);
      expect((error as LimitWriteError).status).toBe(400);
      expect((error as LimitWriteError).code).toBe("invalid_amount");
    }
  });
});

describe("minorUnitsToDollarsInput", () => {
  it("round-trips through the form's own parser", () => {
    expect(minorUnitsToDollarsInput("75000")).toBe("750.00");
    expect(minorUnitsToDollarsInput("50")).toBe("0.50");
    expect(minorUnitsToDollarsInput("150000")).toBe("1500.00");
    // No commas: the value has to be re-readable by dollarsInputToMinorUnits.
    expect(minorUnitsToDollarsInput("150000")).not.toContain(",");
  });

  it("rounds fractional cents half-up, as the display formatter does", () => {
    expect(minorUnitsToDollarsInput("41280.5")).toBe("412.81");
    expect(minorUnitsToDollarsInput("41280.125")).toBe("412.80");
  });

  it("has no dollar value for unlimited or malformed amounts", () => {
    expect(minorUnitsToDollarsInput(null)).toBe("");
    expect(minorUnitsToDollarsInput("-5")).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* Against the real mock                                                      */
/* -------------------------------------------------------------------------- */

interface MockServer {
  baseUrl: string;
  close(): Promise<void>;
}

async function startMock(now: () => Date): Promise<MockServer> {
  const state = new MockState({ org: getFixtureOrg(), now });
  const app = createApp({
    state,
    now,
    adminKey: DEFAULT_ADMIN_KEY,
    analyticsKey: DEFAULT_ANALYTICS_KEY,
    rateLimit: "off",
  });

  let server: ServerType | undefined;
  const info = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, resolve);
  });
  const handle = server as ServerType;

  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        (handle as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        handle.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("the write path against the mock API", () => {
  let mock: MockServer;
  let db: AppDatabase;
  let client: AnthropicClient;
  let ic: Employee;
  let userId: string;

  const snapshotOf = (employee: Employee) => snapshotFor(loadSnapshotIndex(db), employee);

  beforeAll(async () => {
    const clock = new Date();
    mock = await startMock(() => clock);

    db = createDb(IN_MEMORY_DATABASE);
    runMigrations(db);
    seedDatabase(db);

    client = new AnthropicClient({
      baseUrl: mock.baseUrl,
      adminKey: DEFAULT_ADMIN_KEY,
      analyticsKey: DEFAULT_ANALYTICS_KEY,
      maxRetries: 0,
      env: {},
    });

    await syncEffective(db, client, { now: () => clock });
    await syncRequests(db, client, { now: () => clock });

    ic = db.select().from(employees).where(eq(employees.id, FIXTURE.ic.id)).get()!;
    const snapshot = snapshotOf(ic);
    expect(snapshot).not.toBeNull();
    userId = snapshot!.user_id;
  }, 120_000);

  afterAll(async () => {
    db.$client.close();
    await mock.close();
  });

  it("finds the pending request the §G4 warning is about", () => {
    expect(pendingRequestExists(db, userId)).toBe(true);
    expect(pendingRequestExists(db, "user_does_not_exist")).toBe(false);
    expect(pendingRequestExists(db, null)).toBe(false);
  });

  it("reflects a set override in the member's snapshot row", async () => {
    const before = snapshotOf(ic)!;
    // The fixture guarantees `ic` has no per-user override, so this is a real
    // inherited → override transition.
    expect(before.source_type).not.toBe("user");

    await client.setUserLimit(userId, "75000");
    const row = await refreshMemberSnapshot(db, client, userId);

    expect(row?.amount).toBe("75000");
    expect(row?.source_type).toBe("user");
    expect(row?.spend_limit_id).toBeTruthy();
    // Written through to SQLite, not just returned.
    expect(snapshotOf(ic)?.amount).toBe("75000");
  });

  it("touches only the member it was asked about", async () => {
    const other = db.select().from(employees).where(eq(employees.id, FIXTURE.admin.id)).get()!;
    const before = snapshotOf(other)!;

    await client.setUserLimit(userId, "80000");
    await refreshMemberSnapshot(db, client, userId);

    expect(snapshotOf(other)).toEqual(before);
    expect(snapshotOf(ic)?.amount).toBe("80000");
  });

  it("reverts to the inherited source once the override is deleted", async () => {
    const overridden = snapshotOf(ic)!;
    expect(overridden.source_type).toBe("user");

    await client.deleteSpendLimit(overridden.spend_limit_id!);
    const row = await refreshMemberSnapshot(db, client, userId);

    expect(row?.source_type).not.toBe("user");
    // The seeded universe always configures something above the user level, so
    // the fallback is a real inherited amount rather than unlimited.
    expect(row?.amount).not.toBeNull();
    expect(snapshotOf(ic)?.source_type).not.toBe("user");
  });

  it("returns null for a user the API does not list", async () => {
    expect(await refreshMemberSnapshot(db, client, "user_01NotAMember")).toBeNull();
  });
});
