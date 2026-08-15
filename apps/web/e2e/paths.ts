/**
 * Shared constants for the end-to-end run: where things live, and — more
 * importantly — the environment the app under test is given.
 *
 * The env block is not a convenience. An ambient `ANTHROPIC_BASE_URL` in the
 * developer's shell OVERRIDES `apps/web/.env.development` (Next gives real
 * environment variables precedence over env files), and it has already happened
 * on this project: `npm run dev` silently pointed at `https://api.anthropic.com`.
 * Under test that would mean writes landing on a real organization. Passing all
 * three API variables explicitly through `webServer.env` beats the ambient
 * value, so the suite can only ever talk to the local mock.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(WEB_DIR, "..", "..");

/**
 * The suite's own SQLite file, wiped and re-seeded by `global-setup.ts`.
 * `data/` is gitignored, and this never collides with a developer's `app.db`.
 * Later phases assert on the audit log by opening this exact path.
 */
export const E2E_DATABASE_PATH = path.join(WEB_DIR, "data", "e2e.db");

export const MOCK_API_PORT = 8787;
export const WEB_PORT = 3000;
export const MOCK_API_URL = `http://localhost:${MOCK_API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

export const MOCK_ADMIN_KEY = "mock-admin-key";
export const MOCK_ANALYTICS_KEY = "mock-analytics-key";

/** §G6 for `apps/web`, pinned at the mock. */
export const WEB_SERVER_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: MOCK_API_URL,
  ANTHROPIC_ADMIN_KEY: MOCK_ADMIN_KEY,
  ANTHROPIC_ANALYTICS_KEY: MOCK_ANALYTICS_KEY,
  AUTH_MODE: "dev",
  AUTH_HEADER: "x-forwarded-email",
  DATABASE_PATH: E2E_DATABASE_PATH,
  PORT: String(WEB_PORT),
};

/** §G6 for `apps/mock-api`. Seed 42 is what every `FIXTURE` refers to. */
export const MOCK_SERVER_ENV: Record<string, string> = {
  PORT: String(MOCK_API_PORT),
  MOCK_SEED: "42",
  MOCK_ADMIN_KEY,
  MOCK_ANALYTICS_KEY,
  MOCK_RATE_LIMIT: "off",
};
