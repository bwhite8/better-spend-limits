/**
 * Phase 12's arithmetic, proved against a real sync of the seed-42 universe.
 *
 * The aggregations are only as trustworthy as the data shape they assume, so
 * these tests run against the REAL mock over real HTTP (the Phase-8 harness) and
 * a real migrated database rather than hand-built rows. That is what makes the
 * assertions meaningful: the ≥8 near-limit and ≥10 mover cohorts are guarantees
 * §Phase 3 engineered into the generator, and they only survive to here if the
 * analytics endpoint, the sync, the two-legged member join and the sums all
 * agree. A fixture table would prove none of that.
 *
 * The clock is a mutable closure shared by the mock and the sync (never a
 * rebuilt `MockState` — regenerating shifts the whole 90-day cost window), which
 * is what lets the provisional-tail test observe a watermark moving.
 */

import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { FIXTURE } from "@bsl/seed";
import { compareMinorUnits, minorUnitsToNumber, sumMinorUnits } from "@bsl/shared";
import { createApp, DEFAULT_ADMIN_KEY, DEFAULT_ANALYTICS_KEY, MockState } from "mock-api";
import { getFixtureOrg } from "@bsl/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { seedDatabase } from "@/db/seed";
import { employees, userDailyCost, type Employee } from "@/db/schema";
import { AnthropicClient } from "@/lib/anthropic/client";
import {
  costWatermark,
  dailyTotals,
  dateSeries,
  monthStart,
  nearLimit,
  resolveScope,
  shiftDays,
  toIsoDate,
  topSpenders,
  windowEnding,
  wowMovers,
  WEEK_DAYS,
} from "@/lib/analytics-queries";
import { loadEditRoles, visibleEmployees } from "@/lib/permissions";
import { syncCosts, syncEffective } from "@/lib/sync";

/* -------------------------------------------------------------------------- */
/* Pure date helpers                                                          */
/* -------------------------------------------------------------------------- */

describe("date windows", () => {
  it("counts the end day itself as one of the days", () => {
    expect(windowEnding(new Date("2026-08-13T09:00:00.000Z"), 7)).toEqual({
      from: "2026-08-07",
      to: "2026-08-13",
    });
  });

  it("fills every day between the bounds, inclusive", () => {
    expect(dateSeries("2026-02-26", "2026-03-02")).toEqual([
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("anchors month-to-date on the first of the UTC month", () => {
    expect(monthStart(new Date("2026-08-13T23:59:59.000Z"))).toBe("2026-08-01");
  });
});

/* -------------------------------------------------------------------------- */
/* Against the real mock                                                      */
/* -------------------------------------------------------------------------- */

interface MockServer {
  baseUrl: string;
  close(): Promise<void>;
}

async function startMock(now: () => Date): Promise<MockServer> {
  const state = new MockState({ org: getFixtureOrg(), now });
  const app = createApp({
    state,
    now,
    adminKey: DEFAULT_ADMIN_KEY,
    analyticsKey: DEFAULT_ANALYTICS_KEY,
    rateLimit: "off",
  });

  let server: ServerType | undefined;
  const info = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, resolve);
  });
  const handle = server as ServerType;

  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        (handle as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        handle.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("analytics queries", () => {
  let mock: MockServer;
  let db: AppDatabase;
  let client: AnthropicClient;
  let clock: Date;

  let admin: Employee;
  let tier3: Employee;
  let peer: Employee;
  let adminScope: string[];
  let tier3Scope: string[];

  const employeeById = (id: string): Employee =>
    db.select().from(employees).where(eq(employees.id, id)).get()!;

  beforeAll(async () => {
    clock = new Date();
    mock = await startMock(() => clock);

    db = createDb(IN_MEMORY_DATABASE);
    runMigrations(db);
    seedDatabase(db);

    client = new AnthropicClient({
      baseUrl: mock.baseUrl,
      adminKey: DEFAULT_ADMIN_KEY,
      analyticsKey: DEFAULT_ANALYTICS_KEY,
      maxRetries: 0,
      env: {},
    });

    await syncEffective(db, client, { now: () => clock });
    await syncCosts(db, client, { now: () => clock });

    admin = employeeById(FIXTURE.admin.id);
    tier3 = employeeById(FIXTURE.tier3ManagerOfIc.id);
    peer = employeeById(FIXTURE.unrelatedPeer.id);

    const editRoles = loadEditRoles(db);
    adminScope = visibleEmployees(db, admin, editRoles).map((row) => row.id);
    tier3Scope = visibleEmployees(db, tier3, editRoles).map((row) => row.id);
  }, 120_000);

  afterAll(async () => {
    db.$client.close();
    await mock.close();
  });

  /* ---------------------------------------------------------------------- */

  describe("resolveScope", () => {
    it("joins every visible employee to their synced snapshot", () => {
      const scope = resolveScope(db, adminScope);

      expect(scope).toHaveLength(250);
      expect(scope.every((member) => member.userId !== null)).toBe(true);
      expect(scope.every((member) => member.snapshot !== null)).toBe(true);
    });

    it("still finds a member whose claude_user_id was never backfilled (email leg)", () => {
      const ic = employeeById(FIXTURE.ic.id);
      db.update(employees).set({ claude_user_id: null }).where(eq(employees.id, ic.id)).run();

      const [member] = resolveScope(db, [ic.id]);
      expect(member?.userId).toBe(ic.claude_user_id);

      db.update(employees)
        .set({ claude_user_id: ic.claude_user_id })
        .where(eq(employees.id, ic.id))
        .run();
    });

    it("returns nothing for an empty scope rather than everything", () => {
      expect(resolveScope(db, [])).toEqual([]);
      expect(dailyTotals(db, [], 7, { now: clock }).every((day) => day.amount === "0")).toBe(true);
      expect(nearLimit(db, [], 0.8)).toEqual([]);
      expect(wowMovers(db, [], 3, { now: clock })).toEqual([]);
      expect(topSpenders(db, [], 10, { now: clock })).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe("dailyTotals", () => {
    it("emits exactly one row per day in the window, oldest first", () => {
      const totals = dailyTotals(db, adminScope, 30, { now: clock });
      const { from, to } = windowEnding(clock, 30);

      expect(totals).toHaveLength(30);
      expect(totals[0]?.date).toBe(from);
      expect(totals.at(-1)?.date).toBe(to);
      expect(totals.map((day) => day.date)).toEqual([...totals.map((day) => day.date)].sort());
      expect(new Set(totals.map((day) => day.date)).size).toBe(30);
    });

    it("marks a day provisional if and only if it is after the stored watermark (§G5)", () => {
      const watermark = costWatermark(db);
      expect(watermark).toBeTruthy();

      const totals = dailyTotals(db, adminScope, 30, { now: clock });
      for (const day of totals) {
        expect(day.provisional).toBe(day.date > watermark!.slice(0, 10));
      }

      // The mock's watermark is now − 36h, so the tail is never empty.
      expect(totals.filter((day) => day.provisional).length).toBeGreaterThanOrEqual(1);
    });

    it("sums the underlying rows exactly, and zero-fills days with no usage", () => {
      const totals = dailyTotals(db, adminScope, 30, { now: clock });
      const { from, to } = windowEnding(clock, 30);

      const stored = db.select().from(userDailyCost).all();
      const inWindow = stored.filter((row) => row.date >= from && row.date <= to);
      const expected = sumMinorUnits(inWindow.map((row) => row.amount));

      expect(sumMinorUnits(totals.map((day) => day.amount))).toBe(expected);

      const dayWithRows = totals.find((day) => day.date === inWindow[0]?.date);
      expect(dayWithRows?.amount).not.toBe("0");
    });

    it("keeps a narrower scope strictly below the org total", () => {
      const orgTotal = sumMinorUnits(dailyTotals(db, adminScope, 30, { now: clock }).map((d) => d.amount));
      const teamTotal = sumMinorUnits(dailyTotals(db, tier3Scope, 30, { now: clock }).map((d) => d.amount));

      expect(compareMinorUnits(teamTotal, orgTotal)).toBe(-1);
      expect(minorUnitsToNumber(teamTotal)).toBeGreaterThan(0);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe("nearLimit", () => {
    it("finds the seeded near-limit cohort, every row genuinely at or past the threshold", () => {
      const rows = nearLimit(db, adminScope, 0.8);

      // §Phase 3 engineers ten members to 82–96% of their cap.
      expect(rows.length).toBeGreaterThanOrEqual(8);
      for (const row of rows) {
        expect(row.ratio >= 0.8 || row.atCap).toBe(true);
        expect(row.amount).not.toBeNull();
      }
    });

    it("sorts by ratio, worst first", () => {
      const ratios = nearLimit(db, adminScope, 0.8).map((row) => row.ratio);
      expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
    });

    it("includes the zero-cap member as at-cap and excludes the unlimited one (§G9)", () => {
      const rows = nearLimit(db, adminScope, 0.8);
      const ids = rows.map((row) => row.employeeId);

      const zero = rows.find((row) => row.employeeId === FIXTURE.zeroCapMember.id);
      expect(zero?.atCap).toBe(true);
      expect(zero?.amount).toBe("0");

      // No cap means no ratio — an unlimited member can never be "near" it.
      expect(ids).not.toContain(FIXTURE.unlimitedOverrideMember.id);
    });

    it("never reports somebody outside the viewer's scope", () => {
      const scoped = nearLimit(db, tier3Scope, 0.8).map((row) => row.employeeId);
      const inScope = new Set(tier3Scope);

      expect(scoped.every((id) => inScope.has(id))).toBe(true);
      expect(scoped.length).toBeLessThanOrEqual(nearLimit(db, adminScope, 0.8).length);
    });

    it("raising the threshold can only narrow the result", () => {
      const loose = nearLimit(db, adminScope, 0.8).map((row) => row.employeeId);
      const strict = nearLimit(db, adminScope, 0.95).map((row) => row.employeeId);

      expect(strict.every((id) => loose.includes(id))).toBe(true);
      expect(strict.length).toBeLessThanOrEqual(loose.length);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe("wowMovers", () => {
    it("finds the seeded spike cohort", () => {
      const rows = wowMovers(db, adminScope, 3, { now: clock });

      // §Phase 3 engineers twelve members to 3.8–4.6x.
      expect(rows.length).toBeGreaterThanOrEqual(10);
    });

    it("reports sums that match the rows the window covers", () => {
      const rows = wowMovers(db, adminScope, 3, { now: clock });
      const scope = new Map(resolveScope(db, adminScope).map((m) => [m.employeeId, m.userId]));

      const last = windowEnding(clock, WEEK_DAYS);
      const prior = windowEnding(shiftDays(clock, -WEEK_DAYS), WEEK_DAYS);

      for (const row of rows.slice(0, 5)) {
        const userId = scope.get(row.employeeId)!;
        const costs = db
          .select()
          .from(userDailyCost)
          .where(eq(userDailyCost.user_id, userId))
          .all();

        expect(row.lastWeek).toBe(
          sumMinorUnits(
            costs.filter((c) => c.date >= last.from && c.date <= last.to).map((c) => c.amount),
          ),
        );
        expect(row.priorWeek).toBe(
          sumMinorUnits(
            costs.filter((c) => c.date >= prior.from && c.date <= prior.to).map((c) => c.amount),
          ),
        );
      }
    });

    it("every finite multiple really clears the bar, and the list is ordered by it", () => {
      const rows = wowMovers(db, adminScope, 3, { now: clock });
      const finite = rows.filter((row) => row.multiple !== null);

      for (const row of finite) {
        expect(row.multiple!).toBeGreaterThanOrEqual(3);
        expect(minorUnitsToNumber(row.lastWeek)).toBeGreaterThanOrEqual(
          3 * minorUnitsToNumber(row.priorWeek),
        );
      }
      expect(finite.map((row) => row.multiple)).toEqual(
        [...finite.map((row) => row.multiple)].sort((a, b) => b! - a!),
      );
      // A jump from nothing has no multiple and is reported first.
      expect(rows.slice(0, rows.length - finite.length).every((row) => row.multiple === null)).toBe(
        true,
      );
    });

    it("raising the multiple can only narrow the result, and scope is respected", () => {
      const at3 = wowMovers(db, adminScope, 3, { now: clock }).map((row) => row.employeeId);
      const at10 = wowMovers(db, adminScope, 10, { now: clock }).map((row) => row.employeeId);
      expect(at10.every((id) => at3.includes(id))).toBe(true);

      const inScope = new Set(tier3Scope);
      expect(
        wowMovers(db, tier3Scope, 3, { now: clock }).every((row) => inScope.has(row.employeeId)),
      ).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe("topSpenders", () => {
    it("returns at most n members, biggest month-to-date first", () => {
      const rows = topSpenders(db, adminScope, 10, { now: clock });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(10);
      for (let i = 1; i < rows.length; i += 1) {
        expect(compareMinorUnits(rows[i - 1]!.amount, rows[i]!.amount)).not.toBe(-1);
      }
    });

    it("sums only the current UTC month", () => {
      const rows = topSpenders(db, adminScope, 3, { now: clock });
      const scope = new Map(resolveScope(db, adminScope).map((m) => [m.employeeId, m.userId]));
      const from = monthStart(clock);
      const to = toIsoDate(clock);

      for (const row of rows) {
        const costs = db
          .select()
          .from(userDailyCost)
          .where(eq(userDailyCost.user_id, scope.get(row.employeeId)!))
          .all()
          .filter((c) => c.date >= from && c.date <= to);

        expect(row.amount).toBe(sumMinorUnits(costs.map((c) => c.amount)));
      }
    });

    it("a single-member scope reports only that member", () => {
      const rows = topSpenders(db, [peer.id], 10, { now: clock });
      expect(rows.map((row) => row.employeeId)).toEqual(
        rows.length === 0 ? [] : [peer.id],
      );
    });
  });
});
