/**
 * Phase 11, the half a browser cannot see: who the queue shows a request to,
 * and what gets written back once the API has decided.
 *
 * Run against the REAL mock over real HTTP (the Phase-8 harness), because the
 * two facts worth proving here — that approving resolves the request AND writes
 * the override, and that denying is idempotent — are the API's semantics (§G4),
 * not ours. A stub client would agree with whatever this code believed.
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
import {
  employees,
  increaseRequestSnapshot,
  spendLimitSnapshot,
  type Employee,
} from "@/db/schema";
import { AnthropicApiError, AnthropicClient } from "@/lib/anthropic/client";
import { loadSnapshotIndex, snapshotFor } from "@/lib/members";
import { loadEditRoles } from "@/lib/permissions";
import {
  findRequest,
  loadEmployeeIndex,
  loadRequestQueue,
  parseSpendSummary,
  requesterOf,
  upsertRequestSnapshot,
} from "@/lib/requests";
import { syncEffective, syncRequests } from "@/lib/sync";

import { eq } from "drizzle-orm";

/* -------------------------------------------------------------------------- */
/* Pure rules                                                                 */
/* -------------------------------------------------------------------------- */

describe("parseSpendSummary", () => {
  it("reads the §G4 shape the API attaches to pending rows", () => {
    const summary = parseSpendSummary(
      JSON.stringify({
        amount: "50000",
        currency: "USD",
        period: "monthly",
        period_to_date_spend: "41280.125",
      }),
    );

    expect(summary).toEqual({
      amount: "50000",
      currency: "USD",
      period: "monthly",
      period_to_date_spend: "41280.125",
    });
  });

  it("keeps a null amount as UNLIMITED rather than as an absent reading (§G9)", () => {
    expect(parseSpendSummary(JSON.stringify({ amount: null, currency: "USD" }))?.amount).toBeNull();
  });

  it("treats an absent or unreadable summary as no summary at all", () => {
    expect(parseSpendSummary(null)).toBeNull();
    expect(parseSpendSummary("not json")).toBeNull();
    expect(parseSpendSummary("[1,2,3]")).toBeNull();
    expect(parseSpendSummary("null")).toBeNull();
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

describe("the increase-request queue", () => {
  let mock: MockServer;
  let db: AppDatabase;
  let client: AnthropicClient;
  let admin: Employee;
  let tier3: Employee;
  let peer: Employee;

  const employeeById = (id: string): Employee =>
    db.select().from(employees).where(eq(employees.id, id)).get()!;

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

    admin = employeeById(FIXTURE.admin.id);
    tier3 = employeeById(FIXTURE.tier3ManagerOfIc.id);
    peer = employeeById(FIXTURE.unrelatedPeer.id);
  }, 120_000);

  afterAll(async () => {
    db.$client.close();
    await mock.close();
  });

  describe("requester lookup", () => {
    it("joins an API actor back to the employee who raised it", () => {
      const found = findRequest(db, FIXTURE.pendingRequestByIc.id);
      expect(found?.requester?.id).toBe(FIXTURE.ic.id);
    });

    it("falls back to the email when claude_user_id has not been backfilled", () => {
      const ic = employeeById(FIXTURE.ic.id);
      db.update(employees).set({ claude_user_id: null }).where(eq(employees.id, ic.id)).run();

      const index = loadEmployeeIndex(db);
      expect(
        requesterOf(index, { actor_user_id: "user_not_synced", actor_email: ic.email.toUpperCase() })
          ?.id,
      ).toBe(ic.id);

      db.update(employees)
        .set({ claude_user_id: ic.claude_user_id })
        .where(eq(employees.id, ic.id))
        .run();
    });

    it("has no requester for an actor nobody on the roster matches", () => {
      const index = loadEmployeeIndex(db);
      expect(requesterOf(index, { actor_user_id: "user_01Ghost", actor_email: null })).toBeNull();
      expect(findRequest(db, "slir_does_not_exist")).toBeNull();
    });
  });

  describe("visibility (§G8)", () => {
    it("shows an admin every request, split by whether it still needs a decision", () => {
      const queue = loadRequestQueue(db, admin, loadEditRoles(db));

      expect(queue.pending).toHaveLength(6);
      expect(queue.resolved).toHaveLength(6);
      expect(queue.pending.every((entry) => entry.status === "pending")).toBe(true);
      expect(queue.pending.every((entry) => entry.actionable)).toBe(true);
      expect(queue.resolved.every((entry) => entry.actionable)).toBe(false);
    });

    it("shows a tier-3 manager their own people and nobody else's", () => {
      const queue = loadRequestQueue(db, tier3, loadEditRoles(db));
      const ids = queue.pending.map((entry) => entry.id);

      expect(ids).toContain(FIXTURE.pendingRequestByIc.id);
      expect(ids).not.toContain(FIXTURE.pendingRequestOutsideTier3Scope.id);
      // The fixture anchor guarantees this manager owns at least two requesters.
      expect(queue.pending.length).toBeGreaterThanOrEqual(2);
      expect(queue.pending.length).toBeLessThan(6);
    });

    it("shows an IC who manages nobody an empty queue", () => {
      const queue = loadRequestQueue(db, peer, loadEditRoles(db));
      expect(queue.pending).toEqual([]);
      expect(queue.resolved).toEqual([]);
    });

    it("reserves requests from unrostered actors for admins, flagged", () => {
      db.insert(increaseRequestSnapshot)
        .values({
          id: "slir_ghost",
          status: "pending",
          actor_user_id: "user_01Ghost",
          actor_name: "Ex Employee",
          actor_email: "ghost@example.com",
          created_at: new Date().toISOString(),
          resolved_at: null,
          spend_summary: null,
          synced_at: new Date().toISOString(),
        })
        .run();

      const forAdmin = loadRequestQueue(db, admin, loadEditRoles(db)).pending.find(
        (entry) => entry.id === "slir_ghost",
      );
      expect(forAdmin?.requester).toBeNull();
      expect(forAdmin?.displayName).toBe("Ex Employee");
      expect(forAdmin?.summary).toBeNull();

      const forManager = loadRequestQueue(db, tier3, loadEditRoles(db)).pending;
      expect(forManager.map((entry) => entry.id)).not.toContain("slir_ghost");

      db.delete(increaseRequestSnapshot).where(eq(increaseRequestSnapshot.id, "slir_ghost")).run();
    });

    it("carries the live spend context a decision needs on pending rows only", () => {
      const queue = loadRequestQueue(db, admin, loadEditRoles(db));
      expect(queue.pending.every((entry) => entry.summary !== null)).toBe(true);
      expect(queue.resolved.every((entry) => entry.summary === null)).toBe(true);

      const summary = queue.pending[0]!.summary!;
      expect(summary.period_to_date_spend).toMatch(/^\d+(\.\d+)?$/);
    });

    it("shows the member's CURRENT cap, not the one cached on the request", () => {
      // Regression. §G4 gives a pending request a LIVE `spend_summary`; ours is
      // frozen at the last `syncRequests`, and no limit write refreshes it —
      // `refreshMemberSnapshot` touches `spend_limit_snapshot` alone. The queue
      // used to read that stale copy, so a member whose cap had just been changed
      // was shown the OLD figure, and the approve dialog prefilled it: accepting
      // the default silently cut their real limit. Simulating the write by moving
      // the snapshot alone is exactly the state a real edit leaves behind.
      const icUserId = db
        .select()
        .from(employees)
        .where(eq(employees.id, FIXTURE.ic.id))
        .get()!.claude_user_id!;

      const original = db
        .select()
        .from(spendLimitSnapshot)
        .where(eq(spendLimitSnapshot.user_id, icUserId))
        .get()!;

      const cached = parseSpendSummary(
        db
          .select()
          .from(increaseRequestSnapshot)
          .where(eq(increaseRequestSnapshot.id, FIXTURE.pendingRequestByIc.id))
          .get()!.spend_summary,
      );
      expect(cached).not.toBeNull();
      expect(cached!.amount).not.toBe("123456");

      db.update(spendLimitSnapshot)
        .set({ amount: "123456", period_to_date_spend: "777" })
        .where(eq(spendLimitSnapshot.user_id, icUserId))
        .run();

      try {
        const entry = loadRequestQueue(db, admin, loadEditRoles(db)).pending.find(
          (candidate) => candidate.id === FIXTURE.pendingRequestByIc.id,
        );

        expect(entry?.summary?.amount).toBe("123456");
        expect(entry?.summary?.period_to_date_spend).toBe("777");
      } finally {
        db.update(spendLimitSnapshot)
          .set({
            amount: original.amount,
            period_to_date_spend: original.period_to_date_spend,
          })
          .where(eq(spendLimitSnapshot.user_id, icUserId))
          .run();
      }
    });
  });

  /* The mutating cases run last: they resolve requests the tests above count. */
  describe("recording the API's answer", () => {
    it("approving resolves the request AND writes the member's override (§G4)", async () => {
      const before = findRequest(db, FIXTURE.pendingRequestByIc.id)!;
      expect(before.row.status).toBe("pending");

      const updated = await client.approveRequest(FIXTURE.pendingRequestByIc.id, "90000", true);
      const row = upsertRequestSnapshot(db, updated);

      expect(row.status).toBe("approved");
      expect(row.resolved_at).not.toBeNull();
      expect(row.spend_summary).toBeNull();

      // The override the approval wrote, read back from the API itself.
      const effective = await client.listEffective({
        user_ids: [before.row.actor_user_id],
        limit: 1,
      });
      expect(effective.data[0]?.amount).toBe("90000");
      expect(effective.data[0]?.source?.type).toBe("user");

      // And it leaves the queue: no longer pending for anyone.
      const queue = loadRequestQueue(db, admin, loadEditRoles(db));
      expect(queue.pending.map((entry) => entry.id)).not.toContain(FIXTURE.pendingRequestByIc.id);
      expect(queue.resolved.map((entry) => entry.id)).toContain(FIXTURE.pendingRequestByIc.id);
    });

    it("refuses to approve the same request twice", async () => {
      await expect(
        client.approveRequest(FIXTURE.pendingRequestByIc.id, "95000", true),
      ).rejects.toBeInstanceOf(AnthropicApiError);
    });

    it("denying is idempotent, and the snapshot stores what the API reported", async () => {
      const target = loadRequestQueue(db, admin, loadEditRoles(db)).pending[0]!;

      const denied = upsertRequestSnapshot(db, await client.denyRequest(target.id, true));
      expect(denied.status).toBe("denied");
      expect(denied.resolved_at).not.toBeNull();

      const again = upsertRequestSnapshot(db, await client.denyRequest(target.id, true));
      expect(again.status).toBe("denied");
      expect(again.resolved_at).toBe(denied.resolved_at);
    });

    it("leaves the local limit snapshot stale until it is re-read", () => {
      // The approval above changed the API but not `spend_limit_snapshot`; that
      // is exactly why the route calls `refreshMemberSnapshot` afterwards.
      const ic = employeeById(FIXTURE.ic.id);
      expect(snapshotFor(loadSnapshotIndex(db), ic)?.amount).not.toBe("90000");
    });
  });
});
