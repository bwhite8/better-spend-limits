"use client";

/**
 * The sidebar: every destination in the app, plus who you are and how fresh the
 * data is.
 *
 * All four destinations are declared here in Phase 9 — the Requests, Analytics
 * and Admin pages exist as stubs from day one — so no later phase has to edit
 * this file to add its own link, and Phases 10–13 stay on disjoint files.
 *
 * Admin is hidden for non-admins. That is presentation only: `/admin` itself
 * checks the actor, because a hidden link is not an access control.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { SyncStatus, type SyncStatusProps } from "./sync-status";
import type { SwitcherOption } from "./switcher-groups";
import { UserSwitcher } from "./user-switcher";

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

const ITEMS: NavItem[] = [
  { href: "/members", label: "Users" },
  { href: "/requests", label: "Requests" },
  { href: "/analytics", label: "Analytics" },
  { href: "/admin", label: "Admin", adminOnly: true },
];

export interface NavProps {
  isAdmin: boolean;
  currentUser: { name: string; email: string } | null;
  /** `null` outside dev mode — impersonation is a dev-only affordance (§G6). */
  switcher: { options: SwitcherOption[]; currentEmail: string | null } | null;
  /** `null` when the database cannot be read yet (pre-migration). */
  sync: SyncStatusProps | null;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({ isAdmin, currentUser, switcher, sync }: NavProps) {
  const pathname = usePathname();

  // Below `md` the nav is a top bar with no room for the identity block, so it
  // hides behind a disclosure. At `md`+ the block is always shown and this
  // state is inert. Closing on navigation keeps a tapped link from leaving an
  // open panel covering the page you just asked for.
  const [statusOpen, setStatusOpen] = useState(false);
  useEffect(() => {
    setStatusOpen(false);
  }, [pathname]);

  return (
    // ONE nav element for both layouts, repositioned with classes. A second
    // mobile copy would put every `data-testid` in the DOM twice and break
    // Playwright's strict-mode `getByTestId` at every viewport, desktop included.
    <nav
      data-testid="nav"
      className="sticky top-0 z-20 flex w-full shrink-0 flex-col gap-3 border-b border-slate-200 bg-white p-3 md:static md:h-full md:w-60 md:gap-6 md:overflow-y-auto md:border-r md:border-b-0 md:p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between">
        <Link href="/" aria-label="Spend Limits — home" className="flex items-center gap-2">
          {/*
            The mark echoes the SpendBar: a track, a fill, and the limit line the
            fill approaches. `currentColor` is not used — it is filled from the
            `--color-brand-600` design token so a rebrand (globals.css §@theme)
            recolors the logo for free, exactly as it recolors every accent.
          */}
          <svg viewBox="0 0 32 32" aria-hidden="true" className="h-6 w-6 shrink-0">
            <rect width="32" height="32" rx="8" fill="var(--color-brand-600)" />
            <rect x="6.5" y="14.4" width="19" height="3.2" rx="1.6" fill="#fff" opacity="0.35" />
            <rect x="6.5" y="14.4" width="11.5" height="3.2" rx="1.6" fill="#fff" />
            <rect x="22.4" y="9" width="2.6" height="14" rx="1.3" fill="#fff" />
          </svg>
          <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Spend Limits
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setStatusOpen((open) => !open)}
          aria-expanded={statusOpen}
          aria-controls="nav-status"
          data-testid="nav-status-toggle"
          className="rounded border border-slate-300 px-2 py-1 text-xs md:hidden dark:border-slate-700"
        >
          {statusOpen ? "Hide" : "Status"}
        </button>
      </div>

      <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col">
        {ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              data-testid={`nav-link-${item.label.toLowerCase()}`}
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
              className={`block rounded px-2 py-1 text-sm whitespace-nowrap ${
                isActive(pathname, item.href)
                  ? "bg-slate-200 font-medium dark:bg-slate-800"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>

      <div
        id="nav-status"
        className={`flex-col gap-4 md:mt-auto md:flex ${statusOpen ? "flex" : "hidden"}`}
      >
        {currentUser === null ? (
          <p className="text-xs text-slate-500" data-testid="current-user">
            Not signed in
          </p>
        ) : (
          <p className="text-xs text-slate-500" data-testid="current-user" data-email={currentUser.email}>
            <span className="block font-medium text-slate-700 dark:text-slate-300">{currentUser.name}</span>
            {currentUser.email}
            {isAdmin ? <span className="ml-1 font-medium text-brand-600">· admin</span> : null}
          </p>
        )}

        {sync === null ? null : <SyncStatus {...sync} />}
        {switcher === null ? null : (
          <UserSwitcher options={switcher.options} currentEmail={switcher.currentEmail} />
        )}
      </div>
    </nav>
  );
}
