/**
 * `npm run verify:api` — the contract drift detector (plan Phase 14).
 *
 * Every read this app performs is parsed through the Zod schemas in
 * `@bsl/shared`, and every demo runs against a mock that those same schemas
 * describe. That is a closed loop: if Anthropic changes the wire shape, the mock
 * keeps agreeing with us and nothing tells you until production reads start
 * failing. This script breaks the loop by pointing the real client at the real
 * API and checking the answers against the schemas, row by row.
 *
 * Three properties make it safe to run against a live organisation:
 *
 * 1. **Read-only by construction.** The client's `fetch` is wrapped so that a
 *    non-GET request throws before it reaches the network — see
 *    {@link readOnlyFetch}. Nothing here can create, approve, or delete
 *    anything.
 * 2. **It refuses to run against localhost by accident.** Verifying the mock
 *    against schemas the mock was built from proves nothing, so a localhost base
 *    URL is rejected unless you passed `--dry-run` (which deliberately targets
 *    the mock, for CI) or `--force`.
 * 3. **`--dry-run` never transmits a real key.** It substitutes the mock's base
 *    URL and the mock's keys, ignoring `ANTHROPIC_ADMIN_KEY` and
 *    `ANTHROPIC_ANALYTICS_KEY` entirely.
 *
 * Exit codes: `0` every endpoint parsed, `1` something failed to parse or the
 * call errored, `2` the invocation itself was refused (bad flag, localhost
 * without `--dry-run`/`--force`).
 *
 * Unknown FIELDS and unknown open-enum MEMBERS are reported but do not fail the
 * run: the schemas are deliberately loose and open, so those are advance notice
 * of a change rather than a break. A parse failure is a break.
 */

import { pathToFileURL } from "node:url";

import {
  EffectiveSpendLimitListSchema,
  EffectiveSpendLimitRowSchema,
  IncreaseRequestListSchema,
  IncreaseRequestSchema,
  KNOWN_ACTOR_TYPES,
  KNOWN_INCREASE_REQUEST_STATUSES,
  KNOWN_SOURCE_TYPES,
  KNOWN_SPEND_LIMIT_PERIODS,
  UserCostReportEnvelopeSchema,
  UserCostRowSchema,
} from "@bsl/shared";

import {
  ANALYTICS_PATH,
  AnthropicApiError,
  AnthropicClient,
  AnthropicConfigError,
  DEFAULT_ANTHROPIC_BASE_URL,
  INCREASE_REQUESTS_PATH,
  SPEND_LIMITS_PATH,
  type QueryValue,
} from "../lib/anthropic/client";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Where `--dry-run` points when the environment does not already name a local mock. */
export const DEFAULT_MOCK_BASE_URL = "http://localhost:8787";

/** Mock credentials (§G6). `--dry-run` uses these so a real key is never sent. */
export const DRY_RUN_ADMIN_KEY = "mock-admin-key";
export const DRY_RUN_ANALYTICS_KEY = "mock-analytics-key";

/** One page is enough to detect a shape change, and it is one request each. */
export const DEFAULT_ROW_LIMIT = 100;

/** Cost window, in days. Matches the plan's "7-day window". */
export const DEFAULT_COST_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const USAGE = `Usage: npm run verify:api [-- <flags>]

Reads (never writes) three endpoints of the configured Anthropic API and checks
every row against the wire schemas in @bsl/shared.

  --dry-run   Target the local mock instead of the real API, with the mock's own
              keys. Intended for CI; proves the script works, not that the real
              contract holds.
  --force     Allow a localhost ANTHROPIC_BASE_URL without --dry-run.
  --help      Show this message.

Environment: ANTHROPIC_BASE_URL, ANTHROPIC_ADMIN_KEY, ANTHROPIC_ANALYTICS_KEY.
Note that a real ANTHROPIC_BASE_URL exported in your shell overrides
apps/web/.env.development — check the "Base URL" line this script prints.`;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type EnvLike = Record<string, string | undefined>;

interface ParseIssue {
  path: PropertyKey[];
  message: string;
}

/** Structural stand-in for a Zod schema, so this file needs no `zod` import. */
interface Validator {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: ParseIssue[] } };
}

/** An open-enum field worth watching: a new member parses fine but is news. */
interface EnumWatch {
  /** Dotted path within a row, e.g. `source.type`. */
  path: string;
  known: readonly string[];
}

export interface EndpointReport {
  /** Short label used in the table. */
  name: string;
  method: "GET";
  path: string;
  status: "pass" | "fail";
  /** Rows returned by the first page and checked individually. */
  rowsChecked: number;
  /** Envelope- or row-level schema violations. Non-empty means `fail`. */
  parseErrors: string[];
  /** Fields the API sent that no schema knows about (informational). */
  unknownFields: string[];
  /** Open-enum members we have never seen before (informational). */
  unknownEnumValues: string[];
  /** Transport or API-level failure, when the call never produced a body. */
  error: string | null;
  durationMs: number;
}

export interface VerifyReport {
  baseUrl: string;
  dryRun: boolean;
  startedAt: string;
  endpoints: EndpointReport[];
  /** True only when every endpoint passed. */
  ok: boolean;
}

export interface VerifyConfig {
  baseUrl: string;
  adminKey?: string;
  analyticsKey?: string;
  dryRun: boolean;
  limit: number;
  costWindowDays: number;
  now: () => Date;
  fetch?: typeof globalThis.fetch;
}

export type ResolveResult =
  | { ok: true; config: VerifyConfig }
  | { ok: false; exitCode: number; message: string };

/* -------------------------------------------------------------------------- */
/* Read-only enforcement                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a `fetch` so only GET escapes.
 *
 * This is belt-and-braces — the checks below issue nothing else — but it is the
 * difference between "we reviewed the code and it only reads" and "it cannot
 * write". Someone will eventually add a fourth check; this makes the safe thing
 * the default.
 */
export function readOnlyFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const fromRequest = typeof input === "object" && input !== null && "method" in input
      ? String((input as { method?: unknown }).method ?? "GET")
      : "GET";
    const method = String(init?.method ?? fromRequest).toUpperCase();
    if (method !== "GET") {
      throw new Error(
        `verify:api is read-only and refused a ${method} request. This script must never mutate an organisation.`,
      );
    }
    return inner(input, init);
  };
}

/* -------------------------------------------------------------------------- */
/* Schema introspection — unknown-field detection                             */
/* -------------------------------------------------------------------------- */

interface SchemaDef {
  type?: string;
  shape?: Record<string, unknown>;
  options?: unknown[];
  innerType?: unknown;
  element?: unknown;
  in?: unknown;
}

/** Zod 4 keeps its definition under `_zod.def`; read it without an `any` cast. */
function defOf(schema: unknown): SchemaDef | null {
  if (typeof schema !== "object" || schema === null) return null;
  const zod = (schema as { _zod?: unknown })._zod;
  if (typeof zod !== "object" || zod === null) return null;
  const def = (zod as { def?: unknown }).def;
  if (typeof def !== "object" || def === null) return null;
  return def as SchemaDef;
}

const WRAPPERS = new Set([
  "nullable",
  "optional",
  "default",
  "prefault",
  "readonly",
  "nonoptional",
  "catch",
]);

/** Peel wrappers (`.nullable()`, `.default()`, the openEnum pipe) off a schema. */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 16; depth += 1) {
    const def = defOf(current);
    if (!def?.type) return current;
    if (WRAPPERS.has(def.type) && def.innerType !== undefined) {
      current = def.innerType;
      continue;
    }
    // `openEnum` is `z.string().transform(...)`, i.e. a pipe; its input side is
    // what describes the wire value.
    if (def.type === "pipe" && def.in !== undefined) {
      current = def.in;
      continue;
    }
    return current;
  }
  return current;
}

/** Every object shape a schema could accept — one per union branch. */
function objectShapes(schema: unknown): Record<string, unknown>[] {
  const inner = unwrapSchema(schema);
  const def = defOf(inner);
  if (!def) return [];
  if (def.type === "object" && def.shape) return [def.shape];
  if (def.type === "union" && Array.isArray(def.options)) return def.options.flatMap(objectShapes);
  return [];
}

/**
 * One shape covering every branch, used to pick the child schema to recurse
 * into.
 *
 * Selecting the branch that actually `safeParse`d would be more precise, but no
 * union in `@bsl/shared` has branches whose shared keys carry DIFFERENT nested
 * objects (`scope` and `source` differ only in scalars), so the merged shape is
 * exact today — and it is the same key set the unknown-field check already uses.
 * If a union ever grows divergent nested objects, revisit this.
 */
function mergedShape(schema: unknown): Record<string, unknown> | null {
  const shapes = objectShapes(schema);
  if (shapes.length === 0) return null;
  return Object.assign({}, ...shapes) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dotted paths of fields present in `value` that the schema does not name.
 *
 * The schemas are `.loose()` on purpose, so these parse cleanly — which is
 * exactly why they need reporting. A new field is the earliest visible sign
 * that the contract has moved.
 */
export function unknownFieldPaths(value: unknown, schema: unknown, prefix = ""): string[] {
  const found: string[] = [];
  walkUnknown(value, schema, prefix, found);
  return found;
}

function walkUnknown(value: unknown, schema: unknown, prefix: string, found: string[]): void {
  const inner = unwrapSchema(schema);
  const def = defOf(inner);

  if (Array.isArray(value)) {
    if (def?.type === "array" && def.element !== undefined) {
      value.forEach((entry, index) => {
        walkUnknown(entry, def.element, `${prefix}[${index}]`, found);
      });
    }
    return;
  }

  if (!isPlainObject(value)) return;

  const shapes = objectShapes(inner);
  if (shapes.length === 0) return;

  const known = new Set(shapes.flatMap((shape) => Object.keys(shape)));
  const shape = mergedShape(inner);

  for (const key of Object.keys(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (!known.has(key)) {
      found.push(path);
      continue;
    }
    const child = shape?.[key];
    if (child !== undefined) walkUnknown(value[key], child, path, found);
  }
}

/** Read a dotted path out of a parsed row, tolerating anything missing. */
function valueAtPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* The three checks                                                           */
/* -------------------------------------------------------------------------- */

interface EndpointCheck {
  name: string;
  path: string;
  query: (config: VerifyConfig) => Record<string, QueryValue>;
  envelope: Validator;
  row: Validator;
  enums: EnumWatch[];
}

/**
 * GET-only, first page only (§G4/§G5). Read the plan's endpoint list before
 * adding a fourth: anything that mutates belongs somewhere else entirely.
 */
export function endpointChecks(): EndpointCheck[] {
  return [
    {
      name: "spend_limits/effective",
      path: `${SPEND_LIMITS_PATH}/effective`,
      query: (config) => ({ limit: config.limit }),
      envelope: EffectiveSpendLimitListSchema as unknown as Validator,
      row: EffectiveSpendLimitRowSchema as unknown as Validator,
      enums: [
        { path: "source.type", known: KNOWN_SOURCE_TYPES },
        { path: "period", known: KNOWN_SPEND_LIMIT_PERIODS },
        { path: "actor.type", known: KNOWN_ACTOR_TYPES },
      ],
    },
    {
      name: "spend_limit_increase_requests",
      path: INCREASE_REQUESTS_PATH,
      query: (config) => ({ limit: config.limit }),
      envelope: IncreaseRequestListSchema as unknown as Validator,
      row: IncreaseRequestSchema as unknown as Validator,
      enums: [
        { path: "status", known: KNOWN_INCREASE_REQUEST_STATUSES },
        { path: "actor.type", known: KNOWN_ACTOR_TYPES },
      ],
    },
    {
      name: "analytics/user_cost_report",
      path: `${ANALYTICS_PATH}/user_cost_report`,
      query: (config) => ({
        starting_at: new Date(
          config.now().getTime() - config.costWindowDays * MS_PER_DAY,
        ).toISOString(),
        bucket_width: "1d",
        limit: config.limit,
      }),
      envelope: UserCostReportEnvelopeSchema as unknown as Validator,
      row: UserCostRowSchema as unknown as Validator,
      enums: [],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Running the checks                                                         */
/* -------------------------------------------------------------------------- */

/** Identity parser: the client's job here is transport, not validation. */
const RAW: { parse: (value: unknown) => unknown } = { parse: (value) => value };

function issueText(issue: ParseIssue): string {
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

function describeError(error: unknown): string {
  if (error instanceof AnthropicApiError) {
    const requestId = error.requestId ? ` (request_id ${error.requestId})` : "";
    return `HTTP ${error.status} ${error.errorType}: ${error.message}${requestId}`;
  }
  if (error instanceof AnthropicConfigError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function runCheck(
  check: EndpointCheck,
  client: AnthropicClient,
  config: VerifyConfig,
): Promise<EndpointReport> {
  const startedAt = Date.now();
  const report: EndpointReport = {
    name: check.name,
    method: "GET",
    path: check.path,
    status: "pass",
    rowsChecked: 0,
    parseErrors: [],
    unknownFields: [],
    unknownEnumValues: [],
    error: null,
    durationMs: 0,
  };

  let body: unknown;
  try {
    const result = await client.send({
      method: "GET",
      path: check.path,
      query: check.query(config),
      schema: RAW,
    });
    body = result.data;
  } catch (error) {
    report.error = describeError(error);
    report.status = "fail";
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  const envelope = check.envelope.safeParse(body);
  if (!envelope.success) {
    for (const issue of envelope.error.issues.slice(0, 10)) {
      report.parseErrors.push(`envelope → ${issueText(issue)}`);
    }
  }

  // Pull rows off the RAW body: when the envelope failed we still want to know
  // which row caused it, and a parsed envelope would have coerced defaults in.
  const rows =
    isPlainObject(body) && Array.isArray(body.data) ? (body.data as unknown[]) : ([] as unknown[]);
  report.rowsChecked = rows.length;

  const unknownFields = new Set<string>();
  const unknownEnums = new Set<string>();

  rows.forEach((row, index) => {
    const parsed = check.row.safeParse(row);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 5)) {
        report.parseErrors.push(`data[${index}] → ${issueText(issue)}`);
      }
    }
    for (const path of unknownFieldPaths(row, check.row)) unknownFields.add(path);
    for (const watch of check.enums) {
      const observed = valueAtPath(row, watch.path);
      if (typeof observed === "string" && !watch.known.includes(observed)) {
        unknownEnums.add(`${watch.path}=${observed}`);
      }
    }
  });

  // Envelope-level unknowns (a new `data_refreshed_at` sibling, say) matter too.
  if (isPlainObject(body)) {
    const knownEnvelopeKeys = new Set(
      objectShapes(check.envelope).flatMap((shape) => Object.keys(shape)),
    );
    for (const key of Object.keys(body)) {
      if (!knownEnvelopeKeys.has(key)) unknownFields.add(key);
    }
  }

  report.unknownFields = [...unknownFields].sort();
  report.unknownEnumValues = [...unknownEnums].sort();
  // Unknown fields and unknown enum members are open-set news, not breakage.
  report.status = report.parseErrors.length === 0 ? "pass" : "fail";
  report.durationMs = Date.now() - startedAt;
  return report;
}

/** Run all three checks. Never throws — every failure lands in the report. */
export async function verifyRealApi(config: VerifyConfig): Promise<VerifyReport> {
  const client = new AnthropicClient({
    baseUrl: config.baseUrl,
    adminKey: config.adminKey,
    analyticsKey: config.analyticsKey,
    fetch: readOnlyFetch(config.fetch ?? globalThis.fetch),
    // A drift check should report a 429 rather than sit in a backoff loop.
    maxRetries: 0,
    // Nothing here reads the ambient environment; the caller resolved it already.
    env: {},
  });

  const endpoints: EndpointReport[] = [];
  for (const check of endpointChecks()) {
    endpoints.push(await runCheck(check, client, config));
  }

  return {
    baseUrl: config.baseUrl,
    dryRun: config.dryRun,
    startedAt: config.now().toISOString(),
    endpoints,
    ok: endpoints.every((endpoint) => endpoint.status === "pass"),
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Turn flags plus environment into a config, or into a refusal.
 *
 * The refusals are the point of this function: an unknown flag (a mistyped
 * `--dry-run` is the obvious one) and a localhost base URL both stop the run
 * rather than quietly doing the wrong thing to the wrong organisation.
 */
export function resolveVerifyConfig(argv: string[], env: EnvLike = {}): ResolveResult {
  const flags = new Set(argv.filter((arg) => arg.startsWith("-")));
  const unknown = [...flags].filter(
    (flag) => !["--dry-run", "--force", "--help", "-h"].includes(flag),
  );
  if (unknown.length > 0) {
    return { ok: false, exitCode: 2, message: `Unknown flag(s): ${unknown.join(", ")}\n\n${USAGE}` };
  }
  if (flags.has("--help") || flags.has("-h")) {
    return { ok: false, exitCode: 0, message: USAGE };
  }

  const dryRun = flags.has("--dry-run");
  const force = flags.has("--force");
  const configured = env.ANTHROPIC_BASE_URL?.trim();

  if (dryRun) {
    // Point at a mock, whatever the environment says. An ambient real base URL
    // must not turn a CI smoke test into a live API call.
    const baseUrl = configured && isLocalBaseUrl(configured) ? configured : DEFAULT_MOCK_BASE_URL;
    return {
      ok: true,
      config: {
        baseUrl,
        adminKey: env.MOCK_ADMIN_KEY?.trim() || DRY_RUN_ADMIN_KEY,
        analyticsKey: env.MOCK_ANALYTICS_KEY?.trim() || DRY_RUN_ANALYTICS_KEY,
        dryRun: true,
        limit: DEFAULT_ROW_LIMIT,
        costWindowDays: DEFAULT_COST_WINDOW_DAYS,
        now: () => new Date(),
      },
    };
  }

  const baseUrl = configured && configured !== "" ? configured : DEFAULT_ANTHROPIC_BASE_URL;
  if (isLocalBaseUrl(baseUrl) && !force) {
    return {
      ok: false,
      exitCode: 2,
      message:
        `Refusing to run: ANTHROPIC_BASE_URL is ${baseUrl}, which is local.\n` +
        "Checking the mock against the schemas the mock was built from proves nothing.\n" +
        "Use --dry-run to smoke-test the script against the mock, or --force if you\n" +
        "really are pointing at a real API behind a local proxy.",
    };
  }

  return {
    ok: true,
    config: {
      baseUrl,
      adminKey: env.ANTHROPIC_ADMIN_KEY?.trim() || undefined,
      analyticsKey: env.ANTHROPIC_ANALYTICS_KEY?.trim() || undefined,
      dryRun: false,
      limit: DEFAULT_ROW_LIMIT,
      costWindowDays: DEFAULT_COST_WINDOW_DAYS,
      now: () => new Date(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push("better-spend-limits — API contract check");
  lines.push(`  Base URL  ${report.baseUrl}${report.dryRun ? "  (dry run — local mock)" : ""}`);
  lines.push(`  Started   ${report.startedAt}`);
  lines.push("");

  const nameWidth = Math.max(8, ...report.endpoints.map((endpoint) => endpoint.name.length));
  lines.push(`${pad("ENDPOINT", nameWidth)}  RESULT  ROWS  NOTES`);
  for (const endpoint of report.endpoints) {
    const notes: string[] = [];
    if (endpoint.error) notes.push(endpoint.error);
    if (endpoint.parseErrors.length > 0) {
      notes.push(`${endpoint.parseErrors.length} parse error(s)`);
    }
    if (endpoint.unknownFields.length > 0) {
      notes.push(`${endpoint.unknownFields.length} unknown field(s)`);
    }
    if (endpoint.unknownEnumValues.length > 0) {
      notes.push(`${endpoint.unknownEnumValues.length} unknown enum value(s)`);
    }
    lines.push(
      [
        pad(endpoint.name, nameWidth),
        pad(endpoint.status.toUpperCase(), 6),
        pad(String(endpoint.rowsChecked), 4),
        notes.length === 0 ? "—" : notes.join("; "),
      ].join("  "),
    );
  }

  for (const endpoint of report.endpoints) {
    const hasDetail =
      endpoint.parseErrors.length > 0 ||
      endpoint.unknownFields.length > 0 ||
      endpoint.unknownEnumValues.length > 0;
    if (!hasDetail) continue;

    lines.push("");
    lines.push(`${endpoint.name} — GET ${endpoint.path}`);
    for (const detail of endpoint.parseErrors) lines.push(`  parse error  ${detail}`);
    for (const field of endpoint.unknownFields) lines.push(`  new field    ${field}`);
    for (const value of endpoint.unknownEnumValues) lines.push(`  new value    ${value}`);
  }

  lines.push("");
  if (report.ok) {
    const drift = report.endpoints.some(
      (endpoint) => endpoint.unknownFields.length > 0 || endpoint.unknownEnumValues.length > 0,
    );
    lines.push(
      drift
        ? "PASS — every row matched the wire contract. The new fields/values above parse\n       cleanly (the schemas are open by design) but are worth a look."
        : "PASS — every row matched the wire contract.",
    );
  } else {
    lines.push(
      "FAIL — the API no longer matches the schemas in packages/shared.\n" +
        "       Update the schemas AND apps/mock-api together, then re-run.",
    );
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export interface MainOptions {
  argv?: string[];
  env?: EnvLike;
  /** Injectable for tests; wrapped in {@link readOnlyFetch} before use. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  write?: (line: string) => void;
}

/** Returns the process exit code; never throws and never calls `process.exit`. */
export async function main(options: MainOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const resolved = resolveVerifyConfig(options.argv ?? [], options.env ?? {});

  if (!resolved.ok) {
    write(resolved.message);
    return resolved.exitCode;
  }

  const config: VerifyConfig = {
    ...resolved.config,
    now: options.now ?? resolved.config.now,
    fetch: options.fetch,
  };

  const report = await verifyRealApi(config);
  write(formatReport(report));
  return report.ok ? 0 : 1;
}

// Run only when executed directly (`tsx src/scripts/verify-real-api.ts`).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main({ argv: process.argv.slice(2), env: process.env })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`[verify:api] unexpected failure: ${describeError(error)}`);
      process.exitCode = 1;
    });
}
