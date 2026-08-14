/**
 * Shapes of the synthetic universe (plan §Phase 3).
 *
 * Naming convention — worth knowing before you consume any of this:
 *
 * - `SyntheticEmployee` uses **snake_case field names that mirror the §G7
 *   `employees` table verbatim**, so `apps/web`'s `db:seed` is a straight
 *   column-for-column copy with no renaming layer.
 * - Everything else uses **camelCase**, because it is seed-internal linkage
 *   rather than a database row or a wire payload. `apps/mock-api` maps these
 *   onto the §G4/§G5 wire shapes.
 */

/** Where an employee sits in the tree. Not a §G7 column — generation metadata. */
export type EmployeeRole = "ceo" | "vp" | "director" | "senior_manager" | "manager" | "ic";

/**
 * One person. Column names match §G7 `employees`; `created_at`/`updated_at` are
 * deliberately absent — those are the database's business, not the seed's.
 *
 * `tierN_manager_id` is the TRUE Nth ancestor along `direct_manager_id`
 * (tier1 = direct manager), or `null` when the chain runs out. The hierarchy is
 * denormalised exactly as an HRIS export would be; nothing downstream ever
 * recomputes it.
 */
export interface SyntheticEmployee {
  id: string;
  name: string;
  /** Lowercased. The join key between the app database and API actors (§G7). */
  email: string;
  /** API-side identity; `actor.user_id` on every wire payload for this person. */
  claude_user_id: string;
  direct_manager_id: string | null;
  tier2_manager_id: string | null;
  tier3_manager_id: string | null;
  tier4_manager_id: string | null;
  /** Always populated — every employee is aligned to one of the 8 AI leads. */
  aligned_ai_lead_id: string | null;
  is_admin: boolean;
  role: EmployeeRole;
}

/** A seat-tier scoped limit, e.g. `enterprise_standard` → `"50000"`. */
export interface SeatTierLimit {
  seatTier: string;
  amount: string;
}

/** An RBAC-group scoped limit and its (disjoint) membership. */
export interface RbacGroupLimit {
  id: string;
  name: string;
  amount: string;
  memberIds: string[];
}

/**
 * Everything configured ABOVE the per-user level: the organization default, the
 * seat tiers and which employee sits on which, and the RBAC groups. Resolution
 * precedence over these is user > rbac_group > seat_tier > organization (§G4).
 */
export interface OrgDefaults {
  currency: string;
  period: string;
  /** The organization-wide floor every member inherits when nothing else hits. */
  organizationAmount: string;
  seatTiers: SeatTierLimit[];
  /** employee id → `seatTier` key of one of `seatTiers`. Every employee appears. */
  seatTierByEmployeeId: Record<string, string>;
  /** Memberships are disjoint, so multi-group precedence is never ambiguous. */
  rbacGroups: RbacGroupLimit[];
}

/** A per-user override. `amount: null` means UNLIMITED; `"0"` is a real zero cap. */
export interface UserOverride {
  employeeId: string;
  userId: string;
  amount: string | null;
}

export type IncreaseRequestStatus = "pending" | "approved" | "denied";

/**
 * A member asking for more headroom. There is deliberately no requested amount —
 * the real API does not carry one, the approver supplies it (§G4 endpoint 7).
 */
export interface SyntheticIncreaseRequest {
  id: string;
  employeeId: string;
  userId: string;
  status: IncreaseRequestStatus;
  createdAt: string;
  /** Null while `pending`; an ISO timestamp once approved or denied. */
  resolvedAt: string | null;
}

/** One (member, day) usage row. Days with no usage produce no row at all. */
export interface DailyCost {
  employeeId: string;
  userId: string;
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Decimal string in minor units; may carry fractional cents. */
  amount: string;
}

/** The complete demo universe: one call to `generateOrg` produces all of it. */
export interface SyntheticOrg {
  seed: number;
  /** Start of the UTC day the org was generated for; anchors every date below. */
  generatedAt: string;
  employees: SyntheticEmployee[];
  orgDefaults: OrgDefaults;
  userOverrides: UserOverride[];
  increaseRequests: SyntheticIncreaseRequest[];
  /** Sorted by `(employeeId, date)`; trailing 90 days ending on `generatedAt`. */
  dailyCosts: DailyCost[];
}

/** Where a resolved effective limit came from — mirrors §G4 `source`. */
export type EffectiveSource =
  | { type: "user" }
  | { type: "rbac_group"; rbac_group_id: string; rbac_group_name: string }
  | { type: "seat_tier"; seat_tier: string }
  | { type: "organization" };

/** The §G4 `effective` answer for one member, computed from the seed config. */
export interface EffectiveLimit {
  /** `null` = unlimited (either an explicit unlimited override, or nothing set). */
  amount: string | null;
  /** `null` only when NOTHING is configured at any level for this member. */
  source: EffectiveSource | null;
  currency: string;
  period: string;
}
