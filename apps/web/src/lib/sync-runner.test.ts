/**
 * `ensureFreshSync` is what every server component awaits before it reads the
 * snapshot, and Next renders a layout and its page in PARALLEL — so "two
 * callers in the same tick" is the normal case, not an edge case. These tests
 * pin the two properties that makes safe:
 *
 * 1. exactly one sync runs, so the API's shared rate-limit budget is spent once;
 * 2. BOTH callers wait for it, so neither renders against a half-written table.
 *
 * The client is a stub rather than the in-process mock: what is under test here
 * is the coalescing, and a stub is the only way to count runs and to hold a run
 * open long enough for a second caller to arrive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { seedDatabase } from "@/db/seed";
import { syncState } from "@/db/schema";

import type { AnthropicClient } from "./anthropic/client";
import { ensureFreshSync } from "./sync-runner";
import { SYNC_RESOURCES } from "./sync";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.$client.close();
});

interface StubClient {
  client: AnthropicClient;
  /** How many times a full `syncAll` pass has started. */
  runs: number;
  /** Resolves the currently blocked call, letting the run finish. */
  release: () => void;
}

/**
 * A client that answers every list endpoint with an empty page, and blocks the
 * first call of each run until `release()` — which is what gives a second
 * caller a window to arrive while a sync is genuinely in flight.
 */
function stubClient({ block = false }: { block?: boolean } = {}): StubClient {
  let unblock: () => void = () => {};
  const gate = block ? new Promise<void>((resolve) => (unblock = resolve)) : Promise.resolve();

  const stub = {
    runs: 0,
    release: (): void => unblock(),
  } as StubClient;

  stub.client = {
    async listEffective() {
      stub.runs += 1;
      await gate;
      return { data: [], next_page: null };
    },
    async listIncreaseRequests() {
      return { data: [], next_page: null };
    },
    async userCostReport() {
      return { data: [], next_page: null, data_refreshed_at: new Date().toISOString() };
    },
  } as unknown as AnthropicClient;

  return stub;
}

describe("ensureFreshSync", () => {
  it("syncs when the snapshot has never been synced", async () => {
    const stub = stubClient();

    const result = await ensureFreshSync(db, { client: stub.client });

    expect(result?.ran).toBe(true);
    expect(stub.runs).toBe(1);
    for (const resource of SYNC_RESOURCES) {
      const row = db.select().from(syncState).all().find((r) => r.resource === resource);
      expect(row?.last_synced_at).not.toBeNull();
    }
  });

  it("does nothing while the snapshot is inside the staleness window", async () => {
    const first = stubClient();
    await ensureFreshSync(db, { client: first.client });

    const second = stubClient();
    const result = await ensureFreshSync(db, { client: second.client });

    expect(result).toBeNull();
    expect(second.runs).toBe(0);
  });

  it("coalesces concurrent callers onto one run and makes both wait for it", async () => {
    const stub = stubClient({ block: true });

    const layout = ensureFreshSync(db, { client: stub.client });
    const page = ensureFreshSync(db, { client: stub.client });

    // The second caller must NOT have resolved yet: resolving early is exactly
    // the bug that let a page render against an unsynced table.
    const settledEarly = await Promise.race([
      page.then(() => "settled"),
      Promise.resolve().then(() => "pending"),
    ]);
    expect(settledEarly).toBe("pending");

    stub.release();
    const [layoutResult, pageResult] = await Promise.all([layout, page]);

    expect(stub.runs).toBe(1);
    expect(layoutResult?.ran).toBe(true);
    // Same promise, so the same outcome object — not a second `ran: false`.
    expect(pageResult).toBe(layoutResult);
  });

  it("allows a later run once the previous one has settled", async () => {
    const first = stubClient();
    await ensureFreshSync(db, { client: first.client });

    const second = stubClient();
    await ensureFreshSync(db, { client: second.client, force: true });

    expect(second.runs).toBe(1);
  });

  it("never rejects when the sync throws — a dead API is not a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      listEffective(): never {
        throw new Error("boom");
      },
    } as unknown as AnthropicClient;

    // syncAll records per-resource failures itself, so this resolves with an
    // unsuccessful run rather than throwing.
    await expect(ensureFreshSync(db, { client })).resolves.not.toThrow();
    spy.mockRestore();
  });
});
