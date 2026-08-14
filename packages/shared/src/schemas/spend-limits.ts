/**
 * Wire contract for the Claude Spend Limits API (plan §G4).
 *
 * Source: https://platform.claude.com/docs/en/manage-claude/spend-limits-api
 *
 * These schemas are the single source of truth for BOTH sides of the wire: the
 * mock API in `apps/mock-api` produces them, the client in `apps/web` parses
 * them. Two deliberate stances run through the file:
 *
 * 1. Enumerations are OPEN. `scope.type`, `source.type`, request `status`,
 *    `period` and error `type` all accept unknown members instead of failing —
 *    a new seat tier or scope kind must not break a sync.
 * 2. Objects are LOOSE. Unrecognised fields pass through untouched rather than
 *    being stripped, so nothing is silently lost when the API adds a field.
 *
 * Every monetary field is a decimal string in minor units — see `money.ts`.
 */

import { z } from "zod";

import { openEnum, type OpenEnum } from "../open-enum";

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

/** Only `monthly` is documented today; the field is an open set. */
export const KNOWN_SPEND_LIMIT_PERIODS = ["monthly"] as const;
export type SpendLimitPeriod = OpenEnum<(typeof KNOWN_SPEND_LIMIT_PERIODS)[number]>;
export const SpendLimitPeriodSchema = openEnum(KNOWN_SPEND_LIMIT_PERIODS);

/** `amount: null` means UNLIMITED. `"0"` means a real zero cap. */
export const AmountSchema = z.string().nullable();

export const KNOWN_ACTOR_TYPES = ["user_actor"] as const;
export type ActorType = OpenEnum<(typeof KNOWN_ACTOR_TYPES)[number]>;

/** The member a limit or request belongs to. `email_address` is our join key. */
export const UserActorSchema = z
  .object({
    type: openEnum(KNOWN_ACTOR_TYPES),
    user_id: z.string(),
    name: z.string().nullable().default(null),
    email_address: z.string(),
    deleted: z.boolean().default(false),
  })
  .loose();
export type UserActor = z.infer<typeof UserActorSchema>;

/* -------------------------------------------------------------------------- */
/* Scope — what a configured limit applies to                                 */
/* -------------------------------------------------------------------------- */

/** Writes only ever use this variant; `POST /spend_limits` 400s on any other. */
export const UserScopeSchema = z.object({ type: z.literal("user"), user_id: z.string() }).loose();
export type UserScope = z.infer<typeof UserScopeSchema>;

/** Fallback branch keeping the scope union open to future kinds. */
export const UnknownScopeSchema = z.object({ type: z.string() }).loose();

export const ScopeSchema = z.union([UserScopeSchema, UnknownScopeSchema]);
export type Scope = z.infer<typeof ScopeSchema>;

export function isUserScope(scope: Scope): scope is UserScope {
  return scope.type === "user" && typeof (scope as { user_id?: unknown }).user_id === "string";
}

/* -------------------------------------------------------------------------- */
/* Source — which level of the hierarchy produced an effective limit          */
/* -------------------------------------------------------------------------- */

/**
 * Resolution precedence: `user` > `rbac_group` > `seat_tier` > `organization`.
 * No row at any level means unlimited. Treat as an OPEN set (§G4).
 */
export const KNOWN_SOURCE_TYPES = ["user", "rbac_group", "seat_tier", "organization"] as const;
export type SourceType = OpenEnum<(typeof KNOWN_SOURCE_TYPES)[number]>;

const UserSourceSchema = z.object({ type: z.literal("user") }).loose();
const SeatTierSourceSchema = z.object({ type: z.literal("seat_tier"), seat_tier: z.string() }).loose();
// Only the seat-tier payload is documented; the rbac_group identifiers below are
// inferred and therefore optional — do not rely on them being present.
const RbacGroupSourceSchema = z
  .object({
    type: z.literal("rbac_group"),
    rbac_group_id: z.string().optional(),
    rbac_group_name: z.string().optional(),
  })
  .loose();
const OrganizationSourceSchema = z.object({ type: z.literal("organization") }).loose();
const UnknownSourceSchema = z.object({ type: z.string() }).loose();

export const SourceSchema = z.union([
  UserSourceSchema,
  SeatTierSourceSchema,
  RbacGroupSourceSchema,
  OrganizationSourceSchema,
  UnknownSourceSchema,
]);
export type Source = z.infer<typeof SourceSchema>;

/* -------------------------------------------------------------------------- */
/* Endpoint payloads                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `GET /v1/organizations/spend_limits/effective` row — one per current member,
 * with the resolved limit plus where it came from.
 */
export const EffectiveSpendLimitRowSchema = z
  .object({
    scope: ScopeSchema,
    actor: UserActorSchema,
    amount: AmountSchema,
    currency: z.string(),
    period: SpendLimitPeriodSchema,
    // Null when nothing is configured at any level (member is unlimited).
    source: SourceSchema.nullable(),
    spend_limit_id: z.string().nullable(),
    // May carry fractional cents; `"0"` can also mean "reading unavailable".
    period_to_date_spend: z.string(),
  })
  .loose();
export type EffectiveSpendLimitRow = z.infer<typeof EffectiveSpendLimitRowSchema>;

/** A configured limit row: `GET /{id}`, `POST /spend_limits` responses. */
export const SpendLimitSchema = z
  .object({
    type: z.literal("spend_limit"),
    id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    scope: ScopeSchema,
    amount: AmountSchema,
    currency: z.string(),
    period: SpendLimitPeriodSchema,
  })
  .loose();
export type SpendLimit = z.infer<typeof SpendLimitSchema>;

/** Live limit + spend attached to PENDING increase requests only. */
export const SpendSummarySchema = z
  .object({
    amount: AmountSchema,
    currency: z.string(),
    period: SpendLimitPeriodSchema,
    period_to_date_spend: z.string(),
  })
  .loose();
export type SpendSummary = z.infer<typeof SpendSummarySchema>;

export const KNOWN_INCREASE_REQUEST_STATUSES = ["pending", "approved", "denied"] as const;
export type IncreaseRequestStatus = OpenEnum<(typeof KNOWN_INCREASE_REQUEST_STATUSES)[number]>;
export const IncreaseRequestStatusSchema = openEnum(KNOWN_INCREASE_REQUEST_STATUSES);

/**
 * A member's request for more headroom. Requests carry NO requested amount —
 * the approver supplies one (§G4 endpoint 7).
 */
export const IncreaseRequestSchema = z
  .object({
    type: z.literal("spend_limit_increase_request"),
    id: z.string(),
    status: IncreaseRequestStatusSchema,
    actor: UserActorSchema,
    created_at: z.string(),
    resolved_at: z.string().nullable().default(null),
    // Populated for pending rows, null once approved/denied.
    spend_summary: SpendSummarySchema.nullable().default(null),
  })
  .loose();
export type IncreaseRequest = z.infer<typeof IncreaseRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

/** Standard list envelope; `next_page` is an opaque cursor (see `cursor.ts`). */
export interface ListEnvelope<TItem> {
  data: TItem[];
  next_page: string | null;
}

export function listEnvelopeSchema<TItem extends z.ZodType>(item: TItem) {
  return z
    .object({
      data: z.array(item),
      next_page: z.string().nullable().default(null),
    })
    .loose();
}

export const EffectiveSpendLimitListSchema = listEnvelopeSchema(EffectiveSpendLimitRowSchema);
export const IncreaseRequestListSchema = listEnvelopeSchema(IncreaseRequestSchema);

/** Error `type` values documented today; treat as an open set. */
export const KNOWN_API_ERROR_TYPES = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
] as const;
export type ApiErrorType = OpenEnum<(typeof KNOWN_API_ERROR_TYPES)[number]>;

/** Standard Anthropic error body, returned by both surfaces. */
export const ErrorEnvelopeSchema = z
  .object({
    type: z.literal("error"),
    error: z
      .object({
        type: openEnum(KNOWN_API_ERROR_TYPES),
        message: z.string(),
      })
      .loose(),
    request_id: z.string().nullable().default(null),
  })
  .loose();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
