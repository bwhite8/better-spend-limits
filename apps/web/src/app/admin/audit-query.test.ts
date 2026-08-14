/**
 * Audit-log paging (plan §Phase 13).
 *
 * The browser test only ever sees a handful of entries — a demo run writes three
 * or four — so the pager itself is proved here, where a hundred rows cost a
 * millisecond.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { writeAudit } from "@/lib/audit";

import { AUDIT_PAGE_SIZE, loadAuditPage, parseAuditPageParam } from "./audit-query";

let db: AppDatabase;

beforeEach(() => {
  db = createDb(IN_MEMORY_DATABASE);
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
});

/** `count` entries, all with the SAME timestamp — the case `at` cannot order. */
function writeEntries(count: number): void {
  for (let i = 0; i < count; i += 1) {
    writeAudit(db, {
      actor: { id: "emp_0001", email: "admin@example.com" },
      action: "set_limit",
      detail: { index: i },
      at: new Date("2026-08-14T09:00:00.000Z"),
    });
  }
}

describe("parseAuditPageParam", () => {
  it("reads a positive integer", () => {
    expect(parseAuditPageParam("3")).toBe(3);
  });

  it("falls back to page 1 for anything else", () => {
    for (const raw of [undefined, "", "0", "-2", "2.5", "last", "NaN"]) {
      expect(parseAuditPageParam(raw)).toBe(1);
    }
  });

  it("takes the first value when the key is repeated", () => {
    expect(parseAuditPageParam(["2", "9"])).toBe(2);
  });
});

describe("loadAuditPage", () => {
  it("reports an empty log without inventing a page", () => {
    const page = loadAuditPage(db, 1);

    expect(page).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 });
  });

  it("returns the newest entries first, even when timestamps tie", () => {
    writeEntries(3);
    const { rows } = loadAuditPage(db, 1);

    expect(rows.map((row) => row.id)).toEqual([3, 2, 1]);
  });

  it("splits the log into pages of AUDIT_PAGE_SIZE", () => {
    writeEntries(AUDIT_PAGE_SIZE + 4);

    const first = loadAuditPage(db, 1);
    expect(first.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first).toMatchObject({ total: AUDIT_PAGE_SIZE + 4, pageCount: 2, page: 1 });

    const second = loadAuditPage(db, 2);
    expect(second.rows).toHaveLength(4);
    // No entry appears on both pages.
    const ids = new Set([...first.rows, ...second.rows].map((row) => row.id));
    expect(ids.size).toBe(AUDIT_PAGE_SIZE + 4);
    // And the second page continues below the first.
    expect(second.rows[0].id).toBe(first.rows[AUDIT_PAGE_SIZE - 1].id - 1);
  });

  it("clamps a page number past the end onto the last page", () => {
    writeEntries(3);
    const page = loadAuditPage(db, 99);

    expect(page.page).toBe(1);
    expect(page.rows).toHaveLength(3);
  });
});
