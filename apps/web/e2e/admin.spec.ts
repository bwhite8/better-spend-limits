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
import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { APP_CONFIG_DEFAULTS } from "../src/db/config-defaults";
import { loginAs, memberRow, memberRows } from "./helpers";
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

/** §G7 settings, all of which `afterAll` restores. */
const CONFIG_KEY_COUNT = 5;

/**
 * The §Phase 9 delegation trio, and the scope the assignment is worth.
 *
 * Recomputed from the generator rather than read off the app, for the reason
 * `analytics.spec.ts` gives: a test that asks the app what to expect cannot
 * contradict the app. The lead holds no tier-2/3/4 slot of their own, so the
 * assignment is the ONLY thing that can put anybody in front of them.
 */
const LEAD = FIXTURE.delegatedLead;
const LEADER = FIXTURE.delegationLeader;
const DELEGATED_SCOPE = new Set([
  LEAD.id,
  ...getFixtureOrg()
    .employees.filter(
      (employee) =>
        employee.tier3_manager_id === LEADER.id || employee.tier4_manager_id === LEADER.id,
    )
    .map((employee) => employee.id),
]);

async function openAdmin(page: Page): Promise<void> {
  await page.goto("/admin");
  // The nav destination Phase 9 stubbed out is now this page.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Admin");
}

/** The delegation editor for one AI lead. */
function aiLeadRow(page: Page, employeeId: string): Locator {
  return page.locator(`[data-testid="ai-lead-row"][data-employee-id="${employeeId}"]`);
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

  /**
   * Phase 8 criteria 6 and 7.
   *
   * `updateConfig` persists `Object.entries(validated)`, so a §G7 key its
   * validator forgets to return is never written, never audited, and never
   * complained about — the form simply keeps showing the value the admin chose.
   * Reading the change back off the audit log is what catches that, which is why
   * this test looks at the log rather than only at the checkbox.
   *
   * It runs before the import test on purpose: `describe.serial` keeps
   * declaration order, and after the import `FIXTURE.tier3ManagerOfIc` no longer
   * exists.
   */
  test("the org-wide KPI flag round-trips, and hides the organization cards", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);

    const flag = page.getByTestId("config-org-kpis");
    await expect(flag).toBeChecked();
    await flag.uncheck();
    await page.getByTestId("config-save").click();
    await expect(page.getByTestId("config-saved")).toBeVisible();

    // Persisted, not merely held in the form's own state.
    await page.reload();
    await expect(page.getByTestId("config-org-kpis")).not.toBeChecked();

    const newest = page.getByTestId("audit-row").first();
    await expect(newest).toHaveAttribute("data-action", "config_update");
    await expect(newest.getByTestId("audit-actor")).toHaveText(ADMIN_EMAIL);
    await expect(newest.getByTestId("audit-detail")).toContainText("show_org_wide_kpis");

    // With the flag off, a manager is back to their own scope and nothing else.
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
    await expect(page.getByTestId("kpi-card")).toHaveCount(2);
    await expect(page.getByTestId("kpi-scope-total")).toBeVisible();
    await expect(page.getByTestId("kpi-org-total")).toHaveCount(0);

    // Put it back — `afterAll` would too, but only after four more tests have
    // run against a setting this one changed.
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);
    const restored = page.getByTestId("config-org-kpis");
    await expect(restored).not.toBeChecked();
    await restored.check();
    await page.getByTestId("config-save").click();
    await expect(page.getByTestId("config-saved")).toBeVisible();

    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await page.goto("/analytics");
    await expect(page.getByTestId("kpi-card")).toHaveCount(4);
  });

  /**
   * Phase 9 criteria 3, 5 and 10, end to end.
   *
   * Declared before the import test on purpose, twice over: `describe.serial`
   * keeps declaration order, the fixtures stop existing once the mini org
   * replaces the roster, and the assignment this test leaves behind is what the
   * import test's cleanup assertion needs to find.
   */
  test("delegating a leader to an AI lead grants that leader's people, and not the leader", async ({
    page,
  }) => {
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);

    const row = aiLeadRow(page, LEAD.id);
    await expect(row.getByTestId("ai-lead-current")).toHaveText("No delegation");

    const select = row.getByTestId("ai-lead-select");
    // The form never offers an admin — the option list is the first half of the
    // rule, and the server action below is the half that counts.
    await expect(select.locator(`option[value="${FIXTURE.admin.id}"]`)).toHaveCount(0);

    await select.selectOption(LEADER.id);
    await row.getByTestId("ai-lead-save").click();
    await expect(row.getByTestId("ai-lead-saved")).toBeVisible();

    // Persisted, not merely held in the form's own state.
    await page.reload();
    await expect(aiLeadRow(page, LEAD.id).getByTestId("ai-lead-current")).toHaveText(
      `Speaks for ${LEADER.name}`,
    );

    const newest = page.getByTestId("audit-row").first();
    await expect(newest).toHaveAttribute("data-action", "assign_ai_lead");
    await expect(newest.getByTestId("audit-actor")).toHaveText(ADMIN_EMAIL);
    await expect(newest.getByTestId("audit-target")).toHaveText(LEAD.name);
    const detail = newest.getByTestId("audit-detail");
    await expect(detail).toContainText(LEAD.id);
    await expect(detail).toContainText(LEADER.id);

    // The grant, from the lead's own seat: the leader's people, themselves, and
    // nobody else — in particular not the leader.
    await loginAs(page, LEAD.email);
    await page.goto("/members");
    await expect(memberRows(page)).toHaveCount(DELEGATED_SCOPE.size);
    await expect(memberRow(page, FIXTURE.delegatedReport.id)).toBeVisible();
    await expect(memberRow(page, LEADER.id)).toHaveCount(0);
    await expect(page.getByTestId("member-count")).toHaveText(
      `Showing 1–${DELEGATED_SCOPE.size} of ${DELEGATED_SCOPE.size}`,
    );

    // Inherited authority is real authority: the leader's people are editable.
    await expect(
      memberRow(page, FIXTURE.delegatedReport.id).getByTestId("member-edit-limit"),
    ).toBeVisible();
  });

  test("an assignment to an administrator is refused by the server, not just by the form", async ({
    page,
  }) => {
    await loginAs(page, ADMIN_EMAIL);
    await openAdmin(page);

    const row = aiLeadRow(page, LEAD.id);
    const select = row.getByTestId("ai-lead-select");

    // Forge the option the form deliberately does not offer. A hidden control is
    // a courtesy; the refusal has to come from the action.
    await select.evaluate((element, id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = "forged";
      element.append(option);
    }, FIXTURE.admin.id);
    await select.selectOption([FIXTURE.admin.id]);
    await row.getByTestId("ai-lead-save").click();

    const error = row.getByTestId("ai-lead-error");
    await expect(error).toContainText("administrator");
    await expect(error).toContainText("whole organization");

    // And the delegation that was already there is untouched — a rejected write
    // is a write that did not happen, not a write that half happened.
    await page.reload();
    await expect(aiLeadRow(page, LEAD.id).getByTestId("ai-lead-current")).toHaveText(
      `Speaks for ${LEADER.name}`,
    );

    await loginAs(page, LEAD.email);
    await page.goto("/members");
    await expect(memberRows(page)).toHaveCount(DELEGATED_SCOPE.size);
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
    // §Phase 9 criterion 11: the delegation the two tests above left behind names
    // two people the new roster does not have. It is dropped inside the same
    // transaction — and reported, because it is a permission that just went away.
    await expect(page.getByTestId("import-done")).toContainText("Removed 1 AI-lead delegation");

    // The uploader is not on the new roster, so what they reload into is a 403.
    // That is the correct answer, and the dev switcher is the way out of it.
    await page.getByTestId("import-reload").click();
    await expect(page.getByTestId("forbidden")).toBeVisible();

    await loginAs(page, MINI_ORG_ADMIN);
    await page.goto("/members");
    await expect(memberRows(page)).toHaveCount(MINI_ORG_SIZE);
    await expect(memberRows(page).first()).toContainText("Ada Lovelace");
    // The full string, not `toContainText(5)`: the count is a range now
    // (`Showing 1–5 of 5`), and a substring match on a digit would keep passing
    // while meaning nothing.
    await expect(page.getByTestId("member-count")).toHaveText(
      `Showing 1–${MINI_ORG_SIZE} of ${MINI_ORG_SIZE}`,
    );

    // The only place in the suite where a row is genuinely UNSYNCED: the mini
    // org's addresses are on another domain, so no snapshot matched any of them.
    // An admin may edit all five, and there is still nothing to write against —
    // so the inline editor must stand down on `synced`, not just on permission.
    await expect(memberRows(page).first()).toContainText("Not synced");
    await expect(page.getByTestId("member-edit-limit")).toHaveCount(0);
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

      // The import already clears these — but only if it ran. A delegation left
      // behind by a failed run would widen one persona's scope for every spec
      // that follows, which is the kind of state that makes a later failure look
      // like it belongs to a later phase.
      db.prepare("DELETE FROM ai_lead_assignments").run();
    } finally {
      db.close();
    }

    // The restore above is only as complete as `APP_CONFIG_DEFAULTS`. A key
    // dropped from that object would stop being restored here and the four specs
    // that follow would silently inherit whatever this one left behind — so the
    // count is pinned, and asserted after the restore rather than before it.
    expect(Object.keys(APP_CONFIG_DEFAULTS)).toHaveLength(CONFIG_KEY_COUNT);

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
