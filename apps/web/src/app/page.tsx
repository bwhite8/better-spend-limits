/**
 * Members — the landing page and the app's spine.
 *
 * Scope is §G8 option B: the people you may edit, plus yourself; admins see
 * everyone. That decision is made once, in SQL, by `visibleEmployees` — this
 * page never filters a wider set down in the browser.
 *
 * The numbers come from the local snapshot, so the render starts by giving the
 * sync a chance to catch up. `ensureFreshSync` is a no-op inside the staleness
 * window and holds a lock across concurrent renders, and it swallows API
 * failures: a page showing slightly old numbers is right, a 500 is not.
 */

import { getDb } from "@/db/client";
import { MembersTable, type MemberRow } from "@/components/members-table";
import { currentEmployee } from "@/lib/identity";
import { loadSnapshotIndex, pendingRequestUserIds, snapshotFor } from "@/lib/members";
import { loadEditRoles, visibleEmployees } from "@/lib/permissions";
import { ensureFreshSync } from "@/lib/sync-runner";

import Forbidden from "./forbidden";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const db = getDb();
  const actor = await currentEmployee(db);
  if (actor === null) return <Forbidden />;

  await ensureFreshSync(db);

  const editRoles = loadEditRoles(db);
  const visible = visibleEmployees(db, actor, editRoles);
  const snapshots = loadSnapshotIndex(db);
  const pending = pendingRequestUserIds(db);

  const rows: MemberRow[] = visible.map((employee) => {
    const snapshot = snapshotFor(snapshots, employee);
    const userId = snapshot?.user_id ?? employee.claude_user_id;

    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      amount: snapshot?.amount ?? null,
      currency: snapshot?.currency ?? null,
      sourceType: snapshot?.source_type ?? null,
      spend: snapshot?.period_to_date_spend ?? null,
      hasPendingRequest: userId !== null && pending.has(userId),
      synced: snapshot !== null,
    };
  });

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-slate-500">
          {actor.is_admin
            ? "Every member of the organisation."
            : "People whose spend limit you can edit, plus yourself."}
        </p>
      </header>

      <MembersTable rows={rows} />
    </section>
  );
}
