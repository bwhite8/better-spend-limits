/**
 * Contract tests for `/v1/organizations/analytics/user_cost_report`
 * (plan §Phase 5, §G5).
 *
 * Same conventions as the spend-limits suite: real routing through
 * `app.request()`, a fresh {@link MockState} per test over the shared memoised
 * seed-42 universe. The one addition is a MUTABLE CLOCK — `clock` is captured
 * by closure and read per call, so advancing it moves the freshness watermark
 * forward without regenerating the cost series underneath it. Rebuilding state
 * with a later `now` would shift the whole 90-day window and change every
 * amount, which is precisely what the revision test must not do.
 */

import { getFixtureOrg } from "@bsl/seed";
import {
  compareMinorUnits,
  CURSOR_MISMATCH_MESSAGE,
  ErrorEnvelopeSchema,
  minorUnitsToNumber,
  UserCostReportEnvelopeSchema,
  UserCostRowSchema,
  type UserCostRow,
} from "@bsl/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { ANALYTICS_PATH, createApp } from "./app.js";
import { DATA_REFRESH_LAG_MS, deflateProvisional } from "./routes/analytics.js";
import { MockState } from "./state.js";

const ADMIN_KEY = "test-admin-key";
const ANALYTICS_KEY = "test-analytics-key";
const COST_REPORT = `${ANALYTICS_PATH}/user_cost_report`;
const MS_PER_DAY = 86_400_000;

/** Read per request; reassign to advance the mock's clock mid-test. */
let clock: Date;
let state: MockState;
let app: Hono;

beforeEach(() => {
  clock = new Date();
  state = new MockState({ org: getFixtureOrg(), now: () => clock });
  app = createApp({ state, adminKey: ADMIN_KEY, analyticsKey: ANALYTICS_KEY, rateLimit: "off" });
});

/** Analytics-key request by default. `key: null` sends no `x-api-key` at all. */
async function call(path: string, options: { key?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.key !== null) headers["x-api-key"] = options.key ?? ANALYTICS_KEY;
  return app.request(path, { method: "GET", headers });
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
  data_refreshed_at: string;
}

async function report(query: string): Promise<RawEnvelope> {
  const response = await call(`${COST_REPORT}?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RawEnvelope;
}

/** Page to exhaustion, returning parsed rows plus the envelope's watermark. */
async function drain(
  query: string,
): Promise<{ rows: UserCostRow[]; pages: number; refreshedAt: string }> {
  const rows: UserCostRow[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let refreshedAt: string;
  do {
    const suffix: string = cursor === null ? "" : `&page=${encodeURIComponent(cursor)}`;
    const envelope = UserCostReportEnvelopeSchema.parse(await report(`${query}${suffix}`));
    rows.push(...envelope.data);
    refreshedAt = envelope.data_refreshed_at;
    cursor = envelope.next_page;
    pages += 1;
  } while (cursor !== null);
  return { rows, pages, refreshedAt };
}

function isoAt(offsetDays: number): string {
  return new Date(clock.getTime() + offsetDays * MS_PER_DAY).toISOString();
}

function groupByUser(rows: UserCostRow[]): Map<string, UserCostRow[]> {
  const grouped = new Map<string, UserCostRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.actor.user_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.actor.user_id, [row]);
  }
  return grouped;
}

describe("authentication (§G5: the analytics key is not the admin key)", () => {
  it("rejects the Admin API key", async () => {
    const error = await expectError(
      await call(`${COST_REPORT}?starting_at=${isoAt(-7)}`, { key: ADMIN_KEY }),
      401,
    );
    expect(error.type).toBe("authentication_error");
    expect(error.message).toContain("Analytics API");
  });

  it("rejects a missing key", async () => {
    const error = await expectError(
      await call(`${COST_REPORT}?starting_at=${isoAt(-7)}`, { key: null }),
      401,
    );
    expect(error.type).toBe("authentication_error");
  });

  it("accepts the Analytics API key", async () => {
    const response = await call(`${COST_REPORT}?starting_at=${isoAt(-7)}`);
    expect(response.status).toBe(200);
  });
});

describe("query parameters", () => {
  it("requires starting_at", async () => {
    const error = await expectError(await call(COST_REPORT), 400);
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("starting_at");
  });

  it("rejects an unparseable starting_at", async () => {
    const error = await expectError(await call(`${COST_REPORT}?starting_at=yesterday`), 400);
    expect(error.type).toBe("invalid_request_error");
  });

  it("rejects a bucket_width other than 1d", async () => {
    const error = await expectError(
      await call(`${COST_REPORT}?starting_at=${isoAt(-7)}&bucket_width=7d`),
      400,
    );
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("bucket_width");
  });

  it("rejects ending_at before starting_at", async () => {
    const error = await expectError(
      await call(`${COST_REPORT}?starting_at=${isoAt(-7)}&ending_at=${isoAt(-30)}`),
      400,
    );
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("ending_at");
  });
});

describe("totals (no bucket_width)", () => {
  it("returns one row per member, highest spend first, with no date", async () => {
    const { rows } = await drain(`starting_at=${isoAt(-30)}&limit=100`);

    expect(rows.length).toBeGreaterThan(200);
    expect(rows.length).toBeLessThanOrEqual(state.members.length);

    for (const row of rows) {
      // Re-parsed individually so the assertion names the row schema, not the
      // envelope, per the acceptance criterion.
      expect(UserCostRowSchema.parse(row).date).toBeUndefined();
    }

    const userIds = new Set(rows.map((row) => row.actor.user_id));
    expect(userIds.size).toBe(rows.length);

    // Sorted descending: no row ever exceeds the one before it, and the first
    // is at least the last.
    for (let index = 1; index < rows.length; index += 1) {
      expect(compareMinorUnits(rows[index - 1]!.amount, rows[index]!.amount)).toBeGreaterThanOrEqual(
        0,
      );
    }
    expect(compareMinorUnits(rows[0]!.amount, rows[rows.length - 1]!.amount)).toBeGreaterThanOrEqual(
      0,
    );
  });
});

describe("bucket_width=1d", () => {
  it("returns member-days inside the window and an ISO watermark ~36h old", async () => {
    // 13 days back plus today, inclusive at both ends, is exactly 14 days.
    const startingAt = isoAt(-13);
    const firstDay = startingAt.slice(0, 10);
    const lastDay = clock.toISOString().slice(0, 10);

    const { rows, refreshedAt } = await drain(
      `starting_at=${startingAt}&bucket_width=1d&limit=100`,
    );

    expect(rows.length).toBeGreaterThan(0);
    const grouped = groupByUser(rows);
    for (const memberRows of grouped.values()) {
      expect(memberRows.length).toBeLessThanOrEqual(14);
      for (const row of memberRows) {
        expect(row.date).toBeDefined();
        expect(row.date! >= firstDay && row.date! <= lastDay).toBe(true);
      }
    }

    // A chosen member — the busiest in the window — still obeys the bound and
    // has at least one row, so the ≤14 assertion above is not vacuous.
    const busiest = [...grouped.values()].sort((a, b) => b.length - a.length)[0]!;
    expect(busiest.length).toBeGreaterThan(0);
    expect(busiest.length).toBeLessThanOrEqual(14);

    expect(refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const skew = Math.abs(
      new Date(refreshedAt).getTime() - (clock.getTime() - DATA_REFRESH_LAG_MS),
    );
    expect(skew).toBeLessThan(5 * 60 * 1000);
  });
});

describe("freshness semantics (§G5 provisional tail)", () => {
  it("reports post-watermark days at 80% and revises them once the watermark passes", async () => {
    const query = `starting_at=${isoAt(-7)}&bucket_width=1d&limit=100`;

    const first = await drain(query);
    const refreshedDay = first.refreshedAt.slice(0, 10);
    const provisional = first.rows.filter((row) => (row.date ?? "") > refreshedDay);
    expect(provisional.length).toBeGreaterThan(0);

    const target = provisional[0]!;

    // Advance the clock three days: the watermark moves past `target.date`, so
    // the same member-day is now settled data.
    clock = new Date(clock.getTime() + 3 * MS_PER_DAY);

    const second = await drain(query);
    expect(second.refreshedAt.slice(0, 10) >= (target.date ?? "")).toBe(true);

    const settled = second.rows.find(
      (row) => row.actor.user_id === target.actor.user_id && row.date === target.date,
    );
    expect(settled).toBeDefined();

    // Exact: the provisional value IS 80% of the settled one, to the digit.
    expect(compareMinorUnits(deflateProvisional(settled!.amount), target.amount)).toBe(0);
    // …and therefore trivially within the ±1 cent the criterion allows.
    expect(
      Math.abs(minorUnitsToNumber(target.amount) - 0.8 * minorUnitsToNumber(settled!.amount)),
    ).toBeLessThanOrEqual(1);
    // A revision is only observable if it actually moved.
    expect(compareMinorUnits(settled!.amount, target.amount)).toBe(1);
  });

  it("marks nothing provisional once the whole window is behind the watermark", async () => {
    const { rows, refreshedAt } = await drain(
      `starting_at=${isoAt(-30)}&ending_at=${isoAt(-10)}&bucket_width=1d&limit=100`,
    );
    const refreshedDay = refreshedAt.slice(0, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => (row.date ?? "") <= refreshedDay)).toBe(true);
  });
});

describe("pagination", () => {
  it("binds cursors to the query that issued them", async () => {
    const startingAt = isoAt(-7);
    const envelope = await report(`starting_at=${startingAt}&bucket_width=1d&limit=1`);
    expect(envelope.next_page).not.toBeNull();

    const replay = await call(
      `${COST_REPORT}?starting_at=${isoAt(-14)}&bucket_width=1d&limit=1&page=${encodeURIComponent(envelope.next_page!)}`,
    );
    const error = await expectError(replay, 400);
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain(CURSOR_MISMATCH_MESSAGE);
  });

  it("pages a bucketed report to exhaustion without dropping or repeating rows", async () => {
    const query = `starting_at=${isoAt(-3)}&bucket_width=1d`;
    const paged = await drain(`${query}&limit=25`);
    const single = await drain(`${query}&limit=100`);

    expect(paged.pages).toBeGreaterThan(1);
    expect(paged.rows.length).toBe(single.rows.length);
    expect(paged.rows.map((row) => `${row.actor.user_id}:${row.date}`)).toEqual(
      single.rows.map((row) => `${row.actor.user_id}:${row.date}`),
    );
  });
});
