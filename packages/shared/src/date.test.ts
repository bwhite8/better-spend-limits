import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "./date";

describe("formatDate", () => {
  it("renders a date-only string as MMMM D, YYYY", () => {
    expect(formatDate("2026-08-14")).toBe("August 14, 2026");
  });

  it("drops the leading zero from single-digit days", () => {
    expect(formatDate("2026-08-04")).toBe("August 4, 2026");
    expect(formatDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("reads only the date head of a full ISO timestamp", () => {
    expect(formatDate("2026-12-31T23:30:00.000Z")).toBe("December 31, 2026");
  });

  it("does not shift the day across timezones", () => {
    // The hazard this module exists for: `new Date("2026-12-31").toLocaleDateString`
    // in any negative-UTC-offset zone renders December 30. Slicing cannot.
    expect(formatDate("2026-12-31")).toBe("December 31, 2026");
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("January 1, 2026");
  });

  it("covers every month name", () => {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    months.forEach((name, index) => {
      const month = String(index + 1).padStart(2, "0");
      expect(formatDate(`2026-${month}-15`)).toBe(`${name} 15, 2026`);
    });
  });

  it("returns a malformed string verbatim rather than throwing", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDate("")).toBe("");
    expect(formatDate("2026-8-14")).toBe("2026-8-14");
    expect(formatDate("2026/08/14")).toBe("2026/08/14");
    expect(formatDate("14 August 2026")).toBe("14 August 2026");
  });

  it("returns an impossible month or day verbatim", () => {
    expect(formatDate("2026-13-01")).toBe("2026-13-01");
    expect(formatDate("2026-00-01")).toBe("2026-00-01");
    expect(formatDate("2026-08-00")).toBe("2026-08-00");
    expect(formatDate("2026-08-32")).toBe("2026-08-32");
  });
});

describe("formatDateTime", () => {
  it("appends HH:MM from a full ISO timestamp", () => {
    expect(formatDateTime("2026-08-14T09:05:00.000Z")).toBe("August 14, 2026 09:05");
  });

  it("drops seconds", () => {
    expect(formatDateTime("2026-08-13T09:15:22.000Z")).toBe("August 13, 2026 09:15");
  });

  it("renders the date alone when the string carries no time", () => {
    expect(formatDateTime("2026-08-14")).toBe("August 14, 2026");
  });

  it("renders the date alone when the time part is malformed", () => {
    expect(formatDateTime("2026-08-14Tbadtime")).toBe("August 14, 2026");
  });

  it("echoes a malformed date verbatim, as the audit table did before", () => {
    expect(formatDateTime("not a timestamp at all")).toBe("not a timestamp at all");
    expect(formatDateTime("")).toBe("");
  });
});
