import { describe, expect, it } from "vitest";
import type { MemoryReportedUsage } from "./lifecycle";
import { memoryUsageWithCatalogCost } from "./usage";

const pricing = {
  cachedInputTokenPriceUsdPerMillion: 0.2,
  cacheWriteInputTokenPriceUsdPerMillion: null,
  inputTokenPriceUsdPerMillion: 2,
  outputTokenPriceUsdPerMillion: 10
};

const complete: MemoryReportedUsage = {
  cachedInputTokens: 400,
  completeness: "COMPLETE",
  estimatedCostMicros: null,
  inputTokens: 1_000,
  outputTokens: 300,
  reasoningTokens: 100,
  totalTokens: 1_300
};

describe("Memory catalog cost", () => {
  it("prices complete usage like an answer run", () => {
    // 600 uncached x $2 + 400 cached x $0.20 + 300 output x $10 per million.
    expect(memoryUsageWithCatalogCost(complete, pricing))
      .toEqual({ ...complete, estimatedCostMicros: 4_280 });
    // 100 of the input tokens were cache writes at $2.50 per million.
    expect(memoryUsageWithCatalogCost(
      { ...complete, cacheWriteInputTokens: 100 },
      { ...pricing, cacheWriteInputTokenPriceUsdPerMillion: 2.5 }
    )).toMatchObject({ estimatedCostMicros: 4_330 });
  });

  it("keeps provider cost, incomplete usage and unpriced models unchanged", () => {
    const reported = { ...complete, estimatedCostMicros: 17 };
    const partial = {
      ...complete,
      completeness: "PARTIAL" as const,
      outputTokens: null,
      totalTokens: null
    };
    const unavailable: MemoryReportedUsage = {
      cachedInputTokens: null,
      completeness: "UNAVAILABLE",
      estimatedCostMicros: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null
    };
    for (const usage of [reported, partial, unavailable]) {
      expect(memoryUsageWithCatalogCost(usage, pricing)).toBe(usage);
    }
    expect(memoryUsageWithCatalogCost(complete, null)).toBe(complete);
  });
});
