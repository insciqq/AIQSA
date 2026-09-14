import { describe, expect, it, vi } from "vitest";
vi.mock("../aiqsa-memory-live-microbench/acceptance/evaluate", () => ({ judge: vi.fn() }));
import { isWholeReferenceAnswer } from "./semantic";

describe("complete reference equivalence", () => {
  it("accepts complete aliases without accepting mentions, denials or alternative answers", () => {
    expect(isWholeReferenceAnswer("The York.", ["York"])).toBe(true);
    expect(isWholeReferenceAnswer("York", ["Leeds", "York"])).toBe(true);
    expect(isWholeReferenceAnswer("Not York", ["York"])).toBe(false);
    expect(isWholeReferenceAnswer("York or Leeds", ["York"])).toBe(false);
    expect(isWholeReferenceAnswer("Previously York, now Leeds", ["York"])).toBe(false);
    expect(isWholeReferenceAnswer("", [""])).toBe(false);
  });
});
