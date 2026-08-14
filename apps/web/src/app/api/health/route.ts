/**
 * Liveness probe. Deliberately touches nothing — no database, no API client.
 *
 * Playwright starts its `webServer` processes BEFORE `globalSetup` runs, so the
 * readiness URL it polls is hit before migrations exist. Pointing that probe at
 * a real page would open (and cache) a handle to an unmigrated SQLite file that
 * `globalSetup` is about to delete. This route answers without reading anything,
 * which keeps the ordering safe.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true });
}
