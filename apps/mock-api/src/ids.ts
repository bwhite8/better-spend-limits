/**
 * Anthropic-shaped resource identifiers.
 *
 * Real ids look like `spl_01AbCdEfGh` — a prefix, a version-ish `01`, then an
 * opaque suffix. Two flavours live here:
 *
 * - {@link sequentialApiId} is DETERMINISTIC: the same mock state always mints
 *   the same ids in the same order, so a test can restart the server and still
 *   talk about `spl_…` by value.
 * - {@link randomApiId} is not, and is only used for `request_id`s, which are
 *   per-response diagnostics that nothing may depend on.
 */

/** Crockford base32 — no I/L/O/U, so ids stay unambiguous when read aloud. */
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const SUFFIX_LENGTH = 10;

/** `sequentialApiId("spl", 0)` → `spl_010000000000`. */
export function sequentialApiId(prefix: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError(`sequentialApiId: ordinal must be a non-negative integer, got ${String(ordinal)}`);
  }
  let remaining = ordinal;
  let suffix = "";
  for (let index = 0; index < SUFFIX_LENGTH; index += 1) {
    suffix = ID_ALPHABET[remaining % ID_ALPHABET.length] + suffix;
    remaining = Math.floor(remaining / ID_ALPHABET.length);
  }
  return `${prefix}_01${suffix}`;
}

/** `randomApiId("req")` → `req_01…`. Diagnostics only — never a lookup key. */
export function randomApiId(prefix: string): string {
  let suffix = "";
  for (let index = 0; index < 22; index += 1) {
    suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${prefix}_01${suffix}`;
}
