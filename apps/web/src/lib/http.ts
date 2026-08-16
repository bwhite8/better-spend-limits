/**
 * Small shared helpers for the BFF route handlers (demo hardening).
 *
 * Two concerns, both about untrusted input reaching an unauthenticated route:
 *
 * - **Rate limiting.** `enforceRateLimit` turns the process-local limiter into a
 *   429 response, keyed by the caller's IP and a per-route scope.
 * - **Body size.** `readLimitedJson` reads a JSON body while refusing to buffer
 *   more than a few kilobytes, so a multi-gigabyte POST cannot OOM the container
 *   the way `request.json()` on an unbounded stream would.
 */

import { clientIp, rateLimit, type RateLimitRule } from "@/lib/rate-limit";

/** Ceiling for the tiny JSON payloads these routes accept (`{amount}` etc.). */
export const MAX_JSON_BODY_BYTES = 4096;

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Charge one hit against the limiter for this request; return a ready-to-send
 * 429 when the budget is spent, or `null` to continue. `scope` keeps unrelated
 * routes in separate buckets so editing limits does not throttle syncing.
 */
export function enforceRateLimit(
  request: Request,
  rule: RateLimitRule,
  scope: string,
): Response | null {
  const result = rateLimit(`${scope}:${clientIp(request.headers)}`, rule);
  if (result.ok) return null;

  return Response.json(
    { error: "Too many requests — please slow down and try again shortly.", code: "rate_limited" },
    { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } },
  );
}

/**
 * Read and parse a JSON body, capped at `maxBytes` of actual bytes read.
 *
 * The `Content-Length` check rejects an honestly-declared oversize body without
 * reading a byte; the streaming guard then bounds a chunked body that omits or
 * lies about the header. Returns `null` for an empty or unparseable body, so
 * callers keep their existing "missing field" handling. Throws
 * {@link BodyTooLargeError} — and only that — when the cap is exceeded.
 */
export async function readLimitedJson(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) throw new BodyTooLargeError(maxBytes);
  }

  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The 413 for a {@link BodyTooLargeError}. */
export function bodyTooLargeResponse(error: BodyTooLargeError): Response {
  return Response.json(
    { error: `Request body too large (limit ${error.maxBytes} bytes).`, code: "body_too_large" },
    { status: 413 },
  );
}
