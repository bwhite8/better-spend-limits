/**
 * `/api/sync` — the BFF endpoint behind the Refresh button (plan §Phase 8).
 *
 * - `POST` refreshes the snapshot and answers with the per-resource outcome. It
 *   goes through {@link ensureFreshSync}, so it is **staleness-gated by default**:
 *   a call that finds the snapshot already fresh does no work and answers
 *   `ran: false`. The Refresh button asks for a real refresh by sending
 *   `{ "force": true }`; a run that finds the lock held still answers `ran: false`
 *   ("somebody else is already refreshing"), which is exactly what the user
 *   wanted to happen.
 * - `GET` reports `sync_state` plus whether the snapshot is stale, so the status
 *   widget can render without a sync of its own.
 *
 * Both require a provisioned identity (§G8). Syncing writes nothing to the
 * Anthropic API but it does spend the org's shared rate-limit budget and real
 * CPU, so POST is additionally IP-rate-limited (§SYNC_RATE_LIMIT) and the force
 * path is bounded by that budget — an anonymous caller can no longer pin both
 * services by looping this endpoint.
 */

import { getDb } from "@/db/client";
import { loadAppConfig } from "@/lib/config";
import { BodyTooLargeError, bodyTooLargeResponse, enforceRateLimit, readLimitedJson } from "@/lib/http";
import { currentEmployee } from "@/lib/identity";
import { SYNC_RATE_LIMIT } from "@/lib/rate-limit";
import { ensureFreshSync } from "@/lib/sync-runner";
import { isStale, readSyncState } from "@/lib/sync";

export const dynamic = "force-dynamic";

const FORBIDDEN = { error: "not provisioned" } as const;

export async function POST(request: Request): Promise<Response> {
  const limited = enforceRateLimit(request, SYNC_RATE_LIMIT, "sync");
  if (limited) return limited;

  const db = getDb();
  if ((await currentEmployee(db)) === null) return Response.json(FORBIDDEN, { status: 403 });

  let body: unknown;
  try {
    body = await readLimitedJson(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return bodyTooLargeResponse(error);
    throw error;
  }
  const force = (body as { force?: unknown } | null)?.force === true;

  try {
    const result = await ensureFreshSync(db, { force });
    // `null` means the snapshot was already fresh and no force was asked for, so
    // nothing ran — report it in the same shape the widget already understands.
    if (result === null) {
      return Response.json({ ran: false, ok: true, skipped: "fresh", outcomes: [] });
    }
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  const db = getDb();
  if ((await currentEmployee(db)) === null) return Response.json(FORBIDDEN, { status: 403 });

  return Response.json({
    resources: readSyncState(db),
    stale: isStale(db, loadAppConfig(db)),
  });
}
