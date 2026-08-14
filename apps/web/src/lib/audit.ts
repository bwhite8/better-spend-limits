/**
 * The audit trail (§G7 `audit_log`, §G8).
 *
 * Every write this app performs on a user's behalf — setting or removing a
 * limit, approving or denying a request, changing config, importing a roster —
 * goes through here. The Anthropic API records that *someone with the admin key*
 * made a change; this table is the only place that records *which employee asked
 * for it*, so it is not optional decoration.
 *
 * `detail` is free-form JSON on purpose: what is worth recording differs per
 * action (old/new amount, request id, the API's `request_id`, import counts).
 * Callers should include the upstream `request_id` whenever they have one — it
 * is what makes an entry reconcilable against Anthropic's own logs.
 */

import { auditLog, type AuditLogRow } from "@/db/schema";
import type { AppDatabase } from "@/db/client";

/** The §G7 action vocabulary. */
export const AUDIT_ACTIONS = [
  "set_limit",
  "delete_limit",
  "approve_request",
  "deny_request",
  "config_update",
  "import_employees",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Whoever performed the action. `id` is nullable because an authenticated email
 * need not correspond to an employee row; the email is always recorded.
 */
export interface AuditActor {
  id?: string | null;
  email: string;
}

export interface WriteAuditInput {
  actor: AuditActor;
  action: AuditAction;
  /** The employee the action was about, when there is one. */
  targetEmployeeId?: string | null;
  /** The Anthropic `user_id` the action was about, when there is one. */
  targetUserId?: string | null;
  /** Anything worth knowing later. JSON-encoded on the way in. */
  detail?: Record<string, unknown>;
  /** Defaults to now; injectable so tests can pin the timestamp. */
  at?: Date;
}

/** Append one entry and return it. */
export function writeAudit(db: AppDatabase, input: WriteAuditInput): AuditLogRow {
  const row = db
    .insert(auditLog)
    .values({
      at: (input.at ?? new Date()).toISOString(),
      actor_employee_id: input.actor.id ?? null,
      actor_email: input.actor.email.toLowerCase(),
      action: input.action,
      target_employee_id: input.targetEmployeeId ?? null,
      target_user_id: input.targetUserId ?? null,
      detail: JSON.stringify(input.detail ?? {}),
    })
    .returning()
    .get();

  return row;
}

/** `detail` parsed back out, or `{}` when it is unreadable. */
export function parseAuditDetail(row: Pick<AuditLogRow, "detail">): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.detail);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
