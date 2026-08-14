/**
 * `x-api-key` authentication (plan §G4/§G6).
 *
 * The two surfaces this mock serves take DIFFERENT keys — the Admin key for
 * `/spend_limits*`, the Analytics key for the cost report — and they are not
 * interchangeable, so the middleware is parameterised by the key it expects and
 * mounted per subtree rather than globally.
 */

import type { MiddlewareHandler } from "hono";

import { MockApiError } from "./errors.js";

/** Reject any request whose `x-api-key` is missing or not `expectedKey`. */
export function requireApiKey(expectedKey: string, surface: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = c.req.header("x-api-key");
    if (presented === undefined || presented === "") {
      throw new MockApiError(401, "authentication_error", "missing x-api-key header");
    }
    if (presented !== expectedKey) {
      throw new MockApiError(
        401,
        "authentication_error",
        `invalid x-api-key: this endpoint requires the ${surface} key`,
      );
    }
    await next();
  };
}
