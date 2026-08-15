/**
 * Shared e2e helpers.
 *
 * `loginAs` goes through the dev user switcher rather than writing the cookie
 * directly. Setting `bsl_impersonate` from the test would be faster and would
 * also mean the switcher — the only way a real user of a demo deployment
 * changes identity — was never exercised by anything.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Become `email` and wait until the server has re-rendered as that person.
 *
 * The sidebar's current-user line carries the resolved address in `data-email`,
 * which makes "the switch landed" observable rather than a timing guess.
 */
export async function loginAs(page: Page, email: string): Promise<void> {
  // `/members`, not `/`: `/` now redirects to `/analytics`, and landing every
  // `loginAs` on the analytics page would run five aggregate queries over 250
  // people × 90 days before any test had asserted anything — at `workers: 1`.
  if (!page.url().startsWith("http")) await page.goto("/members");

  const switcher = page.getByTestId("user-switcher");
  await switcher.waitFor();
  await switcher.selectOption(email);

  await expect(page.getByTestId("current-user")).toHaveAttribute("data-email", email);
}

/** Every row currently rendered by the members table. */
export function memberRows(page: Page): Locator {
  return page.getByTestId("member-row");
}

/** One member's row, addressed by employee id rather than by position. */
export function memberRow(page: Page, employeeId: string): Locator {
  return page.locator(`[data-testid="member-row"][data-employee-id="${employeeId}"]`);
}

/**
 * Narrow the list to one person and hand back their row.
 *
 * The list pages at 50, so in a 250-person org a row addressed by id is on
 * page 1 only by luck. Searching first makes "this row renders X" a claim about
 * the row rather than about where the generator happened to sort them.
 */
export async function findMemberRow(
  page: Page,
  employeeId: string,
  name: string,
): Promise<Locator> {
  await page.getByTestId("member-search").fill(name);
  const row = memberRow(page, employeeId);
  await expect(row).toBeVisible();
  return row;
}
