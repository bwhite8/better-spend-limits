"use client";

/**
 * Freshness of the local snapshot, plus the manual Refresh (plan §Phase 8).
 *
 * Everything on screen is read from SQLite, so the one thing a user must never
 * have to guess is how old that is. The widget shows the OLDEST
 * `last_synced_at` across the three synced resources — the honest number, since
 * a page mixing a 2-minute-old limit with an hour-old cost is an hour old.
 *
 * The absolute ISO timestamp is exposed as `data-synced-at` alongside the human
 * label so a test can wait for the value to change rather than race a
 * "just now" that was already "just now" before the click.
 *
 * `POST /api/sync` answering `ran: false` means the lock was held — somebody
 * else is already refreshing. That is a normal outcome, not an error.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { syncLabel } from "./sync-label";

export interface SyncStatusProps {
  /** Oldest `last_synced_at`, ISO. `null` when a resource has never synced. */
  syncedAt: string | null;
  /** Server-rendered label, reused as the initial client state (no mismatch). */
  initialLabel: string;
  stale: boolean;
  /** Any resource in `status = 'error'` — surfaced so a dead key is visible. */
  errored: boolean;
}

export function SyncStatus({ syncedAt, initialLabel, stale, errored }: SyncStatusProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState(initialLabel);
  const [message, setMessage] = useState<string | null>(null);

  // The label is time-relative, so it has to tick. Recomputing from the prop
  // (rather than from state) keeps it correct across router refreshes too.
  useEffect(() => {
    setLabel(syncLabel(syncedAt));
    const timer = setInterval(() => setLabel(syncLabel(syncedAt)), 30_000);
    return () => clearInterval(timer);
  }, [syncedAt]);

  const refresh = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/sync", { method: "POST" });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setMessage("Refresh failed");
        } else if (body !== null && typeof body === "object" && (body as { ran?: unknown }).ran === false) {
          setMessage("Already refreshing…");
        }
      } catch {
        setMessage("Refresh failed");
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-1" data-testid="sync-status" data-synced-at={syncedAt ?? ""}>
      <span
        className={`text-xs ${errored ? "text-danger-600" : stale ? "text-warn-600" : "text-slate-500"}`}
        data-testid="sync-label"
      >
        {label}
        {errored ? " (sync error)" : ""}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        data-testid="sync-refresh"
        className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 md:min-h-0 md:px-2 md:py-1 md:text-xs dark:border-slate-700 dark:hover:bg-slate-800"
      >
        {pending ? "Refreshing…" : "Refresh"}
      </button>
      {message === null ? null : (
        <span className="text-xs text-slate-500" data-testid="sync-message">
          {message}
        </span>
      )}
    </div>
  );
}
