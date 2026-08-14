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

import { SyncStatus, type SyncStatusProps } from "./sync-status";
import type { SwitcherOption } from "./switcher-groups";
import { UserSwitcher } from "./user-switcher";

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

const ITEMS: NavItem[] = [
  { href: "/", label: "Members" },
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
  if (href === "/") return pathname === "/" || pathname.startsWith("/members");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({ isAdmin, currentUser, switcher, sync }: NavProps) {
  const pathname = usePathname();

  return (
    <nav
      data-testid="nav"
      className="flex w-60 shrink-0 flex-col gap-6 border-r border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div>
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
          better-spend-limits
        </Link>
      </div>

      <ul className="flex flex-col gap-1">
        {ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              data-testid={`nav-link-${item.label.toLowerCase()}`}
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
              className={`block rounded px-2 py-1 text-sm ${
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

      <div className="mt-auto flex flex-col gap-4">
        {currentUser === null ? (
          <p className="text-xs text-slate-500" data-testid="current-user">
            Not signed in
          </p>
        ) : (
          <p className="text-xs text-slate-500" data-testid="current-user" data-email={currentUser.email}>
            <span className="block font-medium text-slate-700 dark:text-slate-300">{currentUser.name}</span>
            {currentUser.email}
            {isAdmin ? <span className="ml-1 font-medium text-indigo-600">· admin</span> : null}
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
