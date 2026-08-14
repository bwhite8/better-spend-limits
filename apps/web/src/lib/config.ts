/**
 * Reading `app_config` (§G7) safely.
 *
 * Configuration is user-editable from the admin area (Phase 13) and is stored
 * as JSON text, so every read has to survive a value that is missing, is not
 * JSON at all, or is JSON of the wrong shape. The rule throughout is: **a bad
 * value falls back to the documented default rather than throwing**, because a
 * malformed `near_limit_threshold` should not take the whole app down.
 *
 * `loadAppConfig` reads every key in one query and is the intended entry point
 * for anything that needs more than one setting. Phase 7 uses `edit_roles`;
 * Phase 8 wants `sync_stale_after_minutes`, Phase 10 `suppress_notification_default`,
 * Phase 12 `near_limit_threshold`.
 */

import type { AppDatabase } from "@/db/client";
import {
  APP_CONFIG_DEFAULTS,
  EDIT_ROLE_VALUES,
  type AppConfigDefaults,
  type EditRole,
} from "@/db/config-defaults";
import { appConfig } from "@/db/schema";

/** Raw `key → value` (still JSON-encoded) for every configured key. */
export function readRawConfig(db: AppDatabase): Map<string, string> {
  const rows = db.select().from(appConfig).all();
  return new Map(rows.map((row) => [row.key, row.value]));
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const isEditRole = (value: unknown): value is EditRole =>
  typeof value === "string" && (EDIT_ROLE_VALUES as readonly string[]).includes(value);

/**
 * `edit_roles` must be an array whose every entry is one of the five allowed
 * role names (§G7). An EMPTY array is legitimate — it means "only admins may
 * edit" — but a single unrecognised entry rejects the whole value, because
 * silently dropping a role the administrator believed they had granted is worse
 * than visibly falling back to the documented default.
 */
function validateEditRoles(value: unknown): EditRole[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isEditRole)) return null;
  return [...new Set(value)];
}

function validateBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** A ratio in [0, 1]; anything else (including NaN) is rejected. */
function validateRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

function validatePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value > 0 ? value : null;
}

/** Every §G7 setting, with each malformed or missing value replaced by its default. */
export function loadAppConfig(db: AppDatabase): AppConfigDefaults {
  const raw = readRawConfig(db);
  const read = (key: keyof AppConfigDefaults) => parseJson(raw.get(key));

  return {
    edit_roles: validateEditRoles(read("edit_roles")) ?? APP_CONFIG_DEFAULTS.edit_roles,
    suppress_notification_default:
      validateBoolean(read("suppress_notification_default")) ??
      APP_CONFIG_DEFAULTS.suppress_notification_default,
    near_limit_threshold:
      validateRatio(read("near_limit_threshold")) ?? APP_CONFIG_DEFAULTS.near_limit_threshold,
    sync_stale_after_minutes:
      validatePositiveInt(read("sync_stale_after_minutes")) ??
      APP_CONFIG_DEFAULTS.sync_stale_after_minutes,
  };
}
