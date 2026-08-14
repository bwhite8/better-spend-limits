import { describe, expect, it } from "vitest";

import { CURSOR_PREFIX, decodeCursor, encodeCursor, hashListParams } from "./cursor";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a payload", () => {
    const payload = { offset: 100, paramsHash: hashListParams({ user_ids: ["a", "b"] }) };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("round-trips the first page", () => {
    const payload = { offset: 0, paramsHash: hashListParams({}) };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("produces an opaque page_ token that is URL-safe", () => {
    const cursor = encodeCursor({ offset: 40, paramsHash: hashListParams({ period: "monthly" }) });
    expect(cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    expect(cursor).toMatch(/^page_[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it("rejects a non-integer or negative offset", () => {
    expect(() => encodeCursor({ offset: -1, paramsHash: "x" })).toThrow(RangeError);
    expect(() => encodeCursor({ offset: 1.5, paramsHash: "x" })).toThrow(RangeError);
  });

  it.each(["", "page_", "page_!!!!", "not-a-cursor", "page_" + btoa("[]"), "page_" + btoa("{}")])(
    "returns null for the unreadable cursor %o",
    (cursor) => {
      expect(decodeCursor(cursor)).toBeNull();
    },
  );
});

describe("hashListParams", () => {
  it("distinguishes different filter values", () => {
    expect(hashListParams({ user_ids: ["a", "b"] })).not.toBe(hashListParams({ user_ids: ["a"] }));
    expect(hashListParams({ status: ["pending"] })).not.toBe(
      hashListParams({ status: ["approved"] }),
    );
  });

  it("distinguishes a filtered query from an unfiltered one", () => {
    expect(hashListParams({ user_ids: ["a"] })).not.toBe(hashListParams({}));
  });

  it("is stable regardless of key order", () => {
    expect(hashListParams({ user_ids: ["a"], period: ["monthly"] })).toBe(
      hashListParams({ period: ["monthly"], user_ids: ["a"] }),
    );
  });

  it("is stable regardless of the order of repeated values", () => {
    expect(hashListParams({ user_ids: ["b", "a"] })).toBe(hashListParams({ user_ids: ["a", "b"] }));
  });

  it("treats absent, null and empty-array filters as the same query", () => {
    const empty = hashListParams({});
    expect(hashListParams({ user_ids: undefined })).toBe(empty);
    expect(hashListParams({ user_ids: null })).toBe(empty);
    expect(hashListParams({ user_ids: [] })).toBe(empty);
  });

  it("normalises a single value to the equivalent one-element list", () => {
    expect(hashListParams({ period: "monthly" })).toBe(hashListParams({ period: ["monthly"] }));
    expect(hashListParams({ limit: 100 })).toBe(hashListParams({ limit: "100" }));
  });

  it("does not confuse one key's values with another's", () => {
    expect(hashListParams({ user_ids: ["a"], status: ["b"] })).not.toBe(
      hashListParams({ user_ids: ["b"], status: ["a"] }),
    );
  });

  it("is a short, stable hex digest", () => {
    expect(hashListParams({ user_ids: ["a", "b"] })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("cursor binding", () => {
  it("detects a cursor replayed under different filters", () => {
    const issuedUnder = { user_ids: undefined, period: undefined };
    const cursor = encodeCursor({ offset: 100, paramsHash: hashListParams(issuedUnder) });

    const replayed = decodeCursor(cursor);
    expect(replayed?.paramsHash).toBe(hashListParams({}));
    expect(replayed?.paramsHash).not.toBe(hashListParams({ user_ids: ["user_01"] }));
  });
});
