/**
 * Reading an HRIS employee export (plan §Phase 13).
 *
 * This module is deliberately PURE — no database, no drizzle, no `better-sqlite3`
 * — because the upload form imports it to validate a file in the browser before
 * anything is sent. Applying a parsed roster lives in `lib/employee-roster.ts`,
 * which is server-only; keeping the two apart is what stops a native SQLite
 * addon from being dragged into the client bundle.
 *
 * The validation posture is all-or-nothing. A roster is the app's source of
 * truth for who may edit whom (§G8), so importing "the good rows" from a file
 * with three bad ones would silently redraw the permission graph in a way nobody
 * asked for. Every problem is reported with the physical line it is on, and the
 * caller writes nothing unless `errors` is empty.
 *
 * Manager and AI-lead references must resolve WITHIN the file, not against the
 * roster being replaced: the import is a full replace, so a reference to
 * somebody who is not in the file would dangle the moment it landed (and §G7's
 * self-referencing foreign keys would reject it anyway).
 */

/**
 * Import ceilings — a defence against a hostile upload, not a business rule.
 *
 * A full-replace roster import that any admin can trigger is the cheapest way to
 * hurt this app: the whole roster is read into memory and serialised into every
 * page render (§G8 identity is "look the email up in `employees`"), so a file
 * with tens of thousands of rows degrades the app for everyone, not just the
 * uploader. On the public demo "any admin" means "anyone", so the parser refuses
 * an implausibly large file outright and bounds every field a row can carry.
 *
 * The row ceiling is generous — twenty times the synthetic org and comfortably
 * past the "hundreds of users" this is sized for (README) — so a real fork bumps
 * one constant only if it genuinely onboards thousands at once.
 */
export const MAX_EMPLOYEE_ROWS = 5000;

/** Longest each free-text / id field may be, in characters. */
export const MAX_EMPLOYEE_ID_LENGTH = 128;
export const MAX_EMPLOYEE_NAME_LENGTH = 200;
/** RFC 5321's addr-spec ceiling. */
export const MAX_EMPLOYEE_EMAIL_LENGTH = 320;

/** The exact header row an import must carry, in this exact order. */
export const EMPLOYEE_CSV_HEADER = [
  "employee_id",
  "name",
  "email",
  "direct_manager_id",
  "tier2_manager_id",
  "tier3_manager_id",
  "tier4_manager_id",
  "aligned_ai_lead_id",
  "is_admin",
] as const;

/** Columns whose value must name another row in the same file. */
const REFERENCE_COLUMNS = [
  "direct_manager_id",
  "tier2_manager_id",
  "tier3_manager_id",
  "tier4_manager_id",
  "aligned_ai_lead_id",
] as const;

/** One employee, ready for `employees` (§G7). Emails arrive lowercased. */
export interface EmployeeCsvRow {
  id: string;
  name: string;
  email: string;
  direct_manager_id: string | null;
  tier2_manager_id: string | null;
  tier3_manager_id: string | null;
  tier4_manager_id: string | null;
  aligned_ai_lead_id: string | null;
  is_admin: boolean;
}

/** A problem, and the 1-based physical line of the file it is on. */
export interface CsvIssue {
  line: number;
  message: string;
}

export interface ParsedEmployeeCsv {
  /** Rows that parsed cleanly. Do NOT import these unless `errors` is empty. */
  rows: EmployeeCsvRow[];
  errors: CsvIssue[];
}

/* -------------------------------------------------------------------------- */
/* CSV lexing                                                                 */
/* -------------------------------------------------------------------------- */

interface CsvRecord {
  /** The line the record starts on; 1 is the header. */
  line: number;
  fields: string[];
}

/**
 * A small RFC 4180 reader: double quotes, `""` escapes, CRLF or LF.
 *
 * Worth the thirty lines rather than `split(",")` because the very first column
 * a person will quote is `name` — "Vaughan, Dorothy" is exactly the shape an
 * HRIS exports — and a naive split turns that into a silently mangled roster.
 */
function parseCsvRecords(text: string): CsvRecord[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];

  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = (): void => {
    fields.push(field);
    field = "";
    // A line that is entirely empty is spacing, not a record — this is what
    // makes a trailing newline harmless.
    const blank = fields.length === 1 && fields[0].trim() === "";
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n") {
      endRecord();
      line += 1;
      recordLine = line;
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || fields.length > 0) endRecord();

  return records;
}

/* -------------------------------------------------------------------------- */
/* Field rules                                                                */
/* -------------------------------------------------------------------------- */

const TRUE_VALUES = new Set(["1", "true", "yes", "y"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "n"]);

/** `is_admin` accepts what a spreadsheet is likely to have written. */
function parseAdminFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return null;
}

/** Deliberately permissive: an address must have a local part, an `@` and a dot. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

function headerMismatch(actual: string[]): boolean {
  return (
    actual.length !== EMPLOYEE_CSV_HEADER.length ||
    actual.some((column, index) => column !== EMPLOYEE_CSV_HEADER[index])
  );
}

/* -------------------------------------------------------------------------- */
/* The parser                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate a CSV export and return the roster it describes.
 *
 * `errors` non-empty means "import nothing" — the rows that did parse are still
 * returned so the UI can say how much of the file was readable.
 */
export function parseEmployeeCsv(text: string): ParsedEmployeeCsv {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return { rows: [], errors: [{ line: 1, message: "The file is empty." }] };
  }

  const [header, ...body] = records;
  const actual = header.fields.map((column) => column.trim().toLowerCase());

  // One error, not nine: a wrong header means the whole file is misread, and
  // listing every column would bury the one thing that has to be fixed.
  if (headerMismatch(actual)) {
    return {
      rows: [],
      errors: [
        {
          line: header.line,
          message: `The header row must be exactly "${EMPLOYEE_CSV_HEADER.join(",")}" — found "${actual.join(",")}".`,
        },
      ],
    };
  }

  if (body.length === 0) {
    return {
      rows: [],
      errors: [{ line: header.line, message: "The file has a header but no employee rows." }],
    };
  }

  // Refuse an implausibly large file before doing per-row work, so a hostile
  // upload cannot turn one request into a roster that slows every later render.
  if (body.length > MAX_EMPLOYEE_ROWS) {
    return {
      rows: [],
      errors: [
        {
          line: header.line,
          message: `Too many rows: ${body.length} exceeds the ${MAX_EMPLOYEE_ROWS}-employee import limit.`,
        },
      ],
    };
  }

  const errors: CsvIssue[] = [];
  const rows: EmployeeCsvRow[] = [];
  const lineOfRow = new Map<EmployeeCsvRow, number>();
  const idLines = new Map<string, number>();
  const emailLines = new Map<string, number>();

  for (const record of body) {
    const report = (message: string): void => {
      errors.push({ line: record.line, message });
    };

    if (record.fields.length !== EMPLOYEE_CSV_HEADER.length) {
      report(`Expected ${EMPLOYEE_CSV_HEADER.length} columns, found ${record.fields.length}.`);
      continue;
    }

    const [id, name, rawEmail, ...rest] = record.fields.map((value) => value.trim());
    const email = rawEmail.toLowerCase();
    const adminFlag = parseAdminFlag(rest[5]);

    let rowOk = true;
    const reject = (message: string): void => {
      rowOk = false;
      report(message);
    };

    const tooLong = (label: string, value: string, max: number): void => {
      if (value.length > max) reject(`${label} is too long (max ${max} characters, found ${value.length}).`);
    };

    if (id === "") reject("employee_id is required.");
    else tooLong("employee_id", id, MAX_EMPLOYEE_ID_LENGTH);
    if (name === "") reject("name is required.");
    else tooLong("name", name, MAX_EMPLOYEE_NAME_LENGTH);
    if (email === "") reject("email is required.");
    else if (!looksLikeEmail(email)) reject(`"${rawEmail}" is not an email address.`);
    else tooLong("email", email, MAX_EMPLOYEE_EMAIL_LENGTH);
    if (adminFlag === null) reject(`is_admin must be 0 or 1 — found "${rest[5]}".`);

    // The five reference columns hold employee ids; hold them to the same ceiling
    // so an oversized value is a clean error, not a giant string in the database.
    for (let column = 0; column < REFERENCE_COLUMNS.length; column += 1) {
      tooLong(REFERENCE_COLUMNS[column], rest[column], MAX_EMPLOYEE_ID_LENGTH);
    }

    const firstId = idLines.get(id);
    if (id !== "" && firstId !== undefined) reject(`employee_id "${id}" is already used on line ${firstId}.`);
    else if (id !== "") idLines.set(id, record.line);

    const firstEmail = emailLines.get(email);
    if (email !== "" && firstEmail !== undefined) {
      reject(`email "${email}" is already used on line ${firstEmail}.`);
    } else if (email !== "") emailLines.set(email, record.line);

    if (!rowOk) continue;

    const row: EmployeeCsvRow = {
      id,
      name,
      email,
      direct_manager_id: rest[0] === "" ? null : rest[0],
      tier2_manager_id: rest[1] === "" ? null : rest[1],
      tier3_manager_id: rest[2] === "" ? null : rest[2],
      tier4_manager_id: rest[3] === "" ? null : rest[3],
      aligned_ai_lead_id: rest[4] === "" ? null : rest[4],
      is_admin: adminFlag === true,
    };

    rows.push(row);
    lineOfRow.set(row, record.line);
  }

  // References can only be checked once every id in the file is known — a
  // manager is perfectly entitled to appear below their own reports.
  const known = new Set(rows.map((row) => row.id));
  const dangling = new Set<EmployeeCsvRow>();

  for (const row of rows) {
    const line = lineOfRow.get(row) ?? header.line;

    for (const column of REFERENCE_COLUMNS) {
      const value = row[column];
      if (value === null) continue;

      if (value === row.id) {
        errors.push({ line, message: `${column} points at the employee's own id ("${value}").` });
        dangling.add(row);
      } else if (!known.has(value)) {
        errors.push({ line, message: `${column} "${value}" is not an employee_id in this file.` });
        dangling.add(row);
      }
    }
  }

  return {
    rows: dangling.size === 0 ? rows : rows.filter((row) => !dangling.has(row)),
    errors: errors.sort((a, b) => a.line - b.line),
  };
}
