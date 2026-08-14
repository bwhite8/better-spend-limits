"use client";

/**
 * Approve and Deny, on one queue card (plan §Phase 11).
 *
 * Approving takes an amount because the request does not carry one: §G4 requests
 * are "please give me more", full stop, and the approver decides how much more.
 * The field is pre-filled with the member's CURRENT cap, which is the number the
 * approver is deciding to change and therefore the only sensible starting point —
 * but it is a starting point, not a default: approving at the current amount
 * would resolve the request while granting nothing.
 *
 * `suppress_notification` is exposed rather than hard-wired. Its default comes
 * from `app_config` (§G7), so a deployment that wants Anthropic to email the
 * requester can have that, and an approver can still override it for one
 * decision — a limit raised quietly during an incident is a real case.
 *
 * Validation is the shared `parseAmountInput`, the same rule the server runs
 * (§G9): an invalid amount disables the button, so it never reaches the network.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AmountInput, parseAmountInput } from "@/components/amount-input";

export interface RequestActionsProps {
  requestId: string;
  requesterName: string;
  /** Current effective cap in dollars, e.g. `"750.00"`; `""` when unknown. */
  prefillDollars: string;
  /** `app_config.suppress_notification_default` (§G7). */
  suppressDefault: boolean;
}

type OpenDialog = "approve" | "deny" | null;

const REQUEST_HEADERS = { "content-type": "application/json" } as const;

function messageOf(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const { error } = body as { error?: unknown };
    if (typeof error === "string" && error !== "") return error;
  }
  return fallback;
}

export function RequestActions({
  requestId,
  requesterName,
  prefillDollars,
  suppressDefault,
}: RequestActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [minorUnits, setMinorUnits] = useState<string | null>(null);
  const [suppress, setSuppress] = useState(suppressDefault);
  const [error, setError] = useState<string | null>(null);

  const openApprove = () => {
    setError(null);
    setMinorUnits(parseAmountInput(prefillDollars).minorUnits);
    setSuppress(suppressDefault);
    setDialog("approve");
  };

  const openDeny = () => {
    setError(null);
    setSuppress(suppressDefault);
    setDialog("deny");
  };

  const submit = (payload: Record<string, unknown>) => {
    setError(null);
    startTransition(async () => {
      let ok = false;
      try {
        const response = await fetch(`/api/requests/${requestId}`, {
          method: "POST",
          headers: REQUEST_HEADERS,
          body: JSON.stringify(payload),
        });
        const body: unknown = await response.json().catch(() => null);
        ok = response.ok;
        if (!ok) setError(messageOf(body, "The decision could not be recorded."));
      } catch {
        setError("The decision could not be recorded — the app could not be reached.");
      }
      if (ok) setDialog(null);
      // Refresh either way: a rejected decision usually means somebody else has
      // already resolved this request, and stale numbers are what caused it.
      router.refresh();
    });
  };

  const approve = () => {
    if (minorUnits === null) return;
    submit({ action: "approve", amount: minorUnits, suppressNotification: suppress });
  };

  const deny = () => submit({ action: "deny", suppressNotification: suppress });

  const suppressToggle = (testId: string) => (
    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
      <input
        type="checkbox"
        checked={suppress}
        disabled={pending}
        data-testid={testId}
        onChange={(event) => setSuppress(event.target.checked)}
        className="h-3.5 w-3.5"
      />
      Don&rsquo;t notify {requesterName}
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={openApprove}
          disabled={pending}
          data-testid="approve-open"
          className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={openDeny}
          disabled={pending}
          data-testid="deny-open"
          className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-800"
        >
          Deny
        </button>
      </div>

      {dialog === "approve" ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-label={`Approve the increase request from ${requesterName}`}
          data-testid="approve-dialog"
          className="flex flex-col gap-3 rounded border border-slate-300 p-3 dark:border-slate-700"
        >
          <h3 className="text-sm font-semibold">Approve at a new limit</h3>
          <AmountInput
            defaultValue={prefillDollars}
            disabled={pending}
            onValueChange={(value) => setMinorUnits(value)}
          />
          <p className="text-xs text-slate-500">
            The request does not name an amount — this is the new monthly cap {requesterName} will
            get. Approving also writes the override, so it replaces whatever they inherit today.
          </p>
          {suppressToggle("approve-suppress")}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={approve}
              disabled={pending || minorUnits === null}
              data-testid="approve-confirm"
              className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {pending ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={pending}
              data-testid="approve-cancel"
              className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {dialog === "deny" ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-label={`Deny the increase request from ${requesterName}`}
          data-testid="deny-dialog"
          className="flex flex-col gap-3 rounded border border-slate-300 p-3 dark:border-slate-700"
        >
          <h3 className="text-sm font-semibold">Deny this request</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {requesterName}&rsquo;s limit stays exactly as it is. Denying cannot be undone from
            here — they would have to raise a new request.
          </p>
          {suppressToggle("deny-suppress")}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={deny}
              disabled={pending}
              data-testid="deny-confirm"
              className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
            >
              {pending ? "Denying…" : "Deny request"}
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={pending}
              data-testid="deny-cancel"
              className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {error === null ? null : (
        <p role="alert" data-testid="request-error" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
