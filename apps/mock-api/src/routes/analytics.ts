/**
 * `/v1/organizations/analytics/user_cost_report` — plan §G5 / §Phase 5.
 *
 * The one analytics surface v1 consumes. Three things about it differ from the
 * spend-limits routes and are the whole reason this file exists:
 *
 * 1. **A different key.** The Analytics key authenticates here; the Admin key is
 *    rejected. They are not interchangeable, so the app has to hold both.
 * 2. **`data_refreshed_at` is a freshness WATERMARK, not a response timestamp.**
 *    Rows dated after it are an incomplete, provisional tail: they are returned,
 *    but their values will still change. This mock pins the watermark a fixed
 *    36 hours behind the clock and reports post-watermark days at 80% of their
 *    eventual value, so a consumer that re-syncs later genuinely OBSERVES a
 *    revision instead of merely being told one is possible.
 * 3. **Two shapes from one endpoint.** Without `bucket_width` a row is a
 *    member's total over the range, highest spend first; with `bucket_width=1d`
 *    a row is one member-day.
 *
 * Every amount is an exact decimal minor-units string — the deflation below is
 * BigInt arithmetic, never `parseFloat` (§G9).
 */

import { Hono } from "hono";

import { compareMinorUnits, parseMinorUnits, sumMinorUnits, type UserCostRow } from "@bsl/shared";

import { MockApiError } from "../errors.js";
import { pageOf, readPageRequest } from "../request.js";
import type { MockState } from "../state.js";

/** How far behind `now()` this mock's freshness watermark sits (§Phase 5). */
export const DATA_REFRESH_LAG_MS = 36 * 60 * 60 * 1000;

/**
 * The fraction of its eventual value a provisional (post-watermark) day
 * reports. Applied exactly, as ×8/10 on the scaled integer — the constant is
 * documentation, the arithmetic below never uses it as a float.
 */
export const PROVISIONAL_FRACTION = 0.8;

/**
 * Minimum fraction digits on a cost amount. The documented example is
 * `"41280.000000"`, so the endpoint pads rather than trimming; a value that
 * needs more precision than this keeps it rather than being rounded.
 */
const COST_AMOUNT_SCALE = 6;

/** The only bucket width v1 supports (§G5); anything else is a 400. */
export const SUPPORTED_BUCKET_WIDTH = "1d";

/** `YYYY-MM-DD` in UTC — the granularity every cost row is keyed at. */
function toIsoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function requireTimestamp(raw: string | undefined, field: string): Date {
  if (raw === undefined || raw.trim() === "") {
    throw new MockApiError(
      400,
      "invalid_request_error",
      `${field}: an ISO 8601 timestamp is required (e.g. "2026-08-01T00:00:00Z")`,
    );
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new MockApiError(
      400,
      "invalid_request_error",
      `${field}: expected an ISO 8601 timestamp, got ${JSON.stringify(raw)}`,
    );
  }
  return at;
}

/** Pad a decimal minor-units string out to the endpoint's fraction width. */
function formatCostAmount(amount: string): string {
  const { cents, fraction } = parseMinorUnits(amount);
  return `${cents}.${fraction.padEnd(COST_AMOUNT_SCALE, "0")}`;
}

/**
 * Exactly 80% of `amount`, with no floating point involved.
 *
 * An amount with `w` fraction digits is an integer scaled by 10^w. Multiplying
 * by 8/10 is therefore the SAME integer times 8, read at scale 10^(w+1) — one
 * extra digit of precision and not a single rounding decision.
 */
export function deflateProvisional(amount: string): string {
  const { cents, fraction } = parseMinorUnits(amount);
  const width = fraction.length;
  const scaled = cents * 10n ** BigInt(width) + (fraction === "" ? 0n : BigInt(fraction));
  const product = scaled * 8n;
  const nextScale = 10n ** BigInt(width + 1);
  const remainder = (product % nextScale).toString().padStart(width + 1, "0");
  return `${product / nextScale}.${remainder}`;
}

/** Highest spend first, ties broken on user id so paging stays stable. */
function byAmountDesc(a: UserCostRow, b: UserCostRow): number {
  const byAmount = compareMinorUnits(b.amount, a.amount);
  return byAmount !== 0 ? byAmount : a.actor.user_id.localeCompare(b.actor.user_id);
}

/**
 * Bucketed rows go oldest day first, then highest spend within the day. Whole
 * days therefore arrive together, which is what an incremental consumer wants.
 */
function byDateThenAmountDesc(a: UserCostRow, b: UserCostRow): number {
  const byDate = (a.date ?? "").localeCompare(b.date ?? "");
  return byDate !== 0 ? byDate : byAmountDesc(a, b);
}

export function createAnalyticsRoutes(state: MockState): Hono {
  const routes = new Hono();

  routes.get("/user_cost_report", (c) => {
    const startingAtRaw = c.req.query("starting_at");
    const endingAtRaw = c.req.query("ending_at");
    const bucketWidthRaw = c.req.query("bucket_width");

    const startingAt = requireTimestamp(startingAtRaw, "starting_at");
    const endingAt =
      endingAtRaw === undefined || endingAtRaw.trim() === ""
        ? state.now()
        : requireTimestamp(endingAtRaw, "ending_at");
    if (endingAt.getTime() < startingAt.getTime()) {
      throw new MockApiError(
        400,
        "invalid_request_error",
        "ending_at: must not be earlier than starting_at",
      );
    }

    if (
      bucketWidthRaw !== undefined &&
      bucketWidthRaw !== "" &&
      bucketWidthRaw !== SUPPORTED_BUCKET_WIDTH
    ) {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `bucket_width: only "${SUPPORTED_BUCKET_WIDTH}" is supported, got ${JSON.stringify(bucketWidthRaw)}`,
      );
    }
    const bucketed = bucketWidthRaw === SUPPORTED_BUCKET_WIDTH;

    // Hashed from the RAW query values, never the resolved ones: `ending_at`
    // defaults to `now()`, and hashing that would invalidate every cursor on
    // the next millisecond.
    const page = readPageRequest(c, {
      starting_at: startingAtRaw,
      ending_at: endingAtRaw,
      bucket_width: bucketWidthRaw,
    });

    const refreshedAt = new Date(state.now().getTime() - DATA_REFRESH_LAG_MS).toISOString();
    // A day is provisional when it is strictly after the watermark's UTC day —
    // the same answer a plain `date > data_refreshed_at` string compare gives,
    // written explicitly so the rule is not an accident of lexicography.
    const refreshedDay = refreshedAt.slice(0, 10);

    // Bounds are day-granular and inclusive at both ends: the report's unit is
    // a whole UTC day, so a mid-day bound cannot exclude half of one.
    const firstDay = toIsoDate(startingAt);
    const lastDay = toIsoDate(endingAt);

    const rows: UserCostRow[] = [];
    for (const member of state.members) {
      const actor = { user_id: member.userId, email_address: member.actor.email_address };
      const totals: string[] = [];
      for (const cost of state.dailyCosts(member.userId)) {
        if (cost.date < firstDay || cost.date > lastDay) continue;
        const amount = cost.date > refreshedDay ? deflateProvisional(cost.amount) : cost.amount;
        if (bucketed) rows.push({ actor, amount: formatCostAmount(amount), date: cost.date });
        else totals.push(amount);
      }
      // A member with no usage in the range has nothing to report, so no row —
      // the endpoint reports observed cost, not a roster.
      if (!bucketed && totals.length > 0) {
        rows.push({ actor, amount: formatCostAmount(sumMinorUnits(totals)) });
      }
    }

    rows.sort(bucketed ? byDateThenAmountDesc : byAmountDesc);

    const { data, next_page } = pageOf(rows, page);
    return c.json({ data, next_page, data_refreshed_at: refreshedAt });
  });

  return routes;
}
