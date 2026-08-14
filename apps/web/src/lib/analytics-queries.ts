/**
 * Analytics aggregation over the local snapshot (plan §Phase 12).
 *
 * Every figure on the analytics page is computed here, from `user_daily_cost`
 * and `spend_limit_snapshot` — never from a live API call. That is the §G1
 * hybrid model doing its job: the org shares 60 req/min across all of Anthropic's
 * spend-limits endpoints, so a dashboard that fanned out per member would be
 * unusable at 250 people and impossible at 2,500.
 *
 * Four rules the callers can rely on:
 *
 * 1. **Scope is an input, not a filter applied afterwards.** Each function takes
 *    the employee ids the viewer may see (§G8 `visibleEmployees`) and aggregates
 *    only those. A total that included people the viewer cannot open is a leak,
 *    however coarse.
 * 2. **Sums are exact.** Money is added with `sumMinorUnits` (BigInt over decimal
 *    strings, §G9). Floating point appears only in *ratios* — which is the same
 *    concession `spendRatio` already makes, and only ever drives sort order and
 *    bar widths.
 * 3. **The provisional tail is derived from the stored watermark**, not from a
 *    row's cached `provisional` flag. Both say the same thing after a sync, but
 *    the watermark is the single fact §G5 defines, and re-deriving keeps a day's
 *    classification consistent across a table and a chart rendered from
 *    different queries.
 * 4. **Members are joined through the same two legs as everywhere else**
 *    (`claude_user_id`, then lowercased email) by reusing `lib/members.ts`, so a
 *    person shown on the members list cannot silently vanish from a chart.
 */

import { and, gte, inArray, lte, min } from "drizzle-orm";

import {
  compareMinorUnits,
  isZeroMinorUnits,
  minorUnitsToNumber,
  spendRatio,
  sumMinorUnits,
} from "@bsl/shared";

import type { AppDatabase } from "@/db/client";
import { employees, userDailyCost, type SpendLimitSnapshotRow } from "@/db/schema";
import { loadSnapshotIndex, snapshotFor } from "@/lib/members";
import { getSyncState, isProvisionalDate } from "@/lib/sync";

const MS_PER_DAY = 86_400_000;

/** Days shown on the spend-over-time chart by default. */
export const DEFAULT_TREND_DAYS = 60;

/** Length of each half of the week-over-week comparison. */
export const WEEK_DAYS = 7;

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` in UTC — the key `user_daily_cost` uses (§G5 buckets are UTC days). */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `date` shifted by whole UTC days; the argument is not mutated. */
export function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Inclusive `YYYY-MM-DD` range covering the `days` days ending on `end`. */
export function windowEnding(end: Date, days: number): { from: string; to: string } {
  return { from: toIsoDate(shiftDays(end, -(days - 1))), to: toIsoDate(end) };
}

/** Every date string from `from` to `to` inclusive, so a chart has no gaps. */
export function dateSeries(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = new Date(`${from}T00:00:00.000Z`); toIsoDate(day) <= to; day = shiftDays(day, 1)) {
    dates.push(toIsoDate(day));
    if (dates.length > 3650) break; // A decade is a bug, not a request.
  }
  return dates;
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/** One member of the viewer's scope, already joined to their snapshot row. */
export interface ScopeMember {
  employeeId: string;
  name: string;
  email: string;
  /** The Anthropic actor id, or `null` when the sync has never seen them. */
  userId: string | null;
  snapshot: SpendLimitSnapshotRow | null;
}

/**
 * Resolve employee ids to the members the cost tables are keyed by.
 *
 * Callers pass employee ids because that is what §G8 hands them; costs are keyed
 * by Anthropic user id. This is the one place that bridge is crossed.
 */
export function resolveScope(db: AppDatabase, employeeIds: readonly string[]): ScopeMember[] {
  if (employeeIds.length === 0) return [];

  const index = loadSnapshotIndex(db);
  const rows = db
    .select()
    .from(employees)
    .where(inArray(employees.id, [...employeeIds]))
    .all();

  return rows.map((employee) => {
    const snapshot = snapshotFor(index, employee);
    return {
      employeeId: employee.id,
      name: employee.name,
      email: employee.email,
      userId: snapshot?.user_id ?? employee.claude_user_id,
      snapshot,
    };
  });
}

function userIdsOf(scope: readonly ScopeMember[]): string[] {
  return [...new Set(scope.map((member) => member.userId).filter((id): id is string => id !== null))];
}

/* -------------------------------------------------------------------------- */
/* Cost rows                                                                  */
/* -------------------------------------------------------------------------- */

interface CostRow {
  user_id: string;
  date: string;
  amount: string;
}

/** Daily cost rows for these users over an inclusive date range. */
function costRows(
  db: AppDatabase,
  userIds: readonly string[],
  from: string,
  to: string,
): CostRow[] {
  if (userIds.length === 0) return [];

  return db
    .select({
      user_id: userDailyCost.user_id,
      date: userDailyCost.date,
      amount: userDailyCost.amount,
    })
    .from(userDailyCost)
    .where(
      and(
        inArray(userDailyCost.user_id, [...userIds]),
        gte(userDailyCost.date, from),
        lte(userDailyCost.date, to),
      ),
    )
    .all();
}

/** The §G5 freshness watermark stored by the cost sync, or `null` before one runs. */
export function costWatermark(db: AppDatabase): string | null {
  return getSyncState(db, "costs")?.data_refreshed_at ?? null;
}

/** Oldest day held locally for this scope, or `null` when nothing is synced. */
export function earliestCostDate(db: AppDatabase, employeeIds: readonly string[]): string | null {
  const userIds = userIdsOf(resolveScope(db, employeeIds));
  if (userIds.length === 0) return null;

  const row = db
    .select({ date: min(userDailyCost.date) })
    .from(userDailyCost)
    .where(inArray(userDailyCost.user_id, userIds))
    .get();

  return row?.date ?? null;
}

/**
 * How many trailing days the trend chart can honestly draw.
 *
 * The sync re-reads a rolling {@link COST_LOOKBACK_DAYS}-day window (§Phase 8),
 * so asking for 60 days of a 35-day table produces 25 days of `"0"` — a flat
 * line that reads as "nobody spent anything" when it means "we hold no data".
 * Clamping to what is actually stored is the honest chart; the page says so in
 * its caption.
 */
export function trendWindowDays(
  db: AppDatabase,
  employeeIds: readonly string[],
  maxDays: number = DEFAULT_TREND_DAYS,
  now: Date = new Date(),
): number {
  const earliest = earliestCostDate(db, employeeIds);
  if (earliest === null) return maxDays;

  const spanned =
    Math.floor(
      (Date.parse(`${toIsoDate(now)}T00:00:00.000Z`) - Date.parse(`${earliest}T00:00:00.000Z`)) /
        MS_PER_DAY,
    ) + 1;

  return Math.max(1, Math.min(maxDays, spanned));
}

export interface WindowOptions {
  /** Injectable clock — the tests pin it, the page does not. */
  now?: Date;
  /** Overrides the stored watermark; mostly so tests can state it explicitly. */
  watermark?: string | null;
}

function resolveNow(options: WindowOptions): Date {
  return options.now ?? new Date();
}

function resolveWatermark(db: AppDatabase, options: WindowOptions): string | null {
  return options.watermark === undefined ? costWatermark(db) : options.watermark;
}

/* -------------------------------------------------------------------------- */
/* 1. Spend over time                                                         */
/* -------------------------------------------------------------------------- */

export interface DailyTotal {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Exact decimal minor units; `"0"` for a day nobody in scope spent anything. */
  amount: string;
  /** True after the §G5 watermark: still incomplete, still revisable. */
  provisional: boolean;
}

/**
 * Total daily spend across the scope for the `days` days ending today.
 *
 * Days with no usage are emitted as `"0"` rather than skipped: the cost endpoint
 * only reports days WITH usage (§G5), and a line chart that silently closed those
 * gaps would draw a straight line through a quiet weekend.
 */
export function dailyTotals(
  db: AppDatabase,
  employeeIds: readonly string[],
  days: number = DEFAULT_TREND_DAYS,
  options: WindowOptions = {},
): DailyTotal[] {
  const { from, to } = windowEnding(resolveNow(options), days);
  const watermark = resolveWatermark(db, options);
  const scope = resolveScope(db, employeeIds);

  const byDate = new Map<string, string[]>();
  for (const row of costRows(db, userIdsOf(scope), from, to)) {
    const bucket = byDate.get(row.date);
    if (bucket) bucket.push(row.amount);
    else byDate.set(row.date, [row.amount]);
  }

  return dateSeries(from, to).map((date) => ({
    date,
    amount: sumMinorUnits(byDate.get(date) ?? []),
    provisional: isProvisionalDate(date, watermark),
  }));
}

/* -------------------------------------------------------------------------- */
/* 2. Near limit                                                              */
/* -------------------------------------------------------------------------- */

export interface NearLimitRow {
  employeeId: string;
  name: string;
  email: string;
  /** Effective limit; never `null` here — an unlimited member has no ratio. */
  amount: string;
  currency: string | null;
  spend: string | null;
  ratio: number;
  /** `"0"` cap (included usage only) — at their cap by definition (§G9). */
  atCap: boolean;
}

/** An explicit `"0"` cap (§G9). A malformed amount is not one, and never throws. */
function isZeroCap(amount: string): boolean {
  try {
    return isZeroMinorUnits(amount);
  } catch {
    return false;
  }
}

/**
 * Members whose period-to-date spend has reached `threshold` of their cap.
 *
 * The reading is the snapshot's `period_to_date_spend`, i.e. the API's own
 * period figure, not a sum of daily rows: it is the number the members list and
 * the increase-request cards already show, and the one the cap is enforced
 * against. Unlimited members are absent because no ratio exists for them (§G9);
 * `"0"`-cap members are always present, flagged, because included-usage-only is
 * a cap that is met the moment anything is spent.
 */
export function nearLimit(
  db: AppDatabase,
  employeeIds: readonly string[],
  threshold: number,
): NearLimitRow[] {
  const rows: NearLimitRow[] = [];

  for (const member of resolveScope(db, employeeIds)) {
    const snapshot = member.snapshot;
    if (snapshot === null || snapshot.amount === null) continue;

    const ratio = spendRatio(snapshot.period_to_date_spend, snapshot.amount);
    if (ratio === null || ratio < threshold) continue;

    rows.push({
      employeeId: member.employeeId,
      name: member.name,
      email: member.email,
      amount: snapshot.amount,
      currency: snapshot.currency,
      spend: snapshot.period_to_date_spend,
      ratio,
      atCap: isZeroCap(snapshot.amount),
    });
  }

  return rows.sort((a, b) => b.ratio - a.ratio || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* 3. Week-over-week movers                                                   */
/* -------------------------------------------------------------------------- */

export interface WowMoverRow {
  employeeId: string;
  name: string;
  email: string;
  /** Exact sums, minor units. */
  lastWeek: string;
  priorWeek: string;
  /** `null` when the prior week was zero — a jump from nothing has no multiple. */
  multiple: number | null;
}

/**
 * Members whose last 7 days cost at least `multiple` times the 7 before them.
 *
 * A member who spent nothing in the prior week has no finite multiple. They are
 * still a mover — going from zero to real money is exactly the change this
 * report exists to surface — so they are included with a `null` multiple and
 * sorted first, rather than being dropped by a division that cannot be done.
 */
export function wowMovers(
  db: AppDatabase,
  employeeIds: readonly string[],
  multiple: number,
  options: WindowOptions = {},
): WowMoverRow[] {
  const now = resolveNow(options);
  const last = windowEnding(now, WEEK_DAYS);
  const prior = windowEnding(shiftDays(now, -WEEK_DAYS), WEEK_DAYS);
  const scope = resolveScope(db, employeeIds);

  const byUser = new Map<string, { last: string[]; prior: string[] }>();
  for (const row of costRows(db, userIdsOf(scope), prior.from, last.to)) {
    const bucket = byUser.get(row.user_id) ?? { last: [], prior: [] };
    if (row.date >= last.from) bucket.last.push(row.amount);
    else if (row.date >= prior.from) bucket.prior.push(row.amount);
    byUser.set(row.user_id, bucket);
  }

  const rows: WowMoverRow[] = [];
  for (const member of scope) {
    if (member.userId === null) continue;
    const bucket = byUser.get(member.userId);
    if (bucket === undefined) continue;

    const lastWeek = sumMinorUnits(bucket.last);
    const priorWeek = sumMinorUnits(bucket.prior);
    const lastValue = minorUnitsToNumber(lastWeek);
    const priorValue = minorUnitsToNumber(priorWeek);
    if (!(lastValue > 0)) continue;

    if (priorValue > 0) {
      const ratio = lastValue / priorValue;
      if (ratio < multiple) continue;
      rows.push({ ...identityOf(member), lastWeek, priorWeek, multiple: ratio });
    } else {
      rows.push({ ...identityOf(member), lastWeek, priorWeek, multiple: null });
    }
  }

  return rows.sort((a, b) => {
    if (a.multiple === null || b.multiple === null) {
      if (a.multiple === b.multiple) return compareMinorUnits(b.lastWeek, a.lastWeek);
      return a.multiple === null ? -1 : 1;
    }
    return b.multiple - a.multiple;
  });
}

function identityOf(member: ScopeMember): { employeeId: string; name: string; email: string } {
  return { employeeId: member.employeeId, name: member.name, email: member.email };
}

/* -------------------------------------------------------------------------- */
/* 4. Top spenders, month to date                                             */
/* -------------------------------------------------------------------------- */

export interface TopSpenderRow {
  employeeId: string;
  name: string;
  email: string;
  /** Month-to-date sum of daily cost, exact minor units. */
  amount: string;
}

/** First day of `now`'s UTC calendar month, as `YYYY-MM-DD`. */
export function monthStart(now: Date): string {
  return `${toIsoDate(now).slice(0, 7)}-01`;
}

/**
 * The `n` biggest month-to-date spenders in scope, largest first.
 *
 * Summed from `user_daily_cost` rather than read off the snapshot, because a
 * ranking has to be comparable across members and the daily table is the one
 * dataset where every member's figure comes from the same query and window.
 * Members with no spend this month are omitted — a bar list of zeros says
 * nothing.
 */
export function topSpenders(
  db: AppDatabase,
  employeeIds: readonly string[],
  n: number,
  options: WindowOptions = {},
): TopSpenderRow[] {
  const now = resolveNow(options);
  const scope = resolveScope(db, employeeIds);

  const byUser = new Map<string, string[]>();
  for (const row of costRows(db, userIdsOf(scope), monthStart(now), toIsoDate(now))) {
    const bucket = byUser.get(row.user_id);
    if (bucket) bucket.push(row.amount);
    else byUser.set(row.user_id, [row.amount]);
  }

  const rows: TopSpenderRow[] = [];
  for (const member of scope) {
    if (member.userId === null) continue;
    const amounts = byUser.get(member.userId);
    if (amounts === undefined) continue;
    const amount = sumMinorUnits(amounts);
    if (isZeroMinorUnits(amount)) continue;
    rows.push({ ...identityOf(member), amount });
  }

  return rows
    .sort((a, b) => compareMinorUnits(b.amount, a.amount) || a.name.localeCompare(b.name))
    .slice(0, n);
}
