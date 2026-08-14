/**
 * How old the local snapshot is, in words.
 *
 * This lives outside `sync-status.tsx` because BOTH sides need it: the server
 * renders the first label (so the markup is right before hydration), and the
 * client re-renders it as time passes. A function exported from a `"use client"`
 * module cannot be called on the server at all — it becomes a client reference,
 * and calling it throws — so the shared helper has to sit in a module with no
 * directive.
 */

/** `"Synced 3m ago"`. Pure, so the server and the client agree on the wording. */
export function syncLabel(syncedAt: string | null, now: number = Date.now()): string {
  if (syncedAt === null) return "Never synced";
  const at = Date.parse(syncedAt);
  if (Number.isNaN(at)) return "Never synced";

  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "Synced just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}
