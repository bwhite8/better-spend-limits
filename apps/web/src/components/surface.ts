/**
 * The elevated-surface token — one definition of "a card".
 *
 * Every paneled section in the app (Analytics KPIs and charts, Admin settings,
 * a member's detail sections) is the same white surface lifted off the slate
 * canvas by a hairline border and a soft shadow (see globals.css `body` for why
 * the canvas is slate rather than white). Naming it once here, rather than
 * re-typing the class string per page, is what keeps those surfaces from
 * drifting apart — the same reason the accent scales live in `@theme`.
 */
export const CARD =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
