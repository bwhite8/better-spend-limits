/**
 * Fixed-window rate limiting (plan §G4: 60 requests/min per organization,
 * shared across all spend-limit endpoints).
 *
 * Off by default — a demo that 429s while you click around is useless — and
 * enabled with `MOCK_RATE_LIMIT=<n>` so a client's retry/backoff path can be
 * exercised on purpose.
 */

import type { Context, MiddlewareHandler } from "hono";

import { apiError } from "./errors.js";

export type RateLimitSetting = number | "off";

const WINDOW_MS = 60_000;

/** Parse `MOCK_RATE_LIMIT`. Absent/empty/`"off"` disables the limiter. */
export function parseRateLimitSetting(raw: string | undefined): RateLimitSetting {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "off") return "off";
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`MOCK_RATE_LIMIT must be a positive integer or "off", got "${raw}"`);
  }
  return Number(value);
}

/**
 * One counter for the whole mock, reset each wall-clock minute. Requests over
 * the allowance get a 429 envelope plus `retry-after`, so clients can honour it
 * the way they would upstream.
 */
export function createRateLimit(setting: RateLimitSetting, now: () => Date): MiddlewareHandler {
  let windowIndex = -1;
  let used = 0;

  return async (c: Context, next) => {
    if (setting === "off") {
      await next();
      return;
    }

    const millis = now().getTime();
    const currentWindow = Math.floor(millis / WINDOW_MS);
    if (currentWindow !== windowIndex) {
      windowIndex = currentWindow;
      used = 0;
    }
    used += 1;

    if (used > setting) {
      const retryAfter = Math.max(1, Math.ceil(((currentWindow + 1) * WINDOW_MS - millis) / 1000));
      // Built here rather than thrown: the response carries a header, and the
      // error hook that renders thrown failures cannot preserve one.
      const response = apiError(
        c,
        429,
        "rate_limit_error",
        `rate limit exceeded: this organization is allowed ${setting} requests per minute`,
      );
      response.headers.set("retry-after", String(retryAfter));
      return response;
    }

    await next();
    return;
  };
}
