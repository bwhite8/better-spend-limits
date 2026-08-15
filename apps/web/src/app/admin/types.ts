/**
 * Shapes crossing the client↔server-action boundary in the admin area.
 *
 * They live apart from `actions.ts` because that module carries the
 * `"use server"` directive, and every export of such a module becomes a callable
 * RPC endpoint — so it may export async functions and nothing else. Types are
 * erased at compile time, but keeping them out entirely means nobody has to
 * remember which exports are erased and which are wire surface.
 */

import type { CsvIssue } from "@/lib/import-employees";

/** What every admin action answers with. Never throws at the client. */
export interface AdminActionResult {
  ok: boolean;
  /** One sentence, safe to render as-is. */
  message: string;
  /** Line-numbered parse problems, when the action rejected a file. */
  issues?: CsvIssue[];
}

/**
 * One AI lead's complete set of delegated leaders (§Phase 9).
 *
 * A whole-set replace, not an add or a remove: the form shows the full list and
 * edits it as a whole, so a diff would need both sides to agree on a starting
 * point neither can see.
 */
export interface AiLeadAssignmentInput {
  lead_employee_id: string;
  leader_employee_ids: string[];
}

/** The config editor's whole form, as the server expects to receive it. */
export interface ConfigUpdateInput {
  edit_roles: string[];
  near_limit_threshold: number;
  suppress_notification_default: boolean;
  sync_stale_after_minutes: number;
  show_org_wide_kpis: boolean;
}
