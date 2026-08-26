import { describe, expect, it } from "vitest";
import {
  MEMORY_PREPARING_ITEM_TEXT_MAX_CHARACTERS,
  MemoryPreparingRunConflictError,
  validateMemoryPreparingAttemptResult
} from "./preparingRun";

function usedAttempt(aggregationRequested: boolean, approxTokens: number) {
  return {
    budgetSnapshot: {
      plan: { aggregationRequested },
      schemaVersion: 2
    },
    items: [{
      exactItemId: "recall-1",
      exactSafeText: "bounded safe history",
      finalScore: 0.2,
      itemType: "RECALL_CHUNK" as const,
      recallChunkId: "recall-1",
      selectionReason: "aggregation_coverage"
    }],
    outcome: "USED" as const,
    preparedContext: { approxTokens, text: "bounded safe history" }
  };
}

function attemptItems(length: number) {
  return Array.from({ length }, (_, index) => ({
    exactItemId: `recall-${index}`,
    exactSafeText: `bounded safe history ${index}`,
    finalScore: 0.2,
    itemType: "RECALL_CHUNK" as const,
    recallChunkId: `recall-${index}`,
    selectionReason: "aggregation_coverage"
  }));
}

describe("Memory preparing context ceiling", () => {
  it("admits the larger ceiling only for an explicit aggregation plan", () => {
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt(true, 10_000)
    )).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt(false, 5_001)
    )).toThrow(MemoryPreparingRunConflictError);
  });

  it("rejects aggregation context above its bounded ceiling", () => {
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt(true, 10_001)
    )).toThrow(MemoryPreparingRunConflictError);
  });

  it("admits the aggregation item ceiling without widening ordinary retrieval", () => {
    const aggregation = usedAttempt(true, 1_024);
    expect(() => validateMemoryPreparingAttemptResult({
      ...aggregation,
      items: attemptItems(24)
    })).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult({
      ...aggregation,
      budgetSnapshot: { plan: { aggregationRequested: false }, schemaVersion: 2 },
      items: attemptItems(21)
    })).toThrow(MemoryPreparingRunConflictError);
  });

  it("admits a safe 4k projection plus its bounded rendered source prefix", () => {
    const maximum = "x".repeat(MEMORY_PREPARING_ITEM_TEXT_MAX_CHARACTERS);
    const accepted = usedAttempt(true, 1_024);
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      items: [{ ...accepted.items[0]!, exactSafeText: maximum }],
      preparedContext: { approxTokens: 1_024, text: maximum }
    })).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      items: [{ ...accepted.items[0]!, exactSafeText: `${maximum}x` }],
      preparedContext: { approxTokens: 1_024, text: `${maximum}x` }
    })).toThrow(MemoryPreparingRunConflictError);
  });
});
