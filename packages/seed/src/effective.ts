/**
 * Spend-limit resolution over the seeded configuration (plan §G4).
 *
 * Precedence is user > rbac_group > seat_tier > organization; the first level
 * that has a row wins, and its amount is returned VERBATIM — including `null`,
 * which is an explicit "unlimited" override rather than an absence. Only when
 * no level has a row at all is `source` null, and then the member is unlimited
 * because nothing was ever configured.
 *
 * `apps/mock-api` (Phase 4) serves the `effective` endpoint; this function is
 * the same resolution expressed against the seed's own structures, so the
 * generator can aim at real limits (the near-limit cohort) and tests can assert
 * against them without booting a server.
 */

import type { EffectiveLimit, EffectiveSource, SyntheticOrg } from "./types";

interface ResolutionIndex {
  overrideByEmployeeId: Map<string, string | null>;
  rbacByEmployeeId: Map<string, { amount: string; source: EffectiveSource }>;
  seatTierAmounts: Map<string, string>;
}

/**
 * Building the lookup maps is O(config), not O(employees), so callers that
 * resolve the whole org in a loop stay linear overall. Cached per `org` object
 * because the generator resolves all 250 members while shaping cost data.
 */
const indexCache = new WeakMap<SyntheticOrg, ResolutionIndex>();

function indexOf(org: SyntheticOrg): ResolutionIndex {
  const cached = indexCache.get(org);
  if (cached) return cached;

  const overrideByEmployeeId = new Map<string, string | null>();
  for (const override of org.userOverrides) {
    overrideByEmployeeId.set(override.employeeId, override.amount);
  }

  const rbacByEmployeeId = new Map<string, { amount: string; source: EffectiveSource }>();
  for (const group of org.orgDefaults.rbacGroups) {
    for (const memberId of group.memberIds) {
      rbacByEmployeeId.set(memberId, {
        amount: group.amount,
        source: { type: "rbac_group", rbac_group_id: group.id, rbac_group_name: group.name },
      });
    }
  }

  const seatTierAmounts = new Map<string, string>();
  for (const tier of org.orgDefaults.seatTiers) {
    seatTierAmounts.set(tier.seatTier, tier.amount);
  }

  const index = { overrideByEmployeeId, rbacByEmployeeId, seatTierAmounts };
  indexCache.set(org, index);
  return index;
}

/** Resolve the effective limit for one employee id. Unknown ids resolve as unset. */
export function resolveEffectiveLimit(org: SyntheticOrg, employeeId: string): EffectiveLimit {
  const { currency, period } = org.orgDefaults;
  const base = { currency, period };
  const { overrideByEmployeeId, rbacByEmployeeId, seatTierAmounts } = indexOf(org);

  if (overrideByEmployeeId.has(employeeId)) {
    return { ...base, amount: overrideByEmployeeId.get(employeeId) ?? null, source: { type: "user" } };
  }

  const rbac = rbacByEmployeeId.get(employeeId);
  if (rbac) return { ...base, amount: rbac.amount, source: rbac.source };

  const seatTier = org.orgDefaults.seatTierByEmployeeId[employeeId];
  const seatTierAmount = seatTier === undefined ? undefined : seatTierAmounts.get(seatTier);
  if (seatTier !== undefined && seatTierAmount !== undefined) {
    return { ...base, amount: seatTierAmount, source: { type: "seat_tier", seat_tier: seatTier } };
  }

  if (org.orgDefaults.organizationAmount !== undefined) {
    return { ...base, amount: org.orgDefaults.organizationAmount, source: { type: "organization" } };
  }

  return { ...base, amount: null, source: null };
}
