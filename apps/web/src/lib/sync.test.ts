/**
 * Phase 8 verification — the client and the sync engine against the REAL mock.
 *
 * These are integration tests on purpose. The mock API's Hono app is booted
 * in-process on an ephemeral port and driven over actual HTTP, so the client's
 * headers, bracket-notation query strings, opaque cursors and error envelopes
 * are all exercised end to end. A hand-rolled stub would have agreed with
 * whatever the client happened to send, which is precisely the bug class this
 * phase must not ship.
 */

import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import { compareMinorUnits } from "@bsl/shared";
import {
  createApp,
  DEFAULT_ADMIN_KEY,
  DEFAULT_ANALYTICS_KEY,
  MockState,
  type RateLimitSetting,
} from "mock-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { seedDatabase } from "@/db/seed";
import { employees, increaseRequestSnapshot, syncState } from "@/db/schema";
import {
  AnthropicApiError,
  AnthropicClient,
  AnthropicConfigError,
  buildQuery,
  parseRetryAfter,
} from "@/lib/anthropic/client";
import {
  COST_LOOKBACK_DAYS,
  getSyncState,
  isProvisionalDate,
  isStale,
  oldestSyncedAt,
  SYNC_LOCK_RESOURCE,
  syncAll,
  syncCosts,
  syncEffective,
  syncRequests,
} from "@/lib/sync";

const MS_PER_DAY = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface MockServer {
  baseUrl: string;
  state: MockState;
  close(): Promise<void>;
}

/**
 * Boot the mock on an ephemeral port.
 *
 * The universe comes from the memoised seed-42 org, so `FIXTURE` ids line up
 * with what the server serves; `MockState` mutates only its own maps, so each
 * server gets an independent view of the same generated data.
 */
async function startMock(options: {
  now: () => Date;
  rateLimit?: RateLimitSetting;
}): Promise<MockServer> {
  const state = new MockState({ org: getFixtureOrg(), now: options.now });
  const app = createApp({
    state,
    now: options.now,
    adminKey: DEFAULT_ADMIN_KEY,
    analyticsKey: DEFAULT_ANALYTICS_KEY,
    rateLimit: options.rateLimit ?? "off",
  });

  let server: ServerType | undefined;
  const info = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, resolve);
  });
  const handle = server as ServerType;

  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive sockets from the global fetch agent would otherwise hold
        // the server open past the end of the suite.
        (handle as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        handle.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A client with no retries and no access to `process.env`. */
function makeClient(
  baseUrl: string,
  overrides: Partial<ConstructorParameters<typeof AnthropicClient>[0]> = {},
): AnthropicClient {
  return new AnthropicClient({
    baseUrl,
    adminKey: DEFAULT_ADMIN_KEY,
    analyticsKey: DEFAULT_ANALYTICS_KEY,
    maxRetries: 0,
    env: {},
    ...overrides,
  });
}

function freshDb(): AppDatabase {
  const db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
  return db;
}

/** Raw rows, bypassing drizzle's `0`/`1` ↔ boolean mapping. */
function raw<TRow = Record<string, unknown>>(db: AppDatabase, query: string): TRow[] {
  return db.$client.prepare(query).all() as TRow[];
}

function scalar(db: AppDatabase, query: string): number {
  const [row] = raw<Record<string, number>>(db, query);
  return Object.values(row ?? {})[0] ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe("client query building", () => {
  it("serialises arrays with the bracket notation the API requires (§G4)", () => {
    expect(buildQuery({ user_ids: ["a", "b"], limit: 100 })).toBe(
      "?user_ids%5B%5D=a&user_ids%5B%5D=b&limit=100",
    );
  });

  it("drops absent, empty and empty-array values rather than sending them", () => {
    expect(buildQuery({ page: null, status: [], ending_at: undefined, bucket_width: "" })).toBe("");
  });
});

describe("retry-after parsing", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-08-13T12:00:00Z");
    expect(parseRetryAfter("Thu, 13 Aug 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("returns null for a missing or unreadable header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("provisional-date rule (§G5)", () => {
  it("marks a day strictly after the watermark's day", () => {
    expect(isProvisionalDate("2026-08-13", "2026-08-12T09:30:00.000Z")).toBe(true);
  });

  it("does not mark the watermark's own day", () => {
    expect(isProvisionalDate("2026-08-12", "2026-08-12T09:30:00.000Z")).toBe(false);
  });

  it("marks nothing when no watermark has been recorded", () => {
    expect(isProvisionalDate("2026-08-13", null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 1 + 2 — a full sync                                              */
/* -------------------------------------------------------------------------- */

describe("syncAll against the mock API", () => {
  let mock: MockServer;
  let db: AppDatabase;

  beforeAll(async () => {
    const clock = new Date();
    mock = await startMock({ now: () => clock });
    db = freshDb();
    const result = await syncAll(db, makeClient(mock.baseUrl), { now: () => clock });
    expect(result.ran).toBe(true);
    expect(result.outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    db.$client.close();
    await mock.close();
  });

  it("mirrors one effective row per member — all 250, across three pages", () => {
    expect(scalar(db, "SELECT COUNT(*) FROM spend_limit_snapshot")).toBe(250);
  });

  it("mirrors every increase request, six of them pending", () => {
    expect(scalar(db, "SELECT COUNT(*) FROM increase_request_snapshot")).toBe(12);
    expect(
      scalar(db, "SELECT COUNT(*) FROM increase_request_snapshot WHERE status = 'pending'"),
    ).toBe(6);
  });

  it("carries spend_summary on pending rows only (§G4)", () => {
    expect(
      scalar(
        db,
        "SELECT COUNT(*) FROM increase_request_snapshot WHERE status = 'pending' AND spend_summary IS NULL",
      ),
    ).toBe(0);
    expect(
      scalar(
        db,
        "SELECT COUNT(*) FROM increase_request_snapshot WHERE status <> 'pending' AND spend_summary IS NOT NULL",
      ),
    ).toBe(0);
  });

  it("stores daily cost for at least 200 distinct users", () => {
    expect(scalar(db, "SELECT COUNT(DISTINCT user_id) FROM user_daily_cost")).toBeGreaterThanOrEqual(
      200,
    );
  });

  it("leaves all three sync_state rows idle with a timestamp", () => {
    for (const resource of ["effective", "requests", "costs"] as const) {
      const row = getSyncState(db, resource);
      expect(row, resource).not.toBeNull();
      expect(row?.status, resource).toBe("idle");
      expect(row?.last_synced_at, resource).not.toBeNull();
      expect(row?.error, resource).toBeNull();
    }
    expect(getSyncState(db, SYNC_LOCK_RESOURCE)?.status).toBe("idle");
    expect(oldestSyncedAt(db)).not.toBeNull();
  });

  it("reports the snapshot as fresh straight after a sync, and stale an hour later", () => {
    expect(isStale(db)).toBe(false);
    expect(isStale(db, undefined, new Date(Date.now() + 60 * 60 * 1000))).toBe(true);
  });

  /* --- Criterion 2 ---------------------------------------------------- */

  it("backfills employees.claude_user_id from the matching actor email", () => {
    const employee = db.select().from(employees).all().find((row) => row.id === FIXTURE.ic.id);
    expect(employee?.claude_user_id).not.toBeNull();

    const [snapshot] = raw<{ user_id: string; actor_email: string }>(
      db,
      `SELECT user_id, actor_email FROM spend_limit_snapshot WHERE actor_email = '${FIXTURE.ic.email.toLowerCase()}'`,
    );
    expect(snapshot).toBeDefined();
    expect(employee?.claude_user_id).toBe(snapshot?.user_id);
  });

  it("matches every actor against the roster, leaving nobody unmatched", () => {
    expect(
      scalar(db, "SELECT COUNT(*) FROM employees WHERE claude_user_id IS NOT NULL"),
    ).toBe(250);
  });

  /* --- Snapshot fidelity ---------------------------------------------- */

  it("keeps the whole source object so an unknown source kind would survive", () => {
    const [row] = raw<{ source_type: string; source_detail: string }>(
      db,
      `SELECT source_type, source_detail FROM spend_limit_snapshot
       WHERE user_id = '${FIXTURE.seatTierOnlyMember.claude_user_id}'`,
    );
    expect(row?.source_type).toBe("seat_tier");
    expect(JSON.parse(row?.source_detail ?? "{}")).toMatchObject({ type: "seat_tier" });
  });

  it("stores an unlimited override as a NULL amount, not as a zero (§G9)", () => {
    const [row] = raw<{ amount: string | null }>(
      db,
      `SELECT amount FROM spend_limit_snapshot
       WHERE user_id = '${FIXTURE.unlimitedOverrideMember.claude_user_id}'`,
    );
    expect(row?.amount).toBeNull();

    const [zero] = raw<{ amount: string | null }>(
      db,
      `SELECT amount FROM spend_limit_snapshot
       WHERE user_id = '${FIXTURE.zeroCapMember.claude_user_id}'`,
    );
    expect(zero?.amount).toBe("0");
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 6 — write pass-through                                           */
/* -------------------------------------------------------------------------- */

describe("write pass-through then re-sync", () => {
  let mock: MockServer;
  let db: AppDatabase;

  beforeEach(async () => {
    const clock = new Date();
    mock = await startMock({ now: () => clock });
    db = freshDb();
  });

  afterEach(async () => {
    db.$client.close();
    await mock.close();
  });

  it("reflects a POSTed user limit in the next effective snapshot", async () => {
    const client = makeClient(mock.baseUrl);
    const userId = FIXTURE.ic.claude_user_id;

    await syncEffective(db, client);
    const before = raw<{ amount: string | null; source_type: string }>(
      db,
      `SELECT amount, source_type FROM spend_limit_snapshot WHERE user_id = '${userId}'`,
    )[0];
    // The fixture IC deliberately has no override, so this is a real
    // inherited → user transition rather than an amount swap.
    expect(before?.source_type).not.toBe("user");

    const written = await client.setUserLimit(userId, "90000");
    expect(written.amount).toBe("90000");

    await syncEffective(db, client);
    const after = raw<{ amount: string | null; source_type: string; spend_limit_id: string }>(
      db,
      `SELECT amount, source_type, spend_limit_id FROM spend_limit_snapshot WHERE user_id = '${userId}'`,
    )[0];
    expect(after?.amount).toBe("90000");
    expect(after?.source_type).toBe("user");
    expect(after?.spend_limit_id).toBe(written.id);
  }, 30_000);

  it("removes the override again on delete, reverting the snapshot's source", async () => {
    const client = makeClient(mock.baseUrl);
    const userId = FIXTURE.ic.claude_user_id;

    const written = await client.setUserLimit(userId, "90000");
    await syncEffective(db, client);
    expect(
      raw<{ source_type: string }>(
        db,
        `SELECT source_type FROM spend_limit_snapshot WHERE user_id = '${userId}'`,
      )[0]?.source_type,
    ).toBe("user");

    await client.deleteSpendLimit(written.id);
    await syncEffective(db, client);
    expect(
      raw<{ source_type: string }>(
        db,
        `SELECT source_type FROM spend_limit_snapshot WHERE user_id = '${userId}'`,
      )[0]?.source_type,
    ).not.toBe("user");
  }, 30_000);

  it("resolves an approved request and writes the limit in one call", async () => {
    const client = makeClient(mock.baseUrl);
    const approved = await client.approveRequest(FIXTURE.pendingRequestByIc.id, "123400");
    expect(approved.status).toBe("approved");
    expect(approved.resolved_at).not.toBeNull();

    await syncRequests(db, client);
    const [row] = raw<{ status: string; resolved_at: string | null }>(
      db,
      `SELECT status, resolved_at FROM increase_request_snapshot WHERE id = '${FIXTURE.pendingRequestByIc.id}'`,
    );
    expect(row?.status).toBe("approved");
    expect(row?.resolved_at).not.toBeNull();

    // Approving a resolved request conflicts — the client surfaces it as a
    // typed error rather than a silent no-op.
    await expect(client.approveRequest(FIXTURE.pendingRequestByIc.id, "1")).rejects.toBeInstanceOf(
      AnthropicApiError,
    );
  }, 30_000);

  it("retires a pending request the API no longer lists, but keeps resolved history", async () => {
    // §G4 drops ex-members' requests from the listing. A vanished PENDING row
    // used to survive here forever and stay actionable: approving it hit a 404
    // the route reports as "already resolved — refresh the queue", and refreshing
    // never cleared it. It records no decision, so it goes. A vanished RESOLVED
    // row is the record of a decision someone made, so it stays.
    const now = new Date().toISOString();
    const ghost = (id: string, status: string): void => {
      db.insert(increaseRequestSnapshot)
        .values({
          id,
          status,
          actor_user_id: "user_01DepartedPerson",
          actor_name: "Departed Person",
          actor_email: "departed@example.com",
          created_at: now,
          resolved_at: status === "pending" ? null : now,
          spend_summary: null,
          synced_at: now,
        })
        .run();
    };

    ghost("slir_vanished_pending", "pending");
    ghost("slir_vanished_resolved", "approved");

    const result = await syncRequests(db, makeClient(mock.baseUrl));

    expect(result.retired).toBe(1);
    expect(
      raw<{ id: string }>(
        db,
        `SELECT id FROM increase_request_snapshot WHERE id = 'slir_vanished_pending'`,
      ),
    ).toHaveLength(0);
    expect(
      raw<{ id: string }>(
        db,
        `SELECT id FROM increase_request_snapshot WHERE id = 'slir_vanished_resolved'`,
      ),
    ).toHaveLength(1);

    // Requests the API DID list are untouched by the reconciliation.
    expect(
      raw<{ count: number }>(
        db,
        `SELECT COUNT(*) AS count FROM increase_request_snapshot WHERE actor_user_id != 'user_01DepartedPerson'`,
      )[0]?.count,
    ).toBe(12);

    db.delete(increaseRequestSnapshot)
      .where(eq(increaseRequestSnapshot.id, "slir_vanished_resolved"))
      .run();
  }, 30_000);
});

/* -------------------------------------------------------------------------- */
/* Criterion 3 — authentication failure and recovery                          */
/* -------------------------------------------------------------------------- */

describe("failure recording and recovery", () => {
  let mock: MockServer;
  let db: AppDatabase;

  beforeEach(async () => {
    const clock = new Date();
    mock = await startMock({ now: () => clock });
    db = freshDb();
  });

  afterEach(async () => {
    db.$client.close();
    await mock.close();
  });

  it("throws a typed authentication error, records it, and recovers on the next run", async () => {
    const bad = makeClient(mock.baseUrl, { adminKey: "not-the-admin-key" });

    const error = await syncEffective(db, bad).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AnthropicApiError);
    expect((error as AnthropicApiError).errorType).toBe("authentication_error");
    expect((error as AnthropicApiError).status).toBe(401);
    expect((error as AnthropicApiError).requestId).toMatch(/^req_/);

    const failed = getSyncState(db, "effective");
    expect(failed?.status).toBe("error");
    expect(failed?.error).toBeTruthy();
    // A failed sync must not look fresh: the snapshot really is as old as it was.
    expect(failed?.last_synced_at).toBeNull();
    expect(isStale(db)).toBe(true);

    const result = await syncAll(db, makeClient(mock.baseUrl));
    expect(result.ok).toBe(true);
    const recovered = getSyncState(db, "effective");
    expect(recovered?.status).toBe("idle");
    expect(recovered?.error).toBeNull();
    expect(recovered?.last_synced_at).not.toBeNull();
  }, 120_000);

  it("keeps syncing the other resources when one surface fails", async () => {
    const client = makeClient(mock.baseUrl, { analyticsKey: "not-the-analytics-key" });
    const result = await syncAll(db, client);

    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.outcomes.map((outcome) => [outcome.resource, outcome.ok])).toEqual([
      ["effective", true],
      ["requests", true],
      ["costs", false],
    ]);
    expect(scalar(db, "SELECT COUNT(*) FROM spend_limit_snapshot")).toBe(250);
    expect(getSyncState(db, "costs")?.status).toBe("error");
    expect(getSyncState(db, SYNC_LOCK_RESOURCE)?.status).toBe("error");
  }, 60_000);

  it("rejects the Admin key on the analytics surface — the keys are not interchangeable (§G5)", async () => {
    const client = makeClient(mock.baseUrl, { analyticsKey: DEFAULT_ADMIN_KEY });
    await expect(
      client.userCostReport({ starting_at: new Date(Date.now() - MS_PER_DAY).toISOString() }),
    ).rejects.toMatchObject({ status: 401, errorType: "authentication_error" });
  });

  it("refuses to call a surface whose key is not configured", async () => {
    const client = new AnthropicClient({ baseUrl: mock.baseUrl, env: {} });
    await expect(client.listEffective()).rejects.toBeInstanceOf(AnthropicConfigError);
  });

  it("surfaces a 404 as a typed not_found_error", async () => {
    await expect(makeClient(mock.baseUrl).getSpendLimit("spl_nope")).rejects.toMatchObject({
      status: 404,
      errorType: "not_found_error",
    });
  });

  it("retries once on a 429 and honours retry-after", async () => {
    const clock = new Date();
    const limited = await startMock({ now: () => clock, rateLimit: 1 });
    const slept: number[] = [];
    const client = makeClient(limited.baseUrl, {
      maxRetries: 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    try {
      // Spends the single allowed request for this minute…
      await client.listEffective({ limit: 1 });
      // …so this one is rate limited, retried once, and limited again.
      await expect(client.listEffective({ limit: 1 })).rejects.toMatchObject({
        status: 429,
        errorType: "rate_limit_error",
      });
      expect(slept).toHaveLength(1);
      expect(slept[0]).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Criterion 4 — provisional tail and revision                                */
/* -------------------------------------------------------------------------- */

describe("cost freshness (§G5)", () => {
  it("flags the provisional tail, then revises it upward once the watermark passes", async () => {
    let clock = new Date();
    const mock = await startMock({ now: () => clock });
    const db = freshDb();
    const client = makeClient(mock.baseUrl);

    try {
      const first = await syncCosts(db, client, { now: () => clock });
      expect(first.dataRefreshedAt).not.toBeNull();
      expect(getSyncState(db, "costs")?.data_refreshed_at).toBe(first.dataRefreshedAt);

      const watermark = first.dataRefreshedAt ?? "";
      const provisional = raw<{ user_id: string; date: string; amount: string }>(
        db,
        `SELECT user_id, date, amount FROM user_daily_cost
         WHERE provisional = 1 ORDER BY CAST(amount AS REAL) DESC LIMIT 1`,
      )[0];

      expect(provisional, "the mock always has a post-watermark day").toBeDefined();
      expect(provisional!.date > watermark).toBe(true);
      expect(first.provisional).toBeGreaterThan(0);

      // Nothing on or before the watermark may be flagged.
      expect(
        scalar(
          db,
          `SELECT COUNT(*) FROM user_daily_cost WHERE provisional = 1 AND date <= '${watermark.slice(0, 10)}'`,
        ),
      ).toBe(0);

      // Advance the shared clock past that day. The mock stops deflating it and
      // reports the eventual value — the revision a consumer must observe.
      clock = new Date(clock.getTime() + 3 * MS_PER_DAY);

      const second = await syncCosts(db, client, { now: () => clock });
      expect(second.dataRefreshedAt! > watermark).toBe(true);

      const [revised] = raw<{ amount: string; provisional: number }>(
        db,
        `SELECT amount, provisional FROM user_daily_cost
         WHERE user_id = '${provisional!.user_id}' AND date = '${provisional!.date}'`,
      );
      expect(compareMinorUnits(revised!.amount, provisional!.amount)).toBe(1);
      expect(revised!.provisional).toBe(0);
    } finally {
      db.$client.close();
      await mock.close();
    }
  }, 120_000);

  it("re-reads a window wide enough to cover the §G5 revision horizon", async () => {
    const clock = new Date("2026-08-13T12:00:00.000Z");
    const mock = await startMock({ now: () => clock });
    const db = freshDb();

    try {
      const seen: string[] = [];
      const client = makeClient(mock.baseUrl, {
        fetch: async (input, init) => {
          seen.push(String(input));
          return fetch(input as string, init);
        },
      });

      const result = await syncCosts(db, client, { now: () => clock });
      expect(result.startingAt).toBe(
        new Date(clock.getTime() - COST_LOOKBACK_DAYS * MS_PER_DAY).toISOString(),
      );
      expect(COST_LOOKBACK_DAYS).toBeGreaterThan(30);
      expect(seen[0]).toContain("bucket_width=1d");
      expect(seen[0]).toContain("limit=100");
      // Sequential paging, one request at a time (§G4 rate-limit posture).
      expect(seen.length).toBeGreaterThan(1);
    } finally {
      db.$client.close();
      await mock.close();
    }
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/* Criterion 5 — the run lock                                                 */
/* -------------------------------------------------------------------------- */

describe("the whole-run lock", () => {
  let mock: MockServer;
  let db: AppDatabase;

  beforeEach(async () => {
    const clock = new Date();
    mock = await startMock({ now: () => clock });
    db = freshDb();
  });

  afterEach(async () => {
    db.$client.close();
    await mock.close();
  });

  function holdLock(takenAt: Date): void {
    db.insert(syncState)
      .values({
        resource: SYNC_LOCK_RESOURCE,
        status: "running",
        last_synced_at: takenAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: syncState.resource,
        set: { status: "running", last_synced_at: takenAt.toISOString() },
      })
      .run();
  }

  it("makes no API call at all while a fresh lock is held", async () => {
    let calls = 0;
    const client = makeClient(mock.baseUrl, {
      fetch: async (input, init) => {
        calls += 1;
        return fetch(input as string, init);
      },
    });

    holdLock(new Date());
    const result = await syncAll(db, client);

    expect(result.ran).toBe(false);
    expect(result.outcomes).toEqual([]);
    expect(calls).toBe(0);
    expect(scalar(db, "SELECT COUNT(*) FROM spend_limit_snapshot")).toBe(0);
  });

  it("breaks a lock older than the stale-lock window", async () => {
    let calls = 0;
    // Every surface fails fast, so the run proves the lock was taken without
    // paging the whole org.
    const client = makeClient(mock.baseUrl, {
      adminKey: "wrong",
      analyticsKey: "wrong",
      fetch: async (input, init) => {
        calls += 1;
        return fetch(input as string, init);
      },
    });

    holdLock(new Date(Date.now() - 11 * 60 * 1000));
    const result = await syncAll(db, client);

    expect(result.ran).toBe(true);
    expect(calls).toBe(3);
    expect(result.outcomes.every((outcome) => !outcome.ok)).toBe(true);
  });
});
