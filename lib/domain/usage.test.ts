import { describe, expect, it } from "vitest";
import {
  estimateCostMicros,
  mergeTokenUsage,
  normalizeTokenUsage,
  subtractTokenUsage,
  sumTokenUsage,
  usageCostMicros,
  type UsageCostInput
} from "./usage";

describe("usage helpers", () => {
  it("sums token usage from final usage events", () => {
    expect(
      sumTokenUsage([
        { cachedInputTokens: 3, inputTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 31 },
        { cacheWriteInputTokens: 2, inputTokens: 4, outputTokens: 6, reasoningTokens: 2 }
      ])
    ).toEqual({
      cachedInputTokens: 3,
      cacheWriteInputTokens: 2,
      inputTokens: 14,
      outputTokens: 26,
      reasoningTokens: 7,
      totalTokens: 41,
      completeness: "complete"
    });
  });

  it("derives a total from reported input and output while preserving absent breakdowns", () => {
    expect(normalizeTokenUsage({ inputTokens: 5, outputTokens: 7, reasoningTokens: 2 })).toEqual({
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      inputTokens: 5,
      outputTokens: 7,
      reasoningTokens: 2,
      totalTokens: 12,
      completeness: "complete"
    });
  });

  it("retains nulls and completeness through spreads and serialized checkpoints", () => {
    const usage = normalizeTokenUsage({ inputTokens: 0 });
    expect(JSON.parse(JSON.stringify({ ...usage }))).toEqual({
      cachedInputTokens: null, cacheWriteInputTokens: null, inputTokens: 0,
      outputTokens: null, reasoningTokens: null, totalTokens: null, completeness: "partial"
    });
    expect(normalizeTokenUsage(JSON.parse(JSON.stringify(usage)))).toEqual(usage);
    expect(normalizeTokenUsage({})).toMatchObject({ inputTokens: null, totalTokens: null, completeness: "unavailable" });
  });

  it.each([-1, 1.5, Infinity, NaN, "12"])("discards malformed counts without inventing zero (%s)", (count) => {
    expect(normalizeTokenUsage({ inputTokens: count, outputTokens: 0 })).toMatchObject({
      inputTokens: null, outputTokens: 0, totalTokens: null, completeness: "partial"
    });
  });

  it("sums known values and exposes incomplete operations, including reported zero", () => {
    const partial = sumTokenUsage([{ inputTokens: 0 }, { outputTokens: 4 }, {}]);
    expect(partial).toMatchObject({ inputTokens: 0, outputTokens: 4, totalTokens: null, completeness: "partial" });
    expect(normalizeTokenUsage(JSON.parse(JSON.stringify(partial)))).toEqual(partial);
    expect(sumTokenUsage([{}, {}])).toMatchObject({ inputTokens: null, totalTokens: null, completeness: "unavailable" });
    expect(normalizeTokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 0 }).totalTokens).toBe(0);
  });

  it("replaces cumulative counts without losing omitted fields or double counting", () => {
    const initial = normalizeTokenUsage({ inputTokens: 7, outputTokens: 1, cachedInputTokens: 0 });
    const final = mergeTokenUsage(initial, { inputTokens: 7, outputTokens: 4, totalTokens: 11 });
    expect(final).toMatchObject({ cachedInputTokens: 0, inputTokens: 7, outputTokens: 4, totalTokens: 11, completeness: "complete" });
    expect(mergeTokenUsage(final, {})).toEqual(final);
    expect(mergeTokenUsage(final, final)).toEqual(final);
  });

  it("keeps missing and partial provider evidence distinguishable from known zero", () => {
    expect(normalizeTokenUsage({} as never).completeness).toBe("unavailable");
    expect(normalizeTokenUsage({ inputTokens: 0, outputTokens: 4, reasoningTokens: 0 }).completeness)
      .toBe("complete");
    expect(normalizeTokenUsage({ inputTokens: 4, outputTokens: undefined as never, reasoningTokens: 0 }).completeness)
      .toBe("partial");
    expect(sumTokenUsage([{ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, completeness: "unavailable" }])
      .completeness).toBe("unavailable");
  });

  it("subtracts every normalized usage field without permitting underflow", () => {
    expect(subtractTokenUsage({
      cachedInputTokens: 4,
      cacheWriteInputTokens: 3,
      inputTokens: 10,
      outputTokens: 8,
      reasoningTokens: 5,
      totalTokens: 21
    }, {
      cachedInputTokens: 1,
      cacheWriteInputTokens: 2,
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 8
    })).toEqual({
      cachedInputTokens: 3,
      cacheWriteInputTokens: 1,
      inputTokens: 6,
      outputTokens: 5,
      reasoningTokens: 3,
      totalTokens: 13,
      completeness: "complete"
    });
    expect(subtractTokenUsage(
      { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      { inputTokens: 2, outputTokens: 0, reasoningTokens: 0 }
    )).toBeNull();
  });

  it("subtracts only the known contribution of a partial operation", () => {
    expect(subtractTokenUsage({ inputTokens: 12, outputTokens: 5, totalTokens: 7, completeness: "partial" },
      { inputTokens: 5, completeness: "partial" })).toMatchObject({
      inputTokens: 7, outputTokens: 5, totalTokens: 7, completeness: "partial",
      cachedInputTokens: null, cacheWriteInputTokens: null
    });
  });

  it("does not price incomplete usage or an unknown independently priced reasoning category", () => {
    const pricing = { inputTokenPriceUsdPerMillion: 1, outputTokenPriceUsdPerMillion: 2, reasoningTokenPriceUsdPerMillion: 3 };
    expect(estimateCostMicros({}, pricing)).toBeNull();
    expect(estimateCostMicros({ inputTokens: 4 }, pricing)).toBeNull();
    expect(estimateCostMicros({ inputTokens: 4, outputTokens: 3 }, pricing)).toBeNull();
    expect(estimateCostMicros({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, pricing)).toBe(0);
  });

  it("estimates micros using explicit pricing metadata", () => {
    expect(
      estimateCostMicros(
        { inputTokens: 100, outputTokens: 20, reasoningTokens: 10 },
        {
          inputTokenPriceUsdPerMillion: 2,
          outputTokenPriceUsdPerMillion: 8
        }
      )
    ).toBe(360);
  });

  it("splits cache read and write prices and rounds to integer micro-dollars", () => {
    const usage = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000 };
    const pricing = { inputTokenPriceUsdPerMillion: 2, cachedInputTokenPriceUsdPerMillion: 0.2, outputTokenPriceUsdPerMillion: 10 };
    expect(estimateCostMicros(usage, pricing)).toBe(15_600);
    expect(estimateCostMicros({ ...usage, cacheWriteInputTokens: 1_000 },
      { ...pricing, cacheWriteInputTokenPriceUsdPerMillion: 2.5 })).toBe(16_100);
    expect(estimateCostMicros({ inputTokens: 100, outputTokens: 0 },
      { inputTokenPriceUsdPerMillion: 0.0125, outputTokenPriceUsdPerMillion: 0 })).toBe(1);
  });

  it("rounds exact decimal half-micro boundaries up", () => {
    expect(estimateCostMicros({ inputTokens: 50, outputTokens: 0 },
      { inputTokenPriceUsdPerMillion: 0.29, outputTokenPriceUsdPerMillion: 0 })).toBe(15);
  });

  it("falls back to ordinary input prices only for missing cache tariffs", () => {
    const usage = { inputTokens: 10_000, cachedInputTokens: 8_000, cacheWriteInputTokens: 1_000, outputTokens: 1_000 };
    const pricing = { inputTokenPriceUsdPerMillion: 2, outputTokenPriceUsdPerMillion: 10 };
    expect(estimateCostMicros(usage, pricing)).toBe(30_000);
    expect(estimateCostMicros(usage, { ...pricing, inputTokenPriceUsdPerMillion: null })).toBeNull();
    expect(estimateCostMicros(usage, { ...pricing, outputTokenPriceUsdPerMillion: null })).toBeNull();
    expect(estimateCostMicros({ ...usage, completeness: "partial" }, pricing)).toBeNull();
    expect(estimateCostMicros({ inputTokens: 10, outputTokens: 2 },
      { inputTokenPriceUsdPerMillion: 0, outputTokenPriceUsdPerMillion: 0 })).toBe(0);
    expect(estimateCostMicros({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 },
      { ...pricing, cachedInputTokenPriceUsdPerMillion: 0.2 })).toBe(4);
  });

  it("prices reasoning tokens as a subset of output tokens", () => {
    expect(
      estimateCostMicros(
        { inputTokens: 10, outputTokens: 100, reasoningTokens: 80 },
        {
          inputTokenPriceUsdPerMillion: 2,
          outputTokenPriceUsdPerMillion: 8,
          reasoningTokenPriceUsdPerMillion: 20
        }
      )
    ).toBe(1780);
  });

  it("does not double count reasoning tokens when no separate reasoning price exists", () => {
    expect(
      estimateCostMicros(
        { inputTokens: 10, outputTokens: 100, reasoningTokens: 80 },
        {
          inputTokenPriceUsdPerMillion: 2,
          outputTokenPriceUsdPerMillion: 8
        }
      )
    ).toBe(820);
  });
});

describe("usage row cost", () => {
  const prices = { inputTokenPriceUsdPerMillion: 2, cachedInputTokenPriceUsdPerMillion: 0.2,
    cacheWriteInputTokenPriceUsdPerMillion: 2.5, outputTokenPriceUsdPerMillion: 10 };
  const unpriced = { inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null };
  const answerUsage = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000 };
  const cost = (reportedCostUsd: number | null, input: Partial<Omit<UsageCostInput, "reportedCostUsd">> = {}) =>
    usageCostMicros({ reportedCostUsd, usage: answerUsage, pricing: prices, modelClass: "embedding", ...input });

  it("prefers a provider-reported cost over configured prices, keeping a reported zero known", () => {
    for (const modelClass of ["answer", "decision", "image", "embedding", "reranker"] as const) {
      expect(cost(0.0123, { modelClass })).toBe(12_300);
      expect(cost(0, { modelClass })).toBe(0);
    }
    expect(cost(0.0000123, { usage: {}, pricing: unpriced })).toBe(12);
    // OpenRouter's reported embedding and rerank costs (probed 2026-10-07) are sub-micro: a known zero.
    expect(cost(5e-8)).toBe(0);
    expect(cost(1e-7, { modelClass: "reranker" })).toBe(0);
  });

  it("rounds the reported decimal half up exactly, not its binary approximation", () => {
    expect([5e-7, 0.0000025, 0.0000015, 0.0000014, 1.5e-7, 0.13, 1, 2147.483647].map(usd => cost(usd)))
      .toEqual([1, 3, 2, 1, 0, 130_000, 1_000_000, 2_147_483_647]);
  });

  it("keeps an invalid or unrepresentable reported cost unknown instead of estimating it", () => {
    for (const usd of [Number.NaN, -0.000001, Number.POSITIVE_INFINITY, 2147.4836475, 2148, 1e300]) {
      expect(cost(usd, { modelClass: "answer" })).toBeNull();
    }
    expect(cost(2147.4836474)).toBe(2_147_483_647);
  });

  it("costs embedding and reranker usage from input tokens, else total tokens, and never needs output", () => {
    expect(cost(null, { usage: { inputTokens: 1_000_000 }, pricing: { ...unpriced, inputTokenPriceUsdPerMillion: 0.13 } })).toBe(130_000);
    expect(cost(null, { modelClass: "reranker", usage: { totalTokens: 20_000, completeness: "partial" },
      pricing: { ...unpriced, inputTokenPriceUsdPerMillion: 0.05 } })).toBe(1_000);
    // Input wins over total; output tokens and prices outside the class are ignored.
    expect(cost(null, { usage: { inputTokens: 5_000, outputTokens: 900, totalTokens: 9_000 }, pricing: { ...prices, outputTokenPriceUsdPerMillion: 1_000 } }))
      .toBe(10_000);
    expect(cost(null, { usage: { inputTokens: 50 }, pricing: { ...unpriced, inputTokenPriceUsdPerMillion: 0.29 } })).toBe(15);
    expect(cost(null, { usage: { outputTokens: 10 } })).toBeNull();
    expect(cost(null, { usage: { inputTokens: 10, completeness: "unavailable" } })).toBeNull();
    expect(cost(null, { usage: { inputTokens: 10 }, pricing: unpriced })).toBeNull();
    expect(cost(null, { usage: { inputTokens: 10 }, pricing: { ...unpriced, inputTokenPriceUsdPerMillion: Number.NaN } })).toBeNull();
    expect(cost(null, { usage: { inputTokens: 2_000_000_000 }, pricing: { ...unpriced, inputTokenPriceUsdPerMillion: 2 } })).toBeNull();
  });

  it("costs decision and image usage like an answer but charges cached input as input", () => {
    for (const modelClass of ["decision", "image"] as const) {
      expect(cost(null, { modelClass })).toBe(30_000);
      expect(cost(null, { modelClass, usage: { inputTokens: 10, completeness: "partial" } })).toBeNull();
      expect(cost(null, { modelClass, pricing: { ...prices, outputTokenPriceUsdPerMillion: null } })).toBeNull();
    }
  });

  it("keeps answer costing identical to the token-price estimate", () => {
    for (const usage of [answerUsage, { ...answerUsage, cacheWriteInputTokens: 1_000 }, { inputTokens: 4 }, { inputTokens: 50, outputTokens: 0 }]) {
      expect(cost(null, { modelClass: "answer", usage })).toBe(estimateCostMicros(usage, prices));
    }
    expect(cost(null, { modelClass: "answer" })).toBe(15_600);
  });
});
