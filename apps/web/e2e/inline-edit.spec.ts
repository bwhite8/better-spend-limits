/**
 * Phase 7 acceptance: setting a limit from the users list, without opening the
 * detail page.
 *
 * Placement in the run matters. Specs execute in path order, so this file sits
 * between `edit-limit` (which leaves `FIXTURE.ic` on an INHERITED limit, having
 * removed the override it created) and `members`. It therefore starts from the
 * seeded state, creates an override of its own, and hands the same inherited
 * state back in `afterAll` — the pattern `admin.spec.ts` established for a spec
 * that mutates the shared universe.
 *
 * The audit assertion opens the suite's SQLite file directly rather than adding
 * a read-only route that would exist in production solely for a test, exactly as
 * `edit-limit.spec.ts` argues.
 */

import Database from "better-sqlite3";
import { FIXTURE } from "@bsl/seed";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { loginAs, memberRow } from "./helpers";
import { E2E_DATABASE_PATH, WEB_URL } from "./paths";

const LIMIT_PATH = `/api/members/${FIXTURE.ic.id}/limit`;

/** What the test types, and the minor-units string the wire must carry for it. */
const NEW_DOLLARS = "825";
const NEW_MINOR_UNITS = "82500";
/** The list trims `.00` from whole dollars, so the cell reads `$825`. */
const NEW_RENDERED = "$825";

const MANAGER_EMAIL = FIXTURE.tier3ManagerOfIc.email.toLowerCase();

/** A global the page sets and a navigation would destroy. */
const NAVIGATION_PROBE = "__inlineEditProbe";

interface AuditRow {
  actor_email: string;
  detail: string;
}

/**
 * Every `set_limit` entry recorded against `FIXTURE.ic`, oldest first.
 *
 * Opened read-write rather than `readonly`: the app runs the file in WAL mode
 * and a read-only SQLite connection still needs to write the `-shm` index.
 */
function setLimitAudit(): AuditRow[] {
  const db = new Database(E2E_DATABASE_PATH, { fileMustExist: true });
  try {
    return db
      .prepare(
        "SELECT actor_email, detail FROM audit_log WHERE action = 'set_limit' AND target_employee_id = ? ORDER BY id",
      )
      .all(FIXTURE.ic.id) as AuditRow[];
  } finally {
    db.close();
  }
}

/** The scope here is 7 people, so a row is addressable without searching first. */
async function openList(page: Page, email: string): Promise<void> {
  await loginAs(page, email);
  await page.goto("/members");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Users");
}

/** Open the inline editor on a row and hand back the panel. */
async function openEditor(row: Locator): Promise<Locator> {
  await row.getByTestId("member-edit-limit").click();
  const editor = row.getByTestId("member-limit-editor");
  await expect(editor).toBeVisible();
  return editor;
}

/** The Limit cell's rendered amount — column 3, never the spend figure in 5. */
function limitCell(row: Locator): Locator {
  return row.locator("td:nth-child(3)").getByTestId("money");
}

test.describe.serial("inline limit editing", () => {
  test("a tier-3 manager sets a report's limit from the list", async ({ page }) => {
    await openList(page, FIXTURE.tier3ManagerOfIc.email);

    const row = memberRow(page, FIXTURE.ic.id);
    await expect(row).toBeVisible();
    const editor = await openEditor(row);

    // §G4's genuinely surprising rule, repeated where the decision is made: a
    // direct write does NOT resolve the request this member already raised.
    await expect(editor.getByTestId("member-pending-warning")).toContainText(
      "pending increase request",
    );

    // A navigation would wipe this. The row has to update in place.
    await page.evaluate(
      (key) => Object.assign(window, { [key]: true }),
      NAVIGATION_PROBE,
    );

    await editor.getByTestId("amount-input").fill(NEW_DOLLARS);
    const [request] = await Promise.all([
      page.waitForRequest(
        (candidate) => candidate.url().endsWith(LIMIT_PATH) && candidate.method() === "POST",
      ),
      editor.getByTestId("member-limit-save").click(),
    ]);

    // The dollars the user typed, as the minor-units string the API takes.
    expect(request.postData()).toBe(JSON.stringify({ amount: NEW_MINOR_UNITS }));
    expect((await request.response())?.status()).toBe(200);

    await expect(editor).toBeHidden();
    // The editor collapses on success and leaves a "Saved" cue by the button.
    await expect(row.getByTestId("member-limit-saved")).toHaveText("Saved");
    await expect(limitCell(row)).toHaveText(NEW_RENDERED);
    await expect(row.getByTestId("source-badge")).toHaveText("Override");

    const sameDocument = await page.evaluate(
      (key) => (window as unknown as Record<string, unknown>)[key] === true,
      NAVIGATION_PROBE,
    );
    expect(sameDocument, "the row updated without a navigation").toBe(true);
  });

  test("the audit log records the inline write against the manager", () => {
    const rows = setLimitAudit();
    expect(rows.length).toBeGreaterThan(0);

    // `edit-limit.spec.ts` already wrote a `set_limit` row for this member, so
    // the claim is about the newest one, not about "there is one".
    const newest = rows[rows.length - 1]!;
    expect(newest.actor_email).toBe(MANAGER_EMAIL);
    expect(JSON.parse(newest.detail)).toMatchObject({
      new_amount: NEW_MINOR_UNITS,
      outcome: "success",
      // §G4 again, this time as a recorded fact.
      pending_request_unresolved: true,
    });
  });

  test("nobody is offered an editor on a row they may not edit", async ({ page }) => {
    // The manager's OWN row is the case that makes `canEdit` a per-row flag:
    // `visibleEmployees` includes you, and `canEdit(self, self)` is false.
    await openList(page, FIXTURE.tier3ManagerOfIc.email);
    const own = memberRow(page, FIXTURE.tier3ManagerOfIc.id);
    await expect(own).toBeVisible();
    await expect(own.getByTestId("member-edit-limit")).toHaveCount(0);
    // ...while a report on the same page still has one, so this is a per-row
    // decision rather than the feature being switched off.
    await expect(memberRow(page, FIXTURE.ic.id).getByTestId("member-edit-limit")).toBeVisible();

    // An IC whose whole scope is themselves: one row, no editor anywhere.
    await openList(page, FIXTURE.unrelatedPeer.email);
    const alone = memberRow(page, FIXTURE.unrelatedPeer.id);
    await expect(alone).toBeVisible();
    await expect(alone.getByTestId("member-edit-limit")).toHaveCount(0);
    await expect(page.getByTestId("member-edit-limit")).toHaveCount(0);
  });

  test("an invalid amount keeps Save disabled and never reaches the network", async ({ page }) => {
    await openList(page, FIXTURE.tier3ManagerOfIc.email);

    let writes = 0;
    await page.route("**/api/members/**", async (route) => {
      writes += 1;
      await route.abort();
    });

    const editor = await openEditor(memberRow(page, FIXTURE.ic.id));
    await editor.getByTestId("amount-input").fill("12.345");

    await expect(editor.getByTestId("amount-error")).toBeVisible();
    await expect(editor.getByTestId("member-limit-save")).toBeDisabled();
    expect(writes).toBe(0);
  });

  test("the editor is usable on the card layout with no horizontal scroll", async ({ page }) => {
    await openList(page, FIXTURE.tier3ManagerOfIc.email);
    await page.setViewportSize({ width: 375, height: 812 });

    const row = memberRow(page, FIXTURE.ic.id);
    const editor = await openEditor(row);
    await expect(editor.getByTestId("amount-input")).toBeVisible();
    await expect(editor.getByTestId("member-limit-save")).toBeEnabled();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);

    await editor.getByTestId("member-limit-cancel").click();
    await expect(editor).toBeHidden();
  });

  /**
   * Hand the seeded universe back: `members.spec.ts` runs next, and the state it
   * expects is the inherited limit `edit-limit.spec.ts` restored.
   *
   * `afterAll` rather than a final test, because `describe.serial` skips the
   * remaining tests once one fails — which is exactly when the cleanup matters.
   * A 409 (no override to remove, because the first test never got that far) is
   * a fine outcome and not worth failing a run over.
   */
  test.afterAll(async () => {
    try {
      await fetch(`${WEB_URL}${LIMIT_PATH}`, {
        method: "DELETE",
        headers: { cookie: `bsl_impersonate=${MANAGER_EMAIL}` },
      });
    } catch {
      // The suite's last spec overwrites this member's limit anyway.
    }
  });
});
