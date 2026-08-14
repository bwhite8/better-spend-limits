/**
 * Admin — the four things only an administrator can do (plan §Phase 13).
 *
 *   1. **Settings** decide who may edit whose limit (§G8) and how the reports
 *      and the sync behave.
 *   2. **Import** replaces the employee roster, which is where those permissions
 *      come from in the first place.
 *   3. **Audit log** is the record of every write the app has made on somebody's
 *      behalf — including the two above.
 *   4. **Unmatched members** are the people the API knows about and the roster
 *      does not, which is the failure mode 1–3 quietly produce.
 *
 * They are one page rather than four subroutes because they are read together:
 * an admin looking at an unmatched member is about to change the roster, and an
 * admin who has just changed the roster wants to see what it did.
 *
 * The admin check lives here and not only in the nav. Hiding a link is a
 * courtesy; a URL typed by hand must be refused, and so must a server action
 * invoked without ever loading this page — which is why `actions.ts` checks
 * again on every call.
 */

import { getDb } from "@/db/client";
import { employees } from "@/db/schema";
import { loadAppConfig } from "@/lib/config";
import { currentEmployee } from "@/lib/identity";
import { getSyncState } from "@/lib/sync";
import { ensureFreshSync } from "@/lib/sync-runner";

import Forbidden from "../forbidden";
import { loadAuditPage, parseAuditPageParam } from "./audit-query";
import { AuditTable } from "./audit-table";
import { ConfigForm } from "./config-form";
import { EmployeeImport } from "./import";
import { UnmatchedMembers, unmatchedMembers } from "./unmatched";

export const dynamic = "force-dynamic";

function Section({
  id,
  title,
  caption,
  children,
}: {
  id: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <article id={id} className="flex scroll-mt-6 flex-col gap-4">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{title}</h2>
        <p className="text-xs text-slate-500">{caption}</p>
      </header>
      {children}
    </article>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  const actor = await currentEmployee(db);
  if (actor === null) return <Forbidden />;
  if (!actor.is_admin) {
    return (
      <Forbidden
        title="Administrators only"
        detail="The admin area covers app configuration, employee import and the audit log."
      />
    );
  }

  await ensureFreshSync(db);

  const params = await searchParams;
  const config = loadAppConfig(db);
  const audit = loadAuditPage(db, parseAuditPageParam(params.audit));
  const names = new Map(
    db.select({ id: employees.id, name: employees.name }).from(employees).all().map((row) => [row.id, row.name]),
  );
  const unmatched = unmatchedMembers(db);
  const effectiveSyncedAt = getSyncState(db, "effective")?.last_synced_at ?? null;

  return (
    <section className="flex flex-col gap-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-slate-500">
          Settings, the employee roster, and the record of everything this app has changed.
        </p>
      </header>

      <Section
        id="config"
        title="Settings"
        caption="Stored in app_config. Changes take effect on the next page view — including for everybody else."
      >
        <ConfigForm initial={config} />
      </Section>

      <Section
        id="import"
        title="Employee import"
        caption="The roster normally comes from an HRIS export. This replaces it wholesale."
      >
        <EmployeeImport />
      </Section>

      <Section
        id="audit"
        title="Audit log"
        caption="Every limit change, request decision, settings change and import, newest first."
      >
        <AuditTable data={audit} names={names} />
      </Section>

      <Section
        id="unmatched"
        title="Unmatched members"
        caption="Anthropic members whose email address is on no employee record."
      >
        <UnmatchedMembers rows={unmatched} syncedAt={effectiveSyncedAt} />
      </Section>
    </section>
  );
}
