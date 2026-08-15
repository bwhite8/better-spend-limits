/**
 * API members with no employee record (plan §Phase 13).
 *
 * The whole app hangs off one join: an Anthropic actor is matched to an employee
 * by `claude_user_id`, falling back to the lowercased email (§G7). Anybody that
 * join misses is invisible — they do not appear on the members list, no manager
 * can see their spend, and their increase requests are admin-only. That is the
 * correct behaviour and a terrible thing to leave unannounced, so this section
 * exists to make the gap countable.
 *
 * It is almost always a roster problem rather than an API one: a contractor
 * missing from the HRIS export, a personal address on the Anthropic side, or a
 * seat granted before the new joiner reached the export.
 */

import { formatDate } from "@bsl/shared";

import type { AppDatabase } from "@/db/client";
import { spendLimitSnapshot, type SpendLimitSnapshotRow } from "@/db/schema";
import { Money, SpendBar } from "@/components/money";
import { loadEmployeeIndex } from "@/lib/requests";

/** A whole roster's worth of rows is a scroll bar, not a report. */
const MAX_SHOWN = 50;

/**
 * Snapshot rows the employee roster cannot account for.
 *
 * Uses the same two-legged index the request queue uses, rather than a third
 * copy of the join: a member is matched if some employee carries their
 * `claude_user_id`, or if their email address is on the roster.
 */
export function unmatchedMembers(db: AppDatabase): SpendLimitSnapshotRow[] {
  const index = loadEmployeeIndex(db);

  return db
    .select()
    .from(spendLimitSnapshot)
    .orderBy(spendLimitSnapshot.actor_name, spendLimitSnapshot.user_id)
    .all()
    .filter((row) => {
      if (index.byUserId.has(row.user_id)) return false;
      const email = row.actor_email?.trim().toLowerCase();
      return !(email !== undefined && email !== "" && index.byEmail.has(email));
    });
}

export interface UnmatchedMembersProps {
  rows: SpendLimitSnapshotRow[];
  /** When the snapshot was last refreshed, for the "or the sync is behind" case. */
  syncedAt: string | null;
}

export function UnmatchedMembers({ rows, syncedAt }: UnmatchedMembersProps) {
  if (rows.length === 0) {
    return (
      <p data-testid="unmatched-empty" className="text-sm text-slate-500">
        Every user the API reports is on the employee roster.
      </p>
    );
  }

  const shown = rows.slice(0, MAX_SHOWN);

  return (
    <div className="flex flex-col gap-3">
      <p data-testid="unmatched-count" className="text-sm">
        <span className="font-medium">{rows.length}</span>{" "}
        {rows.length === 1 ? "user has" : "users have"} no employee record, so nobody can see or
        edit them here. Add them to the next roster import — matching is by email address.
        <span className="block text-xs text-slate-500">
          {rows.length > shown.length ? `Showing the first ${shown.length}. ` : ""}
          {syncedAt === null
            ? "The snapshot has not been synced yet."
            : `From the snapshot synced ${formatDate(syncedAt)}.`}
        </span>
      </p>

      <div className="overflow-x-auto">
        <table data-testid="unmatched-table" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left dark:border-slate-800">
              {["Name", "Email", "Limit", "Period-to-date spend"].map((header) => (
                <th key={header} scope="col" className="px-2 py-2 font-medium text-slate-500">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={row.user_id}
                data-testid="unmatched-row"
                data-user-id={row.user_id}
                className="border-b border-slate-100 dark:border-slate-800"
              >
                <td className="px-2 py-2">{row.actor_name ?? "—"}</td>
                <td data-testid="unmatched-email" className="px-2 py-2">
                  {row.actor_email ?? "—"}
                </td>
                <td className="px-2 py-2 tabular-nums">
                  <Money amount={row.amount} currency={row.currency} />
                </td>
                <td className="px-2 py-2">
                  <SpendBar
                    spend={row.period_to_date_spend}
                    amount={row.amount}
                    currency={row.currency}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
