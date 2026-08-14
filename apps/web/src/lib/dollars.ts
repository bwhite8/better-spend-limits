/**
 * Minor units → the dollars string a form field wants (§G9).
 *
 * The inverse of `dollarsInputToMinorUnits`, and deliberately NOT
 * `formatMoney`: an input's value has to round-trip back through the parser, so
 * it carries no currency symbol and no thousands separators. `"75000"` becomes
 * `"750.00"`, which `dollarsInputToMinorUnits` turns straight back into
 * `"75000"`.
 *
 * Fractional cents are rounded half-up, matching `formatMoney`, because a form
 * that accepts at most two decimal places cannot represent them — an amount of
 * `"41280.125"` is offered for editing as `"412.80"`.
 *
 * This module is imported by a client component, so it stays free of anything
 * server-only (no database, no `next/*`).
 */

import { parseMinorUnits } from "@bsl/shared";

/**
 * `"75000"` → `"750.00"`. `null` (unlimited) and anything malformed yield `""`,
 * i.e. an empty field — there is no dollar value to pre-fill.
 */
export function minorUnitsToDollarsInput(amount: string | null | undefined): string {
  if (amount === null || amount === undefined) return "";

  try {
    const { cents, fraction } = parseMinorUnits(amount);
    // Fraction digits compare positionally, so ">= '5'" is an exact
    // "at least half a cent" test (same rule as `formatMoney`).
    const rounded = fraction !== "" && fraction >= "5" ? cents + 1n : cents;
    return `${rounded / 100n}.${(rounded % 100n).toString().padStart(2, "0")}`;
  } catch {
    return "";
  }
}
