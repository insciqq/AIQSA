import { describe, expect, it } from "vitest";
import { elapsedMilliseconds } from "./monotonicTime";

describe("monotonic elapsed time", () => {
  it("produces bounded non-negative integer durations", () => {
    expect(elapsedMilliseconds(10.25, 15.99)).toBe(5);
    expect(elapsedMilliseconds(10, 10)).toBe(0);
    expect(elapsedMilliseconds(10, 9)).toBe(0);
    expect(elapsedMilliseconds(Number.NaN, 10)).toBe(0);
    expect(elapsedMilliseconds(0, Number.POSITIVE_INFINITY)).toBe(0);
    expect(elapsedMilliseconds(0, Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
