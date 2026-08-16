/**
 * Analytics — four questions the local snapshot can answer (plan §Phase 12),
 * under a row of month-to-date headline figures.
 *
 *   1. Where is spend going over time, and how much of the recent tail is still
 *      being revised?
 *   2. Who is about to run out of headroom?
 *   3. Whose usage just jumped?
 *   4. Who are the biggest spenders this month?
 *
 * Everything is computed from `user_daily_cost` and `spend_limit_snapshot` by
 * `lib/analytics-queries`, and every dataset is scoped to `visibleEmployees`
 * first (§G8 option B). That matters more here than anywhere else in the app: an
 * aggregate is exactly the kind of number that looks harmless while quietly
 * summarising people the viewer has no business seeing. A manager's "org spend"
 * is their team's spend, and the page says which it is showing.
 *
 * The KPI cards are the ONE deliberate exception, and they are shaped so the
 * exception stays small: a total and a headcount average over the whole roster,
 * naming nobody, alongside the same two figures for the viewer's own scope so
 * the comparison is the point rather than the disclosure. `show_org_wide_kpis`
 * turns the organization pair off. An admin's scope already IS the organization,
 * so they get one pair, labelled as such, rather than the same two numbers twice.
 *
 * The freshness caveat is on the page rather than in a doc, because §G5 makes it
 * a property of the data itself: anything after `data_refreshed_at` is an
 * incomplete tail that may be revised for up to 30 days.
 */

import Link from "next/link";

import { getDb } from "@/db/client";
import { Money, SpendBar } from "@/components/money";
import { CARD } from "@/components/surface";
import {
  allEmployeeIds,
  costWatermark,
  dailyTotals,
  monthToDateTotal,
  nearLimit,
  topSpenders,
  trendWindowDays,
  wowMovers,
  DEFAULT_TREND_DAYS,
  type MonthToDateSummary,
  type NearLimitRow,
  type WowMoverRow,
} from "@/lib/analytics-queries";
import { loadAppConfig } from "@/lib/config";
import { currentEmployee } from "@/lib/identity";
import { authorityIdsOf, visibleEmployees } from "@/lib/permissions";
import { ensureFreshSync } from "@/lib/sync-runner";

import Forbidden from "../forbidden";
import { SpendOverTimeChart, TopSpenderBars } from "./charts";

export const dynamic = "force-dynamic";

/** The jump a week has to make to count as a mover (plan §Phase 12). */
const WOW_MULTIPLE = 3;

/** Rows in the month-to-date bar list. */
const TOP_SPENDER_COUNT = 10;

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`${CARD} flex flex-col gap-3 p-4 sm:p-5`}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{title}</h2>
        {caption === undefined ? null : <p className="text-xs text-slate-500">{caption}</p>}
      </header>
      {children}
    </article>
  );
}

interface Kpi {
  /** Distinguishes the four possible cards from one another in tests. */
  testId: string;
  label: string;
  caption: string;
  /** Decimal minor units. */
  amount: string;
}

/**
 * One headline figure — a segment of the strip, no longer a card of its own.
 *
 * Two figures in two full-width cards spent the entire content column on one
 * number each, which read as a page with nothing on it rather than as a page
 * with two important things on it. Segments of a single panel are denser, and
 * they also say the true thing about these numbers: they are one set to be
 * compared, not two unrelated readings.
 *
 * Cents are kept: unlike the users list, where a column of round caps is scanned
 * rather than audited, these are sums somebody may well reconcile against the
 * top-spender list further down the page.
 */
function KpiCard({ testId, label, caption, amount }: Kpi) {
  return (
    <div
      data-testid="kpi-card"
      className="flex flex-col gap-1 bg-white px-4 py-4 dark:bg-slate-900"
    >
      <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</h2>
      <p data-testid={testId} className="text-2xl font-semibold tracking-tight tabular-nums">
        <Money amount={amount} />
      </p>
      <p className="text-xs text-slate-500">{caption}</p>
    </div>
  );
}

function monthToDateCaption(headcount: number): string {
  return `Month to date, across ${headcount} ${headcount === 1 ? "user" : "users"}.`;
}

/** The month-to-date pair for one population. */
function kpiPair(
  prefix: "org" | "scope",
  label: string,
  summary: MonthToDateSummary,
  caption: string,
): Kpi[] {
  return [
    {
      testId: `kpi-${prefix}-total`,
      label: `${label} spend`,
      caption,
      amount: summary.total,
    },
    {
      testId: `kpi-${prefix}-average`,
      label: `${label} average`,
      caption: "Per user, month to date. Nil spenders included.",
      amount: summary.average,
    },
  ];
}

function MemberLink({
  employeeId,
  name,
  testId,
}: {
  employeeId: string;
  name: string;
  testId: string;
}) {
  return (
    <Link
      href={`/members/${employeeId}`}
      data-testid={testId}
      className="font-medium text-brand-700 hover:underline dark:text-brand-300"
    >
      {name}
    </Link>
  );
}

function NearLimitTable({ rows }: { rows: NearLimitRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table data-testid="near-limit-table" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {[
              { label: "User", align: "text-left" },
              { label: "Limit", align: "text-right" },
              { label: "Period-to-date spend", align: "text-left" },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`px-2 py-2 font-medium text-slate-500 ${header.align}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.employeeId}
              data-testid="near-limit-row"
              data-employee-id={row.employeeId}
              className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
            >
              <td className="px-2 py-2">
                <MemberLink employeeId={row.employeeId} name={row.name} testId="near-limit-link" />
                {row.atCap ? (
                  <span
                    data-testid="at-cap-flag"
                    title="An explicit zero cap: included usage only (§G9)."
                    className="ml-2 rounded bg-danger-100 px-1.5 py-0.5 text-xs font-medium text-danger-900 dark:bg-danger-950 dark:text-danger-200"
                  >
                    At cap
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-2 text-right font-medium tabular-nums">
                <Money amount={row.amount} currency={row.currency} />
              </td>
              {/* `SpendBar` already renders the ratio (§Phase 9), so this table
                  does not repeat it in a column of its own. */}
              <td className="px-2 py-2" data-testid="near-limit-spend">
                <SpendBar spend={row.spend} amount={row.amount} currency={row.currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoversTable({ rows }: { rows: WowMoverRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table data-testid="wow-table" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {[
              { label: "User", align: "text-left" },
              { label: "Last 7 days", align: "text-right" },
              { label: "Previous 7 days", align: "text-right" },
              { label: "Change", align: "text-right" },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`px-2 py-2 font-medium text-slate-500 ${header.align}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.employeeId}
              data-testid="wow-row"
              data-employee-id={row.employeeId}
              className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
            >
              <td className="px-2 py-2">
                <MemberLink employeeId={row.employeeId} name={row.name} testId="wow-link" />
              </td>
              <td className="px-2 py-2 text-right font-medium tabular-nums">
                <Money amount={row.lastWeek} />
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-slate-500">
                <Money amount={row.priorWeek} />
              </td>
              <td
                className="px-2 py-2 text-right font-medium tabular-nums"
                data-testid="wow-multiple"
              >
                {row.multiple === null ? "new spend" : `${row.multiple.toFixed(1)}×`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AnalyticsPage() {
  const db = getDb();
  const actor = await currentEmployee(db);
  if (actor === null) return <Forbidden />;

  await ensureFreshSync(db);

  const config = loadAppConfig(db);
  const scope = visibleEmployees(db, actor, config.edit_roles, authorityIdsOf(db, actor)).map(
    (employee) => employee.id,
  );

  const now = new Date();
  const watermark = costWatermark(db);
  // Only as many days as are actually stored: the sync keeps a rolling window,
  // and padding the chart with zeros would invent a quiet fortnight.
  const days = trendWindowDays(db, scope, DEFAULT_TREND_DAYS, now);

  const trend = dailyTotals(db, scope, days, { now, watermark });
  const near = nearLimit(db, scope, config.near_limit_threshold);
  const movers = wowMovers(db, scope, WOW_MULTIPLE, { now });
  const top = topSpenders(db, scope, TOP_SPENDER_COUNT, { now });

  const thresholdPercent = Math.round(config.near_limit_threshold * 100);

  // An admin's visible set is the whole roster, so their scope pair and an
  // organization pair would be the same two numbers printed twice. They get one
  // pair, named for what it actually covers.
  const scopeSummary = monthToDateTotal(db, scope, { now });
  const orgSummary =
    actor.is_admin || !config.show_org_wide_kpis
      ? null
      : monthToDateTotal(db, allEmployeeIds(db), { now });

  const kpis: Kpi[] = actor.is_admin
    ? kpiPair("org", "Organization", scopeSummary, monthToDateCaption(scopeSummary.headcount))
    : [
        ...kpiPair("scope", "Your scope", scopeSummary, monthToDateCaption(scopeSummary.headcount)),
        ...(orgSummary === null
          ? []
          : kpiPair("org", "Organization", orgSummary, monthToDateCaption(orgSummary.headcount))),
      ];

  return (
    <section className="flex flex-col gap-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p data-testid="analytics-scope" className="text-sm text-slate-500">
          {actor.is_admin
            ? `Organization-wide, across all ${scope.length} users.`
            : `Your scope: ${scope.length} ${scope.length === 1 ? "person" : "people"} you can view.`}
        </p>
      </header>

      {/*
        The dividers are the 1px grid gap with the panel's border colour showing
        through it, rather than a border on each segment. A grid rewraps — two
        columns at `sm`, four at `lg` — and per-segment borders would need to
        know which cells had become the first of a row at each breakpoint. The
        gap knows already, at every width, for free.
      */}
      <div
        data-testid="kpi-cards"
        className={`grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 shadow-sm dark:border-slate-800 dark:bg-slate-800 ${
          kpis.length > 2 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2"
        }`}
      >
        {kpis.map((kpi) => (
          <KpiCard key={kpi.testId} {...kpi} />
        ))}
      </div>

      <Section
        title="Spend over time"
        caption={`Daily total across your scope, last ${days} days. Costs are synced for a rolling window, so the chart starts where the local data does.`}
      >
        <SpendOverTimeChart points={trend} watermarkDate={watermark?.slice(0, 10) ?? null} />
      </Section>

      <Section
        title="Near limit"
        caption={`Users at or above ${thresholdPercent}% of their effective cap. Users with no cap cannot be near one and are not listed.`}
      >
        {near.length === 0 ? (
          <p data-testid="near-limit-empty" className="text-sm text-slate-500">
            Nobody in your scope is within reach of their limit.
          </p>
        ) : (
          <NearLimitTable rows={near} />
        )}
      </Section>

      <Section
        title="Week-over-week movers"
        caption={`Users whose last 7 days cost at least ${WOW_MULTIPLE}× the 7 days before them.`}
      >
        {movers.length === 0 ? (
          <p data-testid="wow-empty" className="text-sm text-slate-500">
            No sharp week-over-week increases in your scope.
          </p>
        ) : (
          <MoversTable rows={movers} />
        )}
      </Section>

      <Section
        title="Top spenders, month to date"
        caption="Summed from daily cost since the first of the month; the most recent days may still be revised."
      >
        <TopSpenderBars rows={top} />
      </Section>
    </section>
  );
}
