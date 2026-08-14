/**
 * Money display primitives (§G9).
 *
 * These are deliberately hook-free so the same module can render inside a
 * Server Component (the members list, 250 rows of it) and inside a Client
 * Component (the search-filtered table) without a `"use client"` boundary and
 * without shipping 250 hydration roots.
 *
 * `AmountInput` genuinely needs state, so it lives in its own client module and
 * is re-exported here — the plan's `@/components/money` import path is the one
 * Phase 10 should use for all three.
 */

import { formatMoney, isZeroMinorUnits, spendRatio, UNLIMITED_LABEL } from "@bsl/shared";

export { AmountInput, type AmountInputProps } from "./amount-input";

/** Bar is clipped here; over-limit is still reported in the label. */
const MAX_BAR_FRACTION = 1;

export interface MoneyProps {
  /** Decimal string in minor units, or `null` for UNLIMITED (§G9). */
  amount: string | null;
  /** ISO currency code. `null`/absent falls back to USD, as the API does. */
  currency?: string | null;
  className?: string;
}

/**
 * `"50000"` → `$500.00`, `null` → `Unlimited`, `"0"` → `$0.00`.
 *
 * A malformed amount renders as the literal string rather than throwing: a
 * money formatter must never be the reason a page 500s.
 */
export function Money({ amount, currency, className }: MoneyProps) {
  let text: string;
  try {
    text = formatMoney(amount, currency ?? undefined);
  } catch {
    text = amount ?? UNLIMITED_LABEL;
  }

  return (
    <span
      className={className}
      data-testid="money"
      data-unlimited={amount === null ? "true" : undefined}
    >
      {text}
    </span>
  );
}

export interface SpendBarProps {
  /** Period-to-date spend, decimal minor units. `"0"` may mean "no reading". */
  spend: string | null;
  /** The effective limit; `null` is unlimited and draws no bar. */
  amount: string | null;
  currency?: string | null;
  className?: string;
}

function barTone(ratio: number): string {
  if (ratio >= 1) return "bg-red-500";
  if (ratio >= 0.8) return "bg-amber-500";
  return "bg-emerald-500";
}

/**
 * Spend against the cap, as a bar plus a percentage.
 *
 * Three cases the plan calls out explicitly (§G9):
 *
 * - unlimited cap → no ratio exists, so no bar is drawn;
 * - `"0"` cap → the member is at their cap by definition, drawn full;
 * - `"0"` spend → the API also returns `"0"` when the reading is unavailable, so
 *   the percentage is shown with an ⓘ note rather than asserted as a fact.
 */
export function SpendBar({ spend, amount, currency, className }: SpendBarProps) {
  const ratio = spendRatio(spend, amount);
  const spendUnavailable = spend !== null && isZeroMinorUnits(spend);

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`} data-testid="spend-bar">
      <span className="tabular-nums">
        <Money amount={spend} currency={currency} />
      </span>

      {ratio === null ? (
        <span className="text-xs text-slate-500" data-testid="spend-ratio">
          no cap
        </span>
      ) : (
        <>
          <span
            aria-hidden="true"
            className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
          >
            <span
              className={`block h-full rounded-full ${barTone(ratio)}`}
              style={{ width: `${Math.min(ratio, MAX_BAR_FRACTION) * 100}%` }}
            />
          </span>
          <span className="text-xs tabular-nums text-slate-500" data-testid="spend-ratio">
            {Math.round(ratio * 100)}%
          </span>
        </>
      )}

      {spendUnavailable ? (
        <span
          data-testid="spend-unavailable"
          title="A reported spend of 0 can also mean the reading is unavailable."
          className="cursor-help text-xs text-slate-400"
        >
          ⓘ
        </span>
      ) : null}
    </span>
  );
}
