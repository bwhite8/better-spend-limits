/**
 * The deterministic synthetic org (plan §Phase 3).
 *
 * `generateOrg(42)` is the single source of the demo universe: `apps/mock-api`
 * turns it into in-memory API state, `apps/web`'s `db:seed` writes its people
 * into SQLite, and `fixtures.ts` names the handful of individuals the test
 * suites talk about. All three MUST see the same universe, so nothing here may
 * touch `Math.random`, `Date.now()` beyond the day-truncated anchor below, or
 * any iteration order that is not explicitly sorted.
 *
 * ## Shape of the tree
 *
 * Six depths, five role bands (§Phase 3 counts the bands, hence "5-level"):
 *
 * ```
 *   CEO (1)  →  VP (4)  →  Director (12)  →  Sr Manager (16)  →  Manager (24)  →  IC (193)
 * ```
 *
 * The manager band deliberately spans two depths, which is what makes an IC's
 * tier chain complete: tier1 = Manager, tier2 = Sr Manager, tier3 = Director,
 * tier4 = VP. That matters because the default permission config (§G1) grants
 * edit rights to tier3, tier4 and the aligned AI lead — with a shallower tree
 * the tier4 slot would be the CEO (an admin) and the permission tests would
 * pass vacuously. Everyone above IC has a short chain with trailing nulls, and
 * the CEO's is entirely null, which exercises the null-skip rule in §G8.
 *
 * ## Determinism
 *
 * `generatedAt` is truncated to the START OF THE UTC DAY, so two calls in the
 * same run produce deep-equal output while the data still tracks the calendar
 * (a 90-day cost window ending today, a current month that means something).
 * Pass `options.now` to pin it outright.
 */

import { compareMinorUnits, isZeroMinorUnits, parseMinorUnits, sumMinorUnits } from "@bsl/shared";

import { resolveEffectiveLimit } from "./effective";
import { EMAIL_DOMAIN, FIRST_NAMES, LAST_NAMES } from "./names";
import { createRng, type Rng } from "./rng";
import type {
  DailyCost,
  EmployeeRole,
  OrgDefaults,
  RbacGroupLimit,
  SyntheticEmployee,
  SyntheticIncreaseRequest,
  SyntheticOrg,
  UserOverride,
} from "./types";

/** The seed every fixture, mock default and `db:seed` run uses. */
export const DEFAULT_SEED = 42;

/** Role bands, root first. Sizes sum to 250. */
const LEVELS: readonly { role: EmployeeRole; count: number }[] = [
  { role: "ceo", count: 1 },
  { role: "vp", count: 4 },
  { role: "director", count: 12 },
  { role: "senior_manager", count: 16 },
  { role: "manager", count: 24 },
  { role: "ic", count: 193 },
];

export const EMPLOYEE_COUNT = LEVELS.reduce((total, level) => total + level.count, 0);

/** Trailing window of daily cost data, ending on `generatedAt` inclusive. */
export const COST_WINDOW_DAYS = 90;

const AI_LEAD_COUNT = 8;
const ADMIN_COUNT = 6;
const USER_OVERRIDE_COUNT = 15;
const RBAC_MEMBER_COUNT = 40;
const NEAR_LIMIT_COHORT = 10;
const WOW_SPIKE_COHORT = 12;
/** Exactly this many members finish the month to date OVER their cap (§Phase 5). */
const OVER_LIMIT_COHORT = 2;
const PENDING_REQUEST_COUNT = 6;
const APPROVED_REQUEST_COUNT = 4;
const DENIED_REQUEST_COUNT = 2;

const ORGANIZATION_AMOUNT = "25000";
const SEAT_TIERS = [
  { seatTier: "enterprise_standard", amount: "50000" },
  { seatTier: "enterprise_premium", amount: "150000" },
] as const;
const PREMIUM_SEAT_PROBABILITY = 0.3;

/** 13 numeric overrides; the generator prepends one unlimited and one zero cap. */
const OVERRIDE_AMOUNTS = [
  "5000", "10000", "30000", "45000", "60000", "75000", "90000",
  "120000", "175000", "200000", "250000", "400000", "500000",
] as const;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** No confusable glyphs — these ids show up in logs and bug reports. */
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export interface GenerateOrgOptions {
  /**
   * Clock anchor. Truncated to the start of its UTC day. Defaults to the real
   * current time — pin it when a test needs a specific calendar position (e.g.
   * a current month with only one elapsed day).
   */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Date helpers — everything is UTC; the synthetic org has no timezone         */
/* -------------------------------------------------------------------------- */

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Small builders                                                             */
/* -------------------------------------------------------------------------- */

function employeeId(index: number): string {
  return `emp_${String(index + 1).padStart(4, "0")}`;
}

/** `user_01AbCdEfGh` / `slir_01AbCdEfGh` — the Anthropic id shape (§G4). */
function makeApiId(rng: Rng, prefix: string, taken: Set<string>): string {
  for (;;) {
    let suffix = "";
    for (let i = 0; i < 8; i += 1) suffix += ID_ALPHABET[rng.int(0, ID_ALPHABET.length - 1)];
    const id = `${prefix}_01${suffix}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * Render a whole-cent value, sometimes with fractional cents. The real cost
 * endpoint reports sub-cent precision (§G5), so downstream code must never
 * assume integers — roughly a third of the rows carry a fraction.
 */
function renderAmount(rng: Rng, cents: bigint, fractionProbability: number): string {
  if (cents < 0n) throw new RangeError(`renderAmount: negative cents ${cents}`);
  if (!rng.bool(fractionProbability)) return cents.toString();
  let fraction = "";
  const digits = rng.int(1, 6);
  for (let i = 0; i < digits; i += 1) fraction += String(rng.int(0, 9));
  return `${cents}.${fraction}`;
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the whole synthetic universe. Same `seed` (and same UTC day, or a
 * pinned `options.now`) always yields deep-equal output.
 */
export function generateOrg(seed: number = DEFAULT_SEED, options: GenerateOrgOptions = {}): SyntheticOrg {
  const rng = createRng(seed);
  const anchor = startOfUtcDay(options.now ?? new Date());
  const generatedAt = anchor.toISOString();

  /* --- people -------------------------------------------------------- */

  const roles: EmployeeRole[] = [];
  for (const level of LEVELS) {
    for (let i = 0; i < level.count; i += 1) roles.push(level.role);
  }

  const takenEmails = new Set<string>();
  const takenApiIds = new Set<string>();
  const employees: SyntheticEmployee[] = roles.map((role, index) => {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const local = `${first}.${last}`.toLowerCase();
    let email = `${local}@${EMAIL_DOMAIN}`;
    for (let suffix = 2; takenEmails.has(email); suffix += 1) {
      email = `${local}${suffix}@${EMAIL_DOMAIN}`;
    }
    takenEmails.add(email);
    return {
      id: employeeId(index),
      name: `${first} ${last}`,
      email,
      claude_user_id: makeApiId(rng, "user", takenApiIds),
      direct_manager_id: null,
      tier2_manager_id: null,
      tier3_manager_id: null,
      tier4_manager_id: null,
      aligned_ai_lead_id: null,
      is_admin: false,
      role,
    };
  });

  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const byRole = (role: EmployeeRole): SyntheticEmployee[] =>
    employees.filter((employee) => employee.role === role);

  /* --- reporting lines ----------------------------------------------- */

  // Every parent gets at least one direct report (each band is larger than the
  // one above it), then the remainder is scattered so team sizes vary.
  let cursor = 0;
  for (let levelIndex = 0; levelIndex < LEVELS.length; levelIndex += 1) {
    const level = LEVELS[levelIndex]!;
    const parents = levelIndex === 0 ? [] : byRole(LEVELS[levelIndex - 1]!.role);
    for (let i = 0; i < level.count; i += 1) {
      const employee = employees[cursor + i]!;
      if (parents.length === 0) continue;
      const parent = i < parents.length ? parents[i]! : rng.pick(parents);
      employee.direct_manager_id = parent.id;
    }
    cursor += level.count;
  }

  // tierN is the TRUE Nth ancestor; short chains simply run out into nulls.
  for (const employee of employees) {
    const chain: string[] = [];
    let current = employee.direct_manager_id;
    while (current !== null && chain.length < 4) {
      chain.push(current);
      current = byId.get(current)?.direct_manager_id ?? null;
    }
    employee.tier2_manager_id = chain[1] ?? null;
    employee.tier3_manager_id = chain[2] ?? null;
    employee.tier4_manager_id = chain[3] ?? null;
  }

  /* --- admins --------------------------------------------------------- */

  // The CEO plus an IT platform owner are always admins; VPs never are, so the
  // tier4 slot of every IC belongs to a non-admin and the §G8 permission tests
  // exercise the role rule rather than the admin escape hatch.
  const adminIds = new Set<string>([employees[0]!.id]);
  const directors = byRole("director");
  adminIds.add(rng.pick(directors).id);
  const adminPool = rng.shuffle([...directors, ...byRole("senior_manager"), ...byRole("manager")]);
  for (const candidate of adminPool) {
    if (adminIds.size >= ADMIN_COUNT) break;
    adminIds.add(candidate.id);
  }
  for (const employee of employees) employee.is_admin = adminIds.has(employee.id);

  /* --- AI leads ------------------------------------------------------- */

  // Eight leads, none of them an admin or a VP, paired up so each VP's org has
  // two leads to be aligned to. Keeping leads out of the admin set means an
  // "aligned AI lead can edit" assertion proves the role, not admin rights.
  const leadPool = rng.shuffle(
    [...directors, ...byRole("senior_manager"), ...byRole("manager")].filter(
      (employee) => !adminIds.has(employee.id),
    ),
  );
  const aiLeads = leadPool.slice(0, AI_LEAD_COUNT);
  const aiLeadIds = new Set(aiLeads.map((lead) => lead.id));
  const leadPairs: [SyntheticEmployee, SyntheticEmployee][] = [];
  for (let i = 0; i < aiLeads.length; i += 2) {
    leadPairs.push([aiLeads[i]!, aiLeads[i + 1]!]);
  }

  const vps = byRole("vp");
  const vpIndexById = new Map(vps.map((vp, index) => [vp.id, index]));
  const subtreeIndexFor = (employee: SyntheticEmployee): number => {
    let current: SyntheticEmployee | undefined = employee;
    while (current) {
      const index = vpIndexById.get(current.id);
      if (index !== undefined) return index;
      current = current.direct_manager_id ? byId.get(current.direct_manager_id) : undefined;
    }
    return 0; // the CEO sits above every subtree; align them to the first pair.
  };

  for (const employee of employees) {
    const pair = leadPairs[subtreeIndexFor(employee) % leadPairs.length]!;
    const choice = rng.int(0, 1);
    // A lead is never their own lead — that would let them edit themselves.
    const lead = pair[choice]!.id === employee.id ? pair[1 - choice]! : pair[choice]!;
    employee.aligned_ai_lead_id = lead.id;
  }

  /* --- limits configuration ------------------------------------------ */

  const seatTierByEmployeeId: Record<string, string> = {};
  for (const employee of employees) {
    seatTierByEmployeeId[employee.id] = rng.bool(PREMIUM_SEAT_PROBABILITY)
      ? SEAT_TIERS[1].seatTier
      : SEAT_TIERS[0].seatTier;
  }

  // Disjoint memberships, so "which group wins" never has to be decided.
  const rbacMembers = rng.shuffle(employees).slice(0, RBAC_MEMBER_COUNT);
  const rbacGroups: RbacGroupLimit[] = [
    {
      id: "rbac_grp_ai_platform",
      name: "AI Platform",
      amount: "100000",
      memberIds: rbacMembers.slice(0, 22).map((employee) => employee.id).sort(),
    },
    {
      id: "rbac_grp_contractors",
      name: "Contractors (restricted)",
      amount: "20000",
      memberIds: rbacMembers.slice(22).map((employee) => employee.id).sort(),
    },
  ];

  const orgDefaults: OrgDefaults = {
    currency: "USD",
    period: "monthly",
    organizationAmount: ORGANIZATION_AMOUNT,
    seatTiers: SEAT_TIERS.map((tier) => ({ ...tier })),
    seatTierByEmployeeId,
    rbacGroups,
  };

  // 15 per-user overrides: one unlimited (null) and one hard zero cap, per §G9,
  // so the UI's "Unlimited" and "$0 cap" paths always have a subject.
  const overrideHolders = rng.shuffle(employees).slice(0, USER_OVERRIDE_COUNT);
  const userOverrides: UserOverride[] = overrideHolders.map((employee, index) => ({
    employeeId: employee.id,
    userId: employee.claude_user_id,
    amount: index === 0 ? null : index === 1 ? "0" : OVERRIDE_AMOUNTS[(index - 2) % OVERRIDE_AMOUNTS.length]!,
  }));
  const overrideIds = new Set(userOverrides.map((override) => override.employeeId));

  /* --- increase requests ---------------------------------------------- */

  // A "clean" requester is an ordinary IC whose whole edit-relevant entourage —
  // direct manager, tier3, tier4, aligned lead — is distinct, non-admin and not
  // an AI lead. FIXTURE.ic is drawn from this pool, which is what lets the
  // permission matrix in Phase 7 assert edit/deny per ROLE instead of tripping
  // over someone who happened to also be an admin.
  const isCleanRequester = (employee: SyntheticEmployee): boolean => {
    if (employee.role !== "ic" || employee.is_admin) return false;
    if (aiLeadIds.has(employee.id) || overrideIds.has(employee.id)) return false;
    const chain = [
      employee.direct_manager_id,
      employee.tier2_manager_id,
      employee.tier3_manager_id,
      employee.tier4_manager_id,
    ];
    if (chain.some((id) => id === null)) return false;
    const lead = employee.aligned_ai_lead_id;
    if (lead === null || adminIds.has(lead) || chain.includes(lead)) return false;
    return !chain.some((id) => adminIds.has(id!) || aiLeadIds.has(id!));
  };

  const cleanRequesters = employees.filter(isCleanRequester);

  // Two pending requests must share a tier-3 manager so Phase 11 can prove a
  // director sees several of their people's requests and none of anyone else's.
  const byTier3 = new Map<string, SyntheticEmployee[]>();
  for (const employee of cleanRequesters) {
    const key = employee.tier3_manager_id!;
    const bucket = byTier3.get(key);
    if (bucket) bucket.push(employee);
    else byTier3.set(key, [employee]);
  }
  const sharedTier3 = [...byTier3.entries()]
    .filter(([, group]) => group.length >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0];
  if (!sharedTier3) {
    throw new Error("seed: no tier-3 manager has two clean IC requesters; adjust the org shape");
  }
  const [anchorTier3Id, anchorGroup] = sharedTier3;
  const pendingRequesters = anchorGroup.slice(0, 2);

  const outsideAnchor = rng.shuffle(
    cleanRequesters.filter(
      (employee) =>
        employee.tier3_manager_id !== anchorTier3Id &&
        employee.tier4_manager_id !== anchorTier3Id &&
        employee.aligned_ai_lead_id !== anchorTier3Id &&
        !pendingRequesters.includes(employee),
    ),
  );
  pendingRequesters.push(...outsideAnchor.slice(0, PENDING_REQUEST_COUNT - pendingRequesters.length));
  if (pendingRequesters.length < PENDING_REQUEST_COUNT) {
    throw new Error("seed: not enough clean IC requesters outside the anchor director's org");
  }

  const pendingIds = new Set(pendingRequesters.map((employee) => employee.id));
  const resolvedRequesters = rng
    .shuffle(cleanRequesters.filter((employee) => !pendingIds.has(employee.id)))
    .slice(0, APPROVED_REQUEST_COUNT + DENIED_REQUEST_COUNT);

  const takenRequestIds = new Set<string>();
  const buildRequest = (
    employee: SyntheticEmployee,
    status: SyntheticIncreaseRequest["status"],
  ): SyntheticIncreaseRequest => {
    const createdMs =
      anchor.getTime() - rng.int(2, 45) * MS_PER_DAY + rng.int(0, MS_PER_DAY / 1000 - 1) * 1000;
    const resolvedMs =
      status === "pending"
        ? null
        : Math.min(createdMs + rng.int(2, 96) * MS_PER_HOUR, anchor.getTime() - MS_PER_HOUR);
    return {
      id: makeApiId(rng, "slir", takenRequestIds),
      employeeId: employee.id,
      userId: employee.claude_user_id,
      status,
      createdAt: new Date(createdMs).toISOString(),
      resolvedAt: resolvedMs === null ? null : new Date(resolvedMs).toISOString(),
    };
  };

  const increaseRequests: SyntheticIncreaseRequest[] = [
    ...pendingRequesters.map((employee) => buildRequest(employee, "pending")),
    ...resolvedRequesters
      .slice(0, APPROVED_REQUEST_COUNT)
      .map((employee) => buildRequest(employee, "approved")),
    ...resolvedRequesters
      .slice(APPROVED_REQUEST_COUNT)
      .map((employee) => buildRequest(employee, "denied")),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  /* --- daily costs ----------------------------------------------------- */

  const org: SyntheticOrg = {
    seed,
    generatedAt,
    employees,
    orgDefaults,
    userOverrides,
    increaseRequests,
    dailyCosts: [],
  };

  const dates: string[] = [];
  const isWeekend: boolean[] = [];
  for (let offset = COST_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const day = addUtcDays(anchor, -offset);
    dates.push(toIsoDate(day));
    isWeekend.push(day.getUTCDay() === 0 || day.getUTCDay() === 6);
  }

  // Log-normal daily spend per person, with weekends mostly quiet and a small
  // cohort of very light users. Days that come out under a cent produce no row
  // at all — the cost endpoint only reports days WITH usage (§G5).
  const costsByEmployee = new Map<string, Map<string, string>>();
  for (const employee of employees) {
    const mu = rng.normal(6.0, 0.75) - (rng.bool(0.06) ? 2.5 : 0);
    const series = new Map<string, string>();
    for (let i = 0; i < dates.length; i += 1) {
      const raw = Math.exp(rng.normal(mu, 0.55)) * (isWeekend[i] ? 0.12 : 1);
      if (raw < 1) continue;
      series.set(dates[i]!, renderAmount(rng, BigInt(Math.floor(Math.min(raw, 1e7))), 0.35));
    }
    costsByEmployee.set(employee.id, series);
  }

  // Three engineered cohorts, disjoint so none disturbs the others:
  //   * near-limit — month-to-date spend driven to 82–96% of the effective cap
  //   * week-over-week movers — last 7 days at ~4x the 7 days before them
  //   * over-limit — exactly two members finish the month to date above their cap
  const shuffledEmployees = rng.shuffle(employees);
  const nearLimitCohort: { employee: SyntheticEmployee; limitCents: bigint }[] = [];
  for (const employee of shuffledEmployees) {
    if (nearLimitCohort.length >= NEAR_LIMIT_COHORT) break;
    const effective = resolveEffectiveLimit(org, employee.id);
    if (effective.amount === null) continue;
    const { cents } = parseMinorUnits(effective.amount);
    if (cents < 1000n) continue;
    nearLimitCohort.push({ employee, limitCents: cents });
  }
  const nearLimitIds = new Set(nearLimitCohort.map((entry) => entry.employee.id));
  const wowCohort = shuffledEmployees
    .filter((employee) => !nearLimitIds.has(employee.id))
    .slice(0, WOW_SPIKE_COHORT);

  const monthPrefix = generatedAt.slice(0, 7);
  const currentMonthDates = dates.filter((date) => date.startsWith(monthPrefix));

  /**
   * Replace one series' month-to-date days with a weighted spread of `target`.
   * The final day absorbs the rounding remainder and stays whole, so the
   * month-to-date total is `target` plus at most a fraction of a cent per
   * earlier day. Draw order is: weights, then one `renderAmount` per day.
   */
  const spreadOverMonth = (series: Map<string, string>, target: bigint): void => {
    const weights = currentMonthDates.map(() => BigInt(rng.int(70, 130)));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
    let assigned = 0n;
    currentMonthDates.forEach((date, index) => {
      const last = index === currentMonthDates.length - 1;
      const value = last ? target - assigned : (target * weights[index]!) / totalWeight;
      assigned += value;
      if (value > 0n) series.set(date, renderAmount(rng, value, last ? 0 : 0.3));
      else series.delete(date);
    });
  };

  for (const { employee, limitCents } of nearLimitCohort) {
    const series = costsByEmployee.get(employee.id)!;
    spreadOverMonth(series, (limitCents * BigInt(82 + rng.int(0, 14))) / 100n);
  }

  const priorWeek = dates.slice(-14, -7);
  const lastWeek = dates.slice(-7);
  for (const employee of wowCohort) {
    const base = BigInt(rng.int(600, 3500));
    const series = costsByEmployee.get(employee.id)!;
    for (const date of priorWeek) {
      series.set(date, renderAmount(rng, (base * BigInt(rng.int(85, 115))) / 100n, 0.3));
    }
    for (const date of lastWeek) {
      // 3.8x–4.6x the baseline: comfortably past the 3x the reports look for,
      // even when the prior week lands at the top of its jitter band.
      series.set(date, renderAmount(rng, (base * BigInt(rng.int(380, 460))) / 100n, 0.3));
    }
  }

  /* --- the over-limit pair, and the clamp that keeps it a pair ---------- */

  // How many people are naturally over their cap is a function of how far into
  // the month the generator runs — month-to-date spend accumulates while the
  // limit stays fixed — so on seed 42 it is 0 on the 1st and 12 by the 28th.
  // Pinning it at 2 therefore takes two operations: engineer a pair (below),
  // and clamp everyone else back under their cap (after that). Both draw AFTER
  // the two cohorts above, so per §rng.ts they perturb no earlier value.
  const wowIds = new Set(wowCohort.map((employee) => employee.id));
  const overLimitCohort: { employee: SyntheticEmployee; limitCents: bigint }[] = [];
  for (const employee of shuffledEmployees) {
    if (overLimitCohort.length >= OVER_LIMIT_COHORT) break;
    if (nearLimitIds.has(employee.id) || wowIds.has(employee.id)) continue;
    const effective = resolveEffectiveLimit(org, employee.id);
    // §G9's two override subjects are excluded: `null` is unlimited (nothing to
    // exceed) and `"0"` is the at-cap member, whose own UI path this must not
    // take over. Both fail the tests below anyway; the intent is worth stating.
    if (effective.amount === null || isZeroMinorUnits(effective.amount)) continue;
    const { cents } = parseMinorUnits(effective.amount);
    if (cents < 1000n) continue;
    overLimitCohort.push({ employee, limitCents: cents });
  }
  if (overLimitCohort.length < OVER_LIMIT_COHORT) {
    throw new Error("seed: not enough capped employees left for the over-limit cohort");
  }
  const overLimitIds = new Set(overLimitCohort.map((entry) => entry.employee.id));
  for (const { employee, limitCents } of overLimitCohort) {
    const series = costsByEmployee.get(employee.id)!;
    spreadOverMonth(series, (limitCents * BigInt(105 + rng.int(0, 25))) / 100n);
  }

  // Everyone else is scaled back to 55–85% of their cap. The near-limit cohort
  // sits at 82–96% by construction, so it never trips this and is never
  // rescaled; the unlimited and zero-cap overrides are skipped outright.
  const currentMonthSet = new Set(currentMonthDates);
  const priorWeekOutsideMonth = priorWeek.filter((date) => !currentMonthSet.has(date));
  for (const employee of employees) {
    if (overLimitIds.has(employee.id)) continue;
    const effective = resolveEffectiveLimit(org, employee.id);
    if (effective.amount === null || isZeroMinorUnits(effective.amount)) continue;
    const series = costsByEmployee.get(employee.id)!;
    const monthToDate = sumMinorUnits(currentMonthDates.map((date) => series.get(date)));
    if (compareMinorUnits(monthToDate, effective.amount) <= 0) continue;

    const { cents: limitCents } = parseMinorUnits(effective.amount);
    const target = (limitCents * BigInt(55 + rng.int(0, 30))) / 100n;
    // Scaling is integer-exact on whole cents; `renderAmount` re-draws the
    // sub-cent tail. Flooring every day keeps the new total at or under target.
    let currentCents = 0n;
    for (const date of currentMonthDates) {
      const amount = series.get(date);
      if (amount !== undefined) currentCents += parseMinorUnits(amount).cents;
    }
    if (currentCents === 0n) continue;
    // A week-over-week mover's prior week straddles the month boundary, so
    // scaling only the current month would shrink one window and not the other
    // and could drop them under the 3x the reports look for. The days outside
    // the month do not count towards month-to-date, so scaling both windows by
    // the identical factor leaves the ratio intact and the clamp unaffected.
    const scaled = wowIds.has(employee.id)
      ? [...currentMonthDates, ...priorWeekOutsideMonth]
      : currentMonthDates;
    for (const date of scaled) {
      const amount = series.get(date);
      if (amount === undefined) continue;
      const value = (parseMinorUnits(amount).cents * target) / currentCents;
      if (value > 0n) series.set(date, renderAmount(rng, value, 0.3));
      else series.delete(date);
    }
  }

  const dailyCosts: DailyCost[] = [];
  for (const employee of employees) {
    const series = costsByEmployee.get(employee.id)!;
    for (const date of dates) {
      const amount = series.get(date);
      if (amount === undefined) continue;
      dailyCosts.push({ employeeId: employee.id, userId: employee.claude_user_id, date, amount });
    }
  }
  org.dailyCosts = dailyCosts;

  return org;
}
