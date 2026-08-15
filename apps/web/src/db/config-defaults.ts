/**
 * The `app_config` defaults from §G7. Values are stored JSON-encoded.
 *
 * Phase 7 reads `edit_roles` through its own validating loader; this module is
 * only about what a freshly seeded database starts out with.
 */

/** Roles that may appear in `edit_roles`; each maps to an `employees.<role>_id` column. */
export const EDIT_ROLE_VALUES = [
  "direct_manager",
  "tier2_manager",
  "tier3_manager",
  "tier4_manager",
] as const;

export type EditRole = (typeof EDIT_ROLE_VALUES)[number];

/**
 * Role names that were grantable once and are not any more (§Phase 9).
 *
 * `aligned_ai_lead` is HRIS data assigned across whole VP subtrees, so a lead's
 * reach had nothing to do with their own position — measured on seed 42, the
 * eight leads saw 87, 69, 27, 26, 25, 25, 24 and 11 people. Delegation replaced
 * it: `ai_lead_assignments` names the LEADERS a lead speaks for, and the lead
 * inherits those leaders' hierarchy scope. The **column stays** — it is real and
 * the member page still shows it — it just stops granting anything.
 *
 * Leaving the role legal-but-not-default would have been worse than removing
 * it: an admin could re-tick the box and quietly restore column-based access,
 * leaving two mechanisms granting the same authority with different scopes and
 * no UI explaining the difference.
 *
 * Kept here rather than deleted so `lib/config.ts` can recognise a persisted
 * value written before the change and rewrite it visibly, instead of silently
 * rejecting the whole array and falling back to the default.
 */
export const RETIRED_EDIT_ROLE_VALUES = ["aligned_ai_lead"] as const;

export interface AppConfigDefaults {
  edit_roles: EditRole[];
  suppress_notification_default: boolean;
  near_limit_threshold: number;
  sync_stale_after_minutes: number;
  /**
   * Show the organization-wide spend KPIs beside the viewer's own scope figures
   * on Analytics.
   *
   * Everything else on that page is scoped first, deliberately (§G8 option B).
   * This is the one exception, and it exists so a manager has a denominator for
   * their own number. It is only ever a TOTAL and a HEADCOUNT AVERAGE — no
   * individual is named, and no per-person figure is derivable from it — but it
   * is still a fact about people the viewer cannot open, so a fork that would
   * rather not publish it can turn it off here.
   */
  show_org_wide_kpis: boolean;
}

export const APP_CONFIG_DEFAULTS: AppConfigDefaults = {
  edit_roles: ["tier3_manager", "tier4_manager"],
  suppress_notification_default: true,
  near_limit_threshold: 0.8,
  sync_stale_after_minutes: 15,
  show_org_wide_kpis: true,
};

/** The defaults as `app_config` rows, ready to insert. */
export function appConfigDefaultRows(): { key: string; value: string }[] {
  return Object.entries(APP_CONFIG_DEFAULTS).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
  }));
}
