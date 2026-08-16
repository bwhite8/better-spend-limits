"use client";

/**
 * The route-level error boundary (Next `error.js` convention, which must be a
 * Client Component).
 *
 * Pages here read the database and sync on render, so a failure — a migration
 * not yet run on a fresh clone, a sync that threw — used to fall through to
 * Next's unstyled default screen. This catches it inside the app shell instead,
 * in the same visual language as `Forbidden`, and offers `reset()`: the write
 * flows are idempotent and the common causes are transient, so "Try again" is a
 * real way out rather than decoration.
 */

import { useEffect } from "react";

import { button } from "@/components/controls";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The message itself is not shown to the user — a render error can carry
    // internals — but it belongs in the server/browser log for whoever is on call.
    console.error("[route] render failed:", error);
  }, [error]);

  return (
    <section data-testid="route-error" className="mx-auto max-w-xl py-16">
      <p className="text-sm font-semibold tracking-wide text-danger-600 uppercase">
        Something went wrong
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">This page could not be loaded</h1>
      <p className="mt-3 text-slate-600 dark:text-slate-400">
        The app hit an unexpected error while building this page. This is often a passing problem —
        a sync that timed out, or data still catching up — so trying again usually clears it.
      </p>
      <div className="mt-6">
        <button
          type="button"
          onClick={reset}
          data-testid="route-error-retry"
          className={button("primary")}
        >
          Try again
        </button>
      </div>
    </section>
  );
}
