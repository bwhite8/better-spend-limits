/**
 * `/v1/organizations/spend_limit_increase_requests` — endpoints 5–8 of §G4.
 *
 * 5. `GET  /`            newest first, filterable by `status[]` / `actor_ids[]`
 * 6. `GET  /{id}`        one request
 * 7. `POST /{id}/approve` writes the per-user limit AND resolves the request
 * 8. `POST /{id}/deny`   resolves the request without writing anything
 *
 * The semantics that actually bite callers:
 *
 * - A request carries NO requested amount. The approver supplies one, and
 *   approving writes exactly the row `POST /spend_limits` would have written.
 * - `deny` is IDEMPOTENT on an already-denied request (200 + the existing
 *   resource) but conflicts on an approved one (409), so automation can tell a
 *   retry from a genuine conflict. `approve` conflicts on anything non-pending.
 * - Only PENDING rows carry `spend_summary`, and it is computed live at read
 *   time — it is a snapshot of the member's limit and spend right now, not
 *   something recorded when the request was filed.
 * - Requests from people who are no longer members are omitted entirely.
 */

import { Hono } from "hono";

import type { IncreaseRequest } from "@bsl/shared";

import { MockApiError } from "../errors.js";
import { pageOf, readJsonBody, readPageRequest, requireAmountString } from "../request.js";
import type { MockIncreaseRequest, MockState } from "../state.js";

function toIncreaseRequest(state: MockState, request: MockIncreaseRequest): IncreaseRequest {
  const member = state.memberByUserId.get(request.userId);
  if (!member) {
    throw new MockApiError(
      500,
      "api_error",
      `increase request "${request.id}" references unknown member "${request.userId}"`,
    );
  }

  const wire: IncreaseRequest = {
    type: "spend_limit_increase_request",
    id: request.id,
    status: request.status,
    actor: member.actor,
    created_at: request.created_at,
    resolved_at: request.resolved_at,
    spend_summary: null,
  };

  if (request.status === "pending") {
    const resolved = state.resolveEffective(request.userId);
    wire.spend_summary = {
      amount: resolved.amount,
      currency: resolved.currency,
      period: resolved.period,
      period_to_date_spend: state.currentMonthSpend(request.userId),
    };
  }

  return wire;
}

function mustFindRequest(state: MockState, id: string): MockIncreaseRequest {
  const request = state.requestById.get(id);
  if (!request) {
    throw new MockApiError(404, "not_found_error", `spend limit increase request "${id}" not found`);
  }
  return request;
}

export function createIncreaseRequestRoutes(state: MockState): Hono {
  const routes = new Hono();

  /* --- 5. GET / ------------------------------------------------------- */
  routes.get("/", (c) => {
    const statuses = c.req.queries("status[]");
    const actorIds = c.req.queries("actor_ids[]");
    const page = readPageRequest(c, { "status[]": statuses, "actor_ids[]": actorIds });

    let rows = state.requests.filter((request) => state.memberByUserId.has(request.userId));
    if (statuses !== undefined && statuses.length > 0) {
      const wanted = new Set(statuses);
      rows = rows.filter((request) => wanted.has(request.status));
    }
    if (actorIds !== undefined && actorIds.length > 0) {
      const wanted = new Set(actorIds);
      rows = rows.filter((request) => wanted.has(request.userId));
    }

    const { data, next_page } = pageOf(rows, page);
    return c.json({ data: data.map((request) => toIncreaseRequest(state, request)), next_page });
  });

  /* --- 6. GET /{id} --------------------------------------------------- */
  routes.get("/:requestId", (c) => {
    const request = mustFindRequest(state, c.req.param("requestId"));
    return c.json(toIncreaseRequest(state, request));
  });

  /* --- 7. POST /{id}/approve ------------------------------------------ */
  routes.post("/:requestId/approve", async (c) => {
    const request = mustFindRequest(state, c.req.param("requestId"));
    const body = await readJsonBody(c);
    // `suppress_notification` is accepted and deliberately ignored: this mock
    // has nowhere to send a notification, and the field must not change output.
    const amount = requireAmountString(body.amount, "amount");

    if (request.status !== "pending") {
      throw new MockApiError(
        409,
        "invalid_request_error",
        `spend limit increase request "${request.id}" is ${request.status} and can no longer be approved`,
      );
    }

    state.upsertUserLimit(request.userId, amount, state.period);
    request.status = "approved";
    request.resolved_at = state.now().toISOString();
    return c.json(toIncreaseRequest(state, request));
  });

  /* --- 8. POST /{id}/deny --------------------------------------------- */
  routes.post("/:requestId/deny", async (c) => {
    const request = mustFindRequest(state, c.req.param("requestId"));
    await readJsonBody(c);

    // Idempotent: re-denying is a retry, not a conflict.
    if (request.status === "denied") {
      return c.json(toIncreaseRequest(state, request));
    }
    if (request.status !== "pending") {
      throw new MockApiError(
        409,
        "invalid_request_error",
        `spend limit increase request "${request.id}" is ${request.status} and can no longer be denied`,
      );
    }

    request.status = "denied";
    request.resolved_at = state.now().toISOString();
    return c.json(toIncreaseRequest(state, request));
  });

  return routes;
}
