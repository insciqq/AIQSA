import { describe, expect, it } from "vitest";
import {
  MEMORY_PREPARING_ITEM_TEXT_MAX_CHARACTERS,
  MemoryPreparingRunConflictError,
  validateMemoryPreparingAttemptResult
} from "./preparingRun";

function usedAttempt(
  budgetProfile: "COMPLEX" | "PAST_CHAT" | "SIMPLE",
  approxTokens: number,
  hardCapTokens: number
) {
  return {
    budgetSnapshot: {
      budgetProfile,
      hardCapTokens,
      plan: { aggregationRequested: budgetProfile === "COMPLEX" },
      providerTokenLimit: null,
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
  it("admits each declared adaptive profile up to its bounded ceiling", () => {
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt("SIMPLE", 10_000, 10_000)
    )).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt("PAST_CHAT", 16_000, 16_000)
    )).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt("COMPLEX", 32_000, 32_000)
    )).not.toThrow();
  });

  it("rejects context above its declared or universal ceiling", () => {
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt("PAST_CHAT", 16_001, 16_000)
    )).toThrow(MemoryPreparingRunConflictError);
    expect(() => validateMemoryPreparingAttemptResult(
      usedAttempt("COMPLEX", 32_001, 32_001)
    )).toThrow(MemoryPreparingRunConflictError);
  });

  it("admits the complex item ceiling without widening ordinary retrieval", () => {
    const aggregation = usedAttempt("COMPLEX", 1_024, 32_000);
    expect(() => validateMemoryPreparingAttemptResult({
      ...aggregation,
      items: attemptItems(40)
    })).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult({
      ...aggregation,
      budgetSnapshot: {
        budgetProfile: "SIMPLE",
        hardCapTokens: 10_000,
        plan: { aggregationRequested: false },
        schemaVersion: 2
      },
      items: attemptItems(21)
    })).toThrow(MemoryPreparingRunConflictError);
  });

  it("rejects a cap that exceeds the admitted provider envelope", () => {
    const accepted = usedAttempt("SIMPLE", 1_000, 1_000);
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      budgetSnapshot: {
        ...accepted.budgetSnapshot,
        providerTokenLimit: 999
      }
    })).toThrow(MemoryPreparingRunConflictError);
  });

  it("rejects a declared cap above the selected profile", () => {
    const accepted = usedAttempt("SIMPLE", 1_000, 10_000);
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      budgetSnapshot: {
        ...accepted.budgetSnapshot,
        hardCapTokens: 10_001
      }
    })).toThrow(MemoryPreparingRunConflictError);
  });

  it("admits a safe 4k source projection", () => {
    const maximum = "x".repeat(MEMORY_PREPARING_ITEM_TEXT_MAX_CHARACTERS);
    const accepted = usedAttempt("COMPLEX", 1_024, 32_000);
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      items: [{ ...accepted.items[0]!, exactSafeText: maximum }],
      preparedContext: { approxTokens: 1_024, text: maximum }
    })).not.toThrow();
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      items: [{ ...accepted.items[0]!, exactSafeText: `${maximum}x` }],
      preparedContext: { approxTokens: 1_024, text: `${maximum}x` }
    })).toThrowError("memory_attempt_item_text_invalid");
  });

  it("reports a content-free reason for a duplicate candidate", () => {
    const accepted = usedAttempt("COMPLEX", 1_024, 32_000);
    expect(() => validateMemoryPreparingAttemptResult({
      ...accepted,
      items: [accepted.items[0]!, accepted.items[0]!]
    })).toThrowError("memory_attempt_item_duplicate");
  });
});
