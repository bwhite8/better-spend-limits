/**
 * `/v1/organizations/spend_limits` — endpoints 1–4 of plan §G4.
 *
 * 1. `GET  /effective`  one resolved row per current member
 * 2. `GET  /{id}`       one configured row
 * 3. `POST /`           upsert a per-user limit (keyed on scope + period)
 * 4. `DELETE /{id}`     remove a per-user limit; the member re-inherits
 *
 * Fidelity notes worth knowing before you consume these:
 *
 * - List filters use BRACKET notation (`user_ids[]=a&user_ids[]=b`). A bare
 *   `user_ids=` is ignored like any unknown parameter, exactly as upstream
 *   would ignore it — clients must send the brackets.
 * - `/effective` is sorted by actor name so paging is stable, and a cursor is
 *   only valid for the filters that issued it (§G4).
 * - Only `scope.type: "user"` is writable. Every other level is configured
 *   elsewhere in the real product, so POST/DELETE reject it.
 */

import { Hono } from "hono";

import type { EffectiveSpendLimitRow, SpendLimit } from "@bsl/shared";

import { MockApiError } from "../errors.js";
import { isRecord, pageOf, readJsonBody, readPageRequest, requireAmountString } from "../request.js";
import type { ConfiguredLimit, MockMember, MockState } from "../state.js";

/** Render a configured row as the `spend_limit` object the API returns. */
export function toSpendLimit(row: ConfiguredLimit): SpendLimit {
  return {
    type: "spend_limit",
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    scope: row.scope,
    amount: row.amount,
    currency: row.currency,
    period: row.period,
  };
}

/** Render one member's resolved limit as an `effective` row. */
function toEffectiveRow(state: MockState, member: MockMember): EffectiveSpendLimitRow {
  const resolved = state.resolveEffective(member.userId);
  return {
    scope: { type: "user", user_id: member.userId },
    actor: member.actor,
    amount: resolved.amount,
    currency: resolved.currency,
    period: resolved.period,
    source: resolved.source,
    spend_limit_id: resolved.spend_limit_id,
    period_to_date_spend: state.currentMonthSpend(member.userId),
  };
}

export function createSpendLimitRoutes(state: MockState): Hono {
  const routes = new Hono();

  /* --- 1. GET /effective --------------------------------------------- */
  // Registered before `/:spendLimitId` so the literal path wins the match.
  routes.get("/effective", (c) => {
    const userIds = c.req.queries("user_ids[]");
    const periods = c.req.queries("period[]");
    const page = readPageRequest(c, { "user_ids[]": userIds, "period[]": periods });

    let members: readonly MockMember[] = state.members;
    if (userIds !== undefined && userIds.length > 0) {
      const wanted = new Set(userIds);
      members = members.filter((member) => wanted.has(member.userId));
    }

    let rows = members.map((member) => toEffectiveRow(state, member));
    if (periods !== undefined && periods.length > 0) {
      const wanted = new Set(periods);
      rows = rows.filter((row) => wanted.has(row.period));
    }

    return c.json(pageOf(rows, page));
  });

  /* --- 2. GET /{spend_limit_id} --------------------------------------- */
  routes.get("/:spendLimitId", (c) => {
    const id = c.req.param("spendLimitId");
    const row = state.limitsById.get(id);
    if (!row) {
      throw new MockApiError(404, "not_found_error", `spend limit "${id}" not found`);
    }
    return c.json(toSpendLimit(row));
  });

  /* --- 3. POST / (upsert a per-user limit) ---------------------------- */
  routes.post("/", async (c) => {
    const body = await readJsonBody(c);

    const scope = body.scope;
    if (!isRecord(scope) || typeof scope.type !== "string") {
      throw new MockApiError(
        400,
        "invalid_request_error",
        'scope: expected an object like {"type":"user","user_id":"user_…"}',
      );
    }
    if (scope.type !== "user") {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `scope.type: only "user" scoped spend limits can be created, got "${scope.type}"`,
      );
    }
    const userId = scope.user_id;
    if (typeof userId !== "string" || userId === "") {
      throw new MockApiError(400, "invalid_request_error", "scope.user_id: expected a user id string");
    }
    if (!state.memberByUserId.has(userId)) {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `scope.user_id: "${userId}" is not a member of this organization`,
      );
    }

    const amount = requireAmountString(body.amount, "amount");

    // Only the organization's own period exists in this mock; a write for any
    // other period would create a row that no `effective` row could ever show.
    const period = body.period ?? state.period;
    if (typeof period !== "string" || period !== state.period) {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `period: only "${state.period}" spend limits are supported, got ${JSON.stringify(body.period)}`,
      );
    }

    return c.json(toSpendLimit(state.upsertUserLimit(userId, amount, period)));
  });

  /* --- 4. DELETE /{spend_limit_id} ------------------------------------ */
  routes.delete("/:spendLimitId", (c) => {
    const id = c.req.param("spendLimitId");
    const row = state.limitsById.get(id);
    if (!row) {
      throw new MockApiError(404, "not_found_error", `spend limit "${id}" not found`);
    }
    if (row.scope.type !== "user") {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `spend limit "${id}" is scoped to "${row.scope.type}"; only per-user spend limits can be deleted`,
      );
    }
    state.deleteUserLimit(row);
    // Anthropic's delete endpoints answer with a tombstone rather than 204.
    return c.json({ id: row.id, type: "spend_limit_deleted" });
  });

  return routes;
}
