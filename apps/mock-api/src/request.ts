/**
 * Request-shaped helpers shared by every route: list pagination and JSON body
 * reading, both of which have to fail exactly the way the real API fails.
 *
 * The pagination rule worth remembering (§G4): a `next_page` cursor is BOUND to
 * the filters that issued it. We encode a hash of those filters into the token
 * and reject a replay under different filters with a 400 — the mock is the only
 * place that check can be exercised before hitting production.
 */

import type { Context } from "hono";

import {
  CURSOR_MISMATCH_MESSAGE,
  decodeCursor,
  encodeCursor,
  hashListParams,
  type ListParamValue,
} from "@bsl/shared";

import { MockApiError } from "./errors.js";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PageRequest {
  limit: number;
  offset: number;
  /** Hash of the filters this page was requested under; re-issued in cursors. */
  paramsHash: string;
}

/**
 * Read `limit` + `page` and validate the cursor against `filters` — the list
 * parameters that participate in cursor binding (NOT `limit`, which callers may
 * legitimately change mid-sequence).
 */
export function readPageRequest(c: Context, filters: Record<string, ListParamValue>): PageRequest {
  const paramsHash = hashListParams(filters);

  let limit = DEFAULT_PAGE_LIMIT;
  const rawLimit = c.req.query("limit");
  if (rawLimit !== undefined && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `limit: expected an integer between 1 and ${MAX_PAGE_LIMIT}, got "${rawLimit}"`,
      );
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new MockApiError(
        400,
        "invalid_request_error",
        `limit: expected an integer between 1 and ${MAX_PAGE_LIMIT}, got ${limit}`,
      );
    }
  }

  let offset = 0;
  const rawPage = c.req.query("page");
  if (rawPage !== undefined && rawPage !== "") {
    const cursor = decodeCursor(rawPage);
    if (cursor === null) {
      throw new MockApiError(400, "invalid_request_error", "page: not a valid pagination cursor");
    }
    if (cursor.paramsHash !== paramsHash) {
      throw new MockApiError(400, "invalid_request_error", CURSOR_MISMATCH_MESSAGE);
    }
    offset = cursor.offset;
  }

  return { limit, offset, paramsHash };
}

/** Slice `rows` for a page and mint the follow-on cursor (null on the last page). */
export function pageOf<TRow>(
  rows: readonly TRow[],
  page: PageRequest,
): { data: TRow[]; next_page: string | null } {
  const data = rows.slice(page.offset, page.offset + page.limit);
  const nextOffset = page.offset + data.length;
  return {
    data,
    next_page:
      nextOffset < rows.length ? encodeCursor({ offset: nextOffset, paramsHash: page.paramsHash }) : null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a JSON object body. An EMPTY body is `{}` rather than an error, because
 * `POST …/deny` is legitimately callable with no body at all; anything present
 * but unparseable is a 400.
 */
export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new MockApiError(400, "invalid_request_error", "body: could not be read");
  }
  if (text.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MockApiError(400, "invalid_request_error", "body: could not be parsed as JSON");
  }
  if (!isRecord(parsed)) {
    throw new MockApiError(400, "invalid_request_error", "body: expected a JSON object");
  }
  return parsed;
}

/** Minor units on the wire are non-negative decimal STRINGS — never numbers (§G9). */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Validate a written amount. Writes cannot express "unlimited" — that is what
 * `DELETE /spend_limits/{id}` is for — so `null` is rejected here on purpose.
 */
export function requireAmountString(value: unknown, field: string): string {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value)) {
    throw new MockApiError(
      400,
      "invalid_request_error",
      `${field}: expected a non-negative decimal string in minor units (e.g. "75000"), got ${JSON.stringify(value) ?? "undefined"}`,
    );
  }
  return value;
}
