/**
 * Phase 14 verification — the contract drift detector.
 *
 * The script's whole value is that it fails when the API stops matching the
 * schemas, so the test that matters is the negative one: a deliberately mangled
 * response must produce FAIL and a non-zero exit code. The positive path runs
 * against the real mock over real HTTP (the Phase-8 harness), because a stubbed
 * fetch would agree with whatever the script happened to ask for.
 */

import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { getFixtureOrg } from "@bsl/seed";
import { createApp, DEFAULT_ADMIN_KEY, DEFAULT_ANALYTICS_KEY, MockState } from "mock-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EffectiveSpendLimitRowSchema, IncreaseRequestSchema } from "@bsl/shared";

import {
  DEFAULT_MOCK_BASE_URL,
  DRY_RUN_ADMIN_KEY,
  endpointChecks,
  formatReport,
  isLocalBaseUrl,
  main,
  readOnlyFetch,
  resolveVerifyConfig,
  unknownFieldPaths,
  verifyRealApi,
  type VerifyConfig,
} from "@/scripts/verify-real-api";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface MockServer {
  baseUrl: string;
  close(): Promise<void>;
}

/** The real mock on an ephemeral port — same shape as the Phase-8 harness. */
async function startMock(): Promise<MockServer> {
  const now = () => new Date();
  const state = new MockState({ org: getFixtureOrg(), now });
  const app = createApp({
    state,
    now,
    adminKey: DEFAULT_ADMIN_KEY,
    analyticsKey: DEFAULT_ANALYTICS_KEY,
    rateLimit: "off",
  });

  let server: ServerType | undefined;
  const info = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, resolve);
  });
  const handle = server as ServerType;

  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        (handle as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        handle.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

let mock: MockServer;

beforeAll(async () => {
  mock = await startMock();
});

afterAll(async () => {
  await mock.close();
});

function dryRunEnv(): Record<string, string> {
  return { ANTHROPIC_BASE_URL: mock.baseUrl };
}

function collect(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

/**
 * A fetch that damages one field of one row on its way back.
 *
 * `amount` is a decimal STRING on the wire (§G9); turning it into a number is
 * exactly the kind of drift the script exists to catch, and it is invisible to
 * anything that does not parse.
 */
function manglingFetch(target: string): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? "");
    if (!url.includes(target)) return response;

    const body = (await response.json()) as { data: Record<string, unknown>[] };
    body.data[0] = { ...body.data[0], amount: 12_345, brand_new_field: "surprise" };
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * A fetch that adds things the schemas do not name but happily accept: a new
 * envelope key and a new `source.type` member. Both are open-set drift — the
 * script must surface them without calling the run a failure.
 */
function driftingFetch(target: string): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? "");
    if (!url.includes(target)) return response;

    const body = (await response.json()) as { data: Record<string, unknown>[] };
    body.data[0] = { ...body.data[0], source: { type: "budget_pool", budget_pool_id: "bp_1" } };
    return new Response(JSON.stringify({ ...body, total_count: 250 }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

function dryRunConfig(overrides: Partial<VerifyConfig> = {}): VerifyConfig {
  const resolved = resolveVerifyConfig(["--dry-run"], dryRunEnv());
  if (!resolved.ok) throw new Error(resolved.message);
  return { ...resolved.config, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Config resolution and refusals                                             */
/* -------------------------------------------------------------------------- */

describe("resolveVerifyConfig", () => {
  it("refuses a localhost base URL without --dry-run or --force", () => {
    const resolved = resolveVerifyConfig([], { ANTHROPIC_BASE_URL: "http://localhost:8787" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.exitCode).toBe(2);
    expect(resolved.message).toContain("Refusing to run");
  });

  it("allows a localhost base URL with --force", () => {
    const resolved = resolveVerifyConfig(["--force"], {
      ANTHROPIC_BASE_URL: "http://localhost:8787",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.baseUrl).toBe("http://localhost:8787");
    expect(resolved.config.dryRun).toBe(false);
  });

  it("defaults to the real API when nothing is configured", () => {
    const resolved = resolveVerifyConfig([], {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.baseUrl).toBe("https://api.anthropic.com");
  });

  it("--dry-run ignores a real base URL and a real key", () => {
    const resolved = resolveVerifyConfig(["--dry-run"], {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_ADMIN_KEY: "sk-ant-admin-REAL",
      ANTHROPIC_ANALYTICS_KEY: "sk-ant-analytics-REAL",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.baseUrl).toBe(DEFAULT_MOCK_BASE_URL);
    expect(resolved.config.adminKey).toBe(DRY_RUN_ADMIN_KEY);
    expect(resolved.config.analyticsKey).not.toContain("REAL");
  });

  it("--dry-run keeps a local base URL so an ephemeral mock port works", () => {
    const resolved = resolveVerifyConfig(["--dry-run"], dryRunEnv());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.baseUrl).toBe(mock.baseUrl);
  });

  it("refuses an unknown flag rather than guessing", () => {
    const resolved = resolveVerifyConfig(["--dryrun"], {});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.exitCode).toBe(2);
    expect(resolved.message).toContain("Unknown flag");
  });

  it("--help exits 0 without running anything", async () => {
    const { lines, write } = collect();
    await expect(main({ argv: ["--help"], env: {}, write })).resolves.toBe(0);
    expect(lines.join("\n")).toContain("Usage: npm run verify:api");
  });

  it("recognises the local hostnames", () => {
    expect(isLocalBaseUrl("http://localhost:8787")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(isLocalBaseUrl("not a url")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only guarantee                                                        */
/* -------------------------------------------------------------------------- */

describe("readOnlyFetch", () => {
  it("passes GET through and refuses everything else", async () => {
    const seen: string[] = [];
    const inner: typeof globalThis.fetch = async (_input, init) => {
      seen.push(String(init?.method ?? "GET"));
      return new Response("{}", { status: 200 });
    };
    const guarded = readOnlyFetch(inner);

    await expect(guarded("https://example.invalid/", { method: "GET" })).resolves.toBeInstanceOf(
      Response,
    );
    await expect(guarded("https://example.invalid/", { method: "POST" })).rejects.toThrow(
      /read-only/,
    );
    await expect(guarded("https://example.invalid/", { method: "delete" })).rejects.toThrow(
      /read-only/,
    );
    expect(seen).toEqual(["GET"]);
  });

  it("only ever asks the API for GETs", async () => {
    const methods: string[] = [];
    const spy: typeof globalThis.fetch = async (input, init) => {
      methods.push(String(init?.method ?? "GET"));
      return globalThis.fetch(input, init);
    };

    await verifyRealApi(dryRunConfig({ fetch: spy }));
    expect(methods).toHaveLength(endpointChecks().length);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });
});

/* -------------------------------------------------------------------------- */
/* Unknown-field detection                                                    */
/* -------------------------------------------------------------------------- */

describe("unknownFieldPaths", () => {
  const row = {
    scope: { type: "user", user_id: "user_1" },
    actor: {
      type: "user_actor",
      user_id: "user_1",
      name: "Jane Smith",
      email_address: "jane@example.com",
      deleted: false,
    },
    amount: "50000",
    currency: "USD",
    period: "monthly",
    source: { type: "seat_tier", seat_tier: "enterprise_standard" },
    spend_limit_id: "spl_1",
    period_to_date_spend: "31402.5",
  };

  it("finds nothing in a row that matches the contract", () => {
    expect(unknownFieldPaths(row, EffectiveSpendLimitRowSchema)).toEqual([]);
  });

  it("reports a new top-level field", () => {
    expect(unknownFieldPaths({ ...row, budget_pool_id: "pool_1" }, EffectiveSpendLimitRowSchema))
      .toEqual(["budget_pool_id"]);
  });

  it("reports a new nested field with its dotted path", () => {
    const drifted = { ...row, actor: { ...row.actor, department: "Research" } };
    expect(unknownFieldPaths(drifted, EffectiveSpendLimitRowSchema)).toEqual(["actor.department"]);
  });

  it("descends into the union branch that actually matched", () => {
    const drifted = { ...row, source: { type: "rbac_group", rbac_group_id: "g1", tenure: 3 } };
    expect(unknownFieldPaths(drifted, EffectiveSpendLimitRowSchema)).toEqual(["source.tenure"]);
  });

  it("looks inside a nullable sub-object", () => {
    const request = {
      type: "spend_limit_increase_request",
      id: "slir_1",
      status: "pending",
      actor: row.actor,
      created_at: "2026-08-01T00:00:00.000Z",
      resolved_at: null,
      spend_summary: {
        amount: "50000",
        currency: "USD",
        period: "monthly",
        period_to_date_spend: "10",
        justification: "needs more headroom",
      },
    };
    expect(unknownFieldPaths(request, IncreaseRequestSchema)).toEqual([
      "spend_summary.justification",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The dry-run PASS path                                                      */
/* -------------------------------------------------------------------------- */

describe("verify:api --dry-run against the mock", () => {
  it("passes all three endpoints and exits 0", async () => {
    const { lines, write } = collect();
    const code = await main({ argv: ["--dry-run"], env: dryRunEnv(), write });

    expect(code).toBe(0);
    const output = lines.join("\n");
    const passes = output.match(/\bPASS\b/g) ?? [];
    // Three endpoint rows plus the summary line.
    expect(passes).toHaveLength(4);
    expect(output).toContain("spend_limits/effective");
    expect(output).toContain("spend_limit_increase_requests");
    expect(output).toContain("analytics/user_cost_report");
    expect(output).not.toContain("FAIL");
  });

  it("checks real rows, not an empty envelope", async () => {
    const report = await verifyRealApi(dryRunConfig());

    expect(report.ok).toBe(true);
    const byName = new Map(report.endpoints.map((endpoint) => [endpoint.name, endpoint]));
    expect(byName.get("spend_limits/effective")?.rowsChecked).toBe(100);
    expect(byName.get("spend_limit_increase_requests")?.rowsChecked).toBe(12);
    expect(byName.get("analytics/user_cost_report")?.rowsChecked).toBeGreaterThan(0);
    for (const endpoint of report.endpoints) {
      expect(endpoint.parseErrors).toEqual([]);
      expect(endpoint.unknownFields).toEqual([]);
      expect(endpoint.unknownEnumValues).toEqual([]);
      expect(endpoint.error).toBeNull();
    }
  });

  it("routes each surface to its own key — a wrong analytics key fails only that row", async () => {
    const report = await verifyRealApi(dryRunConfig({ analyticsKey: "not-the-analytics-key" }));

    expect(report.ok).toBe(false);
    const analytics = report.endpoints.find((e) => e.name === "analytics/user_cost_report");
    expect(analytics?.status).toBe("fail");
    expect(analytics?.error).toContain("authentication_error");
    expect(report.endpoints.filter((e) => e.status === "pass")).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The corrupted-response FAIL path                                           */
/* -------------------------------------------------------------------------- */

describe("verify:api against a drifted API", () => {
  it("fails, names the offending field, and exits 1", async () => {
    const { lines, write } = collect();
    const code = await main({
      argv: ["--dry-run"],
      env: dryRunEnv(),
      fetch: manglingFetch("/spend_limits/effective"),
      write,
    });

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("data[0] → amount");
    // The unrecognised field is reported alongside, not instead of, the failure.
    expect(output).toContain("brand_new_field");
    // The other two endpoints are untouched and still pass.
    expect(output).toContain("spend_limit_increase_requests");
  });

  it("marks only the drifted endpoint as failing", async () => {
    const report = await verifyRealApi(
      dryRunConfig({ fetch: manglingFetch("/spend_limits/effective") }),
    );

    expect(report.ok).toBe(false);
    const effective = report.endpoints.find((e) => e.name === "spend_limits/effective");
    expect(effective?.status).toBe("fail");
    expect(effective?.parseErrors.join(" ")).toContain("amount");
    expect(effective?.unknownFields).toContain("brand_new_field");
    expect(report.endpoints.filter((e) => e.status === "pass")).toHaveLength(2);
  });

  it("reports open-set drift as news, not failure, and still exits 0", async () => {
    const { lines, write } = collect();
    const code = await main({
      argv: ["--dry-run"],
      env: dryRunEnv(),
      fetch: driftingFetch("/spend_limits/effective"),
      write,
    });

    // The schemas are loose and open by design, so all of this parses.
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).not.toContain("FAIL");
    // A new envelope key, a new nested field, and a new open-enum member.
    expect(output).toContain("total_count");
    expect(output).toContain("source.budget_pool_id");
    expect(output).toContain("source.type=budget_pool");
    expect(output).toContain("worth a look");
  });

  it("reports an unreachable API instead of throwing", async () => {
    const report = await verifyRealApi({
      ...dryRunConfig(),
      baseUrl: "http://127.0.0.1:1",
    });

    expect(report.ok).toBe(false);
    expect(report.endpoints).toHaveLength(3);
    for (const endpoint of report.endpoints) {
      expect(endpoint.error).not.toBeNull();
      expect(endpoint.status).toBe("fail");
    }
    expect(formatReport(report)).toContain("FAIL");
  });
});
