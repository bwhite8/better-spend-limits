/**
 * Requests — the approve/deny queue (plan §Phase 11).
 *
 * §G8 makes visibility and authority the same question: you see exactly the
 * requests you may act on. So there is no "read-only card" in the Pending tab —
 * a request you cannot resolve is simply not yours to look at. The one exception
 * is a request whose actor matches no employee record, which admins see flagged,
 * because somebody asking for headroom while missing from the roster is a
 * roster problem an administrator should be told about.
 *
 * The tabs are links, not client state: `?tab=resolved` keeps the whole page a
 * Server Component, survives a refresh after a decision, and can be linked to.
 *
 * A pending card carries the request's `spend_summary` — the live cap and
 * period-to-date spend the API attached to it (§G4). That is the context the
 * decision actually needs; without it, approving is guesswork. Resolved rows
 * have no summary by design, so they show only what happened and when.
 */

import { formatDate } from "@bsl/shared";
import Link from "next/link";

import { getDb } from "@/db/client";
import { Money, SpendBar } from "@/components/money";
import { loadAppConfig } from "@/lib/config";
import { minorUnitsToDollarsInput } from "@/lib/dollars";
import { currentEmployee } from "@/lib/identity";
import { loadRequestQueue, type QueueEntry } from "@/lib/requests";
import { ensureFreshSync } from "@/lib/sync-runner";

import Forbidden from "../forbidden";
import { RequestActions } from "./actions";

export const dynamic = "force-dynamic";

type Tab = "pending" | "resolved";

const STATUS_TONES: Record<string, string> = {
  pending: "bg-warn-100 text-warn-900 dark:bg-warn-950 dark:text-warn-200",
  approved: "bg-success-100 text-success-900 dark:bg-success-950 dark:text-success-200",
  denied: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      data-testid="request-status"
      data-status={status}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium capitalize ${
        STATUS_TONES[status] ?? "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
      }`}
    >
      {status}
    </span>
  );
}

function TabLink({ tab, current, label, count }: { tab: Tab; current: Tab; label: string; count: number }) {
  const active = tab === current;
  return (
    <Link
      href={tab === "pending" ? "/requests" : "/requests?tab=resolved"}
      data-testid={`tab-${tab}`}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-1 rounded px-3 py-2 text-sm font-medium md:block md:min-h-0 md:py-1.5 ${
        active
          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
      }`}
    >
      {label} <span data-testid={`tab-${tab}-count`}>{count}</span>
    </Link>
  );
}

interface CardProps {
  entry: QueueEntry;
  /** Current effective cap in dollars for the approve field; `""` when unknown. */
  prefillDollars: string;
  suppressDefault: boolean;
}

function RequestCard({ entry, prefillDollars, suppressDefault }: CardProps) {
  const { summary } = entry;

  return (
    <li
      data-testid="request-card"
      data-request-id={entry.id}
      data-status={entry.status}
      data-actionable={entry.actionable}
      className="flex flex-col gap-3 rounded border border-slate-200 p-4 dark:border-slate-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {entry.requester === null ? (
            <span data-testid="requester-name" className="font-medium">
              {entry.displayName}
            </span>
          ) : (
            <Link
              href={`/members/${entry.requester.id}`}
              data-testid="requester-name"
              className="font-medium text-brand-700 hover:underline dark:text-brand-300"
            >
              {entry.displayName}
            </Link>
          )}
          <StatusBadge status={entry.status} />
          {entry.requester === null ? (
            <span
              data-testid="unmatched-flag"
              title="This API user matches no row in the employee roster."
              className="rounded bg-warn-100 px-1.5 py-0.5 text-xs font-medium text-warn-900 dark:bg-warn-950 dark:text-warn-200"
            >
              No employee record
            </span>
          ) : null}
        </div>
        <p className="text-xs text-slate-500">
          <span data-testid="request-created">Raised {formatDate(entry.createdAt)}</span>
          {entry.resolvedAt === null ? null : (
            <span data-testid="request-resolved"> · resolved {formatDate(entry.resolvedAt)}</span>
          )}
        </p>
      </div>

      <p className="text-xs text-slate-500">{entry.actorEmail ?? entry.actorUserId}</p>

      {summary === null ? (
        <p data-testid="summary-unavailable" className="text-sm text-slate-500">
          Spend context unavailable for this request.
        </p>
      ) : (
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <dt className="text-xs tracking-wide text-slate-500 uppercase">Current limit</dt>
            <dd className="font-medium tabular-nums" data-testid="request-limit">
              <Money amount={summary.amount} currency={summary.currency} />
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-xs tracking-wide text-slate-500 uppercase">Period to date</dt>
            <dd>
              <SpendBar
                spend={summary.period_to_date_spend}
                amount={summary.amount}
                currency={summary.currency}
              />
            </dd>
          </div>
        </dl>
      )}

      {entry.actionable ? (
        <RequestActions
          requestId={entry.id}
          requesterName={entry.displayName}
          prefillDollars={prefillDollars}
          suppressDefault={suppressDefault}
        />
      ) : null}
    </li>
  );
}

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const db = getDb();
  const actor = await currentEmployee(db);
  if (actor === null) return <Forbidden />;

  await ensureFreshSync(db);

  const { tab } = await searchParams;
  const current: Tab = tab === "resolved" ? "resolved" : "pending";

  const config = loadAppConfig(db);
  const queue = loadRequestQueue(db, actor, config.edit_roles);
  const entries = current === "pending" ? queue.pending : queue.resolved;

  // The approve field opens on the member's current cap — the SAME figure the
  // card shows. `loadRequestQueue` resolves that against `spend_limit_snapshot`
  // (see `summaryFromSnapshot`), so reading it back off the entry here is what
  // keeps the displayed limit and the prefilled amount from ever disagreeing.
  const prefillFor = (entry: QueueEntry): string =>
    minorUnitsToDollarsInput(entry.summary?.amount ?? null);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
        <p className="text-sm text-slate-500">
          {actor.is_admin
            ? "Every increase request in the organization."
            : "Increase requests from people whose spend limit you can edit."}
        </p>
      </header>

      <nav className="flex items-center gap-1" aria-label="Request status">
        <TabLink tab="pending" current={current} label="Pending" count={queue.pending.length} />
        <TabLink tab="resolved" current={current} label="Resolved" count={queue.resolved.length} />
      </nav>

      {entries.length === 0 ? (
        <p data-testid="requests-empty" className="text-sm text-slate-500">
          {current === "pending"
            ? "No pending increase requests need your decision."
            : "No resolved increase requests in your scope."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <RequestCard
              key={entry.id}
              entry={entry}
              prefillDollars={prefillFor(entry)}
              suppressDefault={config.suppress_notification_default}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
