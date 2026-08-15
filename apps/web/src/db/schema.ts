/**
 * The application database — §G7 of the plan, table for table.
 *
 * Two conventions that every later phase depends on:
 *
 * 1. **TypeScript property names are identical to the SQL column names**
 *    (`tier3_manager_id`, not `tier3ManagerId`). This is deliberate. It makes
 *    `db:seed` a straight column-for-column copy of `@bsl/seed`'s
 *    `SyntheticEmployee` (which mirrors §G7 for the same reason), and it lets
 *    the §G8 permission engine map a configured role name onto a column with
 *    plain string concatenation — `edit_roles` entry `"tier3_manager"` is
 *    exactly `employees.tier3_manager_id`.
 *
 * 2. **`INTEGER` booleans are declared with `{ mode: "boolean" }`.** Drizzle
 *    still stores plain `0`/`1`, so raw SQL such as `WHERE is_admin = 1` keeps
 *    working; reads just come back as `true`/`false` instead of `1`/`0`.
 *
 * The source of truth for limits, requests and costs is the Anthropic API. The
 * `*_snapshot` / `user_daily_cost` tables are a synced cache of it (Phase 8);
 * `employees`, `app_config` and `audit_log` are genuinely the app's own data.
 */

import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * People, with the reporting hierarchy DENORMALISED exactly as an HRIS export
 * delivers it: `tierN_manager_id` is the true Nth ancestor, `null` once the
 * chain runs out. The app never recomputes a chain (§G7).
 */
export const employees = sqliteTable("employees", {
  /** e.g. `"emp_0042"`. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Lowercased. The join key to API actors' `email_address` (§G7). */
  email: text("email").notNull().unique(),
  /** Filled in by the Phase-8 sync when an actor's email matches. */
  claude_user_id: text("claude_user_id"),
  direct_manager_id: text("direct_manager_id").references((): AnySQLiteColumn => employees.id),
  tier2_manager_id: text("tier2_manager_id").references((): AnySQLiteColumn => employees.id),
  tier3_manager_id: text("tier3_manager_id").references((): AnySQLiteColumn => employees.id),
  tier4_manager_id: text("tier4_manager_id").references((): AnySQLiteColumn => employees.id),
  aligned_ai_lead_id: text("aligned_ai_lead_id").references((): AnySQLiteColumn => employees.id),
  is_admin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

/**
 * Which LEADERS an AI lead speaks for (§Phase 9).
 *
 * `employees.aligned_ai_lead_id` still records the HRIS fact "this person's AI
 * lead is X", but it stopped being a source of authority: it is assigned across
 * whole VP subtrees, so a lead's reach bore no relation to their own place in
 * the hierarchy. Delegation is an explicit admin decision instead — assign a
 * lead to one or more tier-2/3/4 leaders and they inherit exactly what those
 * leaders' hierarchy roles grant.
 *
 * Two rules the schema cannot state and the code must:
 *
 * - **Non-transitive.** Resolution is one hop. A leader's own delegations never
 *   chain onward to a lead assigned to them.
 * - **Never an admin.** An admin's "scope" is the whole organization, so
 *   inheriting it would be indistinguishable from granting admin rights.
 *   `lib/ai-leads.ts` rejects it, on the server, on every write.
 */
export const aiLeadAssignments = sqliteTable(
  "ai_lead_assignments",
  {
    /** The AI lead who gains the leader's scope. */
    lead_employee_id: text("lead_employee_id")
      .notNull()
      .references((): AnySQLiteColumn => employees.id),
    /** The tier-2/3/4 leader whose scope is delegated. Never an admin. */
    leader_employee_id: text("leader_employee_id")
      .notNull()
      .references((): AnySQLiteColumn => employees.id),
    created_at: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.lead_employee_id, table.leader_employee_id] })],
);

/** Key/value application configuration. `value` is always JSON-encoded (§G7). */
export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Append-only record of every write the app performs on the user's behalf (§G8). */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  actor_employee_id: text("actor_employee_id"),
  actor_email: text("actor_email").notNull(),
  /** `set_limit|delete_limit|approve_request|deny_request|config_update|import_employees`. */
  action: text("action").notNull(),
  target_employee_id: text("target_employee_id"),
  target_user_id: text("target_user_id"),
  /** JSON: `{old_amount, new_amount, request_id, api_request_id, ...}`. */
  detail: text("detail").notNull(),
});

/** Mirror of `GET /v1/organizations/spend_limits/effective` (§G4 endpoint 1). */
export const spendLimitSnapshot = sqliteTable("spend_limit_snapshot", {
  user_id: text("user_id").primaryKey(),
  actor_name: text("actor_name"),
  actor_email: text("actor_email"),
  actor_deleted: integer("actor_deleted", { mode: "boolean" }).notNull().default(false),
  /** Decimal string in minor units; `null` means UNLIMITED (§G9). */
  amount: text("amount"),
  currency: text("currency"),
  period: text("period"),
  source_type: text("source_type"),
  /** JSON of the whole `source` object, so unknown source kinds survive (§G4). */
  source_detail: text("source_detail"),
  spend_limit_id: text("spend_limit_id"),
  period_to_date_spend: text("period_to_date_spend"),
  synced_at: text("synced_at").notNull(),
});

/** Mirror of `GET /v1/organizations/spend_limit_increase_requests` (§G4 endpoint 5). */
export const increaseRequestSnapshot = sqliteTable("increase_request_snapshot", {
  id: text("id").primaryKey(),
  /** `pending|approved|denied` — an OPEN set; store whatever the API returns. */
  status: text("status").notNull(),
  actor_user_id: text("actor_user_id").notNull(),
  actor_name: text("actor_name"),
  actor_email: text("actor_email"),
  created_at: text("created_at").notNull(),
  resolved_at: text("resolved_at"),
  /** JSON `{amount, currency, period, period_to_date_spend}`, or NULL when resolved. */
  spend_summary: text("spend_summary"),
  synced_at: text("synced_at").notNull(),
});

/** Mirror of `GET /v1/organizations/analytics/user_cost_report?bucket_width=1d` (§G5). */
export const userDailyCost = sqliteTable(
  "user_daily_cost",
  {
    user_id: text("user_id").notNull(),
    /** `YYYY-MM-DD`. */
    date: text("date").notNull(),
    /** Decimal string in minor units (§G9). */
    amount: text("amount").notNull(),
    /** True when `date > data_refreshed_at` at sync time — the provisional tail (§G5). */
    provisional: integer("provisional", { mode: "boolean" }).notNull().default(false),
    synced_at: text("synced_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.date] })],
);

/** One row per synced resource: freshness, the run lock, and the last error. */
export const syncState = sqliteTable("sync_state", {
  /** `effective|requests|costs`. */
  resource: text("resource").primaryKey(),
  last_synced_at: text("last_synced_at"),
  /** §G5 watermark; only meaningful for `costs`. */
  data_refreshed_at: text("data_refreshed_at"),
  /** `idle|running|error`. */
  status: text("status").notNull().default(sql`'idle'`),
  error: text("error"),
});

export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;
export type AiLeadAssignmentRow = typeof aiLeadAssignments.$inferSelect;
export type NewAiLeadAssignmentRow = typeof aiLeadAssignments.$inferInsert;
export type AppConfigRow = typeof appConfig.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type SpendLimitSnapshotRow = typeof spendLimitSnapshot.$inferSelect;
export type NewSpendLimitSnapshotRow = typeof spendLimitSnapshot.$inferInsert;
export type IncreaseRequestSnapshotRow = typeof increaseRequestSnapshot.$inferSelect;
export type NewIncreaseRequestSnapshotRow = typeof increaseRequestSnapshot.$inferInsert;
export type UserDailyCostRow = typeof userDailyCost.$inferSelect;
export type NewUserDailyCostRow = typeof userDailyCost.$inferInsert;
export type SyncStateRow = typeof syncState.$inferSelect;
