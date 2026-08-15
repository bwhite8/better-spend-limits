/**
 * Named people (and one request) from the seed-42 universe (plan §Phase 3).
 *
 * Every test and Playwright spec in this repo refers to the synthetic org
 * through these names rather than through hard-coded ids, so a change to the
 * generator moves the fixtures with it instead of breaking twelve suites.
 *
 * All selections are STRUCTURAL — "the first IC, in id order, whose tier-3
 * manager also manages another pending requester" — never a literal id. They
 * are stable as long as `generateOrg(42)` is stable, and they carry guarantees
 * the permission tests depend on:
 *
 * - `ic` is an ordinary IC: not an admin, not an AI lead, no per-user override,
 *   and with a complete tier1–tier4 chain.
 * - `directManagerOfIc`, `tier3ManagerOfIc`, `tier4ManagerOfIc` and `aiLeadOfIc`
 *   are four DISTINCT people, none of them an admin, so "tier 3 can edit but
 *   tier 1 cannot" tests the configured role and not admin rights.
 * - `unrelatedPeer` can edit nobody and view nobody but themselves.
 * - `delegatedLead`, `delegationLeader` and `delegatedReport` are three more
 *   distinct people, none of them any of the above, so a §Phase 9 delegation
 *   test cannot pass on a relationship that was already there.
 */

import { DEFAULT_SEED, generateOrg } from "./generate";
import type { SyntheticEmployee, SyntheticIncreaseRequest, SyntheticOrg } from "./types";

let cachedOrg: SyntheticOrg | null = null;

/**
 * The seed-42 org the fixtures point into. Memoised: importing `@bsl/seed`
 * should cost one generation, not one per consumer.
 */
export function getFixtureOrg(): SyntheticOrg {
  cachedOrg ??= generateOrg(DEFAULT_SEED);
  return cachedOrg;
}

export interface SeedFixtures {
  /** An ordinary IC with a pending increase request — the subject of most tests. */
  ic: SyntheticEmployee;
  /** `ic`'s tier-1 manager. Excluded by the DEFAULT edit_roles config. */
  directManagerOfIc: SyntheticEmployee;
  /** `ic`'s tier-3 manager (a director). Can edit `ic` under the default config. */
  tier3ManagerOfIc: SyntheticEmployee;
  /** `ic`'s tier-4 manager (a VP). Can edit `ic`; deliberately not an admin. */
  tier4ManagerOfIc: SyntheticEmployee;
  /**
   * `ic`'s aligned AI lead, per the HRIS column.
   *
   * Grants NOTHING since §Phase 9 removed `aligned_ai_lead` from the editable
   * roles: the column is data, and authority comes from an explicit delegation
   * instead. Kept because the column is still real and still rendered.
   */
  aiLeadOfIc: SyntheticEmployee;
  /**
   * An AI lead with no hierarchy scope of their own — nobody has them as a
   * tier-2/3/4 manager — so everything they can reach came from a delegation.
   * Not an admin, and not `delegationLeader`.
   */
  delegatedLead: SyntheticEmployee;
  /**
   * A non-admin tier-3 leader with at least two reports, for delegating to
   * `delegatedLead`. Deliberately none of the `*OfIc` fixtures, so a delegation
   * test cannot pass by accident on somebody else's relationship.
   */
  delegationLeader: SyntheticEmployee;
  /** Someone whose tier-3 manager is `delegationLeader`, and who is not the lead. */
  delegatedReport: SyntheticEmployee;
  /** An IC in a different VP org who can edit nobody and view only themselves. */
  unrelatedPeer: SyntheticEmployee;
  /** An admin who is not the CEO — the "IT platform owner" persona. */
  admin: SyntheticEmployee;
  /** The one employee with an entirely null tier chain (§G8 null-skip case). */
  ceo: SyntheticEmployee;
  /** The pending increase request whose requester is `ic`. */
  pendingRequestByIc: SyntheticIncreaseRequest;
  /** A pending request from someone `tier3ManagerOfIc` may NOT see or act on. */
  pendingRequestOutsideTier3Scope: SyntheticIncreaseRequest;
  /** Someone `tier3ManagerOfIc` can neither view nor edit. */
  outsideTier3Scope: SyntheticEmployee;
  /** Holds the `amount: null` override — renders as "Unlimited". */
  unlimitedOverrideMember: SyntheticEmployee;
  /** Holds the `"0"` override — an included-usage-only cap, not "no limit". */
  zeroCapMember: SyntheticEmployee;
  /** Holds an ordinary positive per-user override (`source.type === "user"`). */
  overrideMember: SyntheticEmployee;
  /** No override and no RBAC group — resolves to `source.type === "seat_tier"`. */
  seatTierOnlyMember: SyntheticEmployee;
}

function computeFixtures(org: SyntheticOrg): SeedFixtures {
  const byId = new Map(org.employees.map((employee) => [employee.id, employee]));
  const mustFind = (id: string | null, label: string): SyntheticEmployee => {
    const employee = id === null ? undefined : byId.get(id);
    if (!employee) throw new Error(`seed fixtures: could not resolve ${label} (${String(id)})`);
    return employee;
  };

  const pending = org.increaseRequests.filter((request) => request.status === "pending");
  const requesterOf = (request: SyntheticIncreaseRequest): SyntheticEmployee =>
    mustFind(request.employeeId, `requester of ${request.id}`);

  // Pick the tier-3 manager who owns at least two pending requesters, so the
  // Phase 11 queue has more than one card in scope for `tier3ManagerOfIc`.
  const byTier3 = new Map<string, SyntheticEmployee[]>();
  for (const request of pending) {
    const requester = requesterOf(request);
    if (requester.tier3_manager_id === null) continue;
    const bucket = byTier3.get(requester.tier3_manager_id);
    if (bucket) bucket.push(requester);
    else byTier3.set(requester.tier3_manager_id, [requester]);
  }
  const anchor = [...byTier3.entries()]
    .filter(([, group]) => group.length >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0];
  if (!anchor) {
    throw new Error("seed fixtures: no tier-3 manager owns two pending requesters");
  }
  const ic = anchor[1].slice().sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;

  const directManagerOfIc = mustFind(ic.direct_manager_id, "directManagerOfIc");
  const tier3ManagerOfIc = mustFind(ic.tier3_manager_id, "tier3ManagerOfIc");
  const tier4ManagerOfIc = mustFind(ic.tier4_manager_id, "tier4ManagerOfIc");
  const aiLeadOfIc = mustFind(ic.aligned_ai_lead_id, "aiLeadOfIc");

  const pendingRequestByIc = pending.find((request) => request.employeeId === ic.id);
  if (!pendingRequestByIc) throw new Error("seed fixtures: ic has no pending request");

  const aiLeadIds = new Set(
    org.employees.map((employee) => employee.aligned_ai_lead_id).filter((id): id is string => id !== null),
  );
  const requesterIds = new Set(org.increaseRequests.map((request) => request.employeeId));

  // Nobody has this person as a tier-3/tier-4 manager or AI lead, so their
  // visible set is exactly themselves.
  const unrelatedPeer = org.employees.find(
    (employee) =>
      employee.role === "ic" &&
      !employee.is_admin &&
      employee.id !== ic.id &&
      !aiLeadIds.has(employee.id) &&
      !requesterIds.has(employee.id) &&
      employee.tier4_manager_id !== ic.tier4_manager_id,
  );
  if (!unrelatedPeer) throw new Error("seed fixtures: no unrelated peer available");

  const outOfTier3Scope = (employee: SyntheticEmployee): boolean =>
    employee.id !== tier3ManagerOfIc.id &&
    employee.tier3_manager_id !== tier3ManagerOfIc.id &&
    employee.tier4_manager_id !== tier3ManagerOfIc.id &&
    employee.aligned_ai_lead_id !== tier3ManagerOfIc.id;

  // Kept distinct from `unrelatedPeer` so a spec can assert on both at once
  // without accidentally asserting the same person twice.
  const outsideTier3Scope = org.employees.find(
    (employee) =>
      employee.role === "ic" &&
      !employee.is_admin &&
      employee.id !== unrelatedPeer.id &&
      outOfTier3Scope(employee),
  );
  if (!outsideTier3Scope) throw new Error("seed fixtures: no employee outside the tier-3 scope");

  const pendingRequestOutsideTier3Scope = pending.find((request) =>
    outOfTier3Scope(requesterOf(request)),
  );
  if (!pendingRequestOutsideTier3Scope) {
    throw new Error("seed fixtures: every pending request sits inside the tier-3 scope");
  }

  const admin = org.employees.find((employee) => employee.is_admin && employee.role !== "ceo");
  if (!admin) throw new Error("seed fixtures: no non-CEO admin");
  const ceo = org.employees.find((employee) => employee.role === "ceo");
  if (!ceo) throw new Error("seed fixtures: no CEO");

  // §Phase 9 delegation. Chosen so the assignment is the ONLY thing that can
  // explain the lead's reach: the leader is nobody else's fixture, and the lead
  // holds no tier-2/3/4 slot, so without the assignment their visible set is
  // exactly themselves.
  const byIdOrder = org.employees.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const reportsOf = (leaderId: string): SyntheticEmployee[] =>
    byIdOrder.filter((employee) => employee.tier3_manager_id === leaderId);

  const reservedIds = new Set([
    ic.id,
    directManagerOfIc.id,
    tier3ManagerOfIc.id,
    tier4ManagerOfIc.id,
    aiLeadOfIc.id,
    unrelatedPeer.id,
    outsideTier3Scope.id,
    admin.id,
    ceo.id,
  ]);

  const delegationLeader = byIdOrder.find(
    (employee) =>
      !employee.is_admin && !reservedIds.has(employee.id) && reportsOf(employee.id).length >= 2,
  );
  if (!delegationLeader) throw new Error("seed fixtures: no spare non-admin tier-3 leader");

  const holdsNoTierSlot = (id: string): boolean =>
    !org.employees.some(
      (employee) =>
        employee.tier2_manager_id === id ||
        employee.tier3_manager_id === id ||
        employee.tier4_manager_id === id,
    );

  const delegatedLead = byIdOrder.find(
    (employee) =>
      !employee.is_admin &&
      employee.id !== delegationLeader.id &&
      aiLeadIds.has(employee.id) &&
      holdsNoTierSlot(employee.id),
  );
  if (!delegatedLead) throw new Error("seed fixtures: no AI lead without a hierarchy slot");

  const delegatedReport = reportsOf(delegationLeader.id).find(
    (employee) => employee.id !== delegatedLead.id,
  );
  if (!delegatedReport) throw new Error("seed fixtures: the delegation leader has no report");

  const overrideFor = (predicate: (amount: string | null) => boolean, label: string) => {
    const override = org.userOverrides.find((entry) => predicate(entry.amount));
    if (!override) throw new Error(`seed fixtures: no ${label} override`);
    return mustFind(override.employeeId, label);
  };
  const unlimitedOverrideMember = overrideFor((amount) => amount === null, "unlimited");
  const zeroCapMember = overrideFor((amount) => amount === "0", "zero-cap");
  const overrideMember = overrideFor(
    (amount) => amount !== null && amount !== "0",
    "positive per-user",
  );

  const overrideIds = new Set(org.userOverrides.map((override) => override.employeeId));
  const rbacMemberIds = new Set(org.orgDefaults.rbacGroups.flatMap((group) => group.memberIds));
  const seatTierOnlyMember = org.employees.find(
    (employee) =>
      employee.role === "ic" &&
      !employee.is_admin &&
      employee.id !== unrelatedPeer.id &&
      employee.id !== outsideTier3Scope.id &&
      !overrideIds.has(employee.id) &&
      !rbacMemberIds.has(employee.id),
  );
  if (!seatTierOnlyMember) throw new Error("seed fixtures: no seat-tier-only member");

  return {
    ic,
    directManagerOfIc,
    tier3ManagerOfIc,
    tier4ManagerOfIc,
    aiLeadOfIc,
    delegatedLead,
    delegationLeader,
    delegatedReport,
    unrelatedPeer,
    admin,
    ceo,
    pendingRequestByIc,
    pendingRequestOutsideTier3Scope,
    outsideTier3Scope,
    unlimitedOverrideMember,
    zeroCapMember,
    overrideMember,
    seatTierOnlyMember,
  };
}

/** The named seed-42 fixtures. See {@link SeedFixtures} for what each guarantees. */
export const FIXTURE: SeedFixtures = computeFixtures(getFixtureOrg());
