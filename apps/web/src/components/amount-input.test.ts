/**
 * The dollar field's validation contract (§G9).
 *
 * The component itself is a thin wrapper over this function, and Phase 10's
 * "invalid input issues no network call" requirement rests entirely on it
 * returning `minorUnits: null` for anything the API would reject.
 */

import { describe, expect, it } from "vitest";

import { AMOUNT_INPUT_ERROR, parseAmountInput } from "./amount-input";

describe("parseAmountInput", () => {
  it("converts dollars to minor units", () => {
    expect(parseAmountInput("750")).toEqual({ minorUnits: "75000", error: null });
    expect(parseAmountInput("750.00")).toEqual({ minorUnits: "75000", error: null });
    expect(parseAmountInput("0.5")).toEqual({ minorUnits: "50", error: null });
    expect(parseAmountInput("0")).toEqual({ minorUnits: "0", error: null });
  });

  it("tolerates the punctuation people actually type", () => {
    expect(parseAmountInput(" $1,500.00 ").minorUnits).toBe("150000");
  });

  it("treats an empty field as incomplete, not wrong", () => {
    expect(parseAmountInput("")).toEqual({ minorUnits: null, error: null });
    expect(parseAmountInput("   ")).toEqual({ minorUnits: null, error: null });
  });

  it("rejects what the wire cannot carry, with a message and no value", () => {
    for (const bad of ["-5", "abc", "1.005", "1e3", "."]) {
      expect(parseAmountInput(bad)).toEqual({ minorUnits: null, error: AMOUNT_INPUT_ERROR });
    }
  });
});
