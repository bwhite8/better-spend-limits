import { describe, expect, it } from "vitest";

import { compareMinorUnits, isZeroMinorUnits, minorUnitsToNumber, sumMinorUnits } from "@bsl/shared";

import { resolveEffectiveLimit } from "./effective";
import { FIXTURE, getFixtureOrg } from "./fixtures";
import { COST_WINDOW_DAYS, DEFAULT_SEED, EMPLOYEE_COUNT, generateOrg } from "./generate";
import type { SyntheticEmployee, SyntheticOrg } from "./types";

/** Non-negative decimal, minor units — the only amount shape allowed anywhere. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

const org = getFixtureOrg();
const byId = new Map(org.employees.map((employee) => [employee.id, employee]));

function ancestorIds(employee: SyntheticEmployee): (string | null)[] {
  const chain: (string | null)[] = [];
  let current = employee.direct_manager_id;
  for (let i = 0; i < 4; i += 1) {
    chain.push(current);
    current = current === null ? null : (byId.get(current)?.direct_manager_id ?? null);
  }
  return chain;
}

/** Month-to-date spend per employee, exactly as an analytics roll-up would do it. */
function monthToDateSpend(target: SyntheticOrg): Map<string, string> {
  const monthPrefix = target.generatedAt.slice(0, 7);
  const perEmployee = new Map<string, string[]>();
  for (const cost of target.dailyCosts) {
    if (!cost.date.startsWith(monthPrefix)) continue;
    const bucket = perEmployee.get(cost.employeeId);
    if (bucket) bucket.push(cost.amount);
    else perEmployee.set(cost.employeeId, [cost.amount]);
  }
  return new Map(
    [...perEmployee].map(([employeeId, amounts]) => [employeeId, sumMinorUnits(amounts)]),
  );
}

/** Employees whose month-to-date spend has eaten ≥ `threshold` of a positive cap. */
function nearLimitEmployees(target: SyntheticOrg, threshold: number): string[] {
  const spendByEmployee = monthToDateSpend(target);
  return target.employees
    .filter((employee) => {
      const effective = resolveEffectiveLimit(target, employee.id);
      if (effective.amount === null) return false;
      const limit = minorUnitsToNumber(effective.amount);
      if (!(limit > 0)) return false;
      const spend = spendByEmployee.get(employee.id);
      return spend !== undefined && minorUnitsToNumber(spend) / limit >= threshold;
    })
    .map((employee) => employee.id);
}

/**
 * Employees whose month-to-date spend has passed a POSITIVE, FINITE cap.
 *
 * Deliberately exact rather than the float ratio `nearLimitEmployees` uses: the
 * §Phase 5 count is asserted as an equality, so a member sitting on their cap to
 * the last fractional cent must land on the "not over" side of the line.
 */
function overLimitEmployees(target: SyntheticOrg): string[] {
  const spendByEmployee = monthToDateSpend(target);
  return target.employees
    .filter((employee) => {
      const effective = resolveEffectiveLimit(target, employee.id);
      if (effective.amount === null || isZeroMinorUnits(effective.amount)) return false;
      const spend = spendByEmployee.get(employee.id);
      return spend !== undefined && compareMinorUnits(spend, effective.amount) > 0;
    })
    .map((employee) => employee.id);
}

/** The employee holding the one override matching `predicate`, chosen structurally. */
function overrideHolder(target: SyntheticOrg, predicate: (amount: string | null) => boolean): string {
  const override = target.userOverrides.find((entry) => predicate(entry.amount));
  if (!override) throw new Error("test: no override matches the predicate");
  return override.employeeId;
}

/** Employees whose last 7 days are ≥ `factor` × the 7 days before them. */
function weekOverWeekMovers(target: SyntheticOrg, factor: number): string[] {
  const dates = [...new Set(target.dailyCosts.map((cost) => cost.date))].sort();
  const lastWeek = new Set(dates.slice(-7));
  const priorWeek = new Set(dates.slice(-14, -7));
  const windows = new Map<string, { last: string[]; prior: string[] }>();
  for (const cost of target.dailyCosts) {
    const inLast = lastWeek.has(cost.date);
    if (!inLast && !priorWeek.has(cost.date)) continue;
    const window = windows.get(cost.employeeId) ?? { last: [], prior: [] };
    (inLast ? window.last : window.prior).push(cost.amount);
    windows.set(cost.employeeId, window);
  }
  return [...windows]
    .filter(([, window]) => {
      const prior = minorUnitsToNumber(sumMinorUnits(window.prior));
      if (!(prior > 0)) return false;
      return minorUnitsToNumber(sumMinorUnits(window.last)) >= factor * prior;
    })
    .map(([employeeId]) => employeeId);
}

describe("generateOrg — determinism (criterion 1)", () => {
  it("produces deep-equal output for the same seed", () => {
    const pinned = new Date("2026-05-20T11:34:56.789Z");
    expect(generateOrg(DEFAULT_SEED, { now: pinned })).toEqual(
      generateOrg(DEFAULT_SEED, { now: pinned }),
    );
  });

  it("produces deep-equal output across two unpinned calls", () => {
    expect(generateOrg(DEFAULT_SEED)).toEqual(generateOrg(DEFAULT_SEED));
  });

  it("produces a different universe for a different seed", () => {
    const pinned = new Date("2026-05-20T00:00:00.000Z");
    const other = generateOrg(7, { now: pinned });
    const baseline = generateOrg(DEFAULT_SEED, { now: pinned });
    expect(other.employees.map((employee) => employee.email)).not.toEqual(
      baseline.employees.map((employee) => employee.email),
    );
  });

  it("anchors generatedAt to the start of the UTC day", () => {
    const generated = generateOrg(DEFAULT_SEED, { now: new Date("2026-05-20T23:59:59.999Z") });
    expect(generated.generatedAt).toBe("2026-05-20T00:00:00.000Z");
  });
});

describe("employees and hierarchy (criteria 2 & 3)", () => {
  it("has exactly 250 employees with unique lowercase emails and ids", () => {
    expect(org.employees).toHaveLength(250);
    expect(EMPLOYEE_COUNT).toBe(250);
    expect(new Set(org.employees.map((employee) => employee.id)).size).toBe(250);
    expect(new Set(org.employees.map((employee) => employee.email)).size).toBe(250);
    expect(new Set(org.employees.map((employee) => employee.claude_user_id)).size).toBe(250);
    for (const employee of org.employees) {
      expect(employee.email).toBe(employee.email.toLowerCase());
      expect(employee.claude_user_id.startsWith("user_")).toBe(true);
    }
  });

  it("stores each tierN_manager_id as the true Nth ancestor, or null", () => {
    for (const employee of org.employees) {
      const [tier1, tier2, tier3, tier4] = ancestorIds(employee);
      expect(employee.direct_manager_id).toBe(tier1 ?? null);
      expect(employee.tier2_manager_id).toBe(tier2 ?? null);
      expect(employee.tier3_manager_id).toBe(tier3 ?? null);
      expect(employee.tier4_manager_id).toBe(tier4 ?? null);
      for (const id of [tier1, tier2, tier3, tier4]) {
        if (id !== null) expect(byId.has(id)).toBe(true);
      }
    }
  });

  it("gives the CEO an entirely null tier chain and everyone else a manager", () => {
    const roots = org.employees.filter((employee) => employee.direct_manager_id === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.role).toBe("ceo");
    expect(roots[0]!.tier2_manager_id).toBeNull();
    expect(roots[0]!.tier3_manager_id).toBeNull();
    expect(roots[0]!.tier4_manager_id).toBeNull();
  });

  it("gives every IC a complete tier1–tier4 chain", () => {
    const ics = org.employees.filter((employee) => employee.role === "ic");
    expect(ics.length).toBeGreaterThan(150);
    for (const employee of ics) {
      expect(employee.direct_manager_id).not.toBeNull();
      expect(employee.tier2_manager_id).not.toBeNull();
      expect(employee.tier3_manager_id).not.toBeNull();
      expect(employee.tier4_manager_id).not.toBeNull();
    }
  });

  it("aligns every employee to one of 8 existing AI leads, never to themselves", () => {
    const leadIds = new Set<string>();
    for (const employee of org.employees) {
      expect(employee.aligned_ai_lead_id).not.toBeNull();
      expect(employee.aligned_ai_lead_id).not.toBe(employee.id);
      expect(byId.has(employee.aligned_ai_lead_id!)).toBe(true);
      leadIds.add(employee.aligned_ai_lead_id!);
    }
    expect(leadIds.size).toBe(8);
  });

  it("flags a handful of admins, including the CEO", () => {
    const admins = org.employees.filter((employee) => employee.is_admin);
    expect(admins.length).toBeGreaterThanOrEqual(1);
    expect(admins.some((employee) => employee.role === "ceo")).toBe(true);
    // No VP is an admin, so an IC's tier-4 slot always belongs to a non-admin
    // and the Phase 7 permission matrix tests the role rather than admin rights.
    expect(admins.some((employee) => employee.role === "vp")).toBe(false);
  });
});

describe("limits configuration", () => {
  it("configures all four scope levels of the §G4 hierarchy", () => {
    expect(org.orgDefaults.organizationAmount).toBe("25000");
    expect(org.orgDefaults.seatTiers.map((tier) => tier.seatTier)).toEqual([
      "enterprise_standard",
      "enterprise_premium",
    ]);
    expect(Object.keys(org.orgDefaults.seatTierByEmployeeId)).toHaveLength(250);
    expect(org.orgDefaults.rbacGroups).toHaveLength(2);
    const groupMembers = org.orgDefaults.rbacGroups.flatMap((group) => group.memberIds);
    expect(groupMembers).toHaveLength(40);
    expect(new Set(groupMembers).size).toBe(40); // memberships are disjoint
    expect(org.userOverrides).toHaveLength(15);
  });

  it("includes exactly one unlimited and one zero-cap per-user override", () => {
    expect(org.userOverrides.filter((override) => override.amount === null)).toHaveLength(1);
    expect(org.userOverrides.filter((override) => override.amount === "0")).toHaveLength(1);
  });

  it("resolves effective limits by the user > rbac > seat_tier > organization precedence", () => {
    const sources = org.employees.map(
      (employee) => resolveEffectiveLimit(org, employee.id).source?.type,
    );
    expect(sources.filter((type) => type === "user")).toHaveLength(15);
    expect(sources.filter((type) => type === "rbac_group").length).toBeGreaterThan(0);
    expect(sources.filter((type) => type === "seat_tier").length).toBeGreaterThan(0);
    expect(sources.every((type) => type !== undefined)).toBe(true);

    expect(resolveEffectiveLimit(org, FIXTURE.unlimitedOverrideMember.id)).toMatchObject({
      amount: null,
      source: { type: "user" },
    });
    expect(resolveEffectiveLimit(org, FIXTURE.zeroCapMember.id)).toMatchObject({
      amount: "0",
      source: { type: "user" },
    });
    expect(resolveEffectiveLimit(org, FIXTURE.seatTierOnlyMember.id).source?.type).toBe("seat_tier");
  });
});

describe("increase requests (criterion 4)", () => {
  it("holds 6 pending, 4 approved and 2 denied requests from existing employees", () => {
    expect(org.increaseRequests).toHaveLength(12);
    const byStatus = (status: string) =>
      org.increaseRequests.filter((request) => request.status === status);
    expect(byStatus("pending")).toHaveLength(6);
    expect(byStatus("approved")).toHaveLength(4);
    expect(byStatus("denied")).toHaveLength(2);

    for (const request of org.increaseRequests) {
      const requester = byId.get(request.employeeId);
      expect(requester).toBeDefined();
      expect(request.userId).toBe(requester!.claude_user_id);
      expect(request.id.startsWith("slir_")).toBe(true);
    }
  });

  it("never gives one member two pending requests", () => {
    const pendingRequesters = org.increaseRequests
      .filter((request) => request.status === "pending")
      .map((request) => request.employeeId);
    expect(new Set(pendingRequesters).size).toBe(pendingRequesters.length);
  });

  it("resolves only non-pending requests, always after they were created", () => {
    for (const request of org.increaseRequests) {
      if (request.status === "pending") {
        expect(request.resolvedAt).toBeNull();
      } else {
        expect(request.resolvedAt).not.toBeNull();
        expect(request.resolvedAt! > request.createdAt).toBe(true);
      }
      // Trailing 45 days, per §Phase 3.
      const ageDays = (Date.parse(org.generatedAt) - Date.parse(request.createdAt)) / 86_400_000;
      expect(ageDays).toBeGreaterThan(0);
      expect(ageDays).toBeLessThanOrEqual(45);
    }
  });
});

describe("named fixtures (criterion 5)", () => {
  it("points at the real manager chain and AI lead of FIXTURE.ic", () => {
    const ic = org.employees.find((employee) => employee.id === FIXTURE.ic.id)!;
    expect(ic).toBeDefined();
    expect(FIXTURE.directManagerOfIc.id).toBe(ic.direct_manager_id);
    expect(FIXTURE.tier3ManagerOfIc.id).toBe(ic.tier3_manager_id);
    expect(FIXTURE.tier4ManagerOfIc.id).toBe(ic.tier4_manager_id);
    expect(FIXTURE.aiLeadOfIc.id).toBe(ic.aligned_ai_lead_id);
  });

  it("keeps the four editors distinct and free of admin rights", () => {
    const editors = [
      FIXTURE.directManagerOfIc,
      FIXTURE.tier3ManagerOfIc,
      FIXTURE.tier4ManagerOfIc,
      FIXTURE.aiLeadOfIc,
    ];
    expect(new Set(editors.map((employee) => employee.id)).size).toBe(4);
    for (const editor of editors) expect(editor.is_admin).toBe(false);
    expect(FIXTURE.ic.is_admin).toBe(false);
    expect(FIXTURE.ic.role).toBe("ic");
    // Nothing overrides FIXTURE.ic, so Phase 10's "set a limit" flow is a real
    // transition from an inherited source to `source.type === "user"`.
    expect(org.userOverrides.some((override) => override.employeeId === FIXTURE.ic.id)).toBe(false);
  });

  it("keeps unrelatedPeer outside FIXTURE.ic's chain and out of every edit role", () => {
    const peer = FIXTURE.unrelatedPeer;
    expect(peer.is_admin).toBe(false);
    expect(peer.id).not.toBe(FIXTURE.ic.id);
    expect([
      FIXTURE.ic.direct_manager_id,
      FIXTURE.ic.tier2_manager_id,
      FIXTURE.ic.tier3_manager_id,
      FIXTURE.ic.tier4_manager_id,
      FIXTURE.ic.aligned_ai_lead_id,
    ]).not.toContain(peer.id);
    // Nobody reports to them and nobody is aligned to them, so their §G8
    // visible set is exactly themselves.
    for (const employee of org.employees) {
      expect(employee.tier3_manager_id).not.toBe(peer.id);
      expect(employee.tier4_manager_id).not.toBe(peer.id);
      expect(employee.aligned_ai_lead_id).not.toBe(peer.id);
    }
  });

  it("ties pendingRequestByIc to FIXTURE.ic and keeps a counterpart out of scope", () => {
    expect(FIXTURE.pendingRequestByIc.status).toBe("pending");
    expect(FIXTURE.pendingRequestByIc.employeeId).toBe(FIXTURE.ic.id);

    const tier3 = FIXTURE.tier3ManagerOfIc.id;
    const inScope = org.increaseRequests.filter((request) => {
      const requester = byId.get(request.employeeId)!;
      return (
        request.status === "pending" &&
        (requester.tier3_manager_id === tier3 ||
          requester.tier4_manager_id === tier3 ||
          requester.aligned_ai_lead_id === tier3)
      );
    });
    // §Phase 3: at least two pending requests are actionable by this fixture.
    expect(inScope.length).toBeGreaterThanOrEqual(2);

    const outsider = byId.get(FIXTURE.pendingRequestOutsideTier3Scope.employeeId)!;
    expect(FIXTURE.pendingRequestOutsideTier3Scope.status).toBe("pending");
    expect(outsider.tier3_manager_id).not.toBe(tier3);
    expect(outsider.tier4_manager_id).not.toBe(tier3);
    expect(outsider.aligned_ai_lead_id).not.toBe(tier3);
  });

  it("exposes an admin, the CEO, and distinct limit-shape members", () => {
    expect(FIXTURE.admin.is_admin).toBe(true);
    expect(FIXTURE.admin.role).not.toBe("ceo");
    expect(FIXTURE.ceo.role).toBe("ceo");
    expect(FIXTURE.ceo.tier4_manager_id).toBeNull();

    const ids = [
      FIXTURE.unrelatedPeer.id,
      FIXTURE.outsideTier3Scope.id,
      FIXTURE.seatTierOnlyMember.id,
      FIXTURE.unlimitedOverrideMember.id,
      FIXTURE.zeroCapMember.id,
      FIXTURE.overrideMember.id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(resolveEffectiveLimit(org, FIXTURE.overrideMember.id).source?.type).toBe("user");
  });
});

describe("daily costs (criteria 6 & 7)", () => {
  it("covers a trailing 90-day window ending on generatedAt", () => {
    const dates = [...new Set(org.dailyCosts.map((cost) => cost.date))].sort();
    expect(dates.at(-1)).toBe(org.generatedAt.slice(0, 10));
    expect(dates).toHaveLength(COST_WINDOW_DAYS);
    expect(new Set(org.dailyCosts.map((cost) => cost.employeeId)).size).toBeGreaterThanOrEqual(200);
  });

  it("emits well-formed decimal minor-unit amounts everywhere, including fractional cents", () => {
    for (const cost of org.dailyCosts) expect(cost.amount).toMatch(AMOUNT_PATTERN);
    for (const override of org.userOverrides) {
      if (override.amount !== null) expect(override.amount).toMatch(AMOUNT_PATTERN);
    }
    for (const tier of org.orgDefaults.seatTiers) expect(tier.amount).toMatch(AMOUNT_PATTERN);
    for (const group of org.orgDefaults.rbacGroups) expect(group.amount).toMatch(AMOUNT_PATTERN);
    expect(org.orgDefaults.organizationAmount).toMatch(AMOUNT_PATTERN);

    const fractional = org.dailyCosts.filter((cost) => cost.amount.includes("."));
    expect(fractional.length).toBeGreaterThan(0);
  });

  it("pushes at least 8 members to 80% of their effective monthly limit", () => {
    expect(nearLimitEmployees(org, 0.8).length).toBeGreaterThanOrEqual(8);
  });

  it("gives at least 10 members a 3x week-over-week jump", () => {
    expect(weekOverWeekMovers(org, 3).length).toBeGreaterThanOrEqual(10);
  });

  it("still hits both cohorts when the current month has only one elapsed day", () => {
    // The near-limit cohort spreads a target across the month-to-date days; a
    // 1-day month is the degenerate case where one row carries the whole total.
    const firstOfMonth = generateOrg(DEFAULT_SEED, { now: new Date("2026-06-01T06:00:00.000Z") });
    expect(nearLimitEmployees(firstOfMonth, 0.8).length).toBeGreaterThanOrEqual(8);
    expect(weekOverWeekMovers(firstOfMonth, 3).length).toBeGreaterThanOrEqual(10);
    for (const cost of firstOfMonth.dailyCosts) expect(cost.amount).toMatch(AMOUNT_PATTERN);
  });
});

describe("the over-limit cohort (§Phase 5)", () => {
  /**
   * Month-to-date spend accumulates while the cap stays fixed, so the natural
   * over-limit population is a function of the calendar: on seed 42 it was 0 on
   * the 1st, 6 by the 14th and 12 by the 28th. Any single date would therefore
   * pass by coincidence — these three pin the start, middle and end of a month.
   */
  const PINNED_DATES = ["2026-08-01", "2026-08-15", "2026-08-28"] as const;

  const generated = new Map<string, SyntheticOrg>();
  const orgOn = (date: string): SyntheticOrg => {
    let target = generated.get(date);
    if (!target) {
      target = generateOrg(DEFAULT_SEED, { now: new Date(`${date}T09:15:00.000Z`) });
      generated.set(date, target);
    }
    return target;
  };

  for (const date of PINNED_DATES) {
    describe(`generated on ${date}`, () => {
      it("puts exactly 2 members over a positive, finite cap", () => {
        expect(overLimitEmployees(orgOn(date))).toHaveLength(2);
      });

      it("leaves the zero-cap member out of the count, still spending", () => {
        // §G9's "at cap" UI path needs a subject with a `"0"` override AND real
        // spend; the clamp must not have emptied their month.
        const target = orgOn(date);
        const zeroCap = overrideHolder(target, (amount) => amount === "0");
        expect(overLimitEmployees(target)).not.toContain(zeroCap);
        const spend = monthToDateSpend(target).get(zeroCap);
        expect(spend).toBeDefined();
        expect(compareMinorUnits(spend!, "0")).toBe(1);
      });

      it("leaves the unlimited member with cost rows and out of the count", () => {
        const target = orgOn(date);
        const unlimited = overrideHolder(target, (amount) => amount === null);
        expect(target.dailyCosts.some((cost) => cost.employeeId === unlimited)).toBe(true);
        expect(overLimitEmployees(target)).not.toContain(unlimited);
      });

      it("keeps the near-limit and week-over-week cohorts intact", () => {
        // The clamp rescales current-month days and (for a mover) the prior week
        // by the same factor; both engineered cohorts must survive it.
        const target = orgOn(date);
        expect(nearLimitEmployees(target, 0.8).length).toBeGreaterThanOrEqual(8);
        expect(weekOverWeekMovers(target, 3).length).toBeGreaterThanOrEqual(10);
        for (const cost of target.dailyCosts) expect(cost.amount).toMatch(AMOUNT_PATTERN);
      });
    });
  }
});
