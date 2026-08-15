"use client";

/**
 * The two drawn things on the analytics page (plan §Phase 12).
 *
 * Both are fed entirely by server-computed props — no fetching, no aggregation,
 * no permission reasoning. The server already decided which members are in scope
 * and summed them exactly (§G9 BigInt decimals); these components only convert
 * to a JavaScript number at the last moment, to position a point or size a bar.
 *
 * The trend line is drawn as TWO series over the same axis: everything up to the
 * §G5 freshness watermark, and everything after it. That is not decoration. Data
 * after the watermark is an incomplete tail that the API may revise for up to 30
 * days, and a chart that drew it in the same stroke as settled history would
 * invite somebody to read a dip as a real fall in spend when it is just a day
 * that has not finished arriving. The two series overlap on the last settled
 * point so the line stays continuous.
 */

import Link from "next/link";

import { formatDate, formatMoney, minorUnitsToNumber } from "@bsl/shared";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from "recharts";

/** Recharts' `NameType`, which the package does not re-export from its root. */
type NameType = number | string;

export interface TrendPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Decimal minor units (§G9). */
  amount: string;
  provisional: boolean;
}

/** Minor units → whole currency units, for axis positions only. */
function majorUnits(amount: string): number {
  try {
    return minorUnitsToNumber(amount) / 100;
  } catch {
    return 0;
  }
}

function formatAxisMoney(value: number): string {
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

interface ChartDatum {
  date: string;
  amount: string;
  settled: number | null;
  provisional: number | null;
}

/**
 * `Tooltip.content` is typed against Recharts' own widest value/name types, so
 * the callback has to be too — narrowing it to `number` makes the prop
 * assignment fail. The datum is read off the payload instead, where our own
 * shape is the one that matters.
 */
function ChartTooltip({ active, payload }: TooltipContentProps<TooltipValueType, NameType>) {
  const datum = active ? (payload?.[0]?.payload as ChartDatum | undefined) : undefined;
  if (!datum) return null;

  return (
    <div className="rounded border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <p className="font-medium">{formatDate(datum.date)}</p>
      <p className="tabular-nums">{formatMoney(datum.amount)}</p>
      {datum.settled === null ? <p className="text-amber-600">provisional</p> : null}
    </div>
  );
}

export interface SpendOverTimeChartProps {
  points: TrendPoint[];
  /** The §G5 watermark as `YYYY-MM-DD`; `null` when costs have never synced. */
  watermarkDate: string | null;
}

/**
 * Daily spend across the viewer's scope, settled history solid and the
 * provisional tail dashed.
 */
export function SpendOverTimeChart({ points, watermarkDate }: SpendOverTimeChartProps) {
  const lastSettled = points.reduce(
    (index, point, i) => (point.provisional ? index : i),
    -1,
  );

  const data: ChartDatum[] = points.map((point, index) => {
    const value = majorUnits(point.amount);
    return {
      date: point.date,
      amount: point.amount,
      settled: point.provisional ? null : value,
      // The join point belongs to both series, so the dashed segment starts
      // where the solid one ends instead of floating free.
      provisional: point.provisional || index === lastSettled ? value : null,
    };
  });

  if (data.length === 0) {
    return (
      <p data-testid="spend-chart-empty" className="text-sm text-slate-500">
        No cost data has been synced yet.
      </p>
    );
  }

  return (
    <div data-testid="spend-chart" className="h-56 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-800" />
          <XAxis
            dataKey="date"
            tickFormatter={(date: string) => date.slice(5)}
            interval="preserveStartEnd"
            minTickGap={40}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-slate-400"
          />
          <YAxis
            tickFormatter={formatAxisMoney}
            width={48}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-slate-400"
          />
          <Tooltip content={ChartTooltip} />
          <Line
            type="monotone"
            dataKey="settled"
            name="Settled"
            stroke="#4f46e5"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="provisional"
            name="Provisional"
            stroke="#f59e0b"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={{ r: 2 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <p data-testid="chart-legend" className="mt-2 text-xs text-slate-500">
        <span className="mr-1 inline-block h-0.5 w-4 align-middle bg-indigo-600" /> settled
        <span className="mx-1">·</span>
        <span className="mr-1 inline-block h-0.5 w-4 align-middle bg-amber-500" />
        {watermarkDate === null
          ? "provisional tail — costs have not synced yet"
          : `after ${formatDate(watermarkDate)} = provisional (still being revised, up to 30 days)`}
      </p>
    </div>
  );
}

export interface SpenderBar {
  employeeId: string;
  name: string;
  /** Decimal minor units (§G9). */
  amount: string;
}

/**
 * Month-to-date top spenders as a proportional bar list.
 *
 * Deliberately not a Recharts bar chart: the labels are people's names and the
 * rows link to their member pages, which HTML does better than an SVG axis.
 */
export function TopSpenderBars({ rows }: { rows: SpenderBar[] }) {
  const largest = rows.reduce((max, row) => Math.max(max, majorUnits(row.amount)), 0);

  if (rows.length === 0) {
    return (
      <p data-testid="top-spenders-empty" className="text-sm text-slate-500">
        No spend recorded this month.
      </p>
    );
  }

  return (
    <ol data-testid="top-spenders" className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const width = largest > 0 ? (majorUnits(row.amount) / largest) * 100 : 0;
        return (
          <li
            key={row.employeeId}
            data-testid="top-spender-row"
            data-employee-id={row.employeeId}
            className="flex items-center gap-3 text-sm"
          >
            <Link
              href={`/members/${row.employeeId}`}
              className="w-28 shrink-0 truncate text-indigo-700 hover:underline sm:w-44 dark:text-indigo-300"
            >
              {row.name}
            </Link>
            <span className="h-2 min-w-1 grow overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <span
                aria-hidden="true"
                className="block h-full rounded-full bg-indigo-500"
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums sm:w-24">
              {formatMoney(row.amount)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
