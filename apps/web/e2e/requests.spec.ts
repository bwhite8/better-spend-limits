/**
 * Phase 11 acceptance: the approve / deny queue.
 *
 * This file is deliberately the LAST one Playwright runs (specs run in path
 * order, and `requests` sorts after `admin`, `analytics`, `edit-limit` and
 * `members`), because unlike Phase 10's edit flows these tests CANNOT restore
 * the universe afterwards: §G4 has no endpoint that reopens a resolved request.
 * Approving `FIXTURE.ic`'s request also leaves them with a $900 override for the
 * rest of the run. Anything added later that sorts after this file has to expect
 * that state.
 *
 * The audit assertions open the suite's own SQLite file directly, the same way
 * `edit-limit.spec.ts` does — the alternative is a test-only route living
 * permanently in production surface.
 */

import Database from "better-sqlite3";
import { FIXTURE, getFixtureOrg } from "@bsl/seed";
import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./helpers";
import { E2E_DATABASE_PATH } from "./paths";

const org = getFixtureOrg();
const employeeById = new Map(org.employees.map((employee) => [employee.id, employee]));

/**
 * A second pending request inside the tier-3 manager's scope — the one that gets
 * denied. The fixture anchor guarantees this manager owns at least two pending
 * requesters, so it exists by construction rather than by luck.
 */
const DENY_TARGET = org.increaseRequests.find(
  (request) =>
    request.status === "pending" &&
    request.id !== FIXTURE.pendingRequestByIc.id &&
    employeeById.get(request.employeeId)?.tier3_manager_id === FIXTURE.tier3ManagerOfIc.id,
);
if (!DENY_TARGET) throw new Error("e2e: the tier-3 manager owns no second pending request");

const DENY_REQUESTER = employeeById.get(DENY_TARGET.employeeId)!;
const OUTSIDE_REQUESTER = employeeById.get(FIXTURE.pendingRequestOutsideTier3Scope.employeeId)!;

interface AuditRow {
  action: string;
  actor_email: string;
  target_employee_id: string | null;
  detail: string;
}

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

function card(page: Page, requestId: string) {
  return page.locator(`[data-testid="request-card"][data-request-id="${requestId}"]`);
}

async function openQueue(page: Page, tab: "pending" | "resolved" = "pending"): Promise<void> {
  await page.goto(tab === "pending" ? "/requests" : "/requests?tab=resolved");
  // The nav destination Phase 9 stubbed out is now this page.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Requests");
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("data-active", "true");
}

test.describe.serial("increase requests", () => {
  test("a tier-3 manager sees their own people's requests and nobody else's", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openQueue(page);

    const mine = card(page, FIXTURE.pendingRequestByIc.id);
    await expect(mine).toBeVisible();
    await expect(mine.getByTestId("requester-name")).toHaveText(FIXTURE.ic.name);
    await expect(mine.getByTestId("requester-name")).toHaveAttribute(
      "href",
      `/members/${FIXTURE.ic.id}`,
    );

    // §G8: out of scope is not "read only", it is absent.
    await expect(card(page, FIXTURE.pendingRequestOutsideTier3Scope.id)).toHaveCount(0);
    await expect(
      page.getByTestId("requester-name").filter({ hasText: OUTSIDE_REQUESTER.name }),
    ).toHaveCount(0);

    // Their scope is a real subset: at least two (the fixture anchor) and fewer
    // than the six an admin sees.
    const cards = await page.getByTestId("request-card").count();
    expect(cards).toBeGreaterThanOrEqual(2);
    expect(cards).toBeLessThan(6);
  });

  test("an admin sees all six pending requests", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await openQueue(page);

    await expect(page.getByTestId("request-card")).toHaveCount(6);
    await expect(page.getByTestId("tab-pending-count")).toHaveText("6");
  });

  test("a pending card carries the spend context the decision needs", async ({ page }) => {
    await loginAs(page, FIXTURE.admin.email);
    await openQueue(page);

    const mine = card(page, FIXTURE.pendingRequestByIc.id);
    // §G4 attaches a live limit + spend to pending rows; §G9 says the cap may be
    // "Unlimited" instead of a figure.
    await expect(mine.getByTestId("request-limit")).toHaveText(/^(\$[\d,]+\.\d{2}|Unlimited)$/);
    await expect(mine.getByTestId("spend-bar")).toBeVisible();
    await expect(mine.getByTestId("summary-unavailable")).toHaveCount(0);
  });

  test("approving resolves the request and writes the member's new limit", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openQueue(page);

    const mine = card(page, FIXTURE.pendingRequestByIc.id);
    await mine.getByTestId("approve-open").click();

    const dialog = mine.getByTestId("approve-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("amount-input").fill("900");
    await dialog.getByTestId("approve-confirm").click();

    // The decision is confirmed in place for a beat before the resolved card is
    // swept out of the pending tab.
    await expect(mine.getByTestId("request-done")).toContainText("Approved");
    // Resolved requests leave the pending tab entirely.
    await expect(mine).toHaveCount(0);

    await openQueue(page, "resolved");
    const resolved = card(page, FIXTURE.pendingRequestByIc.id);
    await expect(resolved).toBeVisible();
    await expect(resolved).toHaveAttribute("data-status", "approved");
    await expect(resolved.getByTestId("request-status")).toHaveText("approved");
    // Read-only: no decision controls on a resolved card.
    await expect(resolved.getByTestId("approve-open")).toHaveCount(0);

    // §G4 endpoint 7: approving writes the per-user override as well.
    await page.goto(`/members/${FIXTURE.ic.id}`);
    await expect(page.getByTestId("member-limit")).toHaveText("$900.00");
    await expect(page.getByTestId("limit-card").getByTestId("source-badge")).toHaveText("Override");
    // The request is resolved, so the member page no longer warns about one.
    await expect(page.getByTestId("pending-warning")).toHaveCount(0);
  });

  test("denying another in-scope request moves it to resolved", async ({ page }) => {
    await loginAs(page, FIXTURE.tier3ManagerOfIc.email);
    await openQueue(page);

    const target = card(page, DENY_TARGET.id);
    await expect(target.getByTestId("requester-name")).toHaveText(DENY_REQUESTER.name);
    await target.getByTestId("deny-open").click();

    const dialog = target.getByTestId("deny-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("deny-confirm").click();

    await expect(target.getByTestId("request-done")).toContainText("Denied");
    await expect(target).toHaveCount(0);
    await expect(page.getByTestId("request-error")).toHaveCount(0);

    await openQueue(page, "resolved");
    const resolved = card(page, DENY_TARGET.id);
    await expect(resolved).toHaveAttribute("data-status", "denied");
    await expect(resolved.getByTestId("request-status")).toHaveText("denied");
  });

  test("an unrelated IC has an empty queue and cannot drive the endpoint", async ({ page }) => {
    await loginAs(page, FIXTURE.unrelatedPeer.email);
    await openQueue(page);

    await expect(page.getByTestId("request-card")).toHaveCount(0);
    await expect(page.getByTestId("requests-empty")).toBeVisible();
    await expect(page.getByTestId("tab-pending-count")).toHaveText("0");

    const response = await page.request.post(
      `/api/requests/${FIXTURE.pendingRequestOutsideTier3Scope.id}`,
      { data: { action: "deny" } },
    );
    expect(response.status()).toBe(403);

    // The refusal must leave no trace of a decision in the audit log.
    expect(
      auditRows().filter((row) => row.actor_email === FIXTURE.unrelatedPeer.email.toLowerCase()),
    ).toEqual([]);
  });

  test("the audit log records both decisions against the manager who made them", () => {
    const rows = auditRows().filter(
      (row) => row.action === "approve_request" || row.action === "deny_request",
    );
    const actions = rows.map((row) => row.action);

    expect(actions).toContain("approve_request");
    expect(actions).toContain("deny_request");

    for (const row of rows) {
      expect(row.actor_email).toBe(FIXTURE.tier3ManagerOfIc.email.toLowerCase());
    }

    const approved = rows.find((row) => row.action === "approve_request")!;
    expect(approved.target_employee_id).toBe(FIXTURE.ic.id);
    expect(approved.detail).toContain('"amount":"90000"');
    expect(JSON.parse(approved.detail)).toMatchObject({
      outcome: "success",
      status_after: "approved",
      request_id: FIXTURE.pendingRequestByIc.id,
    });

    const denied = rows.find((row) => row.action === "deny_request")!;
    expect(JSON.parse(denied.detail)).toMatchObject({
      outcome: "success",
      status_after: "denied",
      request_id: DENY_TARGET.id,
    });
  });
});
