/**
 * Phase 12 acceptance: the analytics dashboards.
 *
 * This file also carries the "the destination exists and is reachable" coverage
 * that `members.spec.ts` held while `/analytics` was a stub — `openAnalytics`
 * asserts the heading, the same way `requests.spec.ts` took that job over in
 * Phase 11.
 *
 * The out-of-scope assertion (criterion 3) needs a member who is BOTH near their
 * limit and outside the tier-3 manager's scope, and the seed has no fixture for
 * that pairing. It is derived instead: the admin view lists everybody who is
 * near a limit, and §G8's scope rule is recomputed from the generator, so the
 * test picks a real counter-example rather than hard-coding an id that a change
 * to the generator would silently invalidate.
 *
 * Specs run in path order, and `analytics` sorts before `edit-limit` and
 * `requests`, so these tests see the pristine seeded universe.
 */

import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./helpers";

/** §Phase 3 engineers these cohorts; the reports must find them. */
const MIN_NEAR_LIMIT = 8;
const MIN_MOVERS = 10;

const org = getFixtureOrg();

/**
 * §G8 with the default `edit_roles`: everybody this manager may edit, plus
 * themselves. Recomputed here rather than read from the app, so the test can
 * contradict the app if the app is wrong.
 */
const TIER3_SCOPE = new Set(
  org.employees
    .filter(
      (employee) =>
        employee.id === FIXTURE.tier3ManagerOfIc.id ||
        employee.tier3_manager_id === FIXTURE.tier3ManagerOfIc.id ||
        employee.tier4_manager_id === FIXTURE.tier3ManagerOfIc.id ||
        employee.aligned_ai_lead_id === FIXTURE.tier3ManagerOfIc.id,
    )
    .map((employee) => employee.id),
);

const employeeById = new Map(org.employees.map((employee) => [employee.id, employee]));

async function openAnalytics(page: Page): Promise<void> {
  await page.goto("/analytics");
  // The nav destination Phase 9 stubbed out is now this page.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
}

/** Employee ids currently listed in the near-limit table. */
async function nearLimitIds(page: Page): Promise<string[]> {
  const ids = await page.getByTestId("near-limit-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-employee-id") ?? ""),
  );
  return ids.filter((id) => id !== "");
}

test.describe("analytics", () => {
  test("an admin sees the org chart, both reports, and the provisional legend", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await openAnalytics(page);

    await expect(page.getByTestId("analytics-scope")).toContainText("250");

    // The trend chart is genuinely drawn, not a placeholder.
    const chart = page.getByTestId("spend-chart");
    await expect(chart).toBeVisible();
    await expect(chart.locator("svg").first()).toBeVisible();

    // §G5: the tail after `data_refreshed_at` must be marked as revisable — in
    // the legend, and as its own dashed stroke. The grid's dash pattern is
    // "3 3", so this selector can only match the provisional series.
    await expect(page.getByTestId("chart-legend")).toContainText("provisional");
    await expect(chart.locator('path[stroke-dasharray="4 3"]').first()).toBeVisible();

    const near = page.getByTestId("near-limit-row");
    expect(await near.count()).toBeGreaterThanOrEqual(MIN_NEAR_LIMIT);

    const movers = page.getByTestId("wow-row");
    expect(await movers.count()).toBeGreaterThanOrEqual(MIN_MOVERS);

    // The month-to-date bar list is the fourth dataset on the page.
    await expect(page.getByTestId("top-spender-row").first()).toBeVisible();
  });

  test("a near-limit row opens that member's page", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await openAnalytics(page);

    const row = page.getByTestId("near-limit-row").first();
    const employeeId = await row.getAttribute("data-employee-id");
    expect(employeeId).toBeTruthy();

    await row.getByTestId("near-limit-link").click();

    await expect(page).toHaveURL(new RegExp(`/members/${employeeId}$`));
    await expect(page.getByTestId("member-name")).toContainText(
      employeeById.get(employeeId!)!.name,
    );
  });

  test("a manager's reports are confined to the people they can view", async ({ page }) => {
    // Establish, as an admin, a member who is near their limit AND outside the
    // manager's scope — the counter-example the next assertion needs.
    await loginAs(page, FIXTURE.admin.email);
    await openAnalytics(page);
    const outsider = (await nearLimitIds(page)).find((id) => !TIER3_SCOPE.has(id));
    expect(outsider, "seed 42 has a near-limit member outside the tier-3 scope").toBeTruthy();
    const outsiderName = employeeById.get(outsider!)!.name;

    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openAnalytics(page);

    await expect(page.getByTestId("analytics-scope")).toContainText(String(TIER3_SCOPE.size));

    // Every row shown is inside the scope, and the known outsider is absent —
    // by id and by name, since a name is what a person would actually read.
    for (const id of await nearLimitIds(page)) expect(TIER3_SCOPE.has(id)).toBe(true);
    await expect(
      page.locator(`[data-testid="near-limit-row"][data-employee-id="${outsider}"]`),
    ).toHaveCount(0);
    await expect(page.getByTestId("near-limit-table")).not.toContainText(outsiderName);

    // The page still renders end to end for a small scope: chart, and either a
    // movers table or its empty state — never an error.
    await expect(page.getByTestId("spend-chart")).toBeVisible();
    const moversShown = await page.getByTestId("wow-table").count();
    const moversEmpty = await page.getByTestId("wow-empty").count();
    expect(moversShown + moversEmpty).toBe(1);
  });

  test("an unrelated IC sees only their own data", async ({ page }) => {
    await loginAs(page, FIXTURE.unrelatedPeer.email);
    await openAnalytics(page);

    // §G8 option B: their visible set is exactly themselves.
    await expect(page.getByTestId("analytics-scope")).toContainText("1 person");

    const ids = await nearLimitIds(page);
    expect(ids.length).toBeLessThanOrEqual(1);
    for (const id of ids) expect(id).toBe(FIXTURE.unrelatedPeer.id);

    for (const id of await page
      .getByTestId("top-spender-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-employee-id")))) {
      expect(id).toBe(FIXTURE.unrelatedPeer.id);
    }

    await expect(page.getByTestId("spend-chart")).toBeVisible();
  });
});
