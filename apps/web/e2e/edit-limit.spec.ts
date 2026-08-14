/**
 * Phase 10 acceptance: setting and removing a per-user override.
 *
 * The suite runs with `workers: 1` against one mock and one SQLite file, so
 * these tests are ordered and they clean up after themselves: the "set" test
 * leaves `FIXTURE.ic` with an override that the "remove" test deletes, restoring
 * the seeded universe for whatever runs next.
 *
 * The audit assertions open the e2e database directly rather than adding a
 * test-only route. A read-only route would be a permanent piece of production
 * surface existing solely for a test, and the file is right there.
 */

import Database from "better-sqlite3";
import { FIXTURE } from "@bsl/seed";
import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./helpers";
import { E2E_DATABASE_PATH } from "./paths";

const LIMIT_API = `/api/members/${FIXTURE.ic.id}/limit`;

interface AuditRow {
  action: string;
  actor_email: string;
  target_employee_id: string | null;
  detail: string;
}

/**
 * Every audit entry, oldest first, straight out of the suite's own database.
 *
 * Opened read-write rather than `readonly`: the app runs the file in WAL mode,
 * and a read-only SQLite connection still needs to write the `-shm` index, which
 * makes `readonly: true` the more fragile of the two options here.
 */
function auditRows(): AuditRow[] {
  const db = new Database(E2E_DATABASE_PATH, { fileMustExist: true });
  try {
    return db
      .prepare("SELECT action, actor_email, target_employee_id, detail FROM audit_log ORDER BY id")
      .all() as AuditRow[];
  } finally {
    db.close();
  }
}

async function openMember(page: Page, employeeId: string): Promise<void> {
  await page.goto(`/members/${employeeId}`);
  await expect(page.getByTestId("member-name")).toBeVisible();
}

test.describe.serial("edit limit", () => {
  test("a tier-3 manager sets an override and the page shows it", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openMember(page, FIXTURE.ic.id);

    await expect(page.getByTestId("edit-slot")).toHaveAttribute("data-can-edit", "true");
    await page.getByTestId("set-limit").click();

    const dialog = page.getByTestId("limit-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("amount-input").fill("750");
    await dialog.getByTestId("limit-save").click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("member-limit")).toHaveText("$750.00");
    await expect(page.getByTestId("limit-card").getByTestId("source-badge")).toHaveText("Override");
  });

  test("the same manager removes the override and the limit reverts to an inherited one", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openMember(page, FIXTURE.ic.id);

    const badge = page.getByTestId("limit-card").getByTestId("source-badge");
    await expect(badge).toHaveText("Override");

    await page.getByTestId("remove-override").click();
    const dialog = page.getByTestId("remove-dialog");
    await expect(dialog).toBeVisible();
    // §G4: what they fall back to is only knowable after the delete, so the
    // confirmation names the ladder instead of guessing a number.
    await expect(dialog).toContainText("group, seat-tier, or organisation default");
    await dialog.getByTestId("remove-confirm").click();

    await expect(dialog).toBeHidden();
    await expect(badge).not.toHaveText("Override");
    await expect(page.getByTestId("member-limit")).toHaveText(/^\$[\d,]+\.\d{2}$/);
    // The override is gone, so there is nothing left to remove.
    await expect(page.getByTestId("remove-override")).toHaveCount(0);
  });

  test("the audit log records both writes against the manager who made them", () => {
    const rows = auditRows().filter((row) => row.target_employee_id === FIXTURE.ic.id);
    const actions = rows.map((row) => row.action);

    expect(actions).toContain("set_limit");
    expect(actions).toContain("delete_limit");
    expect(actions.indexOf("set_limit")).toBeLessThan(actions.indexOf("delete_limit"));

    for (const row of rows) {
      expect(row.actor_email).toBe(FIXTURE.tier3ManagerOfIc.email.toLowerCase());
    }

    const set = rows.find((row) => row.action === "set_limit")!;
    expect(JSON.parse(set.detail)).toMatchObject({ new_amount: "75000", outcome: "success" });
  });

  test("the pending increase request is called out, with a link to the queue", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openMember(page, FIXTURE.ic.id);

    const warning = page.getByTestId("pending-warning");
    await expect(warning).toContainText("pending increase request");
    await expect(warning.getByTestId("pending-warning-link")).toHaveAttribute("href", "/requests");
  });

  test("an invalid amount is refused in the browser and never reaches the network", async ({
    page,
  }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);

    let writes = 0;
    await page.route("**/api/members/**", async (route) => {
      writes += 1;
      await route.abort();
    });

    await openMember(page, FIXTURE.ic.id);
    await page.getByTestId("set-limit").click();

    const dialog = page.getByTestId("limit-dialog");
    await dialog.getByTestId("amount-input").fill("-5");

    await expect(dialog.getByTestId("amount-error")).toBeVisible();
    await expect(dialog.getByTestId("limit-save")).toBeDisabled();
    expect(writes).toBe(0);
  });

  test("the direct manager is excluded by the default config", async ({ page }) => {
    // §G8 default `edit_roles` covers tiers 3 and 4 and the AI lead, so a tier-1
    // manager can neither view the page nor drive the endpoint behind it.
    await loginAs(page, FIXTURE.directManagerOfIc.email);
    await page.goto(`/members/${FIXTURE.ic.id}`);

    await expect(page.getByTestId("forbidden")).toBeVisible();
    await expect(page.getByTestId("set-limit")).toHaveCount(0);

    const response = await page.request.post(LIMIT_API, { data: { amount: "75000" } });
    expect(response.status()).toBe(403);
  });

  test("an unrelated IC has no controls and cannot write through the API", async ({ page }) => {
    await loginAs(page, FIXTURE.unrelatedPeer.email);
    await page.goto(`/members/${FIXTURE.ic.id}`);

    await expect(page.getByTestId("forbidden")).toBeVisible();
    await expect(page.getByTestId("set-limit")).toHaveCount(0);

    const post = await page.request.post(LIMIT_API, { data: { amount: "75000" } });
    expect(post.status()).toBe(403);

    const remove = await page.request.delete(LIMIT_API);
    expect(remove.status()).toBe(403);

    // The refusal must leave no trace of a write in the audit log.
    const forbiddenActor = auditRows().filter(
      (row) => row.actor_email === FIXTURE.unrelatedPeer.email.toLowerCase(),
    );
    expect(forbiddenActor).toEqual([]);
  });

  test("the members list reflects the restored inherited limit", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);

    const row = page.locator(`[data-testid="member-row"][data-employee-id="${FIXTURE.ic.id}"]`);
    await expect(row.getByTestId("source-badge")).not.toHaveText("Override");
  });
});
