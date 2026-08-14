/**
 * Contract tests for `/v1/organizations/spend_limits` (plan §Phase 4, §G4).
 *
 * Everything runs through `app.request()` — the real routing, middleware and
 * serialisation stack, no socket. Each test gets a fresh {@link MockState} so
 * writes in one cannot leak into another, but they all share the memoised
 * seed-42 universe behind `getFixtureOrg()`, which is what makes `FIXTURE`
 * names line up with the ids the server serves.
 */

import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import {
  CURSOR_MISMATCH_MESSAGE,
  EffectiveSpendLimitRowSchema,
  ErrorEnvelopeSchema,
  SpendLimitSchema,
  type EffectiveSpendLimitRow,
} from "@bsl/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, SPEND_LIMITS_PATH } from "./app.js";
import { parseRateLimitSetting } from "./rate-limit.js";
import { MockState } from "./state.js";

const ADMIN_KEY = "test-admin-key";
const EFFECTIVE = `${SPEND_LIMITS_PATH}/effective`;

let state: MockState;
let app: Hono;

beforeEach(() => {
  state = new MockState({ org: getFixtureOrg() });
  app = createApp({ state, adminKey: ADMIN_KEY, rateLimit: "off" });
});

/** Authenticated request. Pass `key: null` to send no `x-api-key` at all. */
async function call(
  path: string,
  options: { method?: string; body?: unknown; key?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.key !== null) headers["x-api-key"] = options.key ?? ADMIN_KEY;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function expectError(
  response: Response,
  status: number,
): Promise<{ type: string; message: string }> {
  expect(response.status).toBe(status);
  const body = ErrorEnvelopeSchema.parse(await response.json());
  expect(body.request_id).toMatch(/^req_/);
  return body.error;
}

interface RawEnvelope {
  data: unknown[];
  next_page: string | null;
}

async function effectivePage(query: string): Promise<RawEnvelope> {
  const response = await call(`${EFFECTIVE}?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RawEnvelope;
}

/** Page `/effective` to exhaustion, returning the raw rows and the page count. */
async function drainEffective(query = "limit=100"): Promise<{ rows: unknown[]; pages: number }> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const suffix: string = cursor === null ? "" : `&page=${encodeURIComponent(cursor)}`;
    const envelope = await effectivePage(`${query}${suffix}`);
    rows.push(...envelope.data);
    cursor = envelope.next_page;
    pages += 1;
  } while (cursor !== null);
  return { rows, pages };
}

/** The single `effective` row for one member, fetched through the user filter. */
async function effectiveRowFor(userId: string): Promise<EffectiveSpendLimitRow> {
  const envelope = await effectivePage(`user_ids[]=${userId}`);
  expect(envelope.data).toHaveLength(1);
  return EffectiveSpendLimitRowSchema.parse(envelope.data[0]);
}

describe("authentication", () => {
  it("rejects a request with no x-api-key", async () => {
    const error = await expectError(await call(EFFECTIVE, { key: null }), 401);
    expect(error.type).toBe("authentication_error");
  });

  it("rejects a request with the wrong x-api-key", async () => {
    const error = await expectError(await call(EFFECTIVE, { key: "nope" }), 401);
    expect(error.type).toBe("authentication_error");
  });
});

describe("GET /spend_limits/effective", () => {
  it("returns one row per member across three pages of 100", async () => {
    const { rows, pages } = await drainEffective("limit=100");

    expect(rows).toHaveLength(250);
    expect(pages).toBe(3);

    const parsed = rows.map((row) => EffectiveSpendLimitRowSchema.parse(row));
    const userIds = new Set(parsed.map((row) => row.actor.user_id));
    expect(userIds.size).toBe(250);
    expect(userIds).toEqual(new Set(getFixtureOrg().employees.map((e) => e.claude_user_id)));
  });

  it("pages in a stable actor-name order", async () => {
    const { rows } = await drainEffective("limit=37");
    const names = rows.map((row) => EffectiveSpendLimitRowSchema.parse(row).actor.name ?? "");
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("reports the resolved source for each level of the hierarchy", async () => {
    const seatTierRow = await effectiveRowFor(FIXTURE.seatTierOnlyMember.claude_user_id);
    expect(seatTierRow.source?.type).toBe("seat_tier");
    expect(seatTierRow.amount).not.toBeNull();

    const overrideRow = await effectiveRowFor(FIXTURE.overrideMember.claude_user_id);
    expect(overrideRow.source?.type).toBe("user");

    const unlimitedRow = await effectiveRowFor(FIXTURE.unlimitedOverrideMember.claude_user_id);
    expect(unlimitedRow.source?.type).toBe("user");
    expect(unlimitedRow.amount).toBeNull();

    const zeroRow = await effectiveRowFor(FIXTURE.zeroCapMember.claude_user_id);
    expect(zeroRow.amount).toBe("0");
  });

  it("points spend_limit_id at a retrievable configured row", async () => {
    const row = await effectiveRowFor(FIXTURE.seatTierOnlyMember.claude_user_id);
    expect(row.spend_limit_id).toMatch(/^spl_/);

    const response = await call(`${SPEND_LIMITS_PATH}/${row.spend_limit_id}`);
    expect(response.status).toBe(200);
    const limit = SpendLimitSchema.parse(await response.json());
    expect(limit.scope.type).toBe("seat_tier");
    expect(limit.amount).toBe(row.amount);
  });

  it("filters by period[] and rejects an unusable limit", async () => {
    const matching = await effectivePage("period[]=monthly&limit=100");
    expect(matching.data).toHaveLength(100);

    const empty = await effectivePage("period[]=quarterly&limit=100");
    expect(empty.data).toHaveLength(0);
    expect(empty.next_page).toBeNull();

    const error = await expectError(await call(`${EFFECTIVE}?limit=500`), 400);
    expect(error.type).toBe("invalid_request_error");
  });

  it("rejects a cursor replayed under different filters", async () => {
    const firstPage = await effectivePage("limit=100");
    expect(firstPage.next_page).not.toBeNull();

    const replay = await call(
      `${EFFECTIVE}?limit=100&user_ids[]=${FIXTURE.ic.claude_user_id}&page=${encodeURIComponent(firstPage.next_page ?? "")}`,
    );
    const error = await expectError(replay, 400);
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain(CURSOR_MISMATCH_MESSAGE);
  });

  it("accepts a cursor replayed under the same filters", async () => {
    const query = `user_ids[]=${FIXTURE.ic.claude_user_id}&user_ids[]=${FIXTURE.admin.claude_user_id}&limit=1`;
    const firstPage = await effectivePage(query);
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.next_page).not.toBeNull();

    const secondPage = await effectivePage(
      `${query}&page=${encodeURIComponent(firstPage.next_page ?? "")}`,
    );
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.next_page).toBeNull();
  });

  it("rejects a malformed cursor", async () => {
    const error = await expectError(await call(`${EFFECTIVE}?page=page_not-a-cursor`), 400);
    expect(error.type).toBe("invalid_request_error");
  });
});

describe("POST /spend_limits", () => {
  const userId = FIXTURE.ic.claude_user_id;

  it("upserts on (scope, period), keeping the same id", async () => {
    const first = await call(SPEND_LIMITS_PATH, {
      method: "POST",
      body: { scope: { type: "user", user_id: userId }, amount: "75000" },
    });
    expect(first.status).toBe(200);
    const created = SpendLimitSchema.parse(await first.json());
    expect(created.amount).toBe("75000");
    expect(created.scope.type).toBe("user");

    const second = await call(SPEND_LIMITS_PATH, {
      method: "POST",
      body: { scope: { type: "user", user_id: userId }, amount: "80000" },
    });
    expect(second.status).toBe(200);
    const updated = SpendLimitSchema.parse(await second.json());
    expect(updated.id).toBe(created.id);
    expect(updated.amount).toBe("80000");

    const row = await effectiveRowFor(userId);
    expect(row.amount).toBe("80000");
    expect(row.source?.type).toBe("user");
    expect(row.spend_limit_id).toBe(created.id);
  });

  it("rejects a non-user scope", async () => {
    const error = await expectError(
      await call(SPEND_LIMITS_PATH, {
        method: "POST",
        body: { scope: { type: "seat_tier", seat_tier: "enterprise_standard" }, amount: "1000" },
      }),
      400,
    );
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("scope.type");
  });

  it("rejects a non-string, negative or absent amount", async () => {
    for (const amount of [undefined, null, 75000, "-5", "abc"]) {
      const error = await expectError(
        await call(SPEND_LIMITS_PATH, {
          method: "POST",
          body: { scope: { type: "user", user_id: userId }, amount },
        }),
        400,
      );
      expect(error.type).toBe("invalid_request_error");
      expect(error.message).toContain("amount");
    }
  });

  it("rejects an unknown user and an unparseable body", async () => {
    const unknown = await expectError(
      await call(SPEND_LIMITS_PATH, {
        method: "POST",
        body: { scope: { type: "user", user_id: "user_01NOBODY" }, amount: "1000" },
      }),
      400,
    );
    expect(unknown.message).toContain("scope.user_id");

    const malformed = await app.request(SPEND_LIMITS_PATH, {
      method: "POST",
      headers: { "x-api-key": ADMIN_KEY, "content-type": "application/json" },
      body: "{not json",
    });
    const error = await expectError(malformed, 400);
    expect(error.type).toBe("invalid_request_error");
  });

  it("does not resolve the member's pending increase request", async () => {
    const before = await call(
      `/v1/organizations/spend_limit_increase_requests/${FIXTURE.pendingRequestByIc.id}`,
    );
    expect(((await before.json()) as { status: string }).status).toBe("pending");

    const written = await call(SPEND_LIMITS_PATH, {
      method: "POST",
      body: { scope: { type: "user", user_id: userId }, amount: "123456" },
    });
    expect(written.status).toBe(200);

    const after = await call(
      `/v1/organizations/spend_limit_increase_requests/${FIXTURE.pendingRequestByIc.id}`,
    );
    const request = (await after.json()) as { status: string; resolved_at: string | null };
    expect(request.status).toBe("pending");
    expect(request.resolved_at).toBeNull();
  });
});

describe("DELETE /spend_limits/{id}", () => {
  it("removes an override so the member re-inherits, then 404s", async () => {
    const userId = FIXTURE.ic.claude_user_id;
    const inherited = await effectiveRowFor(userId);
    expect(inherited.source?.type).not.toBe("user");

    const created = SpendLimitSchema.parse(
      await (
        await call(SPEND_LIMITS_PATH, {
          method: "POST",
          body: { scope: { type: "user", user_id: userId }, amount: "75000" },
        })
      ).json(),
    );
    expect((await effectiveRowFor(userId)).source?.type).toBe("user");

    const deleted = await call(`${SPEND_LIMITS_PATH}/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const reverted = await effectiveRowFor(userId);
    expect(reverted.source).toEqual(inherited.source);
    expect(reverted.amount).toBe(inherited.amount);
    expect(reverted.spend_limit_id).toBe(inherited.spend_limit_id);

    const again = await expectError(
      await call(`${SPEND_LIMITS_PATH}/${created.id}`, { method: "DELETE" }),
      404,
    );
    expect(again.type).toBe("not_found_error");
  });

  it("refuses to delete a non-user scoped row", async () => {
    const seatTierRow = await effectiveRowFor(FIXTURE.seatTierOnlyMember.claude_user_id);
    const error = await expectError(
      await call(`${SPEND_LIMITS_PATH}/${seatTierRow.spend_limit_id}`, { method: "DELETE" }),
      400,
    );
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("seat_tier");
  });

  it("404s on an unknown id for both GET and DELETE", async () => {
    expect((await expectError(await call(`${SPEND_LIMITS_PATH}/spl_nope`), 404)).type).toBe(
      "not_found_error",
    );
    expect(
      (await expectError(await call(`${SPEND_LIMITS_PATH}/spl_nope`, { method: "DELETE" }), 404))
        .type,
    ).toBe("not_found_error");
  });
});

describe("rate limiting", () => {
  it("429s past the configured per-minute allowance", async () => {
    // The clock is pinned deliberately. The limiter buckets by
    // `Math.floor(now / 60_000)` and resets the counter when that index changes,
    // so on the real clock these four requests fail whenever they straddle a
    // minute boundary — the fourth lands in a fresh window and returns 200. That
    // flake was observed once during Phase 9. A frozen `now` keeps all four in
    // one window and makes the assertion deterministic.
    const at = new Date("2026-08-13T12:00:00.000Z");
    const limited = createApp({ state, adminKey: ADMIN_KEY, rateLimit: 3, now: () => at });
    const send = async (): Promise<Response> =>
      limited.request(EFFECTIVE, { headers: { "x-api-key": ADMIN_KEY } });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await send()).status).toBe(200);
    }

    const fourth = await send();
    expect(fourth.headers.get("retry-after")).toMatch(/^\d+$/);
    const error = await expectError(fourth, 429);
    expect(error.type).toBe("rate_limit_error");
  });

  it("starts a fresh allowance in the next minute window", async () => {
    // The other half of the same behaviour, and only testable with an injectable
    // clock: the counter must RESET across the boundary, not merely hold.
    let at = new Date("2026-08-13T12:00:30.000Z");
    const limited = createApp({ state, adminKey: ADMIN_KEY, rateLimit: 1, now: () => at });
    const send = async (): Promise<Response> =>
      limited.request(EFFECTIVE, { headers: { "x-api-key": ADMIN_KEY } });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    at = new Date("2026-08-13T12:01:00.000Z");
    expect((await send()).status).toBe(200);
  });

  it("is off by default", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await call(EFFECTIVE)).status).toBe(200);
    }
  });

  it("parses the MOCK_RATE_LIMIT setting", () => {
    expect(parseRateLimitSetting(undefined)).toBe("off");
    expect(parseRateLimitSetting("")).toBe("off");
    expect(parseRateLimitSetting("off")).toBe("off");
    expect(parseRateLimitSetting("60")).toBe(60);
    expect(() => parseRateLimitSetting("0")).toThrow();
    expect(() => parseRateLimitSetting("lots")).toThrow();
  });
});

describe("environment configuration (§G6)", () => {
  const saved = { ...process.env };

  afterEach(() => {
    // Assigning `undefined` would store the STRING "undefined", so unset instead.
    for (const key of ["MOCK_ADMIN_KEY", "MOCK_RATE_LIMIT"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("takes the admin key and rate limit from the environment", async () => {
    process.env.MOCK_ADMIN_KEY = "env-admin-key";
    process.env.MOCK_RATE_LIMIT = "3";
    const configured = createApp({ state });
    const send = async (key: string): Promise<Response> =>
      configured.request(EFFECTIVE, { headers: { "x-api-key": key } });

    expect((await send(ADMIN_KEY)).status).toBe(401);
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      expect((await send("env-admin-key")).status).toBe(200);
    }
    expect((await send("env-admin-key")).status).toBe(429);
  });
});
