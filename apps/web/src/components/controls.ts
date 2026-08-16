/**
 * The interactive-control tokens — one definition of "a button" and "a field".
 *
 * `surface.ts` names the elevated card once so paneled sections cannot drift
 * apart. This is the same argument for the things a user actually operates, and
 * it had further to fall: the secondary-button class string was typed out
 * verbatim in eight files, so the app had eight chances to disagree with itself
 * about what a button is — and did, ending up with a green Approve, an indigo
 * Save and a white-outlined Edit that shared no shape, height or radius.
 *
 * Three rules the whole app now inherits from here:
 *
 *   - **Tone carries meaning, not decoration.** `primary` is the brand action,
 *     `success` a decision that grants something, `danger` a write that cannot
 *     be taken back, `secondary` everything else. They map onto the accent
 *     scales in `globals.css` §@theme, so a rebrand still costs one file.
 *   - **Touch first, then pointer.** Every control is 44px tall on a phone —
 *     the smallest target a thumb can hit reliably — and shrinks to 36px (32px
 *     for `sm`) at `md`, where a mouse is doing the aiming.
 *   - **Compose, never concatenate conflicts.** Each string below sets a given
 *     property exactly once, so `button("primary", "sm")` cannot produce two
 *     competing `min-h-*` utilities whose winner is decided by Tailwind's
 *     internal sort order rather than by this file.
 *
 * The focus ring is deliberately NOT here: it is a single `:focus-visible` rule
 * in `globals.css` covering every element, because a ring some components
 * remember and others forget is one a keyboard user cannot trust.
 */

export type ButtonTone = "primary" | "secondary" | "success" | "danger";

/** `md` is the default; `sm` is for controls that sit inside a table row. */
export type ButtonSize = "md" | "sm";

const BUTTON_SHAPE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: "min-h-11 px-3 py-2 text-sm md:min-h-9 md:py-1.5",
  sm: "min-h-11 px-3 py-2 text-sm md:min-h-8 md:px-2.5 md:py-1 md:text-xs",
};

/*
 * `success` is 700 rather than the 600 the other filled tones use, and that is a
 * contrast fix rather than a taste one: white on `success-600` measures 3.65:1,
 * under the 4.5:1 WCAG AA needs for body-sized text. 700 clears it. The token
 * doc in `globals.css` assigns approvals to the success scale, so Approve stays
 * green — it just stopped being green nobody could read.
 */
const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary:
    "border border-slate-300 bg-white text-slate-700 shadow-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  success: "bg-success-700 text-white hover:bg-success-800",
  danger: "bg-danger-600 text-white hover:bg-danger-700",
};

/** The class string for a button. Callers append layout classes, never colour. */
export function button(tone: ButtonTone = "secondary", size: ButtonSize = "md"): string {
  return `${BUTTON_SHAPE} ${BUTTON_SIZES[size]} ${BUTTON_TONES[tone]}`;
}

/*
 * Width is left to the caller — a search box wants `w-64` and an amount field
 * `w-36` — so it is the one dimension this module does not decide.
 */
const CONTROL_BASE =
  "min-h-11 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-xs disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

/** A text, search, number or file input. */
export const FIELD = `${CONTROL_BASE} px-3 py-2 placeholder:text-slate-400 md:py-1.5`;

/** A single-select. `.select-chevron` (globals.css) owns its right padding. */
export const SELECT = `${CONTROL_BASE} select-chevron py-2 pl-3 md:py-1.5`;

/**
 * A checkbox. The size is the only thing worth stating — the colour comes from
 * the `accent-color` in `globals.css`, which is why this is three utilities and
 * not thirty.
 */
export const CHECKBOX = "h-5 w-5 shrink-0 rounded md:h-4 md:w-4";

/** The small uppercase label above a field or beside a value. */
export const FIELD_LABEL = "text-xs font-medium text-slate-500";
