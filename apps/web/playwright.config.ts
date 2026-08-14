/**
 * End-to-end configuration (plan §Phase 9).
 *
 * Two servers, both started by Playwright and both pinned to the synthetic
 * universe: the mock on 8787 with `MOCK_SEED=42`, and the web app pointed at it
 * through explicit environment variables (see `e2e/paths.ts` for why explicit
 * matters here).
 *
 * The web app is BUILT and served in production mode rather than run through
 * `next dev`. It costs a build per run and buys back determinism: no
 * compile-on-first-request stalls inside test timeouts, and every e2e run also
 * proves the production build still works.
 *
 * `workers: 1` is deliberate. The suite shares one SQLite file and one mock
 * whose state is mutated by the write flows Phases 10 and 11 add; parallel
 * workers would be racing over both.
 */

import { defineConfig, devices } from "@playwright/test";

import { MOCK_API_URL, MOCK_SERVER_ENV, REPO_ROOT, WEB_SERVER_ENV, WEB_URL } from "./e2e/paths";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The first navigation also triggers the staleness sync (~5s against the mock).
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // `list` rather than `html`: the HTML reporter starts a server and waits for a
  // browser, which hangs a non-interactive run.
  reporter: "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run start -w apps/mock-api",
      cwd: REPO_ROOT,
      // Unauthenticated, so it answers 401 — which Playwright accepts as "up".
      url: `${MOCK_API_URL}/v1/organizations/spend_limits/effective`,
      env: MOCK_SERVER_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run build -w apps/web && npm run start -w apps/web",
      cwd: REPO_ROOT,
      // Deliberately NOT `/`: the probe runs before global setup has migrated
      // the database, and `/api/health` reads nothing.
      url: `${WEB_URL}/api/health`,
      env: WEB_SERVER_ENV,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
