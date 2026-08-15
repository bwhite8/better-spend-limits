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
import { expect, test, type Locator, type Page } from "@playwright/test";

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
        // No `aligned_ai_lead_id` clause: §Phase 9 retired that role, and an AI
        // lead's reach is now whatever leaders are delegated to them.
        employee.tier4_manager_id === FIXTURE.tier3ManagerOfIc.id,
    )
    .map((employee) => employee.id),
);

const employeeById = new Map(org.employees.map((employee) => [employee.id, employee]));

async function openAnalytics(page: Page): Promise<void> {
  await page.goto("/analytics");
  // The nav destination Phase 9 stubbed out is now this page.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
}

/** `$12,345.67` as a number, so two KPI cards can be compared. */
async function dollars(locator: Locator): Promise<number> {
  const text = (await locator.innerText()).trim();
  const digits = text.replace(/[^0-9.]/g, "");
  expect(digits, `expected a money figure, got ${JSON.stringify(text)}`).not.toBe("");
  return Number(digits);
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
    // A 7-person scope may legitimately contain nobody near a limit, and then
    // the page renders `near-limit-empty` and there is no table to read. Assert
    // that exactly one of the two branches rendered, and check the name only on
    // the branch where a name could appear — `not.toContainText` against a
    // locator that matches nothing fails rather than passing vacuously.
    const nearShown = await page.getByTestId("near-limit-table").count();
    const nearEmpty = await page.getByTestId("near-limit-empty").count();
    expect(nearShown + nearEmpty).toBe(1);
    if (nearShown === 1) {
      await expect(page.getByTestId("near-limit-table")).not.toContainText(outsiderName);
    }

    // The page still renders end to end for a small scope: chart, and either a
    // movers table or its empty state — never an error.
    await expect(page.getByTestId("spend-chart")).toBeVisible();
    const moversShown = await page.getByTestId("wow-table").count();
    const moversEmpty = await page.getByTestId("wow-empty").count();
    expect(moversShown + moversEmpty).toBe(1);
  });

  /**
   * Phase 8 criteria 4 and 5.
   *
   * An admin's visible set already IS the organization, so a second pair of
   * cards would print the same two numbers twice. They get one pair, named for
   * what it covers; everybody else gets their own scope plus the organization
   * for comparison. Criterion 6 (the flag turned off) lives in `admin.spec.ts`,
   * which is the spec that owns config changes and restores them.
   */
  test("an admin sees one pair of KPI cards, above the chart", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await openAnalytics(page);

    await expect(page.getByTestId("kpi-card")).toHaveCount(2);
    await expect(page.getByTestId("kpi-org-total")).toBeVisible();
    await expect(page.getByTestId("kpi-org-average")).toBeVisible();
    await expect(page.getByTestId("kpi-scope-total")).toHaveCount(0);

    // "Above" as the reader means it, not merely "present somewhere".
    const chartFollowsCards = await page.evaluate(() => {
      const cards = document.querySelector('[data-testid="kpi-cards"]');
      const heading = [...document.querySelectorAll("h2")].find(
        (node) => node.textContent?.trim() === "Spend over time",
      );
      if (cards === null || heading === undefined) return null;
      return Boolean(
        cards.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(chartFollowsCards).toBe(true);

    // The whole roster is the denominator, spenders and nil spenders alike.
    await expect(page.getByTestId("kpi-org-total").locator("..")).toContainText("across 250 users");
  });

  test("a manager sees their scope beside a strictly larger organization", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openAnalytics(page);

    await expect(page.getByTestId("kpi-card")).toHaveCount(4);

    const scopeTotal = await dollars(page.getByTestId("kpi-scope-total"));
    const orgTotal = await dollars(page.getByTestId("kpi-org-total"));
    const scopeAverage = await dollars(page.getByTestId("kpi-scope-average"));
    const orgAverage = await dollars(page.getByTestId("kpi-org-average"));

    expect(scopeTotal).toBeGreaterThan(0);
    expect(orgTotal).toBeGreaterThan(scopeTotal);

    // The average really is the total over the headcount, not over the spenders.
    expect(scopeAverage).toBeCloseTo(scopeTotal / TIER3_SCOPE.size, 1);
    expect(orgAverage).toBeCloseTo(orgTotal / 250, 1);
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
