/**
 * Who is making this request (§G8).
 *
 * Two modes, chosen by `AUTH_MODE` (§G6):
 *
 * - `proxy` — production. An SSO reverse proxy authenticates the user and
 *   forwards their email in `AUTH_HEADER` (default `x-forwarded-email`). The app
 *   trusts that header completely, which is only safe because the proxy is the
 *   sole route to the app; deployment docs (Phase 14) must say so.
 * - `dev` — demos. The email comes from the `bsl_impersonate` cookie that the
 *   user switcher sets. Anyone can become anyone, deliberately.
 *
 * Either way the email is lowercased and looked up in `employees`. **No matching
 * row means no access** — the caller renders the "not provisioned" 403 page.
 * There is no implicit fallback identity: a mistyped header must never silently
 * resolve to somebody.
 *
 * The resolution logic takes header/cookie stores as plain arguments rather than
 * calling `next/headers` itself, so it is testable without a request context.
 * `currentEmployee()` is the thin Next-aware wrapper over it, and it imports
 * `next/headers` lazily so unit tests never pull the framework in.
 */

import { eq } from "drizzle-orm";

import { getDb, type AppDatabase } from "@/db/client";
import { employees, type Employee } from "@/db/schema";

/** Cookie the dev-mode user switcher writes. */
export const IMPERSONATION_COOKIE = "bsl_impersonate";

/** §G6 default for `AUTH_HEADER`. */
export const DEFAULT_AUTH_HEADER = "x-forwarded-email";

/** How long a dev-mode impersonation cookie lives: 30 days. */
export const IMPERSONATION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const AUTH_MODES = ["dev", "proxy"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Anything with `get(name)` returning a header value — including Next's `ReadonlyHeaders`. */
export interface HeadersLike {
  get(name: string): string | null | undefined;
}

/** Next's cookie store returns `{ name, value }`; a plain string is accepted too. */
export type CookieLike = string | { value?: string | null } | null | undefined;

export interface CookiesLike {
  get(name: string): CookieLike;
}

type EnvLike = Record<string, string | undefined>;

/**
 * `AUTH_MODE`, defaulting to `dev` (§G6).
 *
 * An unrecognised value throws rather than falling back. Falling back to `dev`
 * would turn a typo in a production environment file into "any visitor may
 * impersonate any employee"; falling back to `proxy` would lock a developer out
 * with no explanation. Failing loudly is the only honest option.
 */
export function resolveAuthMode(env: EnvLike = process.env): AuthMode {
  const raw = env.AUTH_MODE?.trim().toLowerCase();
  if (!raw) return "dev";
  if ((AUTH_MODES as readonly string[]).includes(raw)) return raw as AuthMode;

  throw new Error(
    `AUTH_MODE must be one of ${AUTH_MODES.join(" | ")} — got ${JSON.stringify(env.AUTH_MODE)}`,
  );
}

/** The header carrying the authenticated email in proxy mode (lowercased for lookup). */
export function resolveAuthHeaderName(env: EnvLike = process.env): string {
  const raw = env.AUTH_HEADER?.trim();
  return raw ? raw.toLowerCase() : DEFAULT_AUTH_HEADER;
}

/** Trim + lowercase; empty and missing both become `null`. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function cookieValue(cookie: CookieLike): string | null {
  if (cookie == null) return null;
  return typeof cookie === "string" ? cookie : (cookie.value ?? null);
}

/**
 * The email the request claims to be, before any lookup. `null` when the header
 * or cookie is missing — that is "not signed in", not an error.
 */
export function resolveCurrentEmail(
  headersLike: HeadersLike | null | undefined,
  cookiesLike: CookiesLike | null | undefined,
  env: EnvLike = process.env,
): string | null {
  if (resolveAuthMode(env) === "proxy") {
    return normaliseEmail(headersLike?.get(resolveAuthHeaderName(env)));
  }
  return normaliseEmail(cookieValue(cookiesLike?.get(IMPERSONATION_COOKIE)));
}

/** The employee with this email, or `null`. Email matching is case-insensitive. */
export function findEmployeeByEmail(db: AppDatabase, email: string | null | undefined): Employee | null {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;

  return db.select().from(employees).where(eq(employees.email, normalised)).get() ?? null;
}

/**
 * The signed-in employee, or `null` when the request carries no identity or the
 * email matches nobody on the roster (§G8: render the 403 "not provisioned"
 * page — do NOT fall back to a default user).
 */
export function resolveCurrentEmployee(
  db: AppDatabase,
  headersLike: HeadersLike | null | undefined,
  cookiesLike: CookiesLike | null | undefined,
  env: EnvLike = process.env,
): Employee | null {
  return findEmployeeByEmail(db, resolveCurrentEmail(headersLike, cookiesLike, env));
}

/**
 * `resolveCurrentEmployee` for server components and route handlers: pulls the
 * request's headers and cookies out of Next's async storage.
 */
export async function currentEmployee(db: AppDatabase = getDb()): Promise<Employee | null> {
  // Lazy so that importing this module from a unit test does not drag in Next.
  const { cookies, headers } = await import("next/headers");
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);

  return resolveCurrentEmployee(db, headerStore, cookieStore);
}

function assertDevMode(operation: string, env: EnvLike): void {
  const mode = resolveAuthMode(env);
  if (mode !== "dev") {
    throw new Error(
      `${operation} is only available when AUTH_MODE=dev; identity comes from the SSO proxy in ${mode} mode.`,
    );
  }
}

/**
 * Become `email` for subsequent requests (dev mode only).
 *
 * The email is not checked against the roster on purpose: impersonating an
 * unknown address is the only way to see what an unprovisioned user sees.
 *
 * Callable from a server action or route handler — nowhere else can set cookies.
 */
export async function setImpersonation(email: string, env: EnvLike = process.env): Promise<void> {
  assertDevMode("setImpersonation", env);

  const normalised = normaliseEmail(email);
  if (!normalised) throw new Error("setImpersonation: an email address is required");

  const { cookies } = await import("next/headers");
  (await cookies()).set(IMPERSONATION_COOKIE, normalised, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: IMPERSONATION_MAX_AGE_SECONDS,
  });
}

/** Drop the impersonation cookie (dev mode only). */
export async function clearImpersonation(env: EnvLike = process.env): Promise<void> {
  assertDevMode("clearImpersonation", env);

  const { cookies } = await import("next/headers");
  (await cookies()).delete(IMPERSONATION_COOKIE);
}
