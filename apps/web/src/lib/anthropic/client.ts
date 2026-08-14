/**
 * The Anthropic API client (plan §G4 / §G5).
 *
 * A deliberately thin wrapper over `fetch`. It owns four things and nothing
 * else, because everything it does is on the critical path of a production
 * write:
 *
 * 1. **Two keys, one base URL.** The spend-limits surface authenticates with the
 *    Admin key; `/analytics/*` authenticates with the Analytics key and REJECTS
 *    the Admin key (§G5). The surface is a property of the endpoint, not of the
 *    caller, so it is chosen here rather than passed in.
 * 2. **Contract parsing.** Every success body goes through the shared Zod
 *    schemas, so a shape drift is caught at the boundary instead of surfacing as
 *    `undefined` three layers down.
 * 3. **Typed failures.** A non-2xx response is parsed as the standard error
 *    envelope and thrown as {@link AnthropicApiError}, carrying the `request_id`
 *    that makes an incident reconcilable against Anthropic's own logs.
 * 4. **A single, polite retry.** The org shares a 60 req/min budget across every
 *    endpoint (§G4), so a 429 is answered by waiting out `retry-after` once —
 *    never by fanning out or hammering.
 *
 * List parameters use BRACKET notation (`user_ids[]=a&user_ids[]=b`); a bare
 * `user_ids=` is silently ignored by the API, so array values are serialised
 * with the brackets automatically.
 */

import {
  EffectiveSpendLimitListSchema,
  ErrorEnvelopeSchema,
  IncreaseRequestListSchema,
  IncreaseRequestSchema,
  SpendLimitSchema,
  UserCostReportEnvelopeSchema,
  type EffectiveSpendLimitRow,
  type IncreaseRequest,
  type ListEnvelope,
  type SpendLimit,
  type UserCostReportEnvelope,
} from "@bsl/shared";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Version header the Admin and Analytics surfaces both require. */
export const ANTHROPIC_VERSION = "2023-06-01";

export const SPEND_LIMITS_PATH = "/v1/organizations/spend_limits";
export const INCREASE_REQUESTS_PATH = "/v1/organizations/spend_limit_increase_requests";
export const ANALYTICS_PATH = "/v1/organizations/analytics";

/** Largest page the list endpoints accept (§G4). Sync always asks for it. */
export const MAX_PAGE_LIMIT = 100;

/** Which credential an endpoint takes. The two are NOT interchangeable (§G5). */
export type ApiSurface = "admin" | "analytics";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A non-2xx answer from the API, with the error envelope unpacked.
 *
 * `errorType` is the API's own classification (`authentication_error`,
 * `rate_limit_error`, …) and is what callers should branch on — the HTTP status
 * is coarser and, for `invalid_request_error`, ambiguous between 400 and 409.
 */
export class AnthropicApiError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly requestId: string | null;
  /** The raw body, kept for diagnostics when it did not match the envelope. */
  readonly body: string | null;

  constructor(init: {
    status: number;
    errorType: string;
    message: string;
    requestId?: string | null;
    body?: string | null;
  }) {
    super(init.message);
    this.name = "AnthropicApiError";
    this.status = init.status;
    this.errorType = init.errorType;
    this.requestId = init.requestId ?? null;
    this.body = init.body ?? null;
  }
}

/**
 * The API answered 2xx with a body that does not match the wire contract.
 *
 * Distinct from {@link AnthropicApiError} on purpose: that one means "the API
 * said no", this one means "the API said yes in a shape we do not understand",
 * and the two want different responses from an operator.
 */
export class AnthropicResponseError extends Error {
  readonly url: string;
  readonly requestId: string | null;

  constructor(message: string, init: { url: string; requestId?: string | null; cause?: unknown }) {
    super(message, { cause: init.cause });
    this.name = "AnthropicResponseError";
    this.url = init.url;
    this.requestId = init.requestId ?? null;
  }
}

/** Raised before any network call when the key for a surface is not configured. */
export class AnthropicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicConfigError";
  }
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

type EnvLike = Record<string, string | undefined>;

/** Anything with Zod's `parse` shape; avoids a direct `zod` dependency here. */
interface Parser<TValue> {
  parse(value: unknown): TValue;
}

export type QueryValue = string | number | boolean | string[] | null | undefined;

export interface AnthropicClientOptions {
  /** §G6 `ANTHROPIC_BASE_URL`. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** §G6 `ANTHROPIC_ADMIN_KEY` — the spend-limits surface. */
  adminKey?: string;
  /** §G6 `ANTHROPIC_ANALYTICS_KEY` — the analytics surface. */
  analyticsKey?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Retries after a 429/5xx. Defaults to 1 — one polite retry, then give up. */
  maxRetries?: number;
  /** Injectable delay so a retry test does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound on an honoured `retry-after`, so a hostile header cannot hang a request. */
  maxRetryDelayMs?: number;
  /** Read only for the values not passed explicitly. */
  env?: EnvLike;
}

/** A response body plus the metadata worth auditing. */
export interface ApiResult<TData> {
  data: TData;
  /** Upstream `request-id` header, when the API sent one. */
  requestId: string | null;
  status: number;
}

export interface ListEffectiveParams {
  limit?: number;
  page?: string | null;
  user_ids?: string[];
  period?: string[];
}

export interface ListIncreaseRequestsParams {
  limit?: number;
  page?: string | null;
  status?: string[];
  actor_ids?: string[];
}

export interface UserCostReportParams {
  starting_at: string;
  ending_at?: string;
  bucket_width?: string;
  limit?: number;
  page?: string | null;
}

const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Serialise a query, dropping empty values and expanding arrays into the
 * bracket notation the API expects. An empty array is dropped rather than sent
 * as `key[]=`, because "no filter" and "filter on nothing" are different queries
 * and only the former is what the caller meant.
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(`${key}[]`, entry);
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * `retry-after` in milliseconds: a delta-seconds count or an HTTP date, both of
 * which the spec allows. Anything unparseable — or in the past — yields `null`
 * so the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (raw === "") return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export class AnthropicClient {
  private readonly baseUrl: string;
  private readonly keys: Record<ApiSurface, string | undefined>;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetryDelayMs: number;

  constructor(options: AnthropicClientOptions = {}) {
    const env = options.env ?? process.env;

    this.baseUrl = (options.baseUrl ?? env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL).replace(
      /\/+$/,
      "",
    );
    // Keys are captured but NOT validated here: an app that only reads costs
    // should not fail to start because the Admin key is absent. The check
    // happens when a call actually needs the key.
    this.keys = {
      admin: options.adminKey ?? env.ANTHROPIC_ADMIN_KEY,
      analytics: options.analyticsKey ?? env.ANTHROPIC_ANALYTICS_KEY,
    };
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 1;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  /** Which credential a path takes. Analytics is its own surface (§G5). */
  static surfaceFor(path: string): ApiSurface {
    return path.startsWith(ANALYTICS_PATH) ? "analytics" : "admin";
  }

  private keyFor(surface: ApiSurface): string {
    const key = this.keys[surface];
    if (!key) {
      const variable = surface === "analytics" ? "ANTHROPIC_ANALYTICS_KEY" : "ANTHROPIC_ADMIN_KEY";
      throw new AnthropicConfigError(
        `${variable} is not set; the ${surface} surface cannot be called without it (§G6)`,
      );
    }
    return key;
  }

  /**
   * One request, with parsing, error unwrapping and a single retry.
   *
   * Public because it is the escape hatch for anything the typed methods below
   * do not cover — notably a caller that wants the upstream `request_id` of a
   * successful write for its audit row.
   */
  async send<TData>(init: {
    method: string;
    path: string;
    query?: Record<string, QueryValue>;
    body?: unknown;
    schema: Parser<TData>;
  }): Promise<ApiResult<TData>> {
    const surface = AnthropicClient.surfaceFor(init.path);
    const key = this.keyFor(surface);
    const url = `${this.baseUrl}${init.path}${buildQuery(init.query ?? {})}`;

    const headers: Record<string, string> = {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      accept: "application/json",
    };
    const requestInit: RequestInit = { method: init.method, headers };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      requestInit.body = JSON.stringify(init.body);
    }

    let attempt = 0;
    for (;;) {
      const response = await this.doFetch(url, requestInit);
      const requestId = response.headers.get("request-id");

      if (response.ok) {
        const text = await response.text();
        // 204/empty bodies parse as `undefined`; schemas that tolerate it (the
        // DELETE tombstone) accept that, the rest fail loudly.
        const payload: unknown = text.trim() === "" ? undefined : safeJson(text, url, requestId);
        try {
          return { data: init.schema.parse(payload), requestId, status: response.status };
        } catch (cause) {
          throw new AnthropicResponseError(
            `${init.method} ${init.path} returned ${response.status} with a body that does not match the wire contract: ${describe(cause)}`,
            { url, requestId, cause },
          );
        }
      }

      const error = await this.toApiError(response, url, requestId);

      const canRetry = attempt < this.maxRetries && RETRYABLE_STATUSES.has(response.status);
      if (!canRetry) throw error;

      const delay = Math.min(
        parseRetryAfter(response.headers.get("retry-after")) ?? backoffMs(attempt),
        this.maxRetryDelayMs,
      );
      await this.sleep(delay);
      attempt += 1;
    }
  }

  private async toApiError(
    response: Response,
    url: string,
    requestId: string | null,
  ): Promise<AnthropicApiError> {
    const body = await response.text().catch(() => "");
    let errorType = `http_${response.status}`;
    let message = `${response.status} ${response.statusText || "error"} from ${url}`;
    let envelopeRequestId: string | null = null;

    if (body.trim() !== "") {
      try {
        const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(body));
        if (parsed.success) {
          errorType = parsed.data.error.type;
          message = parsed.data.error.message;
          envelopeRequestId = parsed.data.request_id;
        }
      } catch {
        // Not JSON — keep the status-derived message and the raw body.
      }
    }

    return new AnthropicApiError({
      status: response.status,
      errorType,
      message,
      requestId: requestId ?? envelopeRequestId,
      body: body === "" ? null : body,
    });
  }

  /* --- Spend limits (§G4 endpoints 1–4) ------------------------------- */

  /** One resolved row per current member. */
  async listEffective(
    params: ListEffectiveParams = {},
  ): Promise<ListEnvelope<EffectiveSpendLimitRow>> {
    const result = await this.send({
      method: "GET",
      path: `${SPEND_LIMITS_PATH}/effective`,
      query: {
        limit: params.limit,
        page: params.page,
        user_ids: params.user_ids,
        period: params.period,
      },
      schema: EffectiveSpendLimitListSchema,
    });
    return result.data;
  }

  /** One configured limit row by id. */
  async getSpendLimit(id: string): Promise<SpendLimit> {
    const result = await this.send({
      method: "GET",
      path: `${SPEND_LIMITS_PATH}/${encodeURIComponent(id)}`,
      schema: SpendLimitSchema,
    });
    return result.data;
  }

  /**
   * Create or replace a member's per-user override. Upsert is keyed on
   * (scope, period), so repeating this call keeps the same `spend_limit_id`.
   *
   * There is no way to write "unlimited": removing the override with
   * {@link deleteSpendLimit} is how a member goes back to inheriting (§G4).
   */
  async setUserLimit(userId: string, amount: string): Promise<SpendLimit> {
    const result = await this.send({
      method: "POST",
      path: SPEND_LIMITS_PATH,
      body: { scope: { type: "user", user_id: userId }, amount },
      schema: SpendLimitSchema,
    });
    return result.data;
  }

  /** Remove a per-user override; the member falls back to what they inherit. */
  async deleteSpendLimit(id: string): Promise<void> {
    await this.send({
      method: "DELETE",
      path: `${SPEND_LIMITS_PATH}/${encodeURIComponent(id)}`,
      // Anthropic's delete endpoints are documented loosely and the mock answers
      // with a tombstone; nothing downstream needs the body, so accept anything.
      schema: { parse: () => undefined },
    });
  }

  /* --- Increase requests (§G4 endpoints 5–8) --------------------------- */

  /** Most recent first. Omit `status` to page every status. */
  async listIncreaseRequests(
    params: ListIncreaseRequestsParams = {},
  ): Promise<ListEnvelope<IncreaseRequest>> {
    const result = await this.send({
      method: "GET",
      path: INCREASE_REQUESTS_PATH,
      query: {
        limit: params.limit,
        page: params.page,
        status: params.status,
        actor_ids: params.actor_ids,
      },
      schema: IncreaseRequestListSchema,
    });
    return result.data;
  }

  async getIncreaseRequest(id: string): Promise<IncreaseRequest> {
    const result = await this.send({
      method: "GET",
      path: `${INCREASE_REQUESTS_PATH}/${encodeURIComponent(id)}`,
      schema: IncreaseRequestSchema,
    });
    return result.data;
  }

  /**
   * Approve at `amount` — requests carry no requested amount, the approver
   * supplies one. This writes the same override `setUserLimit` writes AND
   * resolves the request; approving a non-pending request conflicts (§G4).
   */
  async approveRequest(
    id: string,
    amount: string,
    suppressNotification = true,
  ): Promise<IncreaseRequest> {
    const result = await this.send({
      method: "POST",
      path: `${INCREASE_REQUESTS_PATH}/${encodeURIComponent(id)}/approve`,
      body: { amount, suppress_notification: suppressNotification },
      schema: IncreaseRequestSchema,
    });
    return result.data;
  }

  /** Deny. Idempotent on an already-denied request; conflicts on an approved one. */
  async denyRequest(id: string, suppressNotification = true): Promise<IncreaseRequest> {
    const result = await this.send({
      method: "POST",
      path: `${INCREASE_REQUESTS_PATH}/${encodeURIComponent(id)}/deny`,
      body: { suppress_notification: suppressNotification },
      schema: IncreaseRequestSchema,
    });
    return result.data;
  }

  /* --- Analytics (§G5) -------------------------------------------------- */

  /**
   * Cost per member (no `bucket_width`) or per member per day (`1d`).
   *
   * The envelope's `data_refreshed_at` is a freshness watermark: rows dated
   * after it are provisional and will be revised. Callers must persist it.
   */
  async userCostReport(params: UserCostReportParams): Promise<UserCostReportEnvelope> {
    const result = await this.send({
      method: "GET",
      path: `${ANALYTICS_PATH}/user_cost_report`,
      query: {
        starting_at: params.starting_at,
        ending_at: params.ending_at,
        bucket_width: params.bucket_width,
        limit: params.limit,
        page: params.page,
      },
      schema: UserCostReportEnvelopeSchema,
    });
    return result.data;
  }
}

/** Exponential backoff used when the API sends no `retry-after`. */
function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

function safeJson(text: string, url: string, requestId: string | null): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AnthropicResponseError(`${url} returned a body that is not JSON`, {
      url,
      requestId,
      cause,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The client configured from the environment (§G6). */
export function createAnthropicClient(options: AnthropicClientOptions = {}): AnthropicClient {
  return new AnthropicClient(options);
}
