/**
 * Date rendering (plan §Phase 2).
 *
 * Every date this app displays arrives as a stored ISO string that is already
 * UTC — `user_daily_cost.date` is date-only (`"2026-08-14"`), audit timestamps
 * and request timestamps are full `Z`-suffixed instants. Rendering them with
 * `new Date(...)` plus `toLocaleDateString` would reinterpret the date-only form
 * as UTC midnight and then print it in the *viewer's* zone, so anybody west of
 * Greenwich would read `2026-08-14` as "August 13" — and the server would render
 * one day while the browser hydrated another.
 *
 * So this module never constructs a `Date`, never touches `Intl`, and has no
 * locale dependency: it slices the ISO string and indexes a literal month table.
 * The output is identical on every machine in every timezone.
 *
 * Like `formatMoney` in `money.ts`, these are display helpers and therefore
 * never throw. A string that is not a well-formed ISO date comes back verbatim —
 * a formatter must not be the reason a page 500s.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** The date-only head of an ISO string: exactly `YYYY-MM-DD`. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM`, taken from characters 11–16 of a full ISO timestamp. */
const ISO_TIME_PATTERN = /^\d{2}:\d{2}$/;

/**
 * `"2026-08-14"` → `"August 14, 2026"`.
 *
 * Accepts either a date-only string or a full ISO timestamp (the first ten
 * characters are all that is read). The day carries no leading zero, so
 * `"2026-08-04"` renders as `"August 4, 2026"`. Anything that is not a
 * well-formed `YYYY-MM-DD` head — including a real-looking but impossible month
 * or day — is returned unchanged.
 */
export function formatDate(iso: string): string {
  if (typeof iso !== "string") return iso;
  const head = iso.slice(0, 10);
  if (!ISO_DATE_PATTERN.test(head)) return iso;

  const [year, month, day] = head.split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  const dayNumber = Number(day);
  if (name === undefined || dayNumber < 1 || dayNumber > 31) return iso;

  return `${name} ${dayNumber}, ${year}`;
}

/**
 * `"2026-08-14T09:05:22.000Z"` → `"August 14, 2026 09:05"`. Seconds are noise in
 * an audit log, so they are dropped.
 *
 * A string too short to carry a time, or whose time part is malformed, renders
 * as {@link formatDate} alone; a string whose date part is malformed is echoed
 * verbatim, which is what the audit table did before this helper existed.
 */
export function formatDateTime(iso: string): string {
  const date = formatDate(iso);
  // `formatDate` only ever returns its input when it could not parse it — a
  // successful render always begins with a month name.
  if (date === iso) return iso;
  if (iso.length < 16) return date;

  const time = iso.slice(11, 16);
  return ISO_TIME_PATTERN.test(time) ? `${date} ${time}` : date;
}
