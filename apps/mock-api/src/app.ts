/**
 * The Hono app factory (plan §Phase 4).
 *
 * Exported rather than only served, so tests — here and in `apps/web`'s sync
 * suite — can drive the real routing stack through `app.request()` without a
 * socket. `server.ts` is the only place that binds a port.
 *
 * Configuration comes from explicit options first and the §G6 environment
 * second, so a test can pin the seed, the clock and the keys without touching
 * `process.env`.
 */

import { Hono } from "hono";

import { requireApiKey } from "./auth.js";
import { apiError, MockApiError } from "./errors.js";
import { createRateLimit, parseRateLimitSetting, type RateLimitSetting } from "./rate-limit.js";
import { createAnalyticsRoutes } from "./routes/analytics.js";
import { createIncreaseRequestRoutes } from "./routes/increase-requests.js";
import { createSpendLimitRoutes } from "./routes/spend-limits.js";
import { MockState } from "./state.js";

export const DEFAULT_ADMIN_KEY = "mock-admin-key";
export const DEFAULT_ANALYTICS_KEY = "mock-analytics-key";
export const DEFAULT_PORT = 8787;

export const SPEND_LIMITS_PATH = "/v1/organizations/spend_limits";
export const INCREASE_REQUESTS_PATH = "/v1/organizations/spend_limit_increase_requests";
export const ANALYTICS_PATH = "/v1/organizations/analytics";

export interface CreateAppOptions {
  /** Seed for the synthetic universe. Defaults to `MOCK_SEED`, else 42. */
  seed?: number;
  /**
   * Injectable clock, read on every time-dependent call. The universe is
   * generated once from the value at construction; later calls see the moving
   * clock, which is how a test advances time without reshaping the seed data.
   */
  now?: () => Date;
  /** Defaults to `MOCK_ADMIN_KEY`, else `"mock-admin-key"`. */
  adminKey?: string;
  /**
   * Defaults to `MOCK_ANALYTICS_KEY`, else `"mock-analytics-key"`. Deliberately
   * a DIFFERENT key from {@link CreateAppOptions.adminKey}: the analytics
   * surface takes its own credential and rejects the Admin key (§G5).
   */
  analyticsKey?: string;
  /** Defaults to `MOCK_RATE_LIMIT`, else off. */
  rateLimit?: RateLimitSetting;
  /** Pre-built state, when a test needs a handle on it. */
  state?: MockState;
}

function envSeed(): number | undefined {
  const raw = process.env.MOCK_SEED;
  if (raw === undefined || raw.trim() === "") return undefined;
  const seed = Number(raw);
  if (!Number.isFinite(seed)) throw new Error(`MOCK_SEED must be a number, got "${raw}"`);
  return seed;
}

/** Build the mock. Returns the app; reach the data through `options.state`. */
export function createApp(options: CreateAppOptions = {}): Hono {
  const now = options.now ?? ((): Date => new Date());
  const state = options.state ?? new MockState({ seed: options.seed ?? envSeed(), now });
  const adminKey = options.adminKey ?? process.env.MOCK_ADMIN_KEY ?? DEFAULT_ADMIN_KEY;
  const analyticsKey =
    options.analyticsKey ?? process.env.MOCK_ANALYTICS_KEY ?? DEFAULT_ANALYTICS_KEY;
  const rateLimit = options.rateLimit ?? parseRateLimitSetting(process.env.MOCK_RATE_LIMIT);

  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof MockApiError) {
      return apiError(c, error.status, error.errorType, error.message);
    }
    return apiError(c, 500, "api_error", error instanceof Error ? error.message : String(error));
  });

  app.notFound((c) =>
    apiError(
      c,
      404,
      "not_found_error",
      `${c.req.method} ${new URL(c.req.url).pathname} is not an endpoint on this mock`,
    ),
  );

  // Counted before authentication, matching a real edge limiter.
  app.use("*", createRateLimit(rateLimit, now));

  const spendLimits = new Hono();
  spendLimits.use("*", requireApiKey(adminKey, "Admin API"));
  spendLimits.route("/", createSpendLimitRoutes(state));
  app.route(SPEND_LIMITS_PATH, spendLimits);

  const increaseRequests = new Hono();
  increaseRequests.use("*", requireApiKey(adminKey, "Admin API"));
  increaseRequests.route("/", createIncreaseRequestRoutes(state));
  app.route(INCREASE_REQUESTS_PATH, increaseRequests);

  // Mounted with its own key, so presenting the Admin key here 401s exactly as
  // it would upstream.
  const analytics = new Hono();
  analytics.use("*", requireApiKey(analyticsKey, "Analytics API"));
  analytics.route("/", createAnalyticsRoutes(state));
  app.route(ANALYTICS_PATH, analytics);

  return app;
}
