"use client";

/**
 * The edit controls on a member's page (plan §Phase 10).
 *
 * Two writes, both live pass-through to the API through
 * `/api/members/[id]/limit`:
 *
 * - **Set limit** — an amount in dollars, converted to minor units by the same
 *   `dollarsInputToMinorUnits` the server validates with (§G9). An invalid value
 *   disables the button, so a bad amount never reaches the network.
 * - **Remove override** — offered only when the limit actually IS an override.
 *   The confirmation cannot show the exact value the member will fall back to:
 *   `effective` only reports what resolves TODAY, and what they inherit is only
 *   knowable after the override is gone. Rather than guess, it names the ladder
 *   (group → seat tier → org default → unlimited) — see §G4.
 *
 * There is no "set unlimited": the API cannot write `amount: null`, and removing
 * the override is the only route back to inheriting one (which may or may not be
 * unlimited). The helper text says so rather than offering a control that would
 * always fail.
 *
 * A pending increase request is surfaced permanently, not just inside the
 * dialog, because §G4's rule is genuinely surprising: setting a limit here does
 * NOT resolve the request, and someone who does not know that will believe they
 * have answered it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AmountInput, parseAmountInput } from "@/components/amount-input";
import { Money } from "@/components/money";
import { minorUnitsToDollarsInput } from "@/lib/dollars";

export interface EditLimitProps {
  /** Employee id — the same one the page route uses. */
  employeeId: string;
  memberName: string;
  /** §G8 `canEdit`. False renders an explanation and no controls at all. */
  canEdit: boolean;
  /** False when the sync has never seen this member; there is nothing to write. */
  synced: boolean;
  /** Current effective amount, minor units; `null` is unlimited. */
  amount: string | null;
  currency: string | null;
  /** `"user"` means the current value IS an override and can be removed. */
  sourceType: string | null;
  hasPendingRequest: boolean;
}

type OpenDialog = "set" | "remove" | null;

const REQUEST_HEADERS = { "content-type": "application/json" } as const;

function messageOf(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const { error } = body as { error?: unknown };
    if (typeof error === "string" && error !== "") return error;
  }
  return fallback;
}

export function EditLimit({
  employeeId,
  memberName,
  canEdit,
  synced,
  amount,
  currency,
  sourceType,
  hasPendingRequest,
}: EditLimitProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [minorUnits, setMinorUnits] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) {
    return (
      <p className="text-xs text-slate-500" data-testid="edit-readonly">
        You do not have permission to change this limit. The people who do are listed below.
      </p>
    );
  }

  const isOverride = sourceType === "user";
  const prefill = minorUnitsToDollarsInput(amount);

  const openSet = () => {
    setError(null);
    setMinorUnits(parseAmountInput(prefill).minorUnits);
    setDialog("set");
  };

  const openRemove = () => {
    setError(null);
    setDialog("remove");
  };

  const submit = (init: RequestInit) => {
    setError(null);
    startTransition(async () => {
      let ok = false;
      try {
        const response = await fetch(`/api/members/${employeeId}/limit`, init);
        const body: unknown = await response.json().catch(() => null);
        ok = response.ok;
        if (!ok) setError(messageOf(body, "The change could not be saved."));
      } catch {
        setError("The change could not be saved — the app could not be reached.");
      }
      if (ok) setDialog(null);
      // Refresh either way: a failed write may still have been preceded by a
      // change somebody else made, and stale numbers are what caused it.
      router.refresh();
    });
  };

  const save = () => {
    if (minorUnits === null) return;
    submit({
      method: "POST",
      headers: REQUEST_HEADERS,
      body: JSON.stringify({ amount: minorUnits }),
    });
  };

  const remove = () => submit({ method: "DELETE" });

  return (
    <div className="flex flex-col gap-3">
      {hasPendingRequest ? (
        <p
          data-testid="pending-warning"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {memberName} has a pending increase request — setting a limit directly won&rsquo;t resolve
          it.{" "}
          <Link href="/requests" data-testid="pending-warning-link" className="font-medium underline">
            Go to the requests queue
          </Link>
          .
        </p>
      ) : null}

      {synced ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openSet}
            disabled={pending}
            data-testid="set-limit"
            className="inline-flex min-h-11 items-center justify-center rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
          >
            Set limit
          </button>
          {isOverride ? (
            <button
              type="button"
              onClick={openRemove}
              disabled={pending}
              data-testid="remove-override"
              className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Remove override
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500" data-testid="edit-unsynced">
          This user has not been synced from the API yet, so their limit cannot be changed.
        </p>
      )}

      {dialog === "set" ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-label={`Set spend limit for ${memberName}`}
          data-testid="limit-dialog"
          className="flex flex-col gap-3 rounded border border-slate-300 p-3 dark:border-slate-700"
        >
          <h3 className="text-sm font-semibold">Set spend limit</h3>
          <AmountInput
            defaultValue={prefill}
            disabled={pending}
            onValueChange={(value) => setMinorUnits(value)}
          />
          <p className="text-xs text-slate-500">
            Monthly cap for {memberName}. There is no way to set &ldquo;unlimited&rdquo; directly —
            remove the override instead, and they inherit their group, seat-tier or organization
            limit (which may itself be unlimited).
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending || minorUnits === null}
              data-testid="limit-save"
              className="inline-flex min-h-11 items-center justify-center rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={pending}
              data-testid="limit-cancel"
              className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {dialog === "remove" ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-label={`Remove the spend limit override for ${memberName}`}
          data-testid="remove-dialog"
          className="flex flex-col gap-3 rounded border border-slate-300 p-3 dark:border-slate-700"
        >
          <h3 className="text-sm font-semibold">Remove override</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {memberName}&rsquo;s override of <Money amount={amount} currency={currency} /> will be
            deleted. They fall back to their group, seat-tier, or organization default; if none
            exists, their limit becomes Unlimited.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              data-testid="remove-confirm"
              className="inline-flex min-h-11 items-center justify-center rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs"
            >
              {pending ? "Removing…" : "Remove override"}
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={pending}
              data-testid="remove-cancel"
              className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2.5 md:py-1 md:text-xs dark:border-slate-600 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {error === null ? null : (
        <p role="alert" data-testid="limit-error" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
