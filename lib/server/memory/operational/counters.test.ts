import { describe, expect, it } from "vitest";
import {
  decodeMemoryOperationalCounters,
  MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS,
  MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS,
  MEMORY_OPERATIONAL_COUNTER_KEYS
} from "./counters";

describe("Memory operational counters", () => {
  it("accepts only allowlisted non-negative integer measurements", () => {
    expect(decodeMemoryOperationalCounters({
      contextualFallbackUnsupportedNumber: 2,
      contextualGeneratedRu: 3,
      digestNoop: 1,
      historyRoundSegmentsBuilt: 6,
      historyMessagesProjected: 4
    })).toEqual({
      contextualFallbackUnsupportedNumber: 2,
      contextualGeneratedRu: 3,
      digestNoop: 1,
      historyRoundSegmentsBuilt: 6,
      historyMessagesProjected: 4
    });
    expect(decodeMemoryOperationalCounters({ privateText: 1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ digestNoop: "private" })).toBeNull();
    expect(decodeMemoryOperationalCounters({ digestNoop: -1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ digestNoop: 1.5 })).toBeNull();
    expect(decodeMemoryOperationalCounters([])).toBeNull();
  });

  it("keeps the durable key vocabulary free of identity and content fields", () => {
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("userId");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("text");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("label");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("prompt");
    expect(new Set(Object.values(MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS)).size)
      .toBe(Object.keys(MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS).length);
    expect(MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS).toEqual({
      fallback: {
        en: "contextualFallbackEn",
        mixed: "contextualFallbackMixed",
        other: "contextualFallbackOther",
        ru: "contextualFallbackRu",
        und: "contextualFallbackUnd"
      },
      generated: {
        en: "contextualGeneratedEn",
        mixed: "contextualGeneratedMixed",
        other: "contextualGeneratedOther",
        ru: "contextualGeneratedRu",
        und: "contextualGeneratedUnd"
      }
    });
  });
});
