/**
 * Phase 13 acceptance: the admin area.
 *
 * This file also carries the "the destination exists and is reachable" coverage
 * that `members.spec.ts` held while `/admin` was a stub — `openAdmin` asserts
 * the heading, the same way `requests.spec.ts` and `analytics.spec.ts` took that
 * job over in Phases 11 and 12. That retires the last of the Phase-9 stub tests.
 *
 * **This spec is the only one that destroys the universe.** The import test
 * replaces all 250 seeded employees with a five-person roster, which would leave
 * every later spec impersonating somebody who no longer exists — and specs run
 * in path order, so `admin` runs first, before `analytics`, `edit-limit`,
 * `members` and `requests`. `afterAll` therefore re-seeds the roster and restores
 * the §G7 config defaults unconditionally, whether the tests passed or not.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { FIXTURE } from "@bsl/seed";
import { expect, test, type Page } from "@playwright/test";

import { APP_CONFIG_DEFAULTS } from "../src/db/config-defaults";
import { loginAs, memberRows } from "./helpers";
import { E2E_DATABASE_PATH, REPO_ROOT, WEB_URL } from "./paths";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINI_ORG_CSV = path.join(HERE, "fixtures", "mini-org.csv");

/** The admin inside `mini-org.csv` — the only way back in after the import. */
const MINI_ORG_ADMIN = "ada.lovelace@example.net";
const MINI_ORG_SIZE = 5;
const TOTAL_EMPLOYEES = 250;

/** Seeded actors all live on this domain; the mini org deliberately does not. */
const SEED_EMAIL_DOMAIN = "@example.com";

const ADMIN_EMAIL = FIXTURE.admin.email.toLowerCase();

async function openAdmin(page: Page): Promise<void> {
  await page.goto("/admin");
  // The nav destination Phase 9 stubbed out is now this page.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Admin");
}

/**
 * The highest `audit_log` id, straight from the suite's own database.
 *
 * Opened read-write rather than `readonly` for the reason `edit-limit.spec.ts`
 * documents: the app runs the file in WAL mode, and a read-only connection still
 * needs to write the `-shm` index.
 */
function newestAuditId(): number {
  const db = new Database(E2E_DATABASE_PATH, { fileMustExist: true });
  try {
    const row = db.prepare("SELECT MAX(id) AS id FROM audit_log").get() as { id: number | null };
    return row.id ?? 0;
  } finally {
    db.close();
  }
}

/** `data-audit-id` for every rendered row, in render order. */
async function renderedAuditIds(page: Page): Promise<number[]> {
  return page
    .getByTestId("audit-row")
    .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-audit-id"))));
}

test.describe.serial("admin area", () => {
  test("a manager who is not an admin is refused the whole area", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await page.goto("/admin");

    await expect(page.getByTestId("forbidden")).toBeVisible();
    // Refused means "not rendered", not "rendered and hidden".
    await expect(page.getByTestId("config-form")).toHaveCount(0);
    await expect(page.getByTestId("audit-table")).toHaveCount(0);
    await expect(page.getByTestId("import-file")).toHaveCount(0);
  });

  test("editing edit_roles changes who may edit a member, and changes back", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);

    const tier3 = page.getByTestId("config-role-tier3_manager");
    await expect(tier3).toBeChecked();
    await tier3.uncheck();
    await page.getByTestId("config-save").click();
    await expect(page.getByTestId("config-saved")).toBeVisible();

    // §G8: with tier 3 removed the manager holds no role over this member, so
    // they lose the page itself — `canView` is `canEdit` plus yourself.
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await page.goto(`/members/${FIXTURE.ic.id}`);
    await expect(page.getByTestId("forbidden")).toBeVisible();
    await expect(page.getByTestId("set-limit")).toHaveCount(0);

    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);
    // The saved value survived the round trip, not just the browser's state.
    const restored = page.getByTestId("config-role-tier3_manager");
    await expect(restored).not.toBeChecked();
    await restored.check();
    await page.getByTestId("config-save").click();
    await expect(page.getByTestId("config-saved")).toBeVisible();

    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await page.goto(`/members/${FIXTURE.ic.id}`);
    await expect(page.getByTestId("set-limit")).toBeVisible();
  });

  test("the audit log shows both settings changes, newest first", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);

    const rows = page.getByTestId("audit-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(2);

    const ids = await renderedAuditIds(page);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    // The first row really is the newest entry, not merely the newest of a page
    // that happened to start somewhere convenient.
    expect(ids[0]).toBe(newestAuditId());

    for (const index of [0, 1]) {
      await expect(rows.nth(index)).toHaveAttribute("data-action", "config_update");
      await expect(rows.nth(index).getByTestId("audit-actor")).toHaveText(ADMIN_EMAIL);
    }
    await expect(rows.first().getByTestId("audit-detail")).toContainText("edit_roles");
  });

  test("importing a roster replaces every employee record", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);

    // Before the import every API member is on the roster, so the gap report is
    // empty — which is what makes the 250 rows it grows in the next test mean
    // something rather than being the join failing all along.
    await expect(page.getByTestId("unmatched-empty")).toBeVisible();
    await expect(page.getByTestId("unmatched-row")).toHaveCount(0);

    await page.getByTestId("import-file").setInputFiles(MINI_ORG_CSV);
    await expect(page.getByTestId("import-preview")).toContainText(`${MINI_ORG_SIZE} readable rows`);
    await expect(page.getByTestId("import-issue")).toHaveCount(0);

    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-done")).toContainText(
      `Imported ${MINI_ORG_SIZE} employees`,
    );

    // The uploader is not on the new roster, so what they reload into is a 403.
    // That is the correct answer, and the dev switcher is the way out of it.
    await page.getByTestId("import-reload").click();
    await expect(page.getByTestId("forbidden")).toBeVisible();

    await loginAs(page, MINI_ORG_ADMIN);
    await page.goto("/");
    await expect(memberRows(page)).toHaveCount(MINI_ORG_SIZE);
    await expect(memberRows(page).first()).toContainText("Ada Lovelace");
    // The quoted field in the fixture survived the parse intact.
    await expect(page.getByTestId("member-count")).toContainText(String(MINI_ORG_SIZE));
  });

  test("after the import the newest entry is the import, and the roster gap is reported", async ({
    page,
  }) => {
    await loginAs(page, MINI_ORG_ADMIN);
    await openAdmin(page);

    const newest = page.getByTestId("audit-row").first();
    await expect(newest).toHaveAttribute("data-action", "import_employees");
    // Recorded against whoever pressed the button, not whoever is looking now.
    await expect(newest.getByTestId("audit-actor")).toHaveText(ADMIN_EMAIL);
    await expect(newest.getByTestId("audit-detail")).toContainText(`imported=${MINI_ORG_SIZE}`);

    // Every seeded actor is now unaccounted for by the roster.
    await expect(page.getByTestId("unmatched-count")).toContainText(String(TOTAL_EMPLOYEES));
    const unmatched = page.getByTestId("unmatched-row");
    expect(await unmatched.count()).toBeGreaterThanOrEqual(1);
    await expect(unmatched.first().getByTestId("unmatched-email")).toContainText(SEED_EMAIL_DOMAIN);
  });

  /**
   * Put the universe back for the four spec files that run after this one.
   *
   * `afterAll` rather than a final test: `describe.serial` SKIPS the remaining
   * tests once one fails, and a failure here is precisely when the restore
   * matters most.
   */
  test.afterAll(async () => {
    // `db:seed` only ensures MISSING config keys, so it would leave an edited
    // `edit_roles` in place — restore the §G7 defaults explicitly.
    const db = new Database(E2E_DATABASE_PATH, { fileMustExist: true });
    try {
      const upsert = db.prepare(
        "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      for (const [key, value] of Object.entries(APP_CONFIG_DEFAULTS)) {
        upsert.run(key, JSON.stringify(value));
      }
    } finally {
      db.close();
    }

    execFileSync("npm", ["run", "db:seed"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: E2E_DATABASE_PATH },
      stdio: "inherit",
    });

    // Re-match the restored employees to their Anthropic actors. Without it the
    // later specs lean on the email fallback leg of the join, which works but is
    // not the state global setup leaves behind.
    try {
      await fetch(`${WEB_URL}/api/sync`, {
        method: "POST",
        headers: { cookie: `bsl_impersonate=${ADMIN_EMAIL}` },
      });
    } catch {
      // Not worth failing a run over: the email fallback covers it.
    }
  });
});
