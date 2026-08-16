/**
 * The demo-hardening limiter. Pure and clock-injectable, so these never wait.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetRateLimiter,
  clientIp,
  rateLimit,
  type RateLimitRule,
} from "./rate-limit";

const RULE: RateLimitRule = { limit: 3, windowMs: 1000 };

afterEach(() => {
  __resetRateLimiter();
});

describe("rateLimit", () => {
  it("allows up to `limit` hits in a window, then refuses", () => {
    const now = 10_000;
    expect(rateLimit("k", RULE, now).ok).toBe(true);
    expect(rateLimit("k", RULE, now).ok).toBe(true);
    expect(rateLimit("k", RULE, now).ok).toBe(true);

    const refused = rateLimit("k", RULE, now);
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it("counts down `remaining`", () => {
    const now = 0;
    expect(rateLimit("k", RULE, now).remaining).toBe(2);
    expect(rateLimit("k", RULE, now).remaining).toBe(1);
    expect(rateLimit("k", RULE, now).remaining).toBe(0);
  });

  it("resets once the window elapses", () => {
    const start = 0;
    rateLimit("k", RULE, start);
    rateLimit("k", RULE, start);
    rateLimit("k", RULE, start);
    expect(rateLimit("k", RULE, start).ok).toBe(false);

    // One past the window: a fresh budget.
    expect(rateLimit("k", RULE, start + RULE.windowMs).ok).toBe(true);
  });

  it("keys are independent — one caller cannot spend another's budget", () => {
    const now = 0;
    rateLimit("a", RULE, now);
    rateLimit("a", RULE, now);
    rateLimit("a", RULE, now);
    expect(rateLimit("a", RULE, now).ok).toBe(false);
    expect(rateLimit("b", RULE, now).ok).toBe(true);
  });
});

describe("clientIp", () => {
  const headersFrom = (map: Record<string, string>) => ({
    get: (name: string): string | null => map[name.toLowerCase()] ?? null,
  });

  it("takes the first hop of x-forwarded-for", () => {
    expect(clientIp(headersFrom({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(clientIp(headersFrom({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
  });

  it("shares one bucket when no IP header is present", () => {
    expect(clientIp(headersFrom({}))).toBe("unknown");
  });
});
