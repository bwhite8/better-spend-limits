/**
 * Reading pages of the audit log (§G7 `audit_log`, plan §Phase 13).
 *
 * Split out of `audit-table.tsx` so it can be unit-tested without importing
 * `next/link` — the same instinct as Phase 9's `sync-label.ts`: anything worth
 * asserting on belongs in a module that does not drag the framework in.
 *
 * Newest first, ordered by `id` rather than `at`: two writes inside the same
 * second share an ISO timestamp, and insertion order is the real order.
 */

import { count, desc } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import { auditLog, type AuditLogRow } from "@/db/schema";

/** Rows per page — about a session's worth of work at a glance. */
export const AUDIT_PAGE_SIZE = 25;

/** Query-string key, so a page survives a link, a reload or a decision. */
export const AUDIT_PAGE_PARAM = "audit";

export interface AuditPageData {
  rows: AuditLogRow[];
  /** 1-based, already clamped into range. */
  page: number;
  pageCount: number;
  total: number;
}

/** `?audit=3` → 3. Anything unreadable — including `?audit=0` — means page 1. */
export function parseAuditPageParam(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * One page of the log, newest first.
 *
 * A page number past the end is clamped rather than rendered empty: an admin who
 * follows a stale link should see the oldest entries, not an empty table that
 * looks like the log was cleared.
 */
export function loadAuditPage(db: AppDatabase, requestedPage: number): AuditPageData {
  const total = db.select({ value: count() }).from(auditLog).get()?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pageCount);

  const rows = db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE)
    .offset((page - 1) * AUDIT_PAGE_SIZE)
    .all();

  return { rows, page, pageCount, total };
}
