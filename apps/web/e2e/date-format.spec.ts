/**
 * Phase 2 acceptance: every rendered date reads `MMMM D, YYYY`.
 *
 * The unit tests in `packages/shared/src/date.test.ts` prove `formatDate` is
 * correct and timezone-free. What they cannot prove is that the pages actually
 * call it, so this file walks the three surfaces that render a date and checks
 * the shape of what a browser puts on screen.
 *
 * The assertions are SHAPE assertions, not literal dates: `/requests` and
 * `/admin` show timestamps generated at run time, and the chart watermark tracks
 * the mock's `data_refreshed_at`. A regex for "month name, day without a leading
 * zero, four-digit year" fails on the old `YYYY-MM-DD` form and on a
 * locale-shifted one, which is exactly the pair of regressions this phase is
 * guarding against.
 *
 * The x-axis is asserted in the negative direction: it must KEEP its short
 * `MM-DD` ticks, because ~90 long-form labels do not fit at any width.
 *
 * Placement matters. Specs run in path order and `date-format` sorts after
 * `admin`, so the audit log already holds the rows `admin.spec.ts` wrote — this
 * file never writes anything itself, which is why it can sit in the middle of a
 * suite whose ordering is already load-bearing. The consequence is that the
 * audit test FAILS IF THIS FILE IS RUN ALONE: with an empty log the page renders
 * `audit-empty` and there is no row to inspect. Run the whole suite, or run it
 * after `admin.spec.ts`.
 */

import { FIXTURE } from "@bsl/seed";
import { expect, test } from "@playwright/test";

import { loginAs } from "./helpers";

/** `August 14, 2026` — month name, no leading zero on the day. */
const LONG_DATE = String.raw`[A-Z][a-z]+ \d{1,2}, \d{4}`;

test.describe("date formatting", () => {
  test("a request card dates itself in long form", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await page.goto("/requests");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Requests");

    const created = page.getByTestId("request-created").first();
    await expect(created).toHaveText(new RegExp(`^Raised ${LONG_DATE}$`));
  });

  test("a resolved request dates its resolution in long form", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await page.goto("/requests?tab=resolved");
    await expect(page.getByTestId("tab-resolved")).toHaveAttribute("data-active", "true");

    const resolved = page.getByTestId("request-resolved").first();
    await expect(resolved).toHaveText(new RegExp(`^ · resolved ${LONG_DATE}$`));
  });

  test("the audit log stamps rows in long form with HH:MM", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Admin");

    // `When` is the first cell of the newest row; it carries no testid of its own.
    const when = page.getByTestId("audit-row").first().locator("td").first();
    await expect(when).toHaveText(new RegExp(`^${LONG_DATE} \\d{2}:\\d{2}$`));
  });

  test("the chart keeps short axis ticks and dates its watermark in long form", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");

    const chart = page.getByTestId("spend-chart");
    await expect(chart).toBeVisible();

    // ~90 ticks at `MMMM D, YYYY` would be unreadable, so the axis must not have
    // been swept along with the rest.
    //
    // `ResponsiveContainer` measures its box before it draws anything, so the
    // ticks appear a frame after the wrapper does — hence the explicit wait.
    // Text is read with `textContent`: these are SVG `<text>` nodes, which have
    // no `innerText`.
    // Recharts 3 hoists tick LABELS into their own z-index layer, so they are
    // siblings of `.recharts-xAxis` rather than children of it — the label group
    // is the only selector that reaches them.
    const tickValues = chart.locator(
      ".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value",
    );
    await expect(tickValues.first()).toBeVisible();
    const ticks = await tickValues.allTextContents();
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) expect(tick.trim()).toMatch(/^\d{2}-\d{2}$/);

    await expect(page.getByTestId("chart-legend")).toHaveText(
      new RegExp(`after ${LONG_DATE} = provisional`),
    );
  });
});
