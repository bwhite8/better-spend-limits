/**
 * `POST /api/admin/reset` — restore the public demo to its pristine state.
 *
 * This is the one endpoint that is NOT gated by the app's identity model, and
 * deliberately so: it is called by the `demo-reset` Railway cron, which has no
 * session. It is gated by a shared secret instead — `RESET_TOKEN`, compared in
 * constant time — and does nothing unless that variable is set, so a fork that
 * never configures it has no reset endpoint at all.
 *
 * Even a leaked token buys only the ability to reset synthetic demo data to its
 * seed, which is the endpoint's whole purpose; there is nothing destructive here
 * that the periodic cron is not already doing on a schedule. It is still
 * rate-limited, and it answers 404 (not 401) to an unauthenticated caller so its
 * existence is not advertised.
 */

import { timingSafeEqual } from "node:crypto";

import { getDb } from "@/db/client";
import { resetDatabase } from "@/db/reset";
import { enforceRateLimit } from "@/lib/http";
import { MUTATION_RATE_LIMIT } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "not found" } as const;

/** Constant-time bearer-token check against `RESET_TOKEN`. */
function authorized(request: Request): boolean {
  const expected = process.env.RESET_TOKEN?.trim();
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (provided.length === 0) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, so guard it — and the guard
  // leaks only the length, never the bytes.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const limited = enforceRateLimit(request, MUTATION_RATE_LIMIT, "admin-reset");
  if (limited) return limited;

  if (!authorized(request)) return Response.json(NOT_FOUND, { status: 404 });

  const summary = resetDatabase(getDb());
  return Response.json({ ok: true, ...summary });
}
