/**
 * Phase 13's half that a browser cannot show you: what a CSV is allowed to
 * contain, and what replacing the roster does to the database.
 *
 * The parser tests are pure. The apply tests run against a migrated in-memory
 * database with the real seed loaded, because the two properties worth proving —
 * that §G7's self-referencing foreign keys survive a full replace, and that a
 * returning employee keeps the `claude_user_id` the sync worked out — are both
 * properties of SQLite, not of the code that calls it.
 */

import { FIXTURE } from "@bsl/seed";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type AppDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { IN_MEMORY_DATABASE } from "@/db/paths";
import { employees } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { applyEmployeeImport } from "@/lib/employee-roster";
import { EMPLOYEE_CSV_HEADER, parseEmployeeCsv } from "@/lib/import-employees";

const HEADER = EMPLOYEE_CSV_HEADER.join(",");

/** A file with the canonical header and the given data lines. */
function csv(...lines: string[]): string {
  return [HEADER, ...lines].join("\n");
}

/** Five people in a three-level chain — the happy path, reused throughout. */
const FIVE_ROWS = [
  "emp_1,Ada Lovelace,ada@example.net,,,,,emp_2,1",
  "emp_2,Grace Hopper,grace@example.net,emp_1,,,,emp_1,0",
  "emp_3,Katherine Johnson,katherine@example.net,emp_2,emp_1,,,emp_2,0",
  'emp_4,"Vaughan, Dorothy",dorothy@example.net,emp_3,emp_2,emp_1,,emp_2,0',
  "emp_5,Mary Jackson,mary@example.net,emp_4,emp_3,emp_2,emp_1,emp_2,0",
];

/* -------------------------------------------------------------------------- */
/* parseEmployeeCsv                                                           */
/* -------------------------------------------------------------------------- */

describe("parseEmployeeCsv — the happy path", () => {
  it("reads a five-row file with no errors", () => {
    const { rows, errors } = parseEmployeeCsv(csv(...FIVE_ROWS));

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
  });

  it("maps every column onto the §G7 employee shape", () => {
    const { rows } = parseEmployeeCsv(csv(...FIVE_ROWS));

    expect(rows[4]).toEqual({
      id: "emp_5",
      name: "Mary Jackson",
      email: "mary@example.net",
      direct_manager_id: "emp_4",
      tier2_manager_id: "emp_3",
      tier3_manager_id: "emp_2",
      tier4_manager_id: "emp_1",
      aligned_ai_lead_id: "emp_2",
      is_admin: false,
    });
  });

  it("keeps a quoted field containing a comma intact", () => {
    const { rows } = parseEmployeeCsv(csv(...FIVE_ROWS));
    expect(rows[3].name).toBe("Vaughan, Dorothy");
  });

  it("treats blank hierarchy columns as 'no one' rather than an error", () => {
    const { rows, errors } = parseEmployeeCsv(csv(...FIVE_ROWS));

    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      direct_manager_id: null,
      tier2_manager_id: null,
      tier3_manager_id: null,
      tier4_manager_id: null,
      is_admin: true,
    });
  });

  it("survives CRLF line endings, a BOM and a trailing newline", () => {
    const text = `\uFEFF${[HEADER, ...FIVE_ROWS].join("\r\n")}\r\n`;
    const { rows, errors } = parseEmployeeCsv(text);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows[0].id).toBe("emp_1");
  });

  it("lowercases email addresses, because that is the join key (§G7)", () => {
    const { rows, errors } = parseEmployeeCsv(csv("emp_1,Ada,ADA@Example.NET,,,,,,1"));

    expect(errors).toEqual([]);
    expect(rows[0].email).toBe("ada@example.net");
  });

  it("accepts the several ways a spreadsheet writes a boolean", () => {
    const { rows, errors } = parseEmployeeCsv(
      csv(
        "emp_1,Ada,ada@example.net,,,,,,TRUE",
        "emp_2,Grace,grace@example.net,,,,,,yes",
        "emp_3,Kath,kath@example.net,,,,,,0",
        "emp_4,Dot,dot@example.net,,,,,,",
      ),
    );

    expect(errors).toEqual([]);
    expect(rows.map((row) => row.is_admin)).toEqual([true, true, false, false]);
  });
});

describe("parseEmployeeCsv — refusals", () => {
  it("reports a wrong header once, and reads no rows from it", () => {
    const wrong = ["id,name,email", "emp_1,Ada,ada@example.net"].join("\n");
    const { rows, errors } = parseEmployeeCsv(wrong);

    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
    expect(errors[0].message).toContain("header row must be exactly");
    expect(rows).toEqual([]);
  });

  it("rejects a header with the right columns in the wrong order", () => {
    const swapped = [...EMPLOYEE_CSV_HEADER];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];

    const { errors } = parseEmployeeCsv([swapped.join(","), FIVE_ROWS[0]].join("\n"));
    expect(errors).toHaveLength(1);
  });

  it("names the line of a manager id that is not in the file", () => {
    const { rows, errors } = parseEmployeeCsv(
      csv(
        "emp_1,Ada,ada@example.net,,,,,,1",
        "emp_2,Grace,grace@example.net,emp_1,,emp_404,,,0",
      ),
    );

    // Line 3: header is 1, the first employee is 2.
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(3);
    expect(errors[0].message).toContain("tier3_manager_id");
    expect(errors[0].message).toContain("emp_404");
    // The offending row is withheld, so a caller that ignores `errors` still
    // cannot write a dangling reference.
    expect(rows.map((row) => row.id)).toEqual(["emp_1"]);
  });

  it("accepts a reference to somebody defined further down the file", () => {
    const { errors } = parseEmployeeCsv(
      csv(
        "emp_1,Ada,ada@example.net,,,,,emp_2,1",
        "emp_2,Grace,grace@example.net,emp_1,,,,emp_2x,0",
        "emp_2x,Kath,kath@example.net,emp_1,,,,emp_2,0",
      ),
    );

    expect(errors).toEqual([]);
  });

  it("rejects a duplicate email and points at the first use", () => {
    const { errors } = parseEmployeeCsv(
      csv(
        "emp_1,Ada,ada@example.net,,,,,,1",
        "emp_2,Ada Again,ADA@example.net,,,,,,0",
      ),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(3);
    expect(errors[0].message).toContain("already used on line 2");
  });

  it("rejects a duplicate employee_id", () => {
    const { errors } = parseEmployeeCsv(
      csv("emp_1,Ada,ada@example.net,,,,,,1", "emp_1,Grace,grace@example.net,,,,,,0"),
    );

    expect(errors.some((issue) => issue.message.includes('employee_id "emp_1"'))).toBe(true);
  });

  it("rejects an employee who manages themselves", () => {
    const { errors } = parseEmployeeCsv(csv("emp_1,Ada,ada@example.net,emp_1,,,,,1"));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("own id");
  });

  it("requires an id, a name and a plausible email", () => {
    const { rows, errors } = parseEmployeeCsv(
      csv(
        ",Ada,ada@example.net,,,,,,1",
        "emp_2,,grace@example.net,,,,,,0",
        "emp_3,Kath,not-an-email,,,,,,0",
      ),
    );

    expect(rows).toEqual([]);
    expect(errors.map((issue) => issue.line)).toEqual([2, 3, 4]);
  });

  it("rejects an unreadable is_admin value", () => {
    const { errors } = parseEmployeeCsv(csv("emp_1,Ada,ada@example.net,,,,,,maybe"));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("is_admin");
  });

  it("reports a row with the wrong number of columns", () => {
    const { errors } = parseEmployeeCsv(csv("emp_1,Ada,ada@example.net"));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Expected 9 columns, found 3");
  });

  it("refuses an empty file and a header with no rows", () => {
    expect(parseEmployeeCsv("").errors).toHaveLength(1);
    expect(parseEmployeeCsv(HEADER).errors[0].message).toContain("no employee rows");
  });

  it("orders every issue by line, whichever pass found it", () => {
    const { errors } = parseEmployeeCsv(
      csv(
        "emp_1,Ada,ada@example.net,,,emp_404,,,1",
        "emp_2,,grace@example.net,,,,,,0",
        "emp_3,Kath,kath@example.net,,,emp_405,,,0",
      ),
    );

    expect(errors.map((issue) => issue.line)).toEqual([2, 3, 4]);
  });
});

/* -------------------------------------------------------------------------- */
/* applyEmployeeImport                                                        */
/* -------------------------------------------------------------------------- */

describe("applyEmployeeImport", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createDb(IN_MEMORY_DATABASE);
    runMigrations(db);
    seedDatabase(db);
  });

  afterEach(() => {
    db.$client.close();
  });

  const rowsOf = (text: string) => {
    const parsed = parseEmployeeCsv(text);
    expect(parsed.errors).toEqual([]);
    return parsed.rows;
  };

  it("replaces the whole roster rather than merging into it", () => {
    const summary = applyEmployeeImport(db, rowsOf(csv(...FIVE_ROWS)));

    expect(summary).toMatchObject({ imported: 5, replaced: 250, admins: 1 });
    expect(db.select().from(employees).all()).toHaveLength(5);
  });

  it("satisfies the §G7 self-references even when a lead appears after their report", () => {
    // `emp_1` is aligned to `emp_2`, who is inserted afterwards — the same
    // ordering problem `db:seed` defers foreign keys for.
    expect(() => applyEmployeeImport(db, rowsOf(csv(...FIVE_ROWS)))).not.toThrow();

    const ada = db.select().from(employees).where(eq(employees.id, "emp_1")).get();
    expect(ada?.aligned_ai_lead_id).toBe("emp_2");
  });

  it("keeps the synced claude_user_id and created_at of an address on both rosters", () => {
    db.update(employees)
      .set({ claude_user_id: "user_01Kept", created_at: "2020-01-01T00:00:00.000Z" })
      .where(eq(employees.id, FIXTURE.ic.id))
      .run();

    const summary = applyEmployeeImport(
      db,
      rowsOf(
        csv(
          `emp_1,${FIXTURE.ic.name},${FIXTURE.ic.email},,,,,,1`,
          "emp_2,Newcomer,newcomer@example.net,emp_1,,,,,0",
        ),
      ),
      { now: new Date("2026-08-14T12:00:00.000Z") },
    );

    expect(summary.preserved).toBe(1);

    const returning = db.select().from(employees).where(eq(employees.id, "emp_1")).get();
    expect(returning?.claude_user_id).toBe("user_01Kept");
    expect(returning?.created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(returning?.updated_at).toBe("2026-08-14T12:00:00.000Z");

    const newcomer = db.select().from(employees).where(eq(employees.id, "emp_2")).get();
    expect(newcomer?.claude_user_id).toBeNull();
    expect(newcomer?.created_at).toBe("2026-08-14T12:00:00.000Z");
  });

  it("refuses to empty the roster, which would lock everybody out (§G8)", () => {
    expect(() => applyEmployeeImport(db, [])).toThrow(/empty/i);
    expect(db.select().from(employees).all()).toHaveLength(250);
  });

  it("leaves the previous roster untouched when the insert fails", () => {
    // A duplicate primary key inside the batch: the parser would never emit
    // this, but the transaction is what guarantees an all-or-nothing replace.
    const rows = rowsOf(csv(...FIVE_ROWS));
    rows[1] = { ...rows[1], id: rows[0].id };

    expect(() => applyEmployeeImport(db, rows)).toThrow();
    expect(db.select().from(employees).all()).toHaveLength(250);
  });
});
