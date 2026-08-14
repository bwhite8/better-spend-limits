import { describe, expect, it } from "vitest";

import {
  EffectiveSpendLimitListSchema,
  EffectiveSpendLimitRowSchema,
  ErrorEnvelopeSchema,
  IncreaseRequestSchema,
  SpendLimitSchema,
  UserCostReportEnvelopeSchema,
  UserCostRowSchema,
  isUserScope,
  listEnvelopeSchema,
} from "./index";

/** The documented example row, verbatim from the Spend Limits API docs (§G4). */
const DOC_EFFECTIVE_ROW = {
  scope: { type: "user", user_id: "user_01AbCdEfGh" },
  actor: {
    type: "user_actor",
    user_id: "user_01AbCdEfGh",
    name: "Jane Smith",
    email_address: "jane@example.com",
    deleted: false,
  },
  amount: "50000",
  currency: "USD",
  period: "monthly",
  source: { type: "seat_tier", seat_tier: "enterprise_standard" },
  spend_limit_id: "spl_01XyZ",
  period_to_date_spend: "31402.5",
};

describe("EffectiveSpendLimitRow", () => {
  it("parses the documented example row", () => {
    const row = EffectiveSpendLimitRowSchema.parse(DOC_EFFECTIVE_ROW);
    expect(row.amount).toBe("50000");
    expect(row.period).toBe("monthly");
    expect(row.actor.email_address).toBe("jane@example.com");
    expect(row.actor.deleted).toBe(false);
    expect(row.source).toEqual({ type: "seat_tier", seat_tier: "enterprise_standard" });
    expect(row.period_to_date_spend).toBe("31402.5");
    expect(isUserScope(row.scope)).toBe(true);
  });

  it("accepts an unknown source kind (open set)", () => {
    const row = EffectiveSpendLimitRowSchema.parse({
      ...DOC_EFFECTIVE_ROW,
      source: { type: "future_scope_kind" },
    });
    expect(row.source).toEqual({ type: "future_scope_kind" });
  });

  it("accepts an unknown scope kind and an unknown period", () => {
    const row = EffectiveSpendLimitRowSchema.parse({
      ...DOC_EFFECTIVE_ROW,
      scope: { type: "future_scope_kind", group_id: "grp_1" },
      period: "weekly",
    });
    expect(row.period).toBe("weekly");
    expect(isUserScope(row.scope)).toBe(false);
  });

  it("treats a null amount as unlimited and allows a null source", () => {
    const row = EffectiveSpendLimitRowSchema.parse({
      ...DOC_EFFECTIVE_ROW,
      amount: null,
      source: null,
      spend_limit_id: null,
    });
    expect(row.amount).toBeNull();
    expect(row.source).toBeNull();
    expect(row.spend_limit_id).toBeNull();
  });

  it("passes unrecognised fields through instead of stripping them", () => {
    const row = EffectiveSpendLimitRowSchema.parse({
      ...DOC_EFFECTIVE_ROW,
      future_field: { nested: true },
    });
    expect(row.future_field).toEqual({ nested: true });
  });

  it("defaults an omitted actor name and deleted flag", () => {
    const row = EffectiveSpendLimitRowSchema.parse({
      ...DOC_EFFECTIVE_ROW,
      actor: { type: "user_actor", user_id: "user_01", email_address: "a@example.com" },
    });
    expect(row.actor.name).toBeNull();
    expect(row.actor.deleted).toBe(false);
  });

  it("rejects a row missing a field the app consumes", () => {
    const { period_to_date_spend: _omitted, ...withoutSpend } = DOC_EFFECTIVE_ROW;
    expect(() => EffectiveSpendLimitRowSchema.parse(withoutSpend)).toThrow();
    expect(() =>
      EffectiveSpendLimitRowSchema.parse({ ...DOC_EFFECTIVE_ROW, amount: 50000 }),
    ).toThrow();
  });
});

describe("SpendLimit", () => {
  it("parses a configured user override", () => {
    const limit = SpendLimitSchema.parse({
      type: "spend_limit",
      id: "spl_01XyZ",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      scope: { type: "user", user_id: "user_01AbCdEfGh" },
      amount: "75000",
      currency: "USD",
      period: "monthly",
    });
    expect(limit.id).toBe("spl_01XyZ");
    expect(isUserScope(limit.scope)).toBe(true);
  });
});

describe("IncreaseRequest", () => {
  const PENDING = {
    type: "spend_limit_increase_request",
    id: "slir_01AbC",
    status: "pending",
    actor: {
      type: "user_actor",
      user_id: "user_01AbCdEfGh",
      name: "Jane Smith",
      email_address: "jane@example.com",
      deleted: false,
    },
    created_at: "2026-08-10T12:00:00Z",
    resolved_at: null,
    spend_summary: {
      amount: "50000",
      currency: "USD",
      period: "monthly",
      period_to_date_spend: "49999.5",
    },
  };

  it("parses a pending request with its live spend summary", () => {
    const request = IncreaseRequestSchema.parse(PENDING);
    expect(request.status).toBe("pending");
    expect(request.resolved_at).toBeNull();
    expect(request.spend_summary?.period_to_date_spend).toBe("49999.5");
  });

  it("parses a resolved request with a null spend summary", () => {
    const request = IncreaseRequestSchema.parse({
      ...PENDING,
      status: "approved",
      resolved_at: "2026-08-11T09:30:00Z",
      spend_summary: null,
    });
    expect(request.spend_summary).toBeNull();
    expect(request.resolved_at).toBe("2026-08-11T09:30:00Z");
  });

  it("keeps an unknown status instead of rejecting it (open set)", () => {
    expect(IncreaseRequestSchema.parse({ ...PENDING, status: "escalated" }).status).toBe(
      "escalated",
    );
  });

  it("defaults omitted resolved_at and spend_summary to null", () => {
    const { resolved_at: _r, spend_summary: _s, ...bare } = PENDING;
    const request = IncreaseRequestSchema.parse(bare);
    expect(request.resolved_at).toBeNull();
    expect(request.spend_summary).toBeNull();
  });
});

describe("list envelopes", () => {
  it("parses a page with a cursor and a final page without one", () => {
    const page = EffectiveSpendLimitListSchema.parse({
      data: [DOC_EFFECTIVE_ROW],
      next_page: "page_abc",
    });
    expect(page.data).toHaveLength(1);
    expect(page.next_page).toBe("page_abc");

    expect(EffectiveSpendLimitListSchema.parse({ data: [], next_page: null }).next_page).toBeNull();
    expect(listEnvelopeSchema(EffectiveSpendLimitRowSchema).parse({ data: [] }).next_page).toBeNull();
  });
});

describe("ErrorEnvelope", () => {
  it("parses the standard error body", () => {
    const envelope = ErrorEnvelopeSchema.parse({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
      request_id: "req_01AbC",
    });
    expect(envelope.error.type).toBe("authentication_error");
    expect(envelope.request_id).toBe("req_01AbC");
  });

  it("accepts an unknown error type and a missing request_id", () => {
    const envelope = ErrorEnvelopeSchema.parse({
      type: "error",
      error: { type: "billing_error", message: "nope" },
    });
    expect(envelope.error.type).toBe("billing_error");
    expect(envelope.request_id).toBeNull();
  });
});

describe("user cost report", () => {
  it("parses a totals row (no bucket_width, so no date)", () => {
    const row = UserCostRowSchema.parse({
      actor: { user_id: "user_01AbCdEfGh", email_address: "jane@example.com" },
      amount: "41280.000000",
    });
    expect(row.date).toBeUndefined();
    expect(row.amount).toBe("41280.000000");
  });

  it("parses a daily-bucketed envelope with its freshness watermark", () => {
    const envelope = UserCostReportEnvelopeSchema.parse({
      data: [
        {
          actor: { user_id: "user_01AbCdEfGh", email_address: "jane@example.com" },
          amount: "41280.000000",
          date: "2026-08-01",
        },
      ],
      next_page: null,
      data_refreshed_at: "2026-08-12T00:00:00Z",
    });
    expect(envelope.data[0]?.date).toBe("2026-08-01");
    expect(envelope.data_refreshed_at).toBe("2026-08-12T00:00:00Z");
  });

  it("rejects an envelope without the freshness watermark", () => {
    expect(() => UserCostReportEnvelopeSchema.parse({ data: [], next_page: null })).toThrow();
  });
});
