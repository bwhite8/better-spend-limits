/**
 * Where an effective limit came from (§G4 `source.type`).
 *
 * `source.type` is an OPEN set — the API may grow a fifth kind tomorrow — so an
 * unrecognised value is rendered verbatim in a neutral badge rather than
 * silently collapsing to "unknown". Seeing `future_scope_kind` in the UI is a
 * far better failure than seeing nothing.
 */

const LABELS: Record<string, string> = {
  user: "Override",
  rbac_group: "Group",
  seat_tier: "Seat tier",
  organization: "Org default",
};

const TONES: Record<string, string> = {
  user: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  rbac_group: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  seat_tier: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  organization: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

const UNKNOWN_TONE = "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";

/** The human label for a source type, exported so tests can assert on it. */
export function sourceLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return "None";
  return LABELS[sourceType] ?? sourceType;
}

export interface SourceBadgeProps {
  /** `source.type` from the snapshot; `null` when nothing is configured at all. */
  sourceType: string | null | undefined;
  className?: string;
}

export function SourceBadge({ sourceType, className }: SourceBadgeProps) {
  const known = sourceType != null && sourceType in LABELS;
  const tone = sourceType == null ? TONES.organization : known ? TONES[sourceType] : UNKNOWN_TONE;

  return (
    <span
      data-testid="source-badge"
      data-source-type={sourceType ?? "none"}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${tone} ${className ?? ""}`}
    >
      {sourceLabel(sourceType)}
    </span>
  );
}
