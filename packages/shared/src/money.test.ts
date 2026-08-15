import { describe, expect, it } from "vitest";

import {
  MoneyFormatError,
  compareMinorUnits,
  dollarsInputToMinorUnits,
  formatMoney,
  isZeroMinorUnits,
  minorUnitsToNumber,
  parseMinorUnits,
  spendRatio,
  sumMinorUnits,
} from "./money";

describe("parseMinorUnits", () => {
  it("splits an integer amount", () => {
    expect(parseMinorUnits("50000")).toEqual({ cents: 50000n, fraction: "" });
  });

  it("keeps fractional cents exactly", () => {
    const parsed = parseMinorUnits("41280.125");
    expect(parsed.cents).toBe(41280n);
    expect(parsed.fraction).toBe("125");
  });

  it("canonicalises trailing zeros away", () => {
    expect(parseMinorUnits("41280.000000")).toEqual({ cents: 41280n, fraction: "" });
    expect(parseMinorUnits("10.1200")).toEqual({ cents: 10n, fraction: "12" });
  });

  it("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parseMinorUnits("9007199254740993").cents).toBe(9007199254740993n);
  });

  it.each(["", "-5", "abc", "1.2.3", "1,000", ".5", "5.", "1e3", "NaN"])(
    "rejects %o",
    (input) => {
      expect(() => parseMinorUnits(input)).toThrow(MoneyFormatError);
    },
  );
});

describe("isZeroMinorUnits", () => {
  it("recognises an explicit zero cap", () => {
    expect(isZeroMinorUnits("0")).toBe(true);
    expect(isZeroMinorUnits("0.000")).toBe(true);
    expect(isZeroMinorUnits("0.001")).toBe(false);
    expect(isZeroMinorUnits("1")).toBe(false);
  });
});

describe("compareMinorUnits", () => {
  it("orders on the integer part", () => {
    expect(compareMinorUnits("50000", "150000")).toBe(-1);
    expect(compareMinorUnits("150000", "50000")).toBe(1);
    expect(compareMinorUnits("50000", "50000")).toBe(0);
  });

  it("breaks ties on the fraction", () => {
    expect(compareMinorUnits("100.5", "100.25")).toBe(1);
    expect(compareMinorUnits("100.25", "100.5")).toBe(-1);
    expect(compareMinorUnits("100.5", "100.50")).toBe(0);
    expect(compareMinorUnits("100", "100.0001")).toBe(-1);
  });

  it("sorts a cost report descending without float drift", () => {
    const amounts = ["41280.000001", "41280", "9007199254740993", "0", "41280.1"];
    expect([...amounts].sort((a, b) => compareMinorUnits(b, a))).toEqual([
      "9007199254740993",
      "41280.1",
      "41280.000001",
      "41280",
      "0",
    ]);
  });
});

describe("sumMinorUnits", () => {
  it("sums exactly across mixed fraction widths", () => {
    expect(sumMinorUnits(["0.1", "0.2"])).toBe("0.3");
    expect(sumMinorUnits(["41280.125", "1.875", "10"])).toBe("41292");
  });

  it("skips unlimited (null) members and handles an empty series", () => {
    expect(sumMinorUnits(["100", null, undefined, "50"])).toBe("150");
    expect(sumMinorUnits([])).toBe("0");
  });

  it("stays exact where floats would not", () => {
    const pennies = Array.from({ length: 10 }, () => "0.1");
    expect(sumMinorUnits(pennies)).toBe("1");
  });
});

describe("formatMoney", () => {
  it("renders minor units as dollars", () => {
    expect(formatMoney("50000")).toBe("$500.00");
    expect(formatMoney("0")).toBe("$0.00");
    expect(formatMoney("5")).toBe("$0.05");
  });

  it("renders null as Unlimited", () => {
    expect(formatMoney(null)).toBe("Unlimited");
  });

  it("groups thousands", () => {
    expect(formatMoney("150000")).toBe("$1,500.00");
    expect(formatMoney("123456789")).toBe("$1,234,567.89");
  });

  it("rounds fractional cents half-up", () => {
    expect(formatMoney("31402.5")).toBe("$314.03");
    expect(formatMoney("31402.49")).toBe("$314.02");
    expect(formatMoney("31402.05")).toBe("$314.02");
    expect(formatMoney("41280.000000")).toBe("$412.80");
  });

  it("uses the currency symbol when known and the code otherwise", () => {
    expect(formatMoney("50000", "EUR")).toBe("€500.00");
    expect(formatMoney("50000", "GBP")).toBe("£500.00");
    expect(formatMoney("50000", "XYZ")).toBe("XYZ 500.00");
  });

  it("keeps the cents unless trimWholeDollars is asked for", () => {
    expect(formatMoney("50000")).toBe("$500.00");
    expect(formatMoney("50000", "USD")).toBe("$500.00");
    expect(formatMoney("50000", "USD", {})).toBe("$500.00");
    expect(formatMoney("50000", "USD", { trimWholeDollars: false })).toBe("$500.00");
  });

  it("trims .00 from whole-dollar amounts on request", () => {
    expect(formatMoney("50000", "USD", { trimWholeDollars: true })).toBe("$500");
    expect(formatMoney("0", "USD", { trimWholeDollars: true })).toBe("$0");
    expect(formatMoney("150000", "USD", { trimWholeDollars: true })).toBe("$1,500");
    expect(formatMoney("50000", "EUR", { trimWholeDollars: true })).toBe("€500");
    expect(formatMoney("50000", "XYZ", { trimWholeDollars: true })).toBe("XYZ 500");
  });

  it("keeps the cents on a trimmed amount that is not whole dollars", () => {
    expect(formatMoney("1234", "USD", { trimWholeDollars: true })).toBe("$12.34");
    expect(formatMoney("5", "USD", { trimWholeDollars: true })).toBe("$0.05");
    expect(formatMoney("50001", "USD", { trimWholeDollars: true })).toBe("$500.01");
  });

  it("trims only after rounding, so fractional cents cannot leave a stray .00", () => {
    // 49999.6 rounds up to 50000 minor units, which IS whole dollars.
    expect(formatMoney("49999.6", "USD", { trimWholeDollars: true })).toBe("$500");
    // 31402.5 rounds to 31403, which is not.
    expect(formatMoney("31402.5", "USD", { trimWholeDollars: true })).toBe("$314.03");
  });

  it("still renders null as Unlimited when trimming", () => {
    expect(formatMoney(null, "USD", { trimWholeDollars: true })).toBe("Unlimited");
  });
});

describe("dollarsInputToMinorUnits", () => {
  it("converts whole dollars", () => {
    expect(dollarsInputToMinorUnits("750")).toBe("75000");
    expect(dollarsInputToMinorUnits("750.00")).toBe("75000");
  });

  it("converts partial dollars", () => {
    expect(dollarsInputToMinorUnits("0.5")).toBe("50");
    expect(dollarsInputToMinorUnits("0.05")).toBe("5");
    expect(dollarsInputToMinorUnits("0")).toBe("0");
  });

  it("tolerates currency decoration and whitespace", () => {
    expect(dollarsInputToMinorUnits(" $1,500.00 ")).toBe("150000");
  });

  it("throws on a negative amount", () => {
    expect(() => dollarsInputToMinorUnits("-5")).toThrow(MoneyFormatError);
  });

  it.each(["", "abc", "1.234", "0.005", ".", "1e3"])("throws on %o", (input) => {
    expect(() => dollarsInputToMinorUnits(input)).toThrow(MoneyFormatError);
  });
});

describe("spendRatio", () => {
  it("divides spend by the limit", () => {
    expect(spendRatio("40000", "50000")).toBe(0.8);
    expect(spendRatio("0", "50000")).toBe(0);
  });

  it("treats a zero cap as at-limit", () => {
    expect(spendRatio("1", "0")).toBe(1);
    expect(spendRatio("0", "0")).toBe(1);
  });

  it("has no ratio for an unlimited member", () => {
    expect(spendRatio("1", null)).toBeNull();
  });

  it("reports over-limit spend above 1", () => {
    expect(spendRatio("60000", "50000")).toBeCloseTo(1.2, 10);
  });

  it("returns null instead of throwing on malformed input", () => {
    expect(spendRatio("oops", "50000")).toBeNull();
    expect(spendRatio("40000", "oops")).toBeNull();
    expect(spendRatio(null, "50000")).toBeNull();
  });
});

describe("minorUnitsToNumber", () => {
  it("converts for display math only", () => {
    expect(minorUnitsToNumber("41280.125")).toBe(41280.125);
    expect(() => minorUnitsToNumber("-1")).toThrow(MoneyFormatError);
  });
});
