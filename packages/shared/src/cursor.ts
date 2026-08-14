/**
 * Pagination cursor helpers (plan §G4 "Cross-cutting rules").
 *
 * The Anthropic list endpoints hand back an opaque `next_page` token, and that
 * token is BOUND TO THE QUERY PARAMETERS THAT ISSUED IT: replaying a cursor
 * with different `user_ids[]` / `period[]` / `status[]` / `actor_ids[]` is a
 * 400. We model that by encoding `{offset, paramsHash}` into the token — the
 * mock (issuer) compares the embedded hash against the incoming request's
 * filters, and the client (consumer) only ever passes tokens straight back.
 *
 * No Node-only APIs here (base64 via `btoa`/`atob`, hashing in pure JS) so the
 * module stays importable from any bundle target.
 */

export interface CursorPayload {
  /** Zero-based index of the first row on the page this cursor addresses. */
  offset: number;
  /** {@link hashListParams} of the filters the cursor was issued under. */
  paramsHash: string;
}

/** Real cursors look like `page_...`; we keep the shape for fidelity. */
export const CURSOR_PREFIX = "page_";

/**
 * The exact message the API returns when a cursor is replayed under different
 * filters. Shared so the mock emits it and the client can recognise it.
 */
export const CURSOR_MISMATCH_MESSAGE = "cursor does not match current query parameters";

/** Value shapes a list query parameter can take before normalisation. */
export type ListParamValue = string | string[] | number | null | undefined;

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a 64-bit, hex. Not cryptographic — this only detects filter changes. */
function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}

/** Encode `{offset, paramsHash}` into an opaque `page_<base64url>` token. */
export function encodeCursor(payload: CursorPayload): string {
  const { offset, paramsHash } = payload;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`Cursor offset must be a non-negative integer, got ${String(offset)}`);
  }
  return CURSOR_PREFIX + toBase64Url(JSON.stringify({ o: offset, h: paramsHash }));
}

/**
 * Decode a cursor. Returns `null` for anything unreadable so callers can answer
 * with their own 400 rather than crashing on attacker-supplied input.
 */
export function decodeCursor(cursor: string): CursorPayload | null {
  if (typeof cursor !== "string" || cursor === "") return null;
  const body = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : cursor;
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(body));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const { o: offset, h: paramsHash } = decoded as { o?: unknown; h?: unknown };
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
  if (typeof paramsHash !== "string") return null;
  return { offset, paramsHash };
}

/**
 * Stable hash of a list query's filters.
 *
 * Normalisation: `undefined`/`null` and empty arrays are dropped (an absent
 * filter and an empty one are the same query), single values become one-element
 * arrays, array members and keys are sorted — so neither key order nor the
 * order of repeated `user_ids[]` params changes the hash.
 */
export function hashListParams(params: Record<string, ListParamValue>): string {
  const canonical: [string, string[]][] = [];
  for (const key of Object.keys(params).sort()) {
    const raw = params[key];
    if (raw === undefined || raw === null) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).map((value) => String(value));
    if (values.length === 0) continue;
    canonical.push([key, [...values].sort()]);
  }
  return fnv1a64(JSON.stringify(canonical));
}
