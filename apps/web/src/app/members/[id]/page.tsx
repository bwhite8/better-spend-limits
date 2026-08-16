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

import { formatDate } from "@bsl/shared";
import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import type { EditRole } from "@/db/config-defaults";
import { employees, type Employee } from "@/db/schema";
import { Money, SpendBar } from "@/components/money";
import { SourceBadge } from "@/components/source-badge";
import { CARD } from "@/components/surface";
import { currentEmployee } from "@/lib/identity";
import { loadSnapshotIndex, requestsForUser, snapshotFor } from "@/lib/members";
import {
  authorityIdsOf,
  canEdit,
  canView,
  delegatedEditorsOf,
  editorIdsOf,
  editRoleColumn,
  loadEditRoles,
} from "@/lib/permissions";
import { ensureFreshSync } from "@/lib/sync-runner";

import { NotVisible } from "../../forbidden";
import { EditLimit } from "./edit-limit";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<EditRole, string> = {
  direct_manager: "Direct manager",
  tier2_manager: "Tier 2 manager",
  tier3_manager: "Tier 3 manager",
  tier4_manager: "Tier 4 manager",
};

/**
 * The hierarchy as shown on the page — always all five columns, config or no
 * config.
 *
 * `aligned_ai_lead_id` is on this list and NOT in `ROLE_LABELS`: it is still
 * real HRIS data worth showing, and since §Phase 9 it grants nothing on its own.
 * Whoever the lead speaks for is an explicit delegation, shown in Edit access
 * below when it applies to this person.
 */
const CHAIN: { column: keyof PersonColumns; label: string }[] = [
  { column: "direct_manager_id", label: "Direct manager" },
  { column: "tier2_manager_id", label: "Tier 2 manager" },
  { column: "tier3_manager_id", label: "Tier 3 manager" },
  { column: "tier4_manager_id", label: "Tier 4 manager" },
  { column: "aligned_ai_lead_id", label: "Aligned AI lead" },
];

type PersonColumns = Pick<
  Employee,
  | "direct_manager_id"
  | "tier2_manager_id"
  | "tier3_manager_id"
  | "tier4_manager_id"
  | "aligned_ai_lead_id"
>;

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
  const authority = authorityIdsOf(db, actor);
  if (!canView(actor, target, editRoles, authority)) return <NotVisible />;

  await ensureFreshSync(db);

  const snapshot = snapshotFor(loadSnapshotIndex(db), target);
  const userId = snapshot?.user_id ?? target.claude_user_id;
  const requests = requestsForUser(db, userId);
  const highlighted = requests.find((request) => request.status === "pending") ?? requests[0] ?? null;
  const summary = highlighted === null ? null : parseSpendSummary(highlighted.spend_summary);
  const hasPendingRequest = requests.some((request) => request.status === "pending");
  const editable = canEdit(actor, target, editRoles, authority);

  // Who may edit this person, in two halves that answer the same question:
  // whoever holds a configured role over them, and whoever has had one of those
  // role-holders delegated to them (§Phase 9). The second half cannot be derived
  // from the target's own columns — that is exactly why it needs the database.
  const editorIds = editorIdsOf(target, editRoles);
  const delegated = delegatedEditorsOf(db, target, editRoles);

  // One lookup for every name this page shows: the five hierarchy columns, the
  // role holders, and the delegated leads.
  const relatedIds = [
    ...new Set(
      [
        ...CHAIN.map(({ column }) => target[column]),
        ...editorIds,
        ...delegated.map((editor) => editor.id),
      ].filter((value): value is string => value !== null),
    ),
  ];
  const related = new Map<string, Employee>(
    (relatedIds.length === 0
      ? []
      : db.select().from(employees).where(inArray(employees.id, relatedIds)).all()
    ).map((row) => [row.id, row]),
  );

  const nameOf = (id: string): string => related.get(id)?.name ?? id;

  // Keyed by editor rather than by role, because the card answers "who do I ask"
  // and one person can hold two roles over the same target.
  const rolesByEditor = new Map<string, string[]>();
  for (const role of editRoles) {
    const holder = target[editRoleColumn(role)];
    if (holder === null) continue;
    rolesByEditor.set(holder, [...(rolesByEditor.get(holder) ?? []), ROLE_LABELS[role]]);
  }
  for (const editor of delegated) {
    rolesByEditor.set(editor.id, [
      ...(rolesByEditor.get(editor.id) ?? []),
      `AI lead delegated by ${editor.viaLeaderIds.map(nameOf).join(", ")}`,
    ]);
  }
  const allEditorIds = [...new Set([...editorIds, ...delegated.map((editor) => editor.id)])];

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link href="/members" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
          ← Users
        </Link>
        <h1 data-testid="member-name" className="text-2xl font-semibold tracking-tight">
          {target.name}
          {target.is_admin ? (
            <span
              data-testid="admin-badge"
              className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 align-middle text-xs font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200"
            >
              Admin
            </span>
          ) : null}
        </h1>
        <p data-testid="member-email" className="text-sm text-slate-500">
          {target.email}
        </p>
      </header>

      {/* `items-start`: the two cards hold different amounts of content, and a
          stretched grid row was padding the shorter one with ~90px of empty
          space below its last control rather than letting it end. */}
      <div className="grid items-start gap-4 md:grid-cols-2">
        <article className={`${CARD} flex flex-col gap-4 p-4 sm:p-5`} data-testid="limit-card">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Effective spend limit
          </h2>
          {snapshot === null ? (
            <p className="text-sm text-slate-500" data-testid="limit-unsynced">
              No synced limit for this user yet.
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

        <article className={`${CARD} flex flex-col gap-4 p-4 sm:p-5`} data-testid="identity-card">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">Reporting</h2>
          <dl className="flex flex-col gap-3">
            {CHAIN.map(({ column, label }) => {
              const holderId = target[column];
              const holder = holderId === null ? null : (related.get(holderId) ?? null);
              return (
                <Field key={column} label={label}>
                  {holder === null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <Link
                      href={`/members/${holder.id}`}
                      className="text-brand-700 hover:underline dark:text-brand-300"
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

      {/* Both of these hold a line or two. Full width each, they were two bands
          of mostly empty card stacked under the pair above; side by side they
          match that pair's rhythm and the page ends a screen sooner. */}
      <div className="grid items-start gap-4 md:grid-cols-2">
        <article className={`${CARD} flex flex-col gap-3 p-4 sm:p-5`} data-testid="request-card">
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
                <span className="text-slate-500"> · raised {formatDate(highlighted.created_at)}</span>
                {highlighted.resolved_at === null ? null : (
                  <span className="text-slate-500"> · resolved {formatDate(highlighted.resolved_at)}</span>
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
                className="w-fit text-brand-700 hover:underline dark:text-brand-300"
              >
                Go to the requests queue →
              </Link>
            </div>
          )}
        </article>

        <article className={`${CARD} flex flex-col gap-3 p-4 sm:p-5`} data-testid="edit-access">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">Edit access</h2>
          {allEditorIds.length === 0 ? (
            <p className="text-sm text-slate-500">
              No hierarchy role grants edit access to this user — administrators only.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {allEditorIds.map((editorId) => {
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
      </div>
    </section>
  );
}
