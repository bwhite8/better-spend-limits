/**
 * The route-level loading state (Next `loading.js` convention).
 *
 * Every page here does synchronous DB reads and an `ensureFreshSync` before it
 * renders, and the first sync of a stale snapshot runs several seconds against
 * the API. Without this file that wait is a blank tab; with it, React shows this
 * skeleton the instant a navigation starts and swaps in the page when the server
 * is done. It is deliberately shaped like the pages it stands in for — a title
 * bar and a few rows — so the layout does not jump when the real content lands.
 */

/** One shimmering placeholder line. `w` is any Tailwind width class. */
function Bar({ className = "" }: { className?: string }) {
  return <div className={`h-4 animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`} />;
}

export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="route-loading"
      className="flex flex-col gap-6"
    >
      <span className="sr-only">Loading…</span>

      <div className="flex flex-col gap-2">
        <Bar className="h-7 w-48" />
        <Bar className="w-72 max-w-full" />
      </div>

      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Bar className="w-40" />
            <Bar className="hidden w-24 sm:block" />
            <Bar className="ml-auto w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
