/**
 * §G8 identity resolution: proxy header vs dev impersonation cookie.
 *
 * The header/cookie stores are stubbed with the same shape Next's `headers()`
 * and `cookies()` return, so nothing here needs a request context.
 */

import { FIXTURE } from "@bsl/seed";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { seedDatabase } from "@/db/seed";

import {
  clearImpersonation,
  DEFAULT_AUTH_HEADER,
  DEFAULT_DEV_EMAIL_VAR,
  findEmployeeByEmail,
  IMPERSONATION_COOKIE,
  normaliseEmail,
  resolveAuthHeaderName,
  resolveAuthMode,
  resolveCurrentEmail,
  resolveCurrentEmployee,
  setImpersonation,
  type CookiesLike,
  type HeadersLike,
} from "./identity";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.$client.close();
  vi.unstubAllEnvs();
});

/** Case-insensitive lookup, like Next's `ReadonlyHeaders`. */
function headerStore(values: Record<string, string>): HeadersLike {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

/** Returns `{ name, value }` like Next's `ReadonlyRequestCookies`. */
function cookieStore(values: Record<string, string>): CookiesLike {
  return {
    get: (name) => (name in values ? { name, value: values[name]! } : undefined),
  };
}

const DEV = { AUTH_MODE: "dev" };
const PROXY = { AUTH_MODE: "proxy" };

/**
 * `emp_0030`, a `senior_manager` with `is_admin: true` in seed 42 — and
 * deliberately NOT `FIXTURE.admin` (`emp_0016`), so a test that passes for the
 * wrong reason shows up. Written as a literal because that is how it appears in
 * `apps/web/.env.development` and `docker-compose.yml`.
 */
const DEV_DEFAULT_EMAIL = "theo.delacroix@example.com";
const DEV_WITH_DEFAULT = { AUTH_MODE: "dev", [DEFAULT_DEV_EMAIL_VAR]: DEV_DEFAULT_EMAIL };

describe("resolveAuthMode", () => {
  it("defaults to dev", () => {
    expect(resolveAuthMode({})).toBe("dev");
    expect(resolveAuthMode({ AUTH_MODE: "   " })).toBe("dev");
  });

  it("accepts either documented mode, case- and space-insensitively", () => {
    expect(resolveAuthMode({ AUTH_MODE: "proxy" })).toBe("proxy");
    expect(resolveAuthMode({ AUTH_MODE: " PROXY " })).toBe("proxy");
    expect(resolveAuthMode({ AUTH_MODE: "Dev" })).toBe("dev");
  });

  it("throws on an unrecognised mode rather than guessing", () => {
    expect(() => resolveAuthMode({ AUTH_MODE: "prox" })).toThrow(/AUTH_MODE must be one of/);
  });

  it("rejects a dev fallback identity under proxy, naming both variables", () => {
    const boom = () =>
      resolveAuthMode({ AUTH_MODE: "proxy", [DEFAULT_DEV_EMAIL_VAR]: DEV_DEFAULT_EMAIL });

    expect(boom).toThrow(/AUTH_MODE/);
    expect(boom).toThrow(new RegExp(DEFAULT_DEV_EMAIL_VAR));
  });

  it("treats a blank dev fallback as unset, in either mode", () => {
    expect(resolveAuthMode({ AUTH_MODE: "proxy", [DEFAULT_DEV_EMAIL_VAR]: "" })).toBe("proxy");
    expect(resolveAuthMode({ AUTH_MODE: "proxy", [DEFAULT_DEV_EMAIL_VAR]: "   " })).toBe("proxy");
  });

  it("allows the dev fallback in dev mode", () => {
    expect(resolveAuthMode(DEV_WITH_DEFAULT)).toBe("dev");
    expect(resolveAuthMode({ [DEFAULT_DEV_EMAIL_VAR]: DEV_DEFAULT_EMAIL })).toBe("dev");
  });
});

describe("resolveAuthHeaderName", () => {
  it("defaults to the §G6 header", () => {
    expect(resolveAuthHeaderName({})).toBe(DEFAULT_AUTH_HEADER);
    expect(DEFAULT_AUTH_HEADER).toBe("x-forwarded-email");
  });

  it("lowercases a configured header name", () => {
    expect(resolveAuthHeaderName({ AUTH_HEADER: "X-Auth-Request-Email" })).toBe(
      "x-auth-request-email",
    );
  });
});

describe("normaliseEmail", () => {
  it.each([
    ["  Jane.Smith@Example.COM ", "jane.smith@example.com"],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ])("%s → %s", (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });
});

describe("resolveCurrentEmail — proxy mode", () => {
  it("reads the configured header, case-insensitively", () => {
    const headers = headerStore({ "X-Forwarded-Email": "  Jane.Smith@EXAMPLE.com " });
    expect(resolveCurrentEmail(headers, cookieStore({}), PROXY)).toBe("jane.smith@example.com");
  });

  it("honours a custom AUTH_HEADER", () => {
    const headers = headerStore({ "x-auth-request-email": "vp@example.com" });
    expect(
      resolveCurrentEmail(headers, cookieStore({}), {
        AUTH_MODE: "proxy",
        AUTH_HEADER: "X-Auth-Request-Email",
      }),
    ).toBe("vp@example.com");
  });

  it("ignores the impersonation cookie", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: "ceo@example.com" });
    expect(resolveCurrentEmail(headerStore({}), cookies, PROXY)).toBeNull();
  });

  it("is null when the header is absent", () => {
    expect(resolveCurrentEmail(headerStore({}), cookieStore({}), PROXY)).toBeNull();
    expect(resolveCurrentEmail(null, null, PROXY)).toBeNull();
  });

  it("throws rather than falling back when a dev default is configured", () => {
    // The whole point: a request whose SSO header went missing must NOT acquire
    // an identity. Refusing at resolution time is what guarantees it.
    expect(() =>
      resolveCurrentEmail(headerStore({ [DEFAULT_AUTH_HEADER]: "" }), cookieStore({}), {
        AUTH_MODE: "proxy",
        [DEFAULT_DEV_EMAIL_VAR]: DEV_DEFAULT_EMAIL,
      }),
    ).toThrow(/AUTH_MODE[\s\S]*DEV_DEFAULT_EMAIL|DEV_DEFAULT_EMAIL[\s\S]*AUTH_MODE/);
  });
});

describe("resolveCurrentEmail — dev mode", () => {
  it("reads the impersonation cookie", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: "Jane.Smith@Example.com" });
    expect(resolveCurrentEmail(headerStore({}), cookies, DEV)).toBe("jane.smith@example.com");
  });

  it("ignores the proxy header", () => {
    const headers = headerStore({ [DEFAULT_AUTH_HEADER]: "ceo@example.com" });
    expect(resolveCurrentEmail(headers, cookieStore({}), DEV)).toBeNull();
  });

  it("accepts a bare string cookie value too", () => {
    const cookies: CookiesLike = { get: () => "ic@example.com" };
    expect(resolveCurrentEmail(null, cookies, DEV)).toBe("ic@example.com");
  });

  it("is null with no cookie when no default is configured", () => {
    expect(resolveCurrentEmail(headerStore({}), cookieStore({}), DEV)).toBeNull();
    expect(resolveCurrentEmail(null, null, DEV)).toBeNull();
  });
});

describe("resolveCurrentEmail — DEV_DEFAULT_EMAIL fallback", () => {
  it("resolves to the configured default when no cookie is present", () => {
    expect(resolveCurrentEmail(null, cookieStore({}), DEV_WITH_DEFAULT)).toBe(DEV_DEFAULT_EMAIL);
    expect(resolveCurrentEmail(headerStore({}), null, DEV_WITH_DEFAULT)).toBe(DEV_DEFAULT_EMAIL);
  });

  it("normalises the configured default", () => {
    expect(
      resolveCurrentEmail(null, cookieStore({}), {
        AUTH_MODE: "dev",
        [DEFAULT_DEV_EMAIL_VAR]: "  Theo.Delacroix@EXAMPLE.com ",
      }),
    ).toBe(DEV_DEFAULT_EMAIL);
  });

  it("loses to a cookie that names somebody", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: FIXTURE.ic.email });
    expect(resolveCurrentEmail(null, cookies, DEV_WITH_DEFAULT)).toBe(FIXTURE.ic.email);
  });

  it("loses to a cookie that names NOBODY — the 403 stays reachable", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: "nobody@example.com" });
    expect(resolveCurrentEmail(null, cookies, DEV_WITH_DEFAULT)).toBe("nobody@example.com");
  });

  it("applies when the cookie is present but empty", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: "   " });
    expect(resolveCurrentEmail(null, cookies, DEV_WITH_DEFAULT)).toBe(DEV_DEFAULT_EMAIL);
  });

  it("is ignored in proxy mode — it throws instead", () => {
    expect(() => resolveCurrentEmail(null, null, { ...DEV_WITH_DEFAULT, AUTH_MODE: "proxy" })).toThrow(
      new RegExp(DEFAULT_DEV_EMAIL_VAR),
    );
  });

  it("reads the default from process.env by default", () => {
    vi.stubEnv("AUTH_MODE", "dev");
    vi.stubEnv(DEFAULT_DEV_EMAIL_VAR, DEV_DEFAULT_EMAIL);

    expect(resolveCurrentEmail(null, cookieStore({}))).toBe(DEV_DEFAULT_EMAIL);
  });
});

describe("resolveCurrentEmployee", () => {
  it("resolves a roster email regardless of case (proxy)", () => {
    const headers = headerStore({ [DEFAULT_AUTH_HEADER]: FIXTURE.ic.email.toUpperCase() });
    const employee = resolveCurrentEmployee(db, headers, cookieStore({}), PROXY);

    expect(employee?.id).toBe(FIXTURE.ic.id);
    expect(employee?.email).toBe(FIXTURE.ic.email);
  });

  it("resolves the impersonated employee (dev)", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: FIXTURE.admin.email });
    const employee = resolveCurrentEmployee(db, headerStore({}), cookies, DEV);

    expect(employee?.id).toBe(FIXTURE.admin.id);
    expect(employee?.is_admin).toBe(true);
  });

  it("returns null for an email nobody on the roster has", () => {
    const headers = headerStore({ [DEFAULT_AUTH_HEADER]: "contractor@other-company.example" });
    expect(resolveCurrentEmployee(db, headers, cookieStore({}), PROXY)).toBeNull();
  });

  it("returns null when the request carries no identity at all", () => {
    expect(resolveCurrentEmployee(db, headerStore({}), cookieStore({}), DEV)).toBeNull();
    expect(resolveCurrentEmployee(db, headerStore({}), cookieStore({}), PROXY)).toBeNull();
  });

  it("reads AUTH_MODE from process.env by default", () => {
    vi.stubEnv("AUTH_MODE", "proxy");
    const headers = headerStore({ [DEFAULT_AUTH_HEADER]: FIXTURE.ceo.email });

    expect(resolveCurrentEmployee(db, headers, cookieStore({}))?.id).toBe(FIXTURE.ceo.id);
  });

  it("resolves the dev default to a real seeded employee", () => {
    const employee = resolveCurrentEmployee(db, null, cookieStore({}), DEV_WITH_DEFAULT);

    expect(employee?.id).toBe("emp_0030");
    expect(employee?.is_admin).toBe(true);
    // Not FIXTURE.admin: the default identity is chosen independently, and a
    // test that quietly tracked the fixture would stop proving that.
    expect(employee?.id).not.toBe(FIXTURE.admin.id);
  });

  it("still returns null for a cookie naming nobody, default or not", () => {
    const cookies = cookieStore({ [IMPERSONATION_COOKIE]: "nobody@example.com" });
    expect(resolveCurrentEmployee(db, null, cookies, DEV_WITH_DEFAULT)).toBeNull();
  });
});

describe("findEmployeeByEmail", () => {
  it("is case-insensitive and null-safe", () => {
    expect(findEmployeeByEmail(db, ` ${FIXTURE.ic.email.toUpperCase()} `)?.id).toBe(FIXTURE.ic.id);
    expect(findEmployeeByEmail(db, "nobody@example.com")).toBeNull();
    expect(findEmployeeByEmail(db, null)).toBeNull();
    expect(findEmployeeByEmail(db, "")).toBeNull();
  });
});

describe("impersonation is dev-mode only", () => {
  it("setImpersonation throws under AUTH_MODE=proxy", async () => {
    await expect(setImpersonation(FIXTURE.ic.email, PROXY)).rejects.toThrow(
      /only available when AUTH_MODE=dev/,
    );
  });

  it("clearImpersonation throws under AUTH_MODE=proxy", async () => {
    await expect(clearImpersonation(PROXY)).rejects.toThrow(/only available when AUTH_MODE=dev/);
  });

  it("reads AUTH_MODE from process.env by default", async () => {
    vi.stubEnv("AUTH_MODE", "proxy");
    await expect(setImpersonation(FIXTURE.ic.email)).rejects.toThrow(
      /only available when AUTH_MODE=dev/,
    );
  });

  it("rejects an empty email in dev mode", async () => {
    await expect(setImpersonation("   ", DEV)).rejects.toThrow(/email address is required/);
  });
});
