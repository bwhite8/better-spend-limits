import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";

import { getDb } from "@/db/client";
import { employees } from "@/db/schema";
import { Nav, type NavProps } from "@/components/nav";
import { syncLabel } from "@/components/sync-label";
import { switcherOptionsFor } from "@/components/switcher-groups";
import { findEmployeeByEmail, resolveAuthMode, resolveCurrentEmail } from "@/lib/identity";
import { isStale, oldestSyncedAt, readSyncState, SYNC_RESOURCES } from "@/lib/sync";
import { ensureFreshSync } from "@/lib/sync-runner";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Spend Limits",
    template: "%s · Spend Limits",
  },
  description: "A UI for the Claude Spend Limits and Analytics APIs.",
};

// Identity comes from a cookie or a request header, so nothing here is static.
export const dynamic = "force-dynamic";

/**
 * Upper bound on options the dev user switcher loads. The whole list is
 * serialized into the shell of every render, so it must not be unbounded. The
 * import path already caps the table at `MAX_EMPLOYEE_ROWS`; this is defense in
 * depth, and it clears the 250-person demo with room to spare. The switcher is
 * dev-only (see below), so this never constrains a real, proxy-authed roster.
 */
const SWITCHER_MAX_OPTIONS = 500;

/**
 * Everything the sidebar needs, in one pass over the database.
 *
 * A database that cannot be read (a clone where `db:migrate` has not run yet)
 * degrades to an empty shell rather than a 500 — the nav is chrome, and chrome
 * failing must not hide the page that would have told you what went wrong.
 */
async function loadNavProps(): Promise<NavProps> {
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
  const email = resolveCurrentEmail(headerStore, cookieStore);
  const devMode = resolveAuthMode() === "dev";

  try {
    const db = getDb();
    const actor = findEmployeeByEmail(db, email);

    // Sync here, in the layout, rather than only in the pages: React renders a
    // parent before its children, so this is the one place that can read
    // `sync_state` AFTER the refresh it triggered. Doing it page-side left the
    // sidebar reporting "Never synced" next to freshly synced numbers.
    // Gated on a resolved identity for the same reason `/api/sync` is: syncing
    // spends the organization's shared rate-limit budget (§G4).
    if (actor !== null) await ensureFreshSync(db);

    const state = readSyncState(db).filter((row) =>
      (SYNC_RESOURCES as readonly string[]).includes(row.resource),
    );
    const syncedAt = oldestSyncedAt(db);

    // Dev mode only: in `proxy` mode the SSO header is the identity and the
    // impersonation action throws, so offering the control would be a lie —
    // and the roster read is only needed for the switcher, so proxy mode skips
    // it entirely rather than loading a table it never serializes.
    const switcher = devMode
      ? {
          options: switcherOptionsFor(
            db
              .select()
              .from(employees)
              .orderBy(employees.name, employees.id)
              .limit(SWITCHER_MAX_OPTIONS)
              .all(),
          ),
          currentEmail: email,
        }
      : null;

    return {
      isAdmin: actor?.is_admin === true,
      currentUser: actor === null ? null : { name: actor.name, email: actor.email },
      switcher,
      sync: {
        syncedAt,
        initialLabel: syncLabel(syncedAt),
        stale: isStale(db),
        errored: state.some((row) => row.status === "error"),
      },
    };
  } catch (error) {
    console.error("[shell] could not build the sidebar:", error);
    return { isAdmin: false, currentUser: null, switcher: null, sync: null };
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const navProps = await loadNavProps();

  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        {/*
          Two shells, one DOM. Below `md` this is a normal column and the
          DOCUMENT scrolls — deliberately, because an inner scroller stops iOS
          Safari collapsing its URL bar and permanently costs vertical space.
          At `md`+ the wrapper is locked to the viewport (`md:h-dvh`) and
          `<main>` becomes the only scrolling region, so the sidebar stays put.
          `md:min-h-0` is load-bearing: without it the inherited `min-h-screen`
          fights `h-dvh`, the wrapper can exceed the viewport, and document
          scrolling comes back.
        */}
        <div className="flex min-h-screen flex-col md:h-dvh md:min-h-0 md:flex-row md:overflow-hidden">
          <Nav {...navProps} />
          {/*
            One content measure for the whole app. `<main>` fills the space
            beside the sidebar, but the page itself lives in a centered column
            capped at `max-w-5xl` — so on a wide monitor content is framed with
            even margins instead of stranded against the left edge, and every
            route shares the same width. Genuinely wide content (the analytics
            chart, the users table) still fills this column.
          */}
          <main className="min-w-0 flex-1 p-4 md:overflow-y-auto md:p-6">
            <div className="mx-auto w-full max-w-5xl">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
