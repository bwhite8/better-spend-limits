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
import { useEffect, useRef, useState, useTransition } from "react";

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

/**
 * How long the "Approved / Denied" confirmation stays up before the queue
 * refreshes and this resolved card leaves the pending list. A resolved request
 * has nowhere to live on this tab, so without this beat the only feedback on a
 * decision would be the card silently disappearing.
 */
const RESOLVED_REFRESH_MS = 1100;

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
  // Once set, the decision is done: the buttons stand down and this line takes
  // their place until the deferred refresh sweeps the resolved card away.
  const [notice, setNotice] = useState<string | null>(null);

  // The deny dialog has no field to catch focus, so focus its panel on open —
  // Escape then closes from anywhere inside, and the label is announced.
  const denyDialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (dialog === "deny") denyDialogRef.current?.focus();
  }, [dialog]);

  // A deferred refresh outlives its transition, so clear it if the card unmounts
  // first (a navigation away before the beat elapses).
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
  }, []);

  const openApprove = () => {
    setError(null);
    setNotice(null);
    setMinorUnits(parseAmountInput(prefillDollars).minorUnits);
    setSuppress(suppressDefault);
    setDialog("approve");
  };

  const openDeny = () => {
    setError(null);
    setNotice(null);
    setSuppress(suppressDefault);
    setDialog("deny");
  };

  const submit = (payload: Record<string, unknown>, successMessage: string) => {
    setError(null);
    setNotice(null);
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
      if (ok) {
        setDialog(null);
        setNotice(successMessage);
        // Hold the refresh a beat so the confirmation is seen before the card
        // leaves the pending queue.
        refreshTimer.current = setTimeout(() => router.refresh(), RESOLVED_REFRESH_MS);
      } else {
        // Refresh now: a rejected decision usually means somebody else has
        // already resolved this request, and stale numbers are what caused it.
        router.refresh();
      }
    });
  };

  const approve = () => {
    if (minorUnits === null) return;
    submit(
      { action: "approve", amount: minorUnits, suppressNotification: suppress },
      `Approved — ${requesterName}'s new limit is set.`,
    );
  };

  const deny = () =>
    submit(
      { action: "deny", suppressNotification: suppress },
      `Denied — ${requesterName}'s limit is unchanged.`,
    );

  const suppressToggle = (testId: string) => (
    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
      <input
        type="checkbox"
        checked={suppress}
        disabled={pending}
        data-testid={testId}
        onChange={(event) => setSuppress(event.target.checked)}
        className="h-5 w-5 shrink-0 md:h-3.5 md:w-3.5"
      />
      Don&rsquo;t notify {requesterName}
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      {notice === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openApprove}
            disabled={pending}
            data-testid="approve-open"
            className="inline-flex min-h-11 items-center justify-center rounded bg-success-600 px-3 py-2 text-sm font-medium text-white hover:bg-success-700 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={openDeny}
            disabled={pending}
            data-testid="deny-open"
            className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs dark:border-slate-600 dark:hover:bg-slate-800"
          >
            Deny
          </button>
        </div>
      ) : null}

      {dialog === "approve" ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-label={`Approve the increase request from ${requesterName}`}
          data-testid="approve-dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) setDialog(null);
          }}
          className="flex flex-col gap-3 rounded border border-slate-300 p-3 dark:border-slate-700"
        >
          <h3 className="text-sm font-semibold">Approve at a new limit</h3>
          <AmountInput
            defaultValue={prefillDollars}
            disabled={pending}
            autoFocus
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
              className="inline-flex min-h-11 items-center justify-center rounded bg-success-600 px-3 py-2 text-sm font-medium text-white hover:bg-success-700 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
            >
              {pending ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={pending}
              data-testid="approve-cancel"
              className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {dialog === "deny" ? (
        <section
          ref={denyDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="false"
          aria-label={`Deny the increase request from ${requesterName}`}
          data-testid="deny-dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) setDialog(null);
          }}
          className="flex flex-col gap-3 rounded border border-slate-300 p-3 focus:outline-none dark:border-slate-700"
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
              className="inline-flex min-h-11 items-center justify-center rounded bg-danger-600 px-3 py-2 text-sm font-medium text-white hover:bg-danger-700 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
            >
              {pending ? "Denying…" : "Deny request"}
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={pending}
              data-testid="deny-cancel"
              className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {notice === null ? null : (
        <p role="status" data-testid="request-done" className="text-sm font-medium text-success-700 dark:text-success-400">
          {notice}
        </p>
      )}

      {error === null ? null : (
        <p role="alert" data-testid="request-error" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}
