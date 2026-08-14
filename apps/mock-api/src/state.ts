/**
 * In-memory state for the mock (plan §Phase 4).
 *
 * Everything starts from `generateOrg(MOCK_SEED)` and then MUTATES as writes
 * arrive: per-user limits are created, replaced and deleted, and increase
 * requests move out of `pending`. Nothing is persisted — restarting the server
 * restores the seeded universe exactly.
 *
 * Two structural notes:
 *
 * 1. Only per-user limits are writable (§G4: `POST /spend_limits` accepts no
 *    other scope, `DELETE` removes no other scope), so the seat-tier / RBAC /
 *    organization levels are immutable. That lets {@link MockState.resolveEffective}
 *    reuse `resolveEffectiveLimit` from `@bsl/seed` for everything below the
 *    user level — the precedence rule lives in exactly one place — and simply
 *    layer the mutable user overrides on top.
 * 2. The clock is injectable and read PER CALL (`now()`), so a test can advance
 *    time after the state was built without regenerating the universe.
 */

import {
  DEFAULT_SEED,
  generateOrg,
  resolveEffectiveLimit,
  type DailyCost,
  type EffectiveSource,
  type SyntheticIncreaseRequest,
  type SyntheticOrg,
} from "@bsl/seed";
import { sumMinorUnits, type Scope, type Source, type UserActor } from "@bsl/shared";

import { sequentialApiId } from "./ids.js";

/** A configured limit row at any scope level — what `GET /{id}` returns. */
export interface ConfiguredLimit {
  id: string;
  scope: Scope;
  /** `null` = unlimited (§G9). Only reachable on seeded rows; writes send strings. */
  amount: string | null;
  currency: string;
  period: string;
  created_at: string;
  updated_at: string;
}

/** A member of the organization: the app-side employee plus its API actor. */
export interface MockMember {
  employeeId: string;
  userId: string;
  actor: UserActor;
}

/** An increase request. `status`/`resolved_at` mutate on approve/deny. */
export interface MockIncreaseRequest {
  id: string;
  userId: string;
  employeeId: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/** The resolved answer behind one `effective` row. */
export interface ResolvedEffectiveLimit {
  amount: string | null;
  source: Source | null;
  currency: string;
  period: string;
  spend_limit_id: string | null;
}

export interface MockStateOptions {
  /** Defaults to `MOCK_SEED`'s value, i.e. 42. */
  seed?: number;
  /** Read on every time-dependent call. Defaults to the real clock. */
  now?: () => Date;
  /** Pre-generated universe; supply to pin generation independently of `now`. */
  org?: SyntheticOrg;
}

/** How long before `generatedAt` the seeded configuration claims to have existed. */
const CONFIG_AGE_DAYS = 120;
const USER_OVERRIDE_AGE_DAYS = 45;
const MS_PER_DAY = 86_400_000;

/**
 * A stable key for the level an inherited limit came from, used to find the
 * configured row's id. `user` never appears here — per-user rows are looked up
 * directly, because they are the mutable ones.
 */
function sourceKey(source: EffectiveSource): string {
  switch (source.type) {
    case "user":
      return "user";
    case "rbac_group":
      return `rbac_group:${source.rbac_group_id}`;
    case "seat_tier":
      return `seat_tier:${source.seat_tier}`;
    case "organization":
      return "organization";
  }
}

function isoDaysBefore(anchor: string, days: number): string {
  return new Date(new Date(anchor).getTime() - days * MS_PER_DAY).toISOString();
}

export class MockState {
  readonly org: SyntheticOrg;
  readonly now: () => Date;

  /** Sorted by actor name (then user id) — the stable order `effective` pages over. */
  readonly members: MockMember[];
  readonly memberByUserId = new Map<string, MockMember>();

  readonly limitsById = new Map<string, ConfiguredLimit>();
  readonly userLimitByUserId = new Map<string, ConfiguredLimit>();

  /** Newest first, matching §G4 endpoint 5. */
  readonly requests: MockIncreaseRequest[];
  readonly requestById = new Map<string, MockIncreaseRequest>();

  /**
   * The seeded org with its per-user overrides removed. Resolution against this
   * view answers "what would this member inherit?", which is what the mutable
   * user layer sits on top of.
   */
  private readonly inheritedView: SyntheticOrg;
  private readonly inheritedIdBySourceKey = new Map<string, string>();
  private readonly costsByUserId = new Map<string, DailyCost[]>();
  private nextLimitOrdinal = 0;

  constructor(options: MockStateOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.org = options.org ?? generateOrg(options.seed ?? DEFAULT_SEED, { now: this.now() });
    this.inheritedView = { ...this.org, userOverrides: [] };

    const { currency, period } = this.org.orgDefaults;

    /* --- members ------------------------------------------------------ */

    this.members = this.org.employees
      .map((employee) => ({
        employeeId: employee.id,
        userId: employee.claude_user_id,
        actor: {
          type: "user_actor",
          user_id: employee.claude_user_id,
          name: employee.name,
          email_address: employee.email,
          deleted: false,
        } satisfies UserActor,
      }))
      .sort((a, b) => {
        const byName = (a.actor.name ?? "").localeCompare(b.actor.name ?? "");
        return byName !== 0 ? byName : a.userId.localeCompare(b.userId);
      });
    for (const member of this.members) this.memberByUserId.set(member.userId, member);

    /* --- configured limits, one row per scope level -------------------- */

    const configuredAt = isoDaysBefore(this.org.generatedAt, CONFIG_AGE_DAYS);
    const addInherited = (source: EffectiveSource, scope: Scope, amount: string | null): void => {
      const row = this.mintLimit(scope, amount, currency, period, configuredAt);
      this.inheritedIdBySourceKey.set(sourceKey(source), row.id);
    };

    addInherited(
      { type: "organization" },
      { type: "organization" },
      this.org.orgDefaults.organizationAmount,
    );
    for (const tier of this.org.orgDefaults.seatTiers) {
      addInherited(
        { type: "seat_tier", seat_tier: tier.seatTier },
        { type: "seat_tier", seat_tier: tier.seatTier },
        tier.amount,
      );
    }
    for (const group of this.org.orgDefaults.rbacGroups) {
      addInherited(
        { type: "rbac_group", rbac_group_id: group.id, rbac_group_name: group.name },
        { type: "rbac_group", rbac_group_id: group.id, rbac_group_name: group.name },
        group.amount,
      );
    }

    const overriddenAt = isoDaysBefore(this.org.generatedAt, USER_OVERRIDE_AGE_DAYS);
    for (const override of this.org.userOverrides) {
      const row = this.mintLimit(
        { type: "user", user_id: override.userId },
        override.amount,
        currency,
        period,
        overriddenAt,
      );
      this.userLimitByUserId.set(override.userId, row);
    }

    /* --- increase requests -------------------------------------------- */

    this.requests = this.org.increaseRequests
      .map((request: SyntheticIncreaseRequest) => ({
        id: request.id,
        userId: request.userId,
        employeeId: request.employeeId,
        status: request.status as string,
        created_at: request.createdAt,
        resolved_at: request.resolvedAt,
      }))
      .sort((a, b) => {
        const byCreated = b.created_at.localeCompare(a.created_at);
        return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
      });
    for (const request of this.requests) this.requestById.set(request.id, request);

    /* --- cost index for period_to_date_spend --------------------------- */

    for (const cost of this.org.dailyCosts) {
      const bucket = this.costsByUserId.get(cost.userId);
      if (bucket) bucket.push(cost);
      else this.costsByUserId.set(cost.userId, [cost]);
    }
  }

  /** The organization's currency/period; every seeded row shares them. */
  get currency(): string {
    return this.org.orgDefaults.currency;
  }

  get period(): string {
    return this.org.orgDefaults.period;
  }

  /** Daily cost rows for a member, ascending by date. Empty for unknown members. */
  dailyCosts(userId: string): readonly DailyCost[] {
    return this.costsByUserId.get(userId) ?? [];
  }

  private mintLimit(
    scope: Scope,
    amount: string | null,
    currency: string,
    period: string,
    at: string,
  ): ConfiguredLimit {
    const row: ConfiguredLimit = {
      id: sequentialApiId("spl", this.nextLimitOrdinal),
      scope,
      amount,
      currency,
      period,
      created_at: at,
      updated_at: at,
    };
    this.nextLimitOrdinal += 1;
    this.limitsById.set(row.id, row);
    return row;
  }

  /**
   * Resolve a member's effective limit: user override first, then whatever the
   * seeded hierarchy says (§G4 precedence user > rbac_group > seat_tier >
   * organization).
   *
   * When NOTHING is configured at any level the member is unlimited, which we
   * model as `amount: null` with a `null` source and no `spend_limit_id` —
   * there is no row to point at, and inventing an `organization` source would
   * claim a configuration that does not exist. With the shipped seed an
   * organization default always exists, so this branch is only reachable for
   * unknown user ids.
   */
  resolveEffective(userId: string): ResolvedEffectiveLimit {
    const userRow = this.userLimitByUserId.get(userId);
    if (userRow) {
      return {
        amount: userRow.amount,
        source: { type: "user" },
        currency: userRow.currency,
        period: userRow.period,
        spend_limit_id: userRow.id,
      };
    }

    const member = this.memberByUserId.get(userId);
    const unset: ResolvedEffectiveLimit = {
      amount: null,
      source: null,
      currency: this.currency,
      period: this.period,
      spend_limit_id: null,
    };
    if (!member) return unset;

    const inherited = resolveEffectiveLimit(this.inheritedView, member.employeeId);
    if (inherited.source === null) return unset;

    return {
      amount: inherited.amount,
      source: inherited.source,
      currency: inherited.currency,
      period: inherited.period,
      spend_limit_id: this.inheritedIdBySourceKey.get(sourceKey(inherited.source)) ?? null,
    };
  }

  /**
   * `period_to_date_spend`: the member's summed cost for the current calendar
   * month (the only period the API defines). `"0"` for a member with no usage —
   * which the consumer must not read as a confident zero (§G9).
   */
  currentMonthSpend(userId: string): string {
    const now = this.now();
    const prefix = `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
    const amounts: string[] = [];
    for (const cost of this.dailyCosts(userId)) {
      if (cost.date.startsWith(prefix)) amounts.push(cost.amount);
    }
    return sumMinorUnits(amounts);
  }

  /**
   * Create or replace a member's per-user limit. Upsert is keyed on
   * (scope, period) per §G4, so a repeat write KEEPS THE SAME `id` and only
   * bumps `updated_at` — clients that stored the id stay correct.
   */
  upsertUserLimit(userId: string, amount: string, period: string): ConfiguredLimit {
    const at = this.now().toISOString();
    const existing = this.userLimitByUserId.get(userId);
    if (existing && existing.period === period) {
      existing.amount = amount;
      existing.updated_at = at;
      return existing;
    }
    const row = this.mintLimit({ type: "user", user_id: userId }, amount, this.currency, period, at);
    this.userLimitByUserId.set(userId, row);
    return row;
  }

  /** Remove a per-user override; the member falls back to what they inherit. */
  deleteUserLimit(row: ConfiguredLimit): void {
    this.limitsById.delete(row.id);
    const userId = (row.scope as { user_id?: unknown }).user_id;
    if (typeof userId === "string" && this.userLimitByUserId.get(userId)?.id === row.id) {
      this.userLimitByUserId.delete(userId);
    }
  }
}
