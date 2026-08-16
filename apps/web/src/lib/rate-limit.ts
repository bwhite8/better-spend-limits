/**
 * A small in-memory, per-key rate limiter (demo hardening).
 *
 * The app has no authentication of its own — on the public demo every visitor is
 * an admin (§G6 `AUTH_MODE=dev`). That is fine for *trying* the app and fatal for
 * *hammering* it: the write routes and admin actions each do real work (an API
 * round trip, a roster replace, a full sync), and nothing stopped one client
 * from calling them in a loop. This bounds that.
 *
 * It is deliberately process-local and unsynchronised: the Railway demo runs a
 * single replica, and a limiter that resets on redeploy is exactly right for a
 * demo. A multi-replica production fork that needs a shared limiter should put
 * one in its proxy — this is not that.
 *
 * The window is fixed, not sliding: the first request in a window starts a
 * `windowMs` clock, and the (limit+1)th request inside it is refused. Simple,
 * cheap, and more than enough to turn "thousands per minute" into "dozens".
 */

export interface RateLimitRule {
  /** Requests allowed within one window. */
  limit: number;
  /** Window length, in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets, for a `Retry-After` header. */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  /** Epoch ms at which this window ends and the count resets. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Cap on distinct keys held at once, so the limiter cannot itself become the
 * memory-growth vector it exists to prevent. When the map is full a sweep drops
 * every expired window; keys are IP-scoped, so the live set is naturally small.
 */
const MAX_TRACKED_KEYS = 10_000;

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Record one hit against `key` and say whether it is allowed.
 *
 * `now` is injectable so tests can advance the clock without waiting on it.
 */
export function rateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
  const existing = buckets.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    if (buckets.size >= MAX_TRACKED_KEYS) sweepExpired(now);
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { ok: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= rule.limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { ok: true, remaining: rule.limit - existing.count, retryAfterSeconds: 0 };
}

/** Drop all state. For tests only. */
export function __resetRateLimiter(): void {
  buckets.clear();
}

/**
 * Mutations a human performs by hand — set/clear a limit, approve/deny, save
 * admin settings. Thirty a minute is far past any real click rate and still
 * turns a write loop into a trickle.
 */
export const MUTATION_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60_000 };

/**
 * A full sync is the single most expensive thing an anonymous caller can ask
 * for (it pages the whole org and writes thousands of rows), so it gets its own,
 * tighter budget on top of the staleness gate in the route.
 */
export const SYNC_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60_000 };

/** Anything with a header getter — Web `Headers` or Next's `ReadonlyHeaders`. */
export interface HeadersLike {
  get(name: string): string | null | undefined;
}

/**
 * The caller's IP, as the trusted proxy reports it.
 *
 * Behind Railway's edge (and any standard reverse proxy) the real client is the
 * first entry of `x-forwarded-for`. This is spoofable by anything that can reach
 * the app *without* going through that proxy — which is the same trust the whole
 * `AUTH_MODE=proxy` model already rests on — so it is a throttle key, never an
 * identity. Everything with no usable header shares the `"unknown"` bucket.
 */
export function clientIp(headers: HeadersLike): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return "unknown";
}

/** `clientIp` for server actions, which get their headers from Next's store. */
export async function currentClientIp(): Promise<string> {
  // Lazy import so a unit test of `rateLimit` never drags Next in.
  const { headers } = await import("next/headers");
  return clientIp(await headers());
}
