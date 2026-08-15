"use client";

/**
 * AI-lead delegation, the admin surface (plan §Phase 9).
 *
 * This grid is a permission editor, not a directory. Assigning a leader to a
 * lead hands that lead everything the leader's tier-2/3/4 roles grant — their
 * people's spend limits and their increase requests — so each row says who is
 * affected and the section caption says what the grant is worth.
 *
 * Three deliberate shapes:
 *
 * - **The whole set at once.** The multi-select shows the complete assignment
 *   and Save replaces it. Add/remove buttons would need the browser and the
 *   server to agree on a starting point, and the browser's copy can be minutes
 *   stale on a page an admin left open.
 * - **Leaders only, admins never.** The options are the non-admin holders of a
 *   tier-2/3/4 slot. The server re-checks (`lib/ai-leads.ts`) — a select element
 *   is advice, and the error it renders is the real answer.
 * - **The leaders themselves stay out of scope.** Worth stating on the page,
 *   because "inherits their scope" reads as "can see them" until you are told
 *   otherwise.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { AiLeadDirectory, AiLeadEntry, AiLeadPerson } from "@/lib/ai-leads";

import { updateAiLeadAssignments } from "./actions";
import type { AdminActionResult } from "./types";

export type AiLeadsProps = AiLeadDirectory;

/** Enough rows that it reads as a list to scroll, few enough that eight fit on a page. */
const SELECT_ROWS = 5;

function LeadRow({ lead, leaders }: { lead: AiLeadEntry; leaders: AiLeadPerson[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>(lead.assignedLeaderIds);
  const [result, setResult] = useState<AdminActionResult | null>(null);

  const byId = new Map(leaders.map((leader) => [leader.id, leader]));
  const assignedNames = lead.assignedLeaderIds.map((id) => byId.get(id)?.name ?? id);

  const save = () => {
    setResult(null);
    startTransition(async () => {
      const answer = await updateAiLeadAssignments({
        lead_employee_id: lead.id,
        leader_employee_ids: selected,
      });

      setResult(answer);
      // Either way: on success so the row redraws from the stored assignment, on
      // failure so it redraws from the one that still holds.
      router.refresh();
    });
  };

  return (
    <div
      data-testid="ai-lead-row"
      data-employee-id={lead.id}
      className="flex flex-col gap-3 rounded border border-slate-200 p-3 md:flex-row md:items-start md:gap-6 dark:border-slate-800"
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:w-56 md:shrink-0">
        <span className="text-sm font-medium">{lead.name}</span>
        <span className="truncate text-xs text-slate-500">{lead.email}</span>
        <span data-testid="ai-lead-current" className="mt-1 text-xs text-slate-500">
          {assignedNames.length === 0 ? "No delegation" : `Speaks for ${assignedNames.join(", ")}`}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <label className="flex min-w-0 flex-col gap-1 text-sm sm:w-72">
            <span className="sr-only">{`Leaders delegated to ${lead.name}`}</span>
            <select
              multiple
              size={Math.min(SELECT_ROWS, Math.max(leaders.length, 2))}
              value={selected}
              disabled={pending}
              data-testid="ai-lead-select"
              aria-label={`Leaders delegated to ${lead.name}`}
              onChange={(event) => {
                setResult(null);
                setSelected([...event.target.selectedOptions].map((option) => option.value));
              }}
              className="w-full rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {leaders.map((leader) => (
                <option key={leader.id} value={leader.id}>
                  {leader.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={save}
            disabled={pending}
            data-testid="ai-lead-save"
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60 md:min-h-0 md:py-1.5 dark:bg-slate-100 dark:text-slate-900"
          >
            {pending ? "Saving…" : "Save delegation"}
          </button>
        </div>

        {result?.ok === true ? (
          <p
            role="status"
            data-testid="ai-lead-saved"
            className="text-sm text-emerald-700 dark:text-emerald-400"
          >
            {result.message}
          </p>
        ) : null}

        {result?.ok === false ? (
          <p role="alert" data-testid="ai-lead-error" className="text-sm text-red-600">
            {result.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AiLeads({ leads, leaders }: AiLeadsProps) {
  if (leads.length === 0 || leaders.length === 0) {
    return (
      <p data-testid="ai-leads-empty" className="text-sm text-slate-500">
        {leads.length === 0
          ? "No employee is named as an aligned AI lead, so there is nothing to delegate."
          : "No non-admin employee holds a tier-2, tier-3 or tier-4 leadership slot, so there is no scope to delegate."}
      </p>
    );
  }

  return (
    <div data-testid="ai-leads" className="flex flex-col gap-3">
      <p className="text-xs text-slate-500">
        Hold ⌘ or Ctrl to pick more than one. Saving replaces the whole list, so an empty selection
        removes the delegation. Administrators are not offered: their scope is the whole
        organization, and delegating it would be a grant of admin rights by another name.
      </p>
      {leads.map((lead) => (
        <LeadRow key={lead.id} lead={lead} leaders={leaders} />
      ))}
    </div>
  );
}
