/**
 * `/api/sync` — the BFF endpoint behind the Refresh button (plan §Phase 8).
 *
 * - `POST` runs a full sync and answers with the per-resource outcome. A run
 *   that finds the lock held is NOT an error: it answers 200 with `ran: false`,
 *   because "somebody else is already refreshing" is exactly what the user
 *   wanted to happen.
 * - `GET` reports `sync_state` plus whether the snapshot is stale, so the status
 *   widget can render without a sync of its own.
 *
 * Both require a provisioned identity (§G8). Syncing writes nothing to the
 * Anthropic API and so needs no audit entry, but it does spend the org's shared
 * rate-limit budget, which is not something an unauthenticated caller should be
 * able to burn.
 */

import { getDb } from "@/db/client";
import { loadAppConfig } from "@/lib/config";
import { createAnthropicClient } from "@/lib/anthropic/client";
import { currentEmployee } from "@/lib/identity";
import { isStale, readSyncState, syncAll } from "@/lib/sync";

export const dynamic = "force-dynamic";

const FORBIDDEN = { error: "not provisioned" } as const;

export async function POST(): Promise<Response> {
  const db = getDb();
  if ((await currentEmployee(db)) === null) return Response.json(FORBIDDEN, { status: 403 });

  try {
    const result = await syncAll(db, createAnthropicClient());
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
