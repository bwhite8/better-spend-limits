"use client";

/**
 * The application settings editor (§G7 `app_config`, plan §Phase 13).
 *
 * These five values are not preferences — `edit_roles` alone decides which
 * hierarchy roles may change anybody's spend limit (§G8) — so each field says,
 * in plain words, what
 * turning it changes. The role checkboxes in particular are a permission grid
 * wearing a checkbox costume, and the caption spells out the consequence.
 *
 * Validation is duplicated between here and the action on purpose: the client
 * copy exists so a slip is caught before a round trip, and the server copy
 * exists because the client copy is advice.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { button, CHECKBOX, FIELD } from "@/components/controls";
import { EDIT_ROLE_VALUES, type AppConfigDefaults, type EditRole } from "@/db/config-defaults";

import { updateConfig } from "./actions";
import type { AdminActionResult } from "./types";

/**
 * Human wording for each §G8 role, in the order the hierarchy runs.
 *
 * `aligned_ai_lead` used to be here. It is now an explicit per-lead delegation
 * in its own section (§Phase 9) rather than a column anyone can switch on.
 */
const ROLE_LABELS: Record<EditRole, string> = {
  direct_manager: "Direct manager (tier 1)",
  tier2_manager: "Tier 2 manager",
  tier3_manager: "Tier 3 manager",
  tier4_manager: "Tier 4 manager",
};

export interface ConfigFormProps {
  initial: AppConfigDefaults;
}

export function ConfigForm({ initial }: ConfigFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [roles, setRoles] = useState<EditRole[]>(initial.edit_roles);
  const [threshold, setThreshold] = useState(String(initial.near_limit_threshold));
  const [suppress, setSuppress] = useState(initial.suppress_notification_default);
  const [staleAfter, setStaleAfter] = useState(String(initial.sync_stale_after_minutes));
  const [orgKpis, setOrgKpis] = useState(initial.show_org_wide_kpis);
  const [result, setResult] = useState<AdminActionResult | null>(null);

  const thresholdValue = Number(threshold);
  const staleValue = Number(staleAfter);

  const localError =
    roles.length === 0
      ? "Choose at least one role, or only admins will be able to edit limits."
      : !Number.isFinite(thresholdValue) || thresholdValue < 0 || thresholdValue > 1
        ? "The near-limit threshold is a fraction between 0 and 1."
        : !Number.isInteger(staleValue) || staleValue <= 0
          ? "Sync staleness is a whole number of minutes, greater than zero."
          : null;

  const toggleRole = (role: EditRole, checked: boolean) => {
    setResult(null);
    setRoles((current) =>
      checked ? [...current, role] : current.filter((entry) => entry !== role),
    );
  };

  const save = () => {
    if (localError !== null) return;
    setResult(null);

    startTransition(async () => {
      const answer = await updateConfig({
        edit_roles: roles,
        near_limit_threshold: thresholdValue,
        suppress_notification_default: suppress,
        sync_stale_after_minutes: staleValue,
        show_org_wide_kpis: orgKpis,
      });

      setResult(answer);
      // Re-render the server tree either way: on success so the page reflects
      // the new settings, on failure so it reflects the ones that still hold.
      router.refresh();
    });
  };

  return (
    <div data-testid="config-form" className="flex max-w-2xl flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Who may edit a spend limit</legend>
        <p className="text-xs text-slate-500">
          A person may edit somebody&rsquo;s limit — and resolve their increase requests — when they
          hold one of these roles over them. Admins always may, and an AI lead may exercise these
          same roles for whichever leaders are delegated to them below.
        </p>
        <div className="mt-1 flex flex-col gap-1.5">
          {EDIT_ROLE_VALUES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={roles.includes(role)}
                disabled={pending}
                data-testid={`config-role-${role}`}
                onChange={(event) => toggleRole(role, event.target.checked)}
                className={CHECKBOX}
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Near-limit threshold</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={threshold}
          disabled={pending}
          data-testid="config-threshold"
          onChange={(event) => {
            setResult(null);
            setThreshold(event.target.value);
          }}
          className={`${FIELD} w-32 tabular-nums`}
        />
        <span className="text-xs text-slate-500">
          The fraction of their cap at which somebody appears in the Analytics near-limit report.
        </span>
      </label>

      {/* `items-start`: these two labels carry a second explanatory line, and
          centring the box against a two-line block floated it between them,
          level with neither. It lines up with the title it belongs to. */}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={suppress}
          disabled={pending}
          data-testid="config-suppress"
          onChange={(event) => {
            setResult(null);
            setSuppress(event.target.checked);
          }}
          className={`${CHECKBOX} mt-0.5`}
        />
        <span>
          <span className="font-medium">Suppress notifications by default</span>
          <span className="block text-xs text-slate-500">
            Pre-selects &ldquo;don&rsquo;t notify&rdquo; when approving or denying an increase
            request. Approvers can still override it per decision.
          </span>
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Re-sync after (minutes)</span>
        <input
          type="number"
          min={1}
          step={1}
          value={staleAfter}
          disabled={pending}
          data-testid="config-stale"
          onChange={(event) => {
            setResult(null);
            setStaleAfter(event.target.value);
          }}
          className={`${FIELD} w-32 tabular-nums`}
        />
        <span className="text-xs text-slate-500">
          How old the local snapshot may get before a page view triggers a refresh. The
          organization shares 60 API requests a minute, so shorter is not always better.
        </span>
      </label>

      {/* `items-start`: these two labels carry a second explanatory line, and
          centring the box against a two-line block floated it between them,
          level with neither. It lines up with the title it belongs to. */}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={orgKpis}
          disabled={pending}
          data-testid="config-org-kpis"
          onChange={(event) => {
            setResult(null);
            setOrgKpis(event.target.checked);
          }}
          className={`${CHECKBOX} mt-0.5`}
        />
        <span>
          <span className="font-medium">Show organization-wide spend on Analytics</span>
          <span className="block text-xs text-slate-500">
            Gives everyone a total and a per-user average for the whole organization, next to the
            same two figures for their own scope. No individual is named and no per-person figure
            can be read off it — but it does describe people the viewer cannot otherwise see. Turn
            it off and everybody sees their own scope only.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || localError !== null}
          data-testid="config-save"
          className={button("primary")}
        >
          {pending ? "Saving…" : "Save settings"}
        </button>

        {result?.ok === true ? (
          <p role="status" data-testid="config-saved" className="text-sm text-success-700 dark:text-success-400">
            {result.message}
          </p>
        ) : null}
      </div>

      {localError === null && result?.ok !== false ? null : (
        <p role="alert" data-testid="config-error" className="text-sm text-danger-600">
          {localError ?? result?.message}
        </p>
      )}
    </div>
  );
}
