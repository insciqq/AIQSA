import { describe, expect, it } from "vitest";
import { memoryMaintenanceSpanIntersects } from "./suppression";

describe("automatic cleanup source-span fence", () => {
  const fence = { sourceMessageId: "m1", sourceMessageContentHash: "a".repeat(64), sourceStartOffset: 10, sourceEndOffset: 30 };
  const evidence = { messageId: "m1", sourceTextHash: "a".repeat(64), startOffset: 10, endOffset: 30 };
  it("blocks the same original assertion despite a changed model paraphrase", () => {
    expect(memoryMaintenanceSpanIntersects(fence, evidence)).toBe(true);
    expect(memoryMaintenanceSpanIntersects(fence, { ...evidence, startOffset: 12, endOffset: 28 })).toBe(true);
    expect(memoryMaintenanceSpanIntersects(fence, { ...evidence, startOffset: 0, endOffset: 50 })).toBe(true);
    expect(memoryMaintenanceSpanIntersects(fence, { ...evidence, startOffset: 20, endOffset: 50 })).toBe(true);
  });
  it("retains useful independent assertions, other messages and edited source content", () => {
    for (const candidate of [{ ...evidence, startOffset: 31, endOffset: 50 }, { ...evidence, messageId: "m2" },
      { ...evidence, sourceTextHash: "b".repeat(64) }]) {
      expect(memoryMaintenanceSpanIntersects(fence, candidate)).toBe(false);
    }
  });
});
