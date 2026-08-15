/**
 * Phase 9 acceptance: the shell, the members list, the member page, and the two
 * dev-only controls in the sidebar.
 *
 * Every persona is a named seed fixture rather than a literal id, so a change to
 * the generator moves these tests with it. `FIXTURE` is computed from
 * `generateOrg(42)`, which is exactly the universe `MOCK_SEED=42` serves.
 */

import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import { expect, test } from "@playwright/test";

import { findMemberRow, loginAs, memberRow, memberRows } from "./helpers";

/** §G9: `formatMoney` comma-groups thousands, so `$1,500.00` is a valid limit. */
const MONEY_OR_UNLIMITED = /^(\$[\d,]+\.\d{2}|Unlimited)$/;

/** The list trims `.00`, so `$500` and `$12.34` are both valid there. */
const LIST_MONEY_OR_UNLIMITED = /^(\$[\d,]+(\.\d{2})?|Unlimited)$/;

const TOTAL_EMPLOYEES = 250;
/** `PAGE_SIZE` in `members-table.tsx`. */
const PAGE_SIZE = 50;
const TOTAL_PAGES = Math.ceil(TOTAL_EMPLOYEES / PAGE_SIZE);

test.describe("landing route", () => {
  // `/` is a redirect, not a page. The list it used to hold is at `/members`,
  // and the sidebar link to it reads "Users" — the route keeps the API's
  // vocabulary, the copy does not.
  test("/ redirects to analytics and the list lives at /members", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    await page.goto("/");
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Users");
    // One page of the org, not the whole thing — see the pagination tests below.
    await expect(memberRows(page)).toHaveCount(PAGE_SIZE);
  });

  test("the Users link is current on both the list and a detail page", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const link = page.getByTestId("nav-link-users");
    await expect(link).toHaveAttribute("aria-current", "page");

    // The generic `startsWith` branch in `isActive` is what keeps the link lit
    // on the detail route; there is no `/`-shaped special case left to carry it.
    await page.goto(`/members/${FIXTURE.ic.id}`);
    await expect(page.getByTestId("member-name")).toContainText(FIXTURE.ic.name);
    await expect(link).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: "← Users" }).click();
    await expect(page).toHaveURL(/\/members$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Users");
  });
});

test.describe("members list", () => {
  test("an admin sees the whole organization and every nav destination", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    await expect(memberRows(page)).toHaveCount(PAGE_SIZE);
    // The scope is still the whole org; the count line is what says so now.
    await expect(page.getByTestId("member-count")).toHaveText(
      `Showing 1–${PAGE_SIZE} of ${TOTAL_EMPLOYEES}`,
    );

    for (const label of ["users", "requests", "analytics", "admin"]) {
      await expect(page.getByTestId(`nav-link-${label}`)).toBeVisible();
    }
  });

  test("an unrelated IC sees only themselves, no admin nav, and no other member's page", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE.unrelatedPeer.email);

    // §G8 option B: view scope is "everyone you can edit, plus yourself", and
    // this fixture can edit nobody.
    await expect(memberRows(page)).toHaveCount(1);
    await expect(memberRow(page, FIXTURE.unrelatedPeer.id)).toBeVisible();
    await expect(page.getByTestId("nav-link-admin")).toHaveCount(0);

    await page.goto(`/members/${FIXTURE.ic.id}`);
    await expect(page.getByTestId("forbidden")).toBeVisible();
    // The member's own details must not render at all — not merely be hidden.
    await expect(page.getByTestId("member-name")).toHaveCount(0);
  });

  test("a tier-3 manager can open a report's page and is listed as an editor", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);

    const row = memberRow(page, FIXTURE.ic.id);
    await expect(row).toBeVisible();
    await row.getByTestId("member-link").click();

    await expect(page).toHaveURL(new RegExp(`/members/${FIXTURE.ic.id}$`));
    await expect(page.getByTestId("member-name")).toContainText(FIXTURE.ic.name);
    await expect(page.getByTestId("member-limit")).toHaveText(MONEY_OR_UNLIMITED);
    await expect(page.getByTestId("limit-card").getByTestId("source-badge")).toBeVisible();
    await expect(page.getByTestId("edit-access")).toContainText(FIXTURE.tier3ManagerOfIc.name);

    // §Phase 9 criterion 7: the HRIS column is still real data and still shown,
    // even though it no longer grants anything — so it is on the Reporting card
    // and NOT in Edit access.
    const reporting = page.getByTestId("identity-card");
    await expect(reporting).toContainText("Aligned AI lead");
    await expect(reporting).toContainText(FIXTURE.aiLeadOfIc.name);
    await expect(page.getByTestId("edit-access")).not.toContainText(FIXTURE.aiLeadOfIc.name);
  });

  test("the seeded unlimited override renders as Unlimited", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const row = await findMemberRow(
      page,
      FIXTURE.unlimitedOverrideMember.id,
      FIXTURE.unlimitedOverrideMember.name,
    );
    await expect(row).toContainText("Unlimited");
  });
});

test.describe("users list controls", () => {
  test("the list pages at 50 and the last page holds the remainder", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    await expect(memberRows(page)).toHaveCount(PAGE_SIZE);
    await expect(page.getByTestId("member-page-status")).toHaveText(`Page 1 of ${TOTAL_PAGES}`);
    await expect(page.getByTestId("member-page-prev")).toBeDisabled();

    for (let page_ = 2; page_ <= TOTAL_PAGES; page_ += 1) {
      await page.getByTestId("member-page-next").click();
      await expect(page.getByTestId("member-page-status")).toHaveText(
        `Page ${page_} of ${TOTAL_PAGES}`,
      );
    }

    // 250 into pages of 50 leaves a full last page; what matters is that the
    // rows on it are the tail of the set, not a repeat of page 1.
    const remainder = TOTAL_EMPLOYEES - (TOTAL_PAGES - 1) * PAGE_SIZE;
    await expect(memberRows(page)).toHaveCount(remainder);
    await expect(page.getByTestId("member-page-next")).toBeDisabled();
    await expect(page.getByTestId("member-count")).toHaveText(
      `Showing ${TOTAL_EMPLOYEES - remainder + 1}–${TOTAL_EMPLOYEES} of ${TOTAL_EMPLOYEES}`,
    );
  });

  test("a scope that fits on one page has no pager at all", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);

    const scope = await memberRows(page).count();
    expect(scope).toBeLessThanOrEqual(PAGE_SIZE);
    await expect(page.getByTestId("member-pager")).toHaveCount(0);
    await expect(page.getByTestId("member-count")).toHaveText(`Showing 1–${scope} of ${scope}`);
  });

  test("search reaches a row that would otherwise sit on a later page", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const subject = FIXTURE.unlimitedOverrideMember;
    await page.getByTestId("member-search").fill(subject.name);

    await expect(memberRows(page)).toHaveCount(1);
    await expect(memberRow(page, subject.id)).toBeVisible();
    await expect(page.getByTestId("member-count")).toHaveText(
      `Showing 1 of 1 (filtered from ${TOTAL_EMPLOYEES})`,
    );
    // A one-row result is a single page, so the pager stands down.
    await expect(page.getByTestId("member-pager")).toHaveCount(0);
  });

  test("the limit column is headed Limit and drops the .00 from round caps", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const headers = page.getByRole("columnheader");
    await expect(headers.filter({ hasText: /^Limit$/ })).toHaveCount(1);
    await expect(headers.filter({ hasText: "Effective limit" })).toHaveCount(0);

    // Every seeded cap is a round number of dollars, so the trim is visible on
    // the whole page rather than on one lucky row.
    const limits = memberRows(page).locator("td:nth-child(3)").getByTestId("money");
    const rendered = await limits.allTextContents();
    expect(rendered.length).toBe(PAGE_SIZE);
    for (const text of rendered) expect(text).toMatch(LIST_MONEY_OR_UNLIMITED);
    expect(rendered.some((text) => /^\$[\d,]+$/.test(text))).toBe(true);
    expect(rendered.some((text) => text.endsWith(".00"))).toBe(false);
  });

  test("the tier-3 filter narrows the list to that manager's reports", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const manager = FIXTURE.tier3ManagerOfIc;
    const expected = getFixtureOrg().employees.filter(
      (employee) => employee.tier3_manager_id === manager.id,
    );
    expect(expected.length).toBeGreaterThan(0);

    await page.getByTestId("member-filter-tier3").selectOption(manager.id);

    await expect(memberRows(page)).toHaveCount(expected.length);
    await expect(page.getByTestId("member-count")).toHaveText(
      `Showing 1${expected.length === 1 ? "" : `–${expected.length}`} of ${expected.length} (filtered from ${TOTAL_EMPLOYEES})`,
    );
    for (const employee of expected) {
      await expect(memberRow(page, employee.id)).toBeVisible();
    }
  });

  test("the tier filters only offer managers who appear on the rows in scope", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);

    // The scope is small enough to fit one page, so the rendered rows ARE the
    // whole scope — no paging to compensate for.
    const scopedIds = await memberRows(page).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-employee-id")),
    );
    expect(scopedIds.length).toBeGreaterThan(1);
    expect(scopedIds.length).toBeLessThanOrEqual(PAGE_SIZE);

    const byId = new Map(getFixtureOrg().employees.map((employee) => [employee.id, employee]));
    const columns = {
      tier2: "tier2_manager_id",
      tier3: "tier3_manager_id",
      tier4: "tier4_manager_id",
    } as const;

    for (const [tier, column] of Object.entries(columns)) {
      // Derived here from the seed, independently of how the server derived it.
      const permitted = new Set(
        scopedIds
          .map((id) => (id === null ? null : (byId.get(id)?.[column] ?? null)))
          .filter((value): value is string => value !== null),
      );
      expect(permitted.size, `${tier} has managers to offer`).toBeGreaterThan(0);

      const offered = await page
        .getByTestId(`member-filter-${tier}`)
        .locator("option")
        .evaluateAll((options) =>
          options
            .map((option) => (option as HTMLOptionElement).value)
            .filter((value) => value !== ""),
        );

      // Exact set equality, so an option naming anyone the scope never
      // mentioned is a failure, not merely an extra.
      expect([...offered].sort(), `${tier} options`).toEqual([...permitted].sort());
    }
  });

  test("only manual overrides leaves only rows sourced from an override", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    await page.getByTestId("member-filter-overrides").check();

    const rows = memberRows(page);
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    const sources = await rows.getByTestId("source-badge").allTextContents();
    expect(sources).toHaveLength(count);
    for (const source of sources) expect(source).toBe("Override");

    await page.getByTestId("member-filter-overrides").uncheck();
    await expect(memberRows(page)).toHaveCount(PAGE_SIZE);
  });

  test("a phone renders full-width cards with no horizontal scroll", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    // One dedicated test rather than a second Playwright project: the config
    // declares a single Desktop Chrome project at `workers: 1`, so a second one
    // would double an already-serial suite.
    const desktopRows = await memberRows(page).count();
    await page.setViewportSize({ width: 375, height: 812 });

    // Same elements restyled, so the row count cannot move.
    await expect(memberRows(page)).toHaveCount(desktopRows);

    const first = memberRows(page).first();
    await expect(first.getByTestId("member-link")).toBeVisible();
    await expect(first.locator("td:nth-child(3)").getByTestId("money")).toBeVisible();
    await expect(first.locator("td:nth-child(2)")).toBeHidden();
    await expect(first.locator("td:nth-child(4)")).toBeHidden();

    // A card, not a squeezed table row: it fits the viewport and its three
    // surviving cells stack instead of sitting on one line.
    const card = await first.boundingBox();
    expect(card).not.toBeNull();
    expect(card!.width).toBeLessThanOrEqual(375);
    expect(card!.width).toBeGreaterThan(300);
    expect(card!.height).toBeGreaterThan(60);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  });
});

test.describe("sidebar", () => {
  test("the user switcher changes scope without a restart", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await expect(memberRows(page)).toHaveCount(PAGE_SIZE);

    await loginAs(page, FIXTURE.unrelatedPeer.email);
    await expect(memberRows(page)).toHaveCount(1);
  });

  test("refresh re-syncs and the freshness timestamp moves", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const status = page.getByTestId("sync-status");
    await expect(page.getByTestId("sync-label")).toContainText("Synced");

    const before = await status.getAttribute("data-synced-at");
    expect(before).toBeTruthy();

    await page.getByTestId("sync-refresh").click();
    await expect(status).not.toHaveAttribute("data-synced-at", before!, { timeout: 60_000 });
  });
});

// The last of the Phase-9 stubs is gone: `/requests` was replaced in Phase 11,
// `/analytics` in Phase 12, and `/admin` in Phase 13. Each replacing phase's own
// spec took over the coverage that mattered here — that the destination exists,
// is reachable, and refuses the people it should. For `/admin` that is
// `admin.spec.ts` (`openAdmin`, plus its non-admin 403 test).
