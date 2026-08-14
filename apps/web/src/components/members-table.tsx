"use client";

/**
 * The members table, with client-side name search.
 *
 * The rows are computed on the server (permission-scoped, joined to the
 * snapshot) and handed over whole: the visible set is at most the 250-person
 * org, so filtering in the browser is instant and costs no round trip. What is
 * NOT done here is any permission reasoning — the server already decided which
 * rows exist, and a filter box must never be the thing standing between a user
 * and somebody else's data.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { Money, SpendBar } from "./money";
import { SourceBadge } from "./source-badge";

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  /** Effective limit; `null` means unlimited — but only when `synced`. */
  amount: string | null;
  currency: string | null;
  sourceType: string | null;
  spend: string | null;
  hasPendingRequest: boolean;
  /** False when no `spend_limit_snapshot` row matched this employee. */
  synced: boolean;
}

/**
 * Column headers. `className` travels with the label so a column can be hidden
 * in both places at once — the header and its body cell must disappear
 * together, or the remaining cells shift a column to the left.
 */
const HEADERS: { label: string; className?: string }[] = [
  { label: "Name" },
  { label: "Email", className: "hidden sm:table-cell" },
  { label: "Effective limit" },
  { label: "Source" },
  { label: "Period-to-date spend" },
  { label: "" },
];

export function MembersTable({ rows }: { rows: MemberRow[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          placeholder="Search by name or email"
          aria-label="Search members"
          data-testid="member-search"
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm sm:w-64 dark:border-slate-700 dark:bg-slate-900"
        />
        <span className="text-sm text-slate-500" data-testid="member-count">
          {filtered.length} of {rows.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p data-testid="members-empty" className="text-sm text-slate-500">
          No members match.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                {HEADERS.map((header, index) => (
                  <th
                    key={header.label || index}
                    scope="col"
                    className={`px-2 py-2 font-medium text-slate-500 ${header.className ?? ""}`}
                  >
                    {header.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  data-testid="member-row"
                  data-employee-id={row.id}
                  className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
                >
                  <td className="px-2 py-2">
                    <Link
                      href={`/members/${row.id}`}
                      data-testid="member-link"
                      className="font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="hidden px-2 py-2 text-slate-500 sm:table-cell">{row.email}</td>
                  <td className="px-2 py-2 tabular-nums">
                    {row.synced ? (
                      <Money amount={row.amount} currency={row.currency} />
                    ) : (
                      <span className="text-slate-400">Not synced</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {row.synced ? <SourceBadge sourceType={row.sourceType} /> : null}
                  </td>
                  <td className="px-2 py-2">
                    {row.synced ? (
                      <SpendBar spend={row.spend} amount={row.amount} currency={row.currency} />
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    {row.hasPendingRequest ? (
                      <span
                        data-testid="pending-chip"
                        className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      >
                        Pending request
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
