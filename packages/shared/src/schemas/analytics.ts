/**
 * Wire contract for the Claude Enterprise Analytics cost endpoint (plan §G5).
 *
 * Source: https://platform.claude.com/docs/en/manage-claude/analytics-api
 *
 * `GET /v1/organizations/analytics/user_cost_report` is the only analytics
 * surface v1 consumes; org aggregates are summed app-side. It authenticates
 * with the ANALYTICS key, not the Admin key — the two are not interchangeable.
 *
 * Same conventions as the spend-limits surface: decimal minor-unit strings,
 * bracket-notation list params, opaque cursors, loose/open parsing.
 */

import { z } from "zod";

import { openEnum, type OpenEnum } from "../open-enum";

/** Only `1d` is supported in v1; the parameter itself is an open set. */
export const KNOWN_BUCKET_WIDTHS = ["1d"] as const;
export type BucketWidth = OpenEnum<(typeof KNOWN_BUCKET_WIDTHS)[number]>;
export const BucketWidthSchema = openEnum(KNOWN_BUCKET_WIDTHS);

/** Cost rows identify the member by id + email only — no name, no `type`. */
export const UserCostActorSchema = z
  .object({
    user_id: z.string(),
    email_address: z.string(),
  })
  .loose();
export type UserCostActor = z.infer<typeof UserCostActorSchema>;

/**
 * One row per member (no `bucket_width`) or per member per day
 * (`bucket_width=1d`, where `date` is present as `YYYY-MM-DD`).
 */
export const UserCostRowSchema = z
  .object({
    actor: UserCostActorSchema,
    amount: z.string(),
    date: z.string().optional(),
  })
  .loose();
export type UserCostRow = z.infer<typeof UserCostRowSchema>;

/**
 * Cost envelope. `data_refreshed_at` is a freshness WATERMARK, not a timestamp
 * of the response: rows dated after it are an incomplete, provisional tail and
 * any date's value may be revised for up to 30 days. Callers must persist the
 * watermark and mark the tail rather than presenting them as final (§G5).
 */
export const UserCostReportEnvelopeSchema = z
  .object({
    data: z.array(UserCostRowSchema),
    next_page: z.string().nullable().default(null),
    data_refreshed_at: z.string(),
  })
  .loose();
export type UserCostReportEnvelope = z.infer<typeof UserCostReportEnvelopeSchema>;
