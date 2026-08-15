import { describe, expect, it } from "vitest";
import { memoryFactDecisionToolChoice } from "./runtime";

describe("Memory fact decision runtime diagnostics", () => {
  it("requires the verifier tool while preserving the consolidator control", () => {
    expect(memoryFactDecisionToolChoice("VERIFY")).toBe("required");
    expect(memoryFactDecisionToolChoice("CONSOLIDATE")).toBe("auto");
  });
});
