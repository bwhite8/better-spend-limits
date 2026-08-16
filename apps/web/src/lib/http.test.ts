/**
 * `readLimitedJson` is the guard that keeps a multi-gigabyte POST from being
 * buffered whole. These prove it parses small bodies and refuses large ones,
 * whether the size is declared honestly or hidden behind a chunked stream.
 */

import { describe, expect, it } from "vitest";

import { BodyTooLargeError, MAX_JSON_BODY_BYTES, readLimitedJson } from "./http";

const post = (body: BodyInit, headers?: Record<string, string>): Request =>
  new Request("http://test/api", { method: "POST", body, headers });

describe("readLimitedJson", () => {
  it("parses a small JSON body", async () => {
    const result = await readLimitedJson(post(JSON.stringify({ amount: "75000" })));
    expect(result).toEqual({ amount: "75000" });
  });

  it("returns null for an empty body", async () => {
    expect(await readLimitedJson(post(""))).toBeNull();
  });

  it("returns null for unparseable JSON, matching the old catch(() => null)", async () => {
    expect(await readLimitedJson(post("not json"))).toBeNull();
  });

  it("rejects a body whose Content-Length exceeds the cap, without reading it", async () => {
    const request = post("{}", { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
    await expect(readLimitedJson(request)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("rejects an oversize body even when Content-Length lies", async () => {
    const oversized = "x".repeat(MAX_JSON_BODY_BYTES + 100);
    // A ReadableStream carries no Content-Length, so only the streaming guard
    // can catch this.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const request = new Request("http://test/api", {
      method: "POST",
      body: stream,
      // @ts-expect-error — duplex is required for a streaming body in undici.
      duplex: "half",
    });
    await expect(readLimitedJson(request)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("accepts a body exactly at the cap", async () => {
    const payload = JSON.stringify({ pad: "y".repeat(MAX_JSON_BODY_BYTES - 20) });
    expect(payload.length).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES);
    const result = (await readLimitedJson(post(payload))) as { pad: string };
    expect(result.pad.length).toBe(MAX_JSON_BODY_BYTES - 20);
  });
});
