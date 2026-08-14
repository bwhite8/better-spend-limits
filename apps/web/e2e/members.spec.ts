/**
 * Phase 9 acceptance: the shell, the members list, the member page, and the two
 * dev-only controls in the sidebar.
 *
 * Every persona is a named seed fixture rather than a literal id, so a change to
 * the generator moves these tests with it. `FIXTURE` is computed from
 * `generateOrg(42)`, which is exactly the universe `MOCK_SEED=42` serves.
 */

import { FIXTURE } from "@bsl/seed";
import { expect, test } from "@playwright/test";

import { loginAs, memberRow, memberRows } from "./helpers";

/** §G9: `formatMoney` comma-groups thousands, so `$1,500.00` is a valid limit. */
const MONEY_OR_UNLIMITED = /^(\$[\d,]+\.\d{2}|Unlimited)$/;

const TOTAL_EMPLOYEES = 250;

test.describe("members list", () => {
  test("an admin sees the whole organisation and every nav destination", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    await expect(memberRows(page)).toHaveCount(TOTAL_EMPLOYEES);

    for (const label of ["members", "requests", "analytics", "admin"]) {
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
  });

  test("the seeded unlimited override renders as Unlimited", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const row = memberRow(page, FIXTURE.unlimitedOverrideMember.id);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Unlimited");
  });
});

test.describe("sidebar", () => {
  test("the user switcher changes scope without a restart", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await expect(memberRows(page)).toHaveCount(TOTAL_EMPLOYEES);

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
