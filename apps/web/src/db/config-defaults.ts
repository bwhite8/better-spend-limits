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
  "aligned_ai_lead",
] as const;

export type EditRole = (typeof EDIT_ROLE_VALUES)[number];

export interface AppConfigDefaults {
  edit_roles: EditRole[];
  suppress_notification_default: boolean;
  near_limit_threshold: number;
  sync_stale_after_minutes: number;
}

export const APP_CONFIG_DEFAULTS: AppConfigDefaults = {
  edit_roles: ["tier3_manager", "tier4_manager", "aligned_ai_lead"],
  suppress_notification_default: true,
  near_limit_threshold: 0.8,
  sync_stale_after_minutes: 15,
};

/** The defaults as `app_config` rows, ready to insert. */
export function appConfigDefaultRows(): { key: string; value: string }[] {
  return Object.entries(APP_CONFIG_DEFAULTS).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
  }));
}
