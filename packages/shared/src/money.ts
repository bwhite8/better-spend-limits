/**
 * Money utilities (plan §G9).
 *
 * Every amount that crosses the wire — spend limits, period-to-date spend, cost
 * report rows — is a DECIMAL STRING IN MINOR UNITS (cents) that may carry a
 * fractional part (`"41280.125"` = 41280.125 cents). Arithmetic here is done on
 * BigInt integer parts plus digit-string fractions; `parseFloat` is never used
 * for anything but explicitly display-only conversions.
 *
 * `null` means UNLIMITED (no limit configured anywhere). `"0"` means an actual
 * zero cap — included-usage only — and is treated as "at limit", not "no limit".
 */

/** Thrown when a string is not a well-formed non-negative decimal amount. */
export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

export interface ParsedMinorUnits {
  /** Whole minor units (cents). BigInt so large orgs never lose precision. */
  cents: bigint;
  /** Digits after the decimal point, trailing zeros stripped; "" when none. */
  fraction: string;
}

/** Amounts on the wire are non-negative: digits, optional `.` + digits. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

/** Dollar input accepts at most 2 decimal places (cents). */
const DOLLAR_INPUT_PATTERN = /^\d+(\.\d{1,2})?$/;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "CA$",
  AUD: "A$",
  EUR: "€",
  GBP: "£",
};

/** Label rendered for an unlimited (null) amount. */
export const UNLIMITED_LABEL = "Unlimited";

function stripTrailingZeros(fraction: string): string {
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") end -= 1;
  return fraction.slice(0, end);
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Parse a decimal minor-units string into an exact `{cents, fraction}` pair.
 * Throws {@link MoneyFormatError} on anything malformed (including negatives —
 * the APIs in this project never emit them).
 */
export function parseMinorUnits(amount: string): ParsedMinorUnits {
  if (typeof amount !== "string") {
    throw new MoneyFormatError(`Expected a decimal minor-units string, got ${typeof amount}`);
  }
  const trimmed = amount.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) {
    throw new MoneyFormatError(`Malformed minor-units amount: ${JSON.stringify(amount)}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return { cents: BigInt(whole), fraction: stripTrailingZeros(fraction) };
}

/** True when the parsed amount is exactly zero (an explicit `"0"` cap). */
export function isZeroMinorUnits(amount: string): boolean {
  const { cents, fraction } = parseMinorUnits(amount);
  return cents === 0n && fraction === "";
}

/**
 * Order two decimal minor-units strings. Integer parts compare as BigInt; ties
 * break on the zero-padded fraction digits.
 */
export function compareMinorUnits(a: string, b: string): -1 | 0 | 1 {
  const left = parseMinorUnits(a);
  const right = parseMinorUnits(b);
  if (left.cents !== right.cents) return left.cents < right.cents ? -1 : 1;
  const width = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(width, "0");
  const rightFraction = right.fraction.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

/**
 * Exact sum of decimal minor-units strings. `null`/`undefined` entries are
 * skipped (an unlimited member contributes nothing to a spend total). Returns a
 * canonical decimal string; `"0"` for an empty input.
 */
export function sumMinorUnits(amounts: Iterable<string | null | undefined>): string {
  const parsed: ParsedMinorUnits[] = [];
  let width = 0;
  for (const amount of amounts) {
    if (amount === null || amount === undefined) continue;
    const value = parseMinorUnits(amount);
    width = Math.max(width, value.fraction.length);
    parsed.push(value);
  }
  const scale = 10n ** BigInt(width);
  let total = 0n;
  for (const { cents, fraction } of parsed) {
    const padded = fraction.padEnd(width, "0");
    total += cents * scale + (padded === "" ? 0n : BigInt(padded));
  }
  const whole = total / scale;
  if (width === 0) return whole.toString();
  const fraction = stripTrailingZeros((total % scale).toString().padStart(width, "0"));
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * Lossy conversion to a JS number, for CHART AXES AND RATIOS ONLY. Never round
 * trip a stored amount through this — use the string helpers above.
 */
export function minorUnitsToNumber(amount: string): number {
  const { cents, fraction } = parseMinorUnits(amount);
  return Number(fraction === "" ? cents.toString() : `${cents}.${fraction}`);
}

export interface FormatMoneyOptions {
  /**
   * Drop the `.00` from an amount that lands exactly on a whole major unit, so
   * a column of round caps reads `$500` instead of `$500.00`.
   *
   * This is a DENSITY choice for list views, not a rounding one: the trim is
   * applied after the half-up rounding, and only when the trimmed digits were
   * both zero. `"1234"` still renders `"$12.34"`. Anywhere a reader might be
   * checking a figure to the cent — the member page, the edit dialogs, the
   * audit log — leave it off.
   */
  trimWholeDollars?: boolean;
}

/**
 * Render an amount for display: `"50000"` → `"$500.00"`, `null` → `"Unlimited"`.
 * Fractional cents are rounded half-up to the nearest cent. Thousands are comma
 * grouped (`"150000"` → `"$1,500.00"`). Unknown currency codes render as
 * `"XYZ 500.00"`.
 *
 * See {@link FormatMoneyOptions.trimWholeDollars} for the one shape that omits
 * the cents.
 */
export function formatMoney(
  amount: string | null,
  currency = "USD",
  options: FormatMoneyOptions = {},
): string {
  if (amount === null || amount === undefined) return UNLIMITED_LABEL;
  const { cents, fraction } = parseMinorUnits(amount);
  // Fraction digits compare positionally, so a plain string compare against "5"
  // is an exact "is this at least half a cent?" test.
  const rounded = fraction !== "" && fraction >= "5" ? cents + 1n : cents;
  const major = groupDigits((rounded / 100n).toString());
  const minorUnits = rounded % 100n;
  const body =
    options.trimWholeDollars === true && minorUnits === 0n
      ? major
      : `${major}.${minorUnits.toString().padStart(2, "0")}`;
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol === undefined ? `${currency.toUpperCase()} ${body}` : `${symbol}${body}`;
}

/**
 * Convert a dollars-and-cents form input into the minor-units string the wire
 * expects: `"750"` → `"75000"`, `"0.5"` → `"50"`. `$` signs, commas and
 * surrounding whitespace are tolerated. Throws {@link MoneyFormatError} on
 * negatives, non-numbers, empty input, or more than two decimal places.
 */
export function dollarsInputToMinorUnits(input: string): string {
  if (typeof input !== "string") {
    throw new MoneyFormatError(`Expected a dollar amount string, got ${typeof input}`);
  }
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!DOLLAR_INPUT_PATTERN.test(cleaned)) {
    throw new MoneyFormatError(
      `Enter a non-negative dollar amount with at most 2 decimal places (got ${JSON.stringify(input)})`,
    );
  }
  const [whole, fraction = ""] = cleaned.split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0")).toString();
}

/**
 * Fraction of an effective limit consumed by period-to-date spend.
 *
 * - `amount === null` (unlimited) → `null`; there is no ratio to draw.
 * - `amount === "0"` (included-usage only) → `1`; the member is at their cap.
 * - malformed input → `null` rather than throwing, so render paths stay safe.
 *
 * Values above 1 are returned as-is (over-limit is meaningful); clamping is the
 * caller's presentation choice.
 */
export function spendRatio(spend: string | null, amount: string | null): number | null {
  if (amount === null || amount === undefined) return null;
  let limit: number;
  try {
    if (isZeroMinorUnits(amount)) return 1;
    limit = minorUnitsToNumber(amount);
  } catch {
    return null;
  }
  if (!(limit > 0)) return null;
  if (spend === null || spend === undefined) return null;
  try {
    return minorUnitsToNumber(spend) / limit;
  } catch {
    return null;
  }
}
