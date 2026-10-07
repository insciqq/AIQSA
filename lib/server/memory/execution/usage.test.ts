import { describe, expect, it } from "vitest";
import { EmbeddingAdapterError } from "../../providers/embeddings";
import { RerankAdapterError } from "../../providers/rerank";
import type { MemoryReportedUsage } from "./lifecycle";
import { memoryUsageWithCatalogCost, memoryVectorCallErrorUsage, memoryVectorCallUsage } from "./usage";

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
    expect(memoryUsageWithCatalogCost(complete, pricing, "answer"))
      .toEqual({ ...complete, estimatedCostMicros: 4_280 });
    // 100 of the input tokens were cache writes at $2.50 per million.
    expect(memoryUsageWithCatalogCost(
      { ...complete, cacheWriteInputTokens: 100 },
      { ...pricing, cacheWriteInputTokenPriceUsdPerMillion: 2.5 },
      "answer"
    )).toMatchObject({ estimatedCostMicros: 4_330 });
    // A decision model charges cached input as input.
    expect(memoryUsageWithCatalogCost(complete, pricing, "decision"))
      .toMatchObject({ estimatedCostMicros: 5_000 });
  });

  it("prices embedding and reranker calls from their input price alone, also from partial usage", () => {
    const inputOnly = { ...pricing, outputTokenPriceUsdPerMillion: null, inputTokenPriceUsdPerMillion: 0.13 };
    const embedding = memoryVectorCallUsage({ costUsd: null, inputTokens: 1_000_000, totalTokens: 1_000_000 });
    expect(memoryUsageWithCatalogCost(embedding, inputOnly, "embedding"))
      .toEqual({ ...embedding, estimatedCostMicros: 130_000 });
    // OpenRouter rerank reports total tokens only.
    const rerank = memoryVectorCallUsage({ costUsd: null, inputTokens: null, totalTokens: 20_000 });
    expect(rerank).toMatchObject({ completeness: "PARTIAL", totalTokens: 20_000 });
    expect(memoryUsageWithCatalogCost(rerank, { ...inputOnly, inputTokenPriceUsdPerMillion: 0.05 }, "reranker"))
      .toMatchObject({ estimatedCostMicros: 1_000 });
  });

  it("keeps provider cost, unpriceable usage and unpriced models unchanged", () => {
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
    // An answer needs complete counts; nothing prices unavailable usage.
    for (const usage of [reported, partial, unavailable]) {
      expect(memoryUsageWithCatalogCost(usage, pricing, "answer")).toBe(usage);
    }
    expect(memoryUsageWithCatalogCost(unavailable, pricing, "embedding")).toBe(unavailable);
    expect(memoryUsageWithCatalogCost(complete, null, "answer")).toBe(complete);
  });
});

describe("Memory embedding and reranker call usage", () => {
  it("carries reported tokens and the reported cost in exact micro-dollars", () => {
    expect(memoryVectorCallUsage({ costUsd: 0.0000123, inputTokens: 5, totalTokens: 5 })).toEqual({
      cachedInputTokens: 0, completeness: "COMPLETE", estimatedCostMicros: 12,
      inputTokens: 5, outputTokens: 0, reasoningTokens: 0, totalTokens: 5
    });
    // OpenRouter's probed embedding cost is a known sub-micro zero.
    expect(memoryVectorCallUsage({ costUsd: 5e-8, inputTokens: 5, totalTokens: 5 }))
      .toMatchObject({ estimatedCostMicros: 0 });
    expect(memoryVectorCallUsage({ inputTokens: 5, totalTokens: null }))
      .toMatchObject({ completeness: "PARTIAL", estimatedCostMicros: null });
  });

  it("keeps a reported cost without token counts as partial usage", () => {
    expect(memoryVectorCallUsage({ costUsd: 0.000002, inputTokens: null, totalTokens: null }))
      .toMatchObject({ completeness: "PARTIAL", estimatedCostMicros: 2, inputTokens: null, totalTokens: null });
    expect(memoryVectorCallUsage({ costUsd: null, inputTokens: null, totalTokens: null })).toEqual({
      cachedInputTokens: null, completeness: "UNAVAILABLE", estimatedCostMicros: null,
      inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null
    });
  });

  it("settles a rejected response with the usage it reported and every other failure unavailable", () => {
    expect(memoryVectorCallErrorUsage(new EmbeddingAdapterError("embedding_response_vector_invalid", {
      usage: { costUsd: 0.0000123, inputTokens: 5, totalTokens: 5 }
    }))).toEqual(memoryVectorCallUsage({ costUsd: 0.0000123, inputTokens: 5, totalTokens: 5 }));
    expect(memoryVectorCallErrorUsage(new RerankAdapterError("rerank_response_invalid", {
      usage: { costUsd: null, inputTokens: null, searchUnits: null, totalTokens: 20 }
    }))).toMatchObject({ completeness: "PARTIAL", estimatedCostMicros: null, totalTokens: 20 });
    for (const error of [
      new EmbeddingAdapterError("embedding_request_timed_out"),
      new RerankAdapterError("rerank_provider_http_error", { httpStatus: 503 }),
      new Error("embedding_response_vector_invalid")
    ]) {
      expect(memoryVectorCallErrorUsage(error)).toMatchObject({ completeness: "UNAVAILABLE", inputTokens: null });
    }
  });
});
