/**
 * The audit log, rendered (§G7 `audit_log`, plan §Phase 13).
 *
 * The Anthropic API records that *the admin key* changed a limit. This table is
 * the only place that records *which employee asked for it*, which makes it the
 * one screen that can answer "who raised this person's cap, and when". It is
 * append-only and has no control for editing or deleting a row — an audit trail
 * an administrator can rewrite is not one.
 *
 * `detail` is free-form JSON by design (see `lib/audit.ts`), so it is rendered
 * generically as key/value pairs rather than through a per-action template that
 * would silently drop whatever a later phase decided to record.
 *
 * The query lives in `audit-query.ts`; this file is presentation only.
 */

import { formatDateTime } from "@bsl/shared";
import Link from "next/link";

import type { AuditLogRow } from "@/db/schema";
import { parseAuditDetail } from "@/lib/audit";

import { AUDIT_PAGE_PARAM, type AuditPageData } from "./audit-query";

/** How each action reads to somebody who did not perform it. */
const ACTION_LABELS: Record<string, string> = {
  set_limit: "Set limit",
  delete_limit: "Removed override",
  approve_request: "Approved request",
  deny_request: "Denied request",
  config_update: "Changed settings",
  import_employees: "Imported employees",
  assign_ai_lead: "Assigned AI lead",
};

function formatDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function DetailCell({ row }: { row: AuditLogRow }) {
  const entries = Object.entries(parseAuditDetail(row));

  if (entries.length === 0) return <span className="text-slate-400">—</span>;

  return (
    <span data-testid="audit-detail" className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
      {entries.map(([key, value]) => (
        <span key={key} className="text-slate-600 dark:text-slate-400">
          <span className="text-slate-400">{key}=</span>
          {formatDetailValue(value)}
        </span>
      ))}
    </span>
  );
}

export interface AuditTableProps {
  data: AuditPageData;
  /** `employee id → name`, for turning a target id into somebody recognisable. */
  names: Map<string, string>;
}

export function AuditTable({ data, names }: AuditTableProps) {
  if (data.total === 0) {
    return (
      <p data-testid="audit-empty" className="text-sm text-slate-500">
        Nothing has been written through this app yet.
      </p>
    );
  }

  const pageHref = (page: number): string => `/admin?${AUDIT_PAGE_PARAM}=${page}#audit`;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table data-testid="audit-table" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left dark:border-slate-800">
              {["When", "Who", "Action", "Target", "Detail"].map((header) => (
                <th key={header} scope="col" className="px-2 py-2 font-medium text-slate-500">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr
                key={row.id}
                data-testid="audit-row"
                data-audit-id={row.id}
                data-action={row.action}
                className="border-b border-slate-100 align-top dark:border-slate-800"
              >
                <td className="px-2 py-2 whitespace-nowrap tabular-nums text-slate-500">
                  {formatDateTime(row.at)}
                </td>
                <td data-testid="audit-actor" className="px-2 py-2">
                  {row.actor_email}
                </td>
                <td data-testid="audit-action" className="px-2 py-2 font-medium whitespace-nowrap">
                  {ACTION_LABELS[row.action] ?? row.action}
                </td>
                <td data-testid="audit-target" className="px-2 py-2">
                  {row.target_employee_id === null
                    ? (row.target_user_id ?? "—")
                    : (names.get(row.target_employee_id) ?? row.target_employee_id)}
                </td>
                <td className="px-2 py-2">
                  <DetailCell row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 text-sm">
        {data.page > 1 ? (
          <Link
            href={pageHref(data.page - 1)}
            data-testid="audit-prev"
            className="text-indigo-700 hover:underline dark:text-indigo-300"
          >
            ← Newer
          </Link>
        ) : null}
        <span data-testid="audit-page-label" className="text-slate-500">
          Page {data.page} of {data.pageCount} · {data.total} entries
        </span>
        {data.page < data.pageCount ? (
          <Link
            href={pageHref(data.page + 1)}
            data-testid="audit-next"
            className="text-indigo-700 hover:underline dark:text-indigo-300"
          >
            Older →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
