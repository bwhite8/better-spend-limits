/**
 * Contract tests for `/v1/organizations/spend_limit_increase_requests`
 * (plan §Phase 4, §G4 endpoints 5–8).
 *
 * The behaviours that matter here are the state transitions: approving writes a
 * per-user limit AND resolves the request, denying is idempotent, and both
 * refuse to act on a request that is already resolved the other way.
 */

import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import {
  CURSOR_MISMATCH_MESSAGE,
  EffectiveSpendLimitRowSchema,
  ErrorEnvelopeSchema,
  IncreaseRequestSchema,
  type IncreaseRequest,
} from "@bsl/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp, INCREASE_REQUESTS_PATH, SPEND_LIMITS_PATH } from "./app.js";
import { MockState } from "./state.js";

const ADMIN_KEY = "test-admin-key";

let state: MockState;
let app: Hono;

beforeEach(() => {
  state = new MockState({ org: getFixtureOrg() });
  app = createApp({ state, adminKey: ADMIN_KEY, rateLimit: "off" });
});

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

async function listPage(query = ""): Promise<RawEnvelope> {
  const response = await call(`${INCREASE_REQUESTS_PATH}${query === "" ? "" : `?${query}`}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RawEnvelope;
}

async function drain(query = "limit=100"): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  do {
    const suffix: string = cursor === null ? "" : `&page=${encodeURIComponent(cursor)}`;
    const envelope = await listPage(`${query}${suffix}`);
    rows.push(...envelope.data);
    cursor = envelope.next_page;
  } while (cursor !== null);
  return rows;
}

async function getRequest(id: string): Promise<IncreaseRequest> {
  const response = await call(`${INCREASE_REQUESTS_PATH}/${id}`);
  expect(response.status).toBe(200);
  return IncreaseRequestSchema.parse(await response.json());
}

async function effectiveRowFor(userId: string): Promise<unknown> {
  const response = await call(`${SPEND_LIMITS_PATH}/effective?user_ids[]=${userId}`);
  expect(response.status).toBe(200);
  const envelope = (await response.json()) as RawEnvelope;
  expect(envelope.data).toHaveLength(1);
  return envelope.data[0];
}

describe("GET /spend_limit_increase_requests", () => {
  it("lists every request newest first with the seeded status mix", async () => {
    const rows = (await drain()).map((row) => IncreaseRequestSchema.parse(row));

    expect(rows).toHaveLength(getFixtureOrg().increaseRequests.length);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(6);
    expect(rows.filter((row) => row.status === "approved")).toHaveLength(4);
    expect(rows.filter((row) => row.status === "denied")).toHaveLength(2);

    const createdAt = rows.map((row) => row.created_at);
    expect(createdAt).toEqual([...createdAt].sort((a, b) => b.localeCompare(a)));
  });

  it("attaches a live spend_summary to pending rows only", async () => {
    const rows = (await drain()).map((row) => IncreaseRequestSchema.parse(row));

    for (const row of rows) {
      if (row.status === "pending") {
        expect(row.resolved_at).toBeNull();
        expect(row.spend_summary).not.toBeNull();
        expect(row.spend_summary?.period).toBe("monthly");
        expect(typeof row.spend_summary?.period_to_date_spend).toBe("string");
      } else {
        expect(row.resolved_at).not.toBeNull();
        expect(row.spend_summary).toBeNull();
      }
    }

    // The summary is resolved live, not recorded when the request was filed.
    const pendingBefore = await getRequest(FIXTURE.pendingRequestByIc.id);
    await call(SPEND_LIMITS_PATH, {
      method: "POST",
      body: { scope: { type: "user", user_id: FIXTURE.ic.claude_user_id }, amount: "654321" },
    });
    const pendingAfter = await getRequest(FIXTURE.pendingRequestByIc.id);
    expect(pendingBefore.spend_summary?.amount).not.toBe("654321");
    expect(pendingAfter.spend_summary?.amount).toBe("654321");
  });

  it("filters by status[] and actor_ids[]", async () => {
    const pending = (await drain("status[]=pending&limit=100")).map((row) =>
      IncreaseRequestSchema.parse(row),
    );
    expect(pending).toHaveLength(6);
    expect(pending.every((row) => row.status === "pending")).toBe(true);

    const resolved = await drain("status[]=approved&status[]=denied&limit=100");
    expect(resolved).toHaveLength(6);

    const mine = (await drain(`actor_ids[]=${FIXTURE.ic.claude_user_id}&limit=100`)).map((row) =>
      IncreaseRequestSchema.parse(row),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(FIXTURE.pendingRequestByIc.id);
  });

  it("pages, and rejects a cursor replayed under different filters", async () => {
    const firstPage = await listPage("limit=5");
    expect(firstPage.data).toHaveLength(5);
    expect(firstPage.next_page).not.toBeNull();

    const replay = await call(
      `${INCREASE_REQUESTS_PATH}?limit=5&status[]=pending&page=${encodeURIComponent(firstPage.next_page ?? "")}`,
    );
    const error = await expectError(replay, 400);
    expect(error.message).toContain(CURSOR_MISMATCH_MESSAGE);
  });

  it("404s on an unknown request id", async () => {
    const error = await expectError(await call(`${INCREASE_REQUESTS_PATH}/slir_nope`), 404);
    expect(error.type).toBe("not_found_error");
  });
});

describe("POST /{id}/approve", () => {
  it("writes the per-user limit and resolves the request", async () => {
    const response = await call(`${INCREASE_REQUESTS_PATH}/${FIXTURE.pendingRequestByIc.id}/approve`, {
      method: "POST",
      body: { amount: "90000", suppress_notification: true },
    });
    expect(response.status).toBe(200);

    const approved = IncreaseRequestSchema.parse(await response.json());
    expect(approved.status).toBe("approved");
    expect(approved.resolved_at).not.toBeNull();
    expect(approved.spend_summary).toBeNull();

    const row = EffectiveSpendLimitRowSchema.parse(
      await effectiveRowFor(FIXTURE.ic.claude_user_id),
    );
    expect(row.amount).toBe("90000");
    expect(row.source?.type).toBe("user");

    // The write is the same row `POST /spend_limits` would have produced.
    const limit = await call(`${SPEND_LIMITS_PATH}/${row.spend_limit_id}`);
    expect(limit.status).toBe(200);
    expect(((await limit.json()) as { scope: { type: string } }).scope.type).toBe("user");
  });

  it("409s when the request is no longer pending", async () => {
    const approve = (): Promise<Response> =>
      call(`${INCREASE_REQUESTS_PATH}/${FIXTURE.pendingRequestByIc.id}/approve`, {
        method: "POST",
        body: { amount: "90000" },
      });

    expect((await approve()).status).toBe(200);

    const error = await expectError(await approve(), 409);
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("approved");
  });

  it("400s without a usable amount, and 404s on an unknown request", async () => {
    for (const body of [{}, { amount: 90000 }, { amount: "-1" }]) {
      const error = await expectError(
        await call(`${INCREASE_REQUESTS_PATH}/${FIXTURE.pendingRequestByIc.id}/approve`, {
          method: "POST",
          body,
        }),
        400,
      );
      expect(error.message).toContain("amount");
    }

    // The member keeps their inherited limit — a rejected approval writes nothing.
    const row = EffectiveSpendLimitRowSchema.parse(
      await effectiveRowFor(FIXTURE.ic.claude_user_id),
    );
    expect(row.source?.type).not.toBe("user");

    const missing = await expectError(
      await call(`${INCREASE_REQUESTS_PATH}/slir_nope/approve`, {
        method: "POST",
        body: { amount: "1000" },
      }),
      404,
    );
    expect(missing.type).toBe("not_found_error");
  });
});

describe("POST /{id}/deny", () => {
  const denyTarget = FIXTURE.pendingRequestOutsideTier3Scope.id;

  it("resolves a pending request and is idempotent on a denied one", async () => {
    const first = await call(`${INCREASE_REQUESTS_PATH}/${denyTarget}/deny`, {
      method: "POST",
      body: { suppress_notification: true },
    });
    expect(first.status).toBe(200);
    const denied = IncreaseRequestSchema.parse(await first.json());
    expect(denied.status).toBe("denied");
    expect(denied.resolved_at).not.toBeNull();
    expect(denied.spend_summary).toBeNull();

    // Retried with no body at all — a denial carries nothing that must be sent.
    const second = await call(`${INCREASE_REQUESTS_PATH}/${denyTarget}/deny`, { method: "POST" });
    expect(second.status).toBe(200);
    const repeated = IncreaseRequestSchema.parse(await second.json());
    expect(repeated.status).toBe("denied");
    expect(repeated.resolved_at).toBe(denied.resolved_at);
  });

  it("writes no spend limit", async () => {
    const requester = getFixtureOrg().employees.find(
      (employee) => employee.id === FIXTURE.pendingRequestOutsideTier3Scope.employeeId,
    );
    const before = EffectiveSpendLimitRowSchema.parse(
      await effectiveRowFor(requester?.claude_user_id ?? ""),
    );

    expect((await call(`${INCREASE_REQUESTS_PATH}/${denyTarget}/deny`, { method: "POST" })).status).toBe(
      200,
    );

    const after = EffectiveSpendLimitRowSchema.parse(
      await effectiveRowFor(requester?.claude_user_id ?? ""),
    );
    expect(after.amount).toBe(before.amount);
    expect(after.source).toEqual(before.source);
  });

  it("409s on a request that was already approved", async () => {
    const approve = await call(
      `${INCREASE_REQUESTS_PATH}/${FIXTURE.pendingRequestByIc.id}/approve`,
      { method: "POST", body: { amount: "90000" } },
    );
    expect(approve.status).toBe(200);

    const error = await expectError(
      await call(`${INCREASE_REQUESTS_PATH}/${FIXTURE.pendingRequestByIc.id}/deny`, {
        method: "POST",
      }),
      409,
    );
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("approved");
  });

  it("404s on an unknown request", async () => {
    const error = await expectError(
      await call(`${INCREASE_REQUESTS_PATH}/slir_nope/deny`, { method: "POST" }),
      404,
    );
    expect(error.type).toBe("not_found_error");
  });
});
