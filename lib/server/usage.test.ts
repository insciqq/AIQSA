import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadProviderModelCostBasis, providerModelUsageCostMicros, storedTokenUsage } from "./usage";

describe("stored token usage", () => {
  it("projects counts and completeness and keeps the search count column", () => {
    expect(storedTokenUsage({ inputTokens: 10, outputTokens: 4, webSearchCount: 2 })).toEqual({
      cachedInputTokens: null, cacheWriteInputTokens: null, inputTokens: 10, outputTokens: 4, reasoningTokens: null,
      totalTokens: 14, usageCompleteness: "COMPLETE", webSearchCount: 2
    });
    expect(storedTokenUsage({ inputTokens: 3 })).toEqual({ cachedInputTokens: null, cacheWriteInputTokens: null,
      inputTokens: 3, outputTokens: null, reasoningTokens: null, totalTokens: null, usageCompleteness: "PARTIAL" });
  });
});

describe("provider model cost basis", () => {
  it("prices an answer deployment's reported web searches at its stored per-search price", async () => {
    const findUnique = vi.fn(async () => ({ modelClass: "answer" as const, inputTokenPriceUsdPerMillion: new Prisma.Decimal(2),
      cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null,
      outputTokenPriceUsdPerMillion: new Prisma.Decimal(10), webSearchPriceUsdPerThousand: new Prisma.Decimal(10) }));
    const basis = await loadProviderModelCostBasis({ providerModel: { findUnique } } as never, "answer-deployment");
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ modelClass: true, webSearchPriceUsdPerThousand: true }), where: { id: "answer-deployment" } }));
    expect(basis?.pricing).toMatchObject({ inputTokenPriceUsdPerMillion: 2, webSearchPriceUsdPerThousand: 10 });
    const usage = { inputTokens: 1_000, outputTokens: 100, webSearchCount: 2 };
    expect(providerModelUsageCostMicros({ basis, reportedCostUsd: null, usage })).toBe(23_000);
    // A reported cost wins; another class never pays the per-search price.
    expect(providerModelUsageCostMicros({ basis, reportedCostUsd: 0.0142, usage })).toBe(14_200);
    expect(providerModelUsageCostMicros({ basis: { ...basis!, modelClass: "decision" }, reportedCostUsd: null, usage })).toBe(3_000);
    expect(providerModelUsageCostMicros({ basis: null, reportedCostUsd: null, usage })).toBeNull();
  });
});
