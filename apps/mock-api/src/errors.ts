/**
 * The standard Anthropic error envelope (plan §G4 "Cross-cutting rules").
 *
 * Handlers signal failures by THROWING {@link MockApiError}; the app's
 * `onError` hook turns it into the envelope below. That keeps route code free
 * of response plumbing and guarantees every failure — including ones raised
 * inside middleware — carries a `request_id` like the real API does.
 */

import type { Context } from "hono";

import type { ApiErrorType, ErrorEnvelope } from "@bsl/shared";

import { randomApiId } from "./ids.js";

/** Statuses this mock can produce. Hono needs a body-bearing status here. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

/**
 * A failure with an HTTP status and an Anthropic error type. Thrown from
 * anywhere in a request; rendered once by the app's error hook.
 */
export class MockApiError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly errorType: ApiErrorType,
    message: string,
  ) {
    super(message);
    this.name = "MockApiError";
  }
}

/** Build the wire body. A fresh `request_id` per response, as upstream does. */
export function errorEnvelope(errorType: ApiErrorType, message: string): ErrorEnvelope {
  return {
    type: "error",
    error: { type: errorType, message },
    request_id: randomApiId("req"),
  };
}

/** Respond with an error envelope. */
export function apiError(
  c: Context,
  status: ApiErrorStatus,
  errorType: ApiErrorType,
  message: string,
): Response {
  return c.json(errorEnvelope(errorType, message), status);
}
