"use server";

/**
 * The two writes the admin area performs (plan §Phase 13).
 *
 * Both are server actions rather than BFF routes — unlike Phases 10 and 11,
 * neither talks to the Anthropic API, so there is no upstream status code to
 * pass through and nothing a route handler would buy. What they do share with
 * those routes is the two non-negotiables: **the permission check happens here,
 * on the server, on every call**, and **every write leaves an `audit_log` row**
 * (§G8). A client that never renders the form can still call these functions.
 *
 * Neither action throws at its caller. A rejected config or an unreadable CSV is
 * an ordinary outcome of an admin screen, and an unhandled server-action
 * rejection would surface as a generic framework error with the actual reason
 * scrubbed out in production.
 */

import type { AppDatabase } from "@/db/client";
import { getDb } from "@/db/client";
import { EDIT_ROLE_VALUES, type AppConfigDefaults, type EditRole } from "@/db/config-defaults";
import { appConfig, type Employee } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { loadAppConfig } from "@/lib/config";
import { applyEmployeeImport, type ImportSummary } from "@/lib/employee-roster";
import { currentEmployee } from "@/lib/identity";
import { parseEmployeeCsv } from "@/lib/import-employees";

import type { AdminActionResult, ConfigUpdateInput } from "./types";

/** How many parse problems the UI is shown before it is just noise. */
const MAX_REPORTED_ISSUES = 20;

const NOT_ADMIN: AdminActionResult = {
  ok: false,
  message: "Only administrators can change application settings.",
};

/** The acting employee, or `null` when they are not an admin (or not anybody). */
async function resolveAdmin(db: AppDatabase): Promise<Employee | null> {
  const actor = await currentEmployee(db);
  return actor !== null && actor.is_admin ? actor : null;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const isEditRole = (value: string): value is EditRole =>
  (EDIT_ROLE_VALUES as readonly string[]).includes(value);

/**
 * Validate the form into a config, or explain what is wrong with it.
 *
 * `edit_roles` must name at least one role. The reader (`lib/config.ts`) accepts
 * an empty list as "admins only", but choosing that from a checkbox grid is far
 * more likely to be a slip than a policy, and an admin who really wants it can
 * still uncheck the roles one deployment-config edit at a time.
 */
function validateConfig(input: ConfigUpdateInput): AppConfigDefaults | string {
  const roles = Array.isArray(input.edit_roles) ? [...new Set(input.edit_roles)] : [];
  if (roles.length === 0) {
    return "Choose at least one role that may edit spend limits, or nobody but admins will be able to.";
  }
  const unknown = roles.filter((role) => !isEditRole(role));
  if (unknown.length > 0) return `Unknown edit role: ${unknown.join(", ")}.`;

  const threshold = Number(input.near_limit_threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return "The near-limit threshold must be a fraction between 0 and 1.";
  }

  const staleAfter = Number(input.sync_stale_after_minutes);
  if (!Number.isInteger(staleAfter) || staleAfter <= 0) {
    return "Sync staleness must be a whole number of minutes, greater than zero.";
  }

  return {
    edit_roles: roles.filter(isEditRole),
    near_limit_threshold: threshold,
    suppress_notification_default: input.suppress_notification_default === true,
    sync_stale_after_minutes: staleAfter,
  };
}

/** Only the keys whose stored JSON actually differs. */
function changedKeys(
  before: AppConfigDefaults,
  after: AppConfigDefaults,
): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of Object.keys(after) as (keyof AppConfigDefaults)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed[key] = { from: before[key], to: after[key] };
    }
  }

  return changed;
}

/**
 * Save the application settings (§G7 `app_config`).
 *
 * Writes every key, not only the changed ones, so a key that was missing or
 * corrupt — and therefore being served from its default — becomes explicit the
 * first time an admin presses Save. The audit entry still records only what
 * genuinely moved.
 */
export async function updateConfig(input: ConfigUpdateInput): Promise<AdminActionResult> {
  const db = getDb();
  const actor = await resolveAdmin(db);
  if (actor === null) return NOT_ADMIN;

  const validated = validateConfig(input);
  if (typeof validated === "string") return { ok: false, message: validated };

  const before = loadAppConfig(db);
  const changed = changedKeys(before, validated);

  db.transaction((tx) => {
    for (const [key, value] of Object.entries(validated)) {
      const encoded = JSON.stringify(value);
      tx.insert(appConfig)
        .values({ key, value: encoded })
        .onConflictDoUpdate({ target: appConfig.key, set: { value: encoded } })
        .run();
    }
  });

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action: "config_update",
    detail: { outcome: "success", changed },
  });

  const count = Object.keys(changed).length;
  return {
    ok: true,
    message: count === 0 ? "Settings saved — nothing changed." : `Saved ${count} setting${count === 1 ? "" : "s"}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Employee import                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Replace the employee roster from a CSV export.
 *
 * The file is re-parsed here even though the upload form already parsed it: the
 * browser's copy is a convenience, and the only validation that counts is the
 * one that runs immediately before the write.
 *
 * A roster with no administrator is refused. Nothing else in the app can undo
 * that mistake — there would be no one left who could reach this screen to
 * upload a corrected file.
 */
export async function importEmployees(csv: string): Promise<AdminActionResult> {
  const db = getDb();
  const actor = await resolveAdmin(db);
  if (actor === null) return NOT_ADMIN;

  const { rows, errors } = parseEmployeeCsv(typeof csv === "string" ? csv : "");

  if (errors.length > 0) {
    return {
      ok: false,
      message: `The file was not imported: ${errors.length} problem${errors.length === 1 ? "" : "s"} found. Nothing was changed.`,
      issues: errors.slice(0, MAX_REPORTED_ISSUES),
    };
  }

  if (!rows.some((row) => row.is_admin)) {
    return {
      ok: false,
      message: "At least one row must have is_admin=1, or nobody could administer the app afterwards.",
    };
  }

  let summary: ImportSummary;
  try {
    summary = applyEmployeeImport(db, rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeAudit(db, {
      actor: { id: actor.id, email: actor.email },
      action: "import_employees",
      detail: { outcome: "error", error_message: message, rows: rows.length },
    });
    return { ok: false, message: `The roster could not be replaced: ${message}` };
  }

  writeAudit(db, {
    actor: { id: actor.id, email: actor.email },
    action: "import_employees",
    detail: { outcome: "success", ...summary },
  });

  return {
    ok: true,
    message: `Imported ${summary.imported} employees, replacing ${summary.replaced}. ${summary.preserved} kept their matched Claude user id.`,
  };
}
