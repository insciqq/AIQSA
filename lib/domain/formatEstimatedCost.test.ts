import { describe, expect, it } from "vitest";
import { costCoverageNote, formatEstimatedCostMicros } from "./formatEstimatedCost";

describe("approximate USD cost", () => {
  it.each([
    [null, "—"], [0, "≈ <$0.01"], [9_999, "≈ <$0.01"], [10_000, "≈ $0.010"],
    [125_000, "≈ $0.125"], [999_999, "≈ $1.000"], [1_000_000, "≈ $1.00"],
    [12_345_000, "≈ $12.35"], [-1, "—"], [Infinity, "—"]
  ])("formats %s without inventing missing accounting", (micros, expected) => {
    expect(formatEstimatedCostMicros(micros)).toBe(expected);
  });
  it("identifies partial cost coverage without confusing unknown or complete totals", () => {
    expect(costCoverageNote(2, 3)).toBe("cost known for 2 of 3 requests");
    expect(costCoverageNote(0, 3)).toBeNull();
    expect(costCoverageNote(3, 3)).toBeNull();
  });
});
