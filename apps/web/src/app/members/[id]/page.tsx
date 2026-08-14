/**
 * One member: who they report to, what their limit is and where it came from,
 * whether they have asked for more, and who is allowed to change it.
 *
 * "Who is allowed to change it" is the part worth having on the page. The
 * permission rule is config-driven (§G8), so the only reliable way for a user
 * to know whether they should be asking their director or their AI lead is for
 * the app to say so, computed from the same `edit_roles` the write path uses.
 *
 * The `edit-slot` holds Phase 10's controls. The server decides `canEdit` here
 * and hands it down; the client component only renders what it is told it may
 * render, and the API route re-checks the same rule for real (§G8) — a hidden
 * button is a UI convenience, never the access control.
 */

import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import type { EditRole } from "@/db/config-defaults";
import { employees, type Employee } from "@/db/schema";
import { Money, SpendBar } from "@/components/money";
import { SourceBadge } from "@/components/source-badge";
import { currentEmployee } from "@/lib/identity";
import { loadSnapshotIndex, requestsForUser, snapshotFor } from "@/lib/members";
import { canEdit, canView, editorIdsOf, editRoleColumn, loadEditRoles } from "@/lib/permissions";
import { ensureFreshSync } from "@/lib/sync-runner";

import { NotVisible } from "../../forbidden";
import { EditLimit } from "./edit-limit";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<EditRole, string> = {
  direct_manager: "Direct manager",
  tier2_manager: "Tier 2 manager",
  tier3_manager: "Tier 3 manager",
  tier4_manager: "Tier 4 manager",
  aligned_ai_lead: "Aligned AI lead",
};

/** The hierarchy as shown on the page — always all five, config or no config. */
const CHAIN: { role: EditRole; label: string }[] = (
  ["direct_manager", "tier2_manager", "tier3_manager", "tier4_manager", "aligned_ai_lead"] as const
).map((role) => ({ role, label: ROLE_LABELS[role] }));

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function parseSpendSummary(raw: string | null): { amount?: string | null; currency?: string | null; period_to_date_spend?: string | null } | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const actor = await currentEmployee(db);
  if (actor === null) return <NotVisible />;

  const target = db.select().from(employees).where(eq(employees.id, id)).get();
  if (!target) notFound();

  const editRoles = loadEditRoles(db);
  if (!canView(actor, target, editRoles)) return <NotVisible />;

  await ensureFreshSync(db);

  const snapshot = snapshotFor(loadSnapshotIndex(db), target);
  const userId = snapshot?.user_id ?? target.claude_user_id;
  const requests = requestsForUser(db, userId);
  const highlighted = requests.find((request) => request.status === "pending") ?? requests[0] ?? null;
  const summary = highlighted === null ? null : parseSpendSummary(highlighted.spend_summary);
  const hasPendingRequest = requests.some((request) => request.status === "pending");
  const editable = canEdit(actor, target, editRoles);

  // One lookup for every name this page shows: the five hierarchy roles plus
  // whoever holds an editing role over the target.
  const editorIds = editorIdsOf(target, editRoles);
  const relatedIds = [
    ...new Set(
      [
        ...CHAIN.map(({ role }) => target[editRoleColumn(role)]),
        ...editorIds,
      ].filter((value): value is string => value !== null),
    ),
  ];
  const related = new Map<string, Employee>(
    (relatedIds.length === 0
      ? []
      : db.select().from(employees).where(inArray(employees.id, relatedIds)).all()
    ).map((row) => [row.id, row]),
  );

  const rolesByEditor = new Map<string, string[]>();
  for (const role of editRoles) {
    const holder = target[editRoleColumn(role)];
    if (holder === null) continue;
    rolesByEditor.set(holder, [...(rolesByEditor.get(holder) ?? []), ROLE_LABELS[role]]);
  }

  return (
    <section className="flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-sm text-indigo-700 hover:underline dark:text-indigo-300">
          ← Members
        </Link>
        <h1 data-testid="member-name" className="text-2xl font-semibold tracking-tight">
          {target.name}
          {target.is_admin ? (
            <span
              data-testid="admin-badge"
              className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 align-middle text-xs font-medium text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
            >
              Admin
            </span>
          ) : null}
        </h1>
        <p data-testid="member-email" className="text-sm text-slate-500">
          {target.email}
        </p>
      </header>

      <div className="grid gap-8 md:grid-cols-2">
        <article className="flex flex-col gap-4" data-testid="limit-card">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Effective spend limit
          </h2>
          {snapshot === null ? (
            <p className="text-sm text-slate-500" data-testid="limit-unsynced">
              No synced limit for this member yet.
            </p>
          ) : (
            <dl className="flex flex-col gap-3">
              <Field label="Limit">
                <span className="text-lg font-semibold tabular-nums" data-testid="member-limit">
                  <Money amount={snapshot.amount} currency={snapshot.currency} />
                </span>
                <span className="ml-2 text-xs text-slate-500">{snapshot.period ?? "monthly"}</span>
              </Field>
              <Field label="Source">
                <SourceBadge sourceType={snapshot.source_type} />
              </Field>
              <Field label="Period-to-date spend">
                <SpendBar
                  spend={snapshot.period_to_date_spend}
                  amount={snapshot.amount}
                  currency={snapshot.currency}
                />
              </Field>
            </dl>
          )}

          <div data-testid="edit-slot" data-can-edit={editable}>
            <EditLimit
              employeeId={target.id}
              memberName={target.name}
              canEdit={editable}
              synced={snapshot !== null}
              amount={snapshot?.amount ?? null}
              currency={snapshot?.currency ?? null}
              sourceType={snapshot?.source_type ?? null}
              hasPendingRequest={hasPendingRequest}
            />
          </div>
        </article>

        <article className="flex flex-col gap-4" data-testid="identity-card">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">Reporting</h2>
          <dl className="flex flex-col gap-3">
            {CHAIN.map(({ role, label }) => {
              const holderId = target[editRoleColumn(role)];
              const holder = holderId === null ? null : (related.get(holderId) ?? null);
              return (
                <Field key={role} label={label}>
                  {holder === null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <Link
                      href={`/members/${holder.id}`}
                      className="text-indigo-700 hover:underline dark:text-indigo-300"
                    >
                      {holder.name}
                    </Link>
                  )}
                </Field>
              );
            })}
          </dl>
        </article>
      </div>

      <article className="flex flex-col gap-3" data-testid="request-card">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Increase request
        </h2>
        {highlighted === null ? (
          <p className="text-sm text-slate-500" data-testid="no-requests">
            No increase requests on record.
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm" data-testid="request-summary" data-status={highlighted.status}>
            <p>
              <span className="font-medium capitalize">{highlighted.status}</span>
              <span className="text-slate-500"> · raised {highlighted.created_at.slice(0, 10)}</span>
              {highlighted.resolved_at === null ? null : (
                <span className="text-slate-500"> · resolved {highlighted.resolved_at.slice(0, 10)}</span>
              )}
            </p>
            {summary === null ? (
              <p className="text-slate-500">No live spend summary on this request.</p>
            ) : (
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500">At request time:</span>
                <Money amount={summary.amount ?? null} currency={summary.currency ?? null} />
                <span className="text-slate-500">cap,</span>
                <SpendBar
                  spend={summary.period_to_date_spend ?? null}
                  amount={summary.amount ?? null}
                  currency={summary.currency ?? null}
                />
              </p>
            )}
            <Link
              href="/requests"
              className="w-fit text-indigo-700 hover:underline dark:text-indigo-300"
            >
              Go to the requests queue →
            </Link>
          </div>
        )}
      </article>

      <article className="flex flex-col gap-3" data-testid="edit-access">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">Edit access</h2>
        {editorIds.length === 0 ? (
          <p className="text-sm text-slate-500">
            No hierarchy role grants edit access to this member — administrators only.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {editorIds.map((editorId) => {
              const editor = related.get(editorId);
              return (
                <li key={editorId} data-testid="editor">
                  <span className="font-medium">{editor?.name ?? editorId}</span>
                  <span className="text-slate-500">
                    {" "}
                    — {(rolesByEditor.get(editorId) ?? []).join(", ")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-slate-500">Administrators can edit anyone.</p>
      </article>
    </section>
  );
}
