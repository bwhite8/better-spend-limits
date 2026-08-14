/**
 * The 403 body, shared by every "you are not allowed to see this" path (§G8).
 *
 * Two distinct situations render it:
 *
 * - **Not provisioned** — the request carries an email that matches no row in
 *   `employees`. There is no fallback identity by design.
 * - **Out of scope** — a real employee asking for somebody they may not view.
 *
 * The dev-mode user switcher lives in the sidebar and is rendered by the layout
 * even in this state, which is the only way out of "not provisioned" on a fresh
 * browser with no impersonation cookie.
 *
 * This is a plain component, not Next's `forbidden.js` convention file: that
 * convention needs `experimental.authInterrupts`, and pages here decide for
 * themselves rather than throwing an interrupt.
 */

export interface ForbiddenProps {
  title?: string;
  /** One sentence explaining what would fix it. */
  detail?: string;
}

export default function Forbidden({
  title = "Not provisioned",
  detail = "This account has no employee record, so there is nothing it is allowed to see. Pick a different user, or ask an administrator to import your record.",
}: ForbiddenProps) {
  return (
    <section data-testid="forbidden" className="mx-auto max-w-xl py-16">
      <p className="text-sm font-semibold tracking-wide text-red-600 uppercase">403 — Forbidden</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-slate-600 dark:text-slate-400">{detail}</p>
    </section>
  );
}

/** The out-of-scope variant, so callers do not restate the wording. */
export function NotVisible() {
  return (
    <Forbidden
      title="Out of scope"
      detail="You can only view people whose spend limit you are allowed to edit, plus yourself."
    />
  );
}
