/**
 * How the dev user switcher buckets 250 people into something scannable.
 *
 * This lives in a module WITHOUT a `"use client"` directive on purpose. The
 * server layout has to compute the option list, and a value imported from a
 * client module is replaced by a client reference on the server — a function
 * throws when called, and an array silently reads as nothing, which is exactly
 * how this file came to exist. Only components should cross that boundary.
 *
 * `employees` (§G7) stores the hierarchy, not job titles, so the buckets are
 * derived from the hierarchy itself: anyone who appears in somebody's
 * `*_manager_id` is a manager, anyone who appears in an `aligned_ai_lead_id` is
 * an AI lead. Admin wins over both.
 */

/** Optgroups, in display order. */
export const SWITCHER_GROUPS = ["Admins", "AI Leads", "Managers", "ICs"] as const;
export type SwitcherGroup = (typeof SWITCHER_GROUPS)[number];

export interface SwitcherOption {
  email: string;
  name: string;
  group: SwitcherGroup;
}

/** The employee fields the grouping needs — structural, so DB rows fit as-is. */
export interface SwitcherSubject {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
  direct_manager_id: string | null;
  tier2_manager_id: string | null;
  tier3_manager_id: string | null;
  tier4_manager_id: string | null;
  aligned_ai_lead_id: string | null;
}

/** One pass over the roster: who is referenced as a manager, and as an AI lead. */
export function switcherOptionsFor(rows: SwitcherSubject[]): SwitcherOption[] {
  const aiLeadIds = new Set<string>();
  const managerIds = new Set<string>();

  for (const row of rows) {
    if (row.aligned_ai_lead_id) aiLeadIds.add(row.aligned_ai_lead_id);
    for (const id of [
      row.direct_manager_id,
      row.tier2_manager_id,
      row.tier3_manager_id,
      row.tier4_manager_id,
    ]) {
      if (id) managerIds.add(id);
    }
  }

  return rows.map((row) => ({
    email: row.email,
    name: row.name,
    group: row.is_admin
      ? "Admins"
      : aiLeadIds.has(row.id)
        ? "AI Leads"
        : managerIds.has(row.id)
          ? "Managers"
          : "ICs",
  }));
}
