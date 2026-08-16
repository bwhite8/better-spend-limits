"use client";

/**
 * The users table: client-side search, hierarchy filters and pagination.
 *
 * The rows are computed on the server (permission-scoped, joined to the
 * snapshot) and handed over whole: the visible set is at most the 250-person
 * org, so filtering in the browser is instant and costs no round trip. What is
 * NOT done here is any permission reasoning — the server already decided which
 * rows exist, and a filter box must never be the thing standing between a user
 * and somebody else's data. The same goes for the filter dropdowns: their
 * options are derived from the rows in scope, never from a wider query, so a
 * change to the scope rule narrows the filters automatically.
 *
 * Order of operations, which is the only interesting part: search and filters
 * apply to the whole scoped set, pagination applies to what survives. Paging
 * first would mean a search only found people who happened to be on the page
 * you were looking at.
 *
 * Below `md` the table restyles into full-width cards. It is the SAME elements
 * with different classes, never a second subtree — a duplicated mobile copy
 * would put every `data-testid` in the document twice and break Playwright's
 * strict mode at every viewport, exactly as `nav.tsx` documents.
 *
 * Rows the viewer may edit carry an inline limit editor, so a manager reviewing
 * a team does not have to open a page per person. Whether a row may be edited is
 * a server decision that arrives on the row (`canEdit`) — see {@link MemberRow}.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { minorUnitsToDollarsInput } from "@/lib/dollars";

import { AmountInput, parseAmountInput } from "./amount-input";
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
  /**
   * §G8 `canEdit(actor, this)`, decided on the SERVER, per row.
   *
   * It is not derivable here and must never be guessed: `visibleEmployees`
   * includes the actor themselves, and `canEdit(self, self)` is false, so every
   * non-admin sees one row they may not touch. Rendering an editor on it would
   * offer a control whose only possible outcome is a 403.
   */
  canEdit: boolean;
  /**
   * The hierarchy columns the tier filters match on. Named after the SQL
   * columns' meaning rather than their spelling, because these cross a client
   * boundary — but they carry the column value verbatim.
   */
  tier2ManagerId: string | null;
  tier3ManagerId: string | null;
  tier4ManagerId: string | null;
}

/** One entry in a tier filter: an id to match on and a name to show. */
export interface ManagerOption {
  id: string;
  name: string;
}

/** The filterable managers, derived server-side from the rows in scope. */
export interface ManagerOptions {
  tier2: ManagerOption[];
  tier3: ManagerOption[];
  tier4: ManagerOption[];
}

/** Rows per page. 250 people is five pages; a phone shows five cards a screen. */
const PAGE_SIZE = 50;

/** `source.type` for a per-user override — the "manual" case §G4 calls out. */
const OVERRIDE_SOURCE_TYPE = "user";

type TierKey = keyof ManagerOptions;

/**
 * Tier 1 (direct manager) is deliberately absent: with 250 people it is a
 * ~60-entry dropdown of mostly single-report managers, which is a worse way to
 * find someone than the search box next to it.
 */
type TierColumn = "tier2ManagerId" | "tier3ManagerId" | "tier4ManagerId";

const TIERS: { key: TierKey; label: string; column: TierColumn }[] = [
  { key: "tier2", label: "Tier 2 manager", column: "tier2ManagerId" },
  { key: "tier3", label: "Tier 3 manager", column: "tier3ManagerId" },
  { key: "tier4", label: "Tier 4 manager", column: "tier4ManagerId" },
];

type TierSelection = Record<TierKey, string>;

const NO_TIER_SELECTION: TierSelection = { tier2: "", tier3: "", tier4: "" };

/**
 * Column headers. `className` travels with the label so a column can be hidden
 * in both places at once — the header and its body cell must disappear
 * together, or the remaining cells shift a column to the left.
 */
const HEADERS: { label: string; className?: string }[] = [
  { label: "Name" },
  { label: "Email", className: "hidden md:table-cell" },
  { label: "Limit" },
  { label: "Source", className: "hidden md:table-cell" },
  { label: "Period-to-date spend" },
  { label: "", className: "hidden md:table-cell" },
];

/** Shared by every body cell: a card line on a phone, a table cell above `md`. */
const CELL = "block px-2 py-1 md:table-cell md:py-2";
/** A cell that only exists on the wide layout. */
const WIDE_ONLY_CELL = "hidden px-2 py-2 md:table-cell";

/**
 * `Showing 1–50 of 250`, and `(filtered from 250)` when a filter is narrowing
 * the set — otherwise the reader cannot tell a 7-person scope from a 7-row
 * search result.
 */
function countLabel(shown: number, offset: number, matched: number, total: number): string {
  const range =
    shown === 0 ? "0" : shown === 1 ? `${offset + 1}` : `${offset + 1}–${offset + shown}`;
  const base = `Showing ${range} of ${matched}`;
  return matched === total ? base : `${base} (filtered from ${total})`;
}

function TierFilter({
  label,
  testId,
  options,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  options: ManagerOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex w-full flex-col gap-1 text-xs text-slate-500 sm:w-52">
      {label}
      <select
        value={value}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      >
        <option value="">Anyone</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  const buttonClass =
    "rounded border border-slate-300 px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700";

  return (
    <nav
      aria-label="Pagination"
      data-testid="member-pager"
      className="flex items-center justify-between gap-3 sm:justify-start"
    >
      <button
        type="button"
        data-testid="member-page-prev"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
        className={buttonClass}
      >
        Previous
      </button>
      <span data-testid="member-page-status" className="text-sm tabular-nums text-slate-500">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        data-testid="member-page-next"
        disabled={page === pageCount}
        onClick={() => onChange(page + 1)}
        className={buttonClass}
      >
        Next
      </button>
    </nav>
  );
}

const REQUEST_HEADERS = { "content-type": "application/json" } as const;

/** The API's `{error, code}` envelope, or a fallback when it sent something else. */
function messageOf(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const { error } = body as { error?: unknown };
    if (typeof error === "string" && error !== "") return error;
  }
  return fallback;
}

/**
 * Set one person's limit without leaving the list.
 *
 * SET ONLY. There is no inline "remove override", and that is a considered
 * omission rather than a gap: the value somebody falls back to is only knowable
 * after the override is gone, so the detail page's dialog names the whole ladder
 * (group → seat tier → org default → unlimited) instead of guessing a number.
 * That paragraph does not fit in a table row, so removal stays where the prose
 * is — see `members/[id]/edit-limit.tsx`.
 *
 * The write is the same `POST /api/members/[id]/limit` the detail page uses, and
 * so is the flow around it: validate in `AmountInput` (an invalid value keeps
 * Save disabled and reaches the network never), then `router.refresh()` on both
 * success and failure, because a rejected write often means somebody else
 * already changed the number this row is showing. The refresh re-renders the
 * server component in place, so the row updates without a navigation and the
 * reader keeps their page, search and filters.
 */
function InlineLimitEditor({ row }: { row: MemberRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [minorUnits, setMinorUnits] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The editor collapses back to the "Edit" button on success, so the row's new
  // number is the main confirmation — but a manager working down a list moves on
  // before the value redraws, so a "Saved" chip sits by the button as a second,
  // slower-to-miss cue. Cleared the moment the editor is reopened.
  const [saved, setSaved] = useState(false);

  const prefill = minorUnitsToDollarsInput(row.amount);

  const openEditor = () => {
    setError(null);
    setSaved(false);
    // Seeded here because `AmountInput` reports a value on change, not on mount;
    // without this, Save would be disabled until the first keystroke.
    setMinorUnits(parseAmountInput(prefill).minorUnits);
    setOpen(true);
  };

  const save = () => {
    if (minorUnits === null) return;
    setError(null);
    startTransition(async () => {
      let ok = false;
      try {
        const response = await fetch(`/api/members/${row.id}/limit`, {
          method: "POST",
          headers: REQUEST_HEADERS,
          body: JSON.stringify({ amount: minorUnits }),
        });
        const body: unknown = await response.json().catch(() => null);
        ok = response.ok;
        // 400 invalid_amount, 403 forbidden, 409 not_synced, 429, 502 — all of
        // them say something the reader can act on, so none of them is swallowed.
        if (!ok) setError(messageOf(body, "The change could not be saved."));
      } catch {
        setError("The change could not be saved — the app could not be reached.");
      }
      if (ok) {
        setOpen(false);
        setSaved(true);
      }
      router.refresh();
    });
  };

  const buttonClass =
    "inline-flex min-h-11 items-center justify-center rounded px-2.5 py-1 text-sm font-medium md:min-h-0 md:py-0.5 md:text-xs";

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2 align-middle">
        <button
          type="button"
          onClick={openEditor}
          data-testid="member-edit-limit"
          aria-label={`Edit the spend limit for ${row.name}`}
          className={`${buttonClass} ml-2 border border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800`}
        >
          Edit
        </button>
        {saved ? (
          <span
            role="status"
            data-testid="member-limit-saved"
            className="text-xs font-medium text-success-700 dark:text-success-400"
          >
            Saved
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div
      role="group"
      aria-label={`Set the spend limit for ${row.name}`}
      data-testid="member-limit-editor"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) setOpen(false);
      }}
      className="mt-2 flex w-full flex-col gap-2 rounded border border-slate-300 p-2 text-left font-normal normal-nums md:w-64 dark:border-slate-700"
    >
      {row.hasPendingRequest ? (
        <p
          data-testid="member-pending-warning"
          className="rounded border border-warn-300 bg-warn-50 px-2 py-1.5 text-xs text-warn-900 dark:border-warn-800 dark:bg-warn-950 dark:text-warn-200"
        >
          {row.name} has a pending increase request — setting a limit here won&rsquo;t resolve it.
        </p>
      ) : null}

      <AmountInput
        label="New limit (USD)"
        defaultValue={prefill}
        disabled={pending}
        autoFocus
        onValueChange={(value) => setMinorUnits(value)}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || minorUnits === null}
          data-testid="member-limit-save"
          className={`${buttonClass} bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60`}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          data-testid="member-limit-cancel"
          className={`${buttonClass} border border-slate-300 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-800`}
        >
          Cancel
        </button>
      </div>

      {row.sourceType === OVERRIDE_SOURCE_TYPE ? (
        <p className="text-xs text-slate-500">
          To remove the override instead, open{" "}
          <Link
            href={`/members/${row.id}`}
            data-testid="member-editor-detail-link"
            className="underline"
          >
            {row.name}&rsquo;s page
          </Link>
          .
        </p>
      ) : null}

      {error === null ? null : (
        <p role="alert" data-testid="member-limit-error" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}

function MemberTableRow({ row }: { row: MemberRow }) {
  return (
    <tr
      data-testid="member-row"
      data-employee-id={row.id}
      className="mb-3 block rounded-lg border border-slate-200 p-2 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-b md:border-slate-100 md:p-0 md:hover:bg-slate-50 dark:border-slate-800 dark:md:border-slate-800 dark:md:hover:bg-slate-900"
    >
      <td className={CELL}>
        <Link
          href={`/members/${row.id}`}
          data-testid="member-link"
          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          {row.name}
        </Link>
      </td>

      <td className={`${WIDE_ONLY_CELL} text-slate-500`}>{row.email}</td>

      <td className={`${CELL} tabular-nums`}>
        {/* The card layout has no header row, so each value names itself. */}
        <span className="mr-2 text-xs text-slate-500 md:hidden">Limit</span>
        {row.synced ? (
          <Money amount={row.amount} currency={row.currency} trimWholeDollars />
        ) : (
          <span className="text-slate-400">Not synced</span>
        )}
        {/* The editor lives in this cell rather than a trailing actions column
            because the trailing column is `hidden` below `md` — a phone would
            get the value and no way to change it. */}
        {row.canEdit && row.synced ? <InlineLimitEditor row={row} /> : null}
      </td>

      <td className={WIDE_ONLY_CELL}>
        {row.synced ? <SourceBadge sourceType={row.sourceType} /> : null}
      </td>

      <td className={CELL}>
        <span className="mr-2 text-xs text-slate-500 md:hidden">Spend</span>
        {row.synced ? (
          <SpendBar spend={row.spend} amount={row.amount} currency={row.currency} />
        ) : null}
      </td>

      <td className={WIDE_ONLY_CELL}>
        {row.hasPendingRequest ? (
          <span
            data-testid="pending-chip"
            className="rounded bg-warn-100 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-warn-900 dark:bg-warn-950 dark:text-warn-200"
          >
            Pending request
          </span>
        ) : null}
      </td>
    </tr>
  );
}

export function MembersTable({
  rows,
  managers,
}: {
  rows: MemberRow[];
  managers: ManagerOptions;
}) {
  const [query, setQuery] = useState("");
  const [tiers, setTiers] = useState<TierSelection>(NO_TIER_SELECTION);
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (
        needle !== "" &&
        !row.name.toLowerCase().includes(needle) &&
        !row.email.toLowerCase().includes(needle)
      ) {
        return false;
      }
      for (const { key, column } of TIERS) {
        const selected = tiers[key];
        if (selected !== "" && row[column] !== selected) return false;
      }
      if (overridesOnly && row.sourceType !== OVERRIDE_SOURCE_TYPE) return false;
      return true;
    });
  }, [rows, query, tiers, overridesOnly]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped rather than stored back: `rows` is replaced wholesale by the
  // `router.refresh()` an inline save triggers, and a `setPage` in a render
  // path would loop. Every control that narrows the set resets to 1 itself.
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const shown = filtered.slice(offset, offset + PAGE_SIZE);

  /** Any control that changes the matched set sends the reader back to page 1. */
  const narrow = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            placeholder="Search by name or email"
            aria-label="Search users"
            data-testid="member-search"
            onChange={(event) => narrow(() => setQuery(event.target.value))}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm sm:w-64 dark:border-slate-700 dark:bg-slate-900"
          />
          <span className="text-sm text-slate-500" data-testid="member-count">
            {countLabel(shown.length, offset, filtered.length, rows.length)}
          </span>
        </div>

        {/* Two-up on a phone: three stacked full-width selects would push the
            first card most of a screen down, which is a lot of chrome to scroll
            past to reach the data you came for. */}
        <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
          {TIERS.filter(({ key }) => managers[key].length > 0).map(({ key, label }) => (
            <TierFilter
              key={key}
              label={label}
              testId={`member-filter-${key}`}
              options={managers[key]}
              value={tiers[key]}
              onChange={(value) => narrow(() => setTiers((current) => ({ ...current, [key]: value })))}
            />
          ))}

          <label className="flex items-center gap-2 py-1 text-sm">
            <input
              type="checkbox"
              checked={overridesOnly}
              data-testid="member-filter-overrides"
              onChange={(event) => narrow(() => setOverridesOnly(event.target.checked))}
              className="h-4 w-4"
            />
            Only manual overrides
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p data-testid="members-empty" className="text-sm text-slate-500">
          No users match.
        </p>
      ) : (
        <>
          <div className="md:overflow-x-auto">
            <table className="block w-full border-collapse text-sm md:table">
              <thead className="hidden md:table-header-group">
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
              <tbody className="block md:table-row-group">
                {shown.map((row) => (
                  <MemberTableRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <Pager page={currentPage} pageCount={pageCount} onChange={setPage} />
          ) : null}
        </>
      )}
    </div>
  );
}
