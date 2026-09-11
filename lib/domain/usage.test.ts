import { describe, expect, it } from "vitest";
import {
  estimateCostMicros,
  mergeTokenUsage,
  normalizeTokenUsage,
  subtractTokenUsage,
  sumTokenUsage
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
    const pricing = { inputTokenPriceMicros: 1, outputTokenPriceMicros: 2, reasoningTokenPriceMicros: 3 };
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
          inputTokenPriceMicros: 2,
          outputTokenPriceMicros: 8
        }
      )
    ).toBe(360);
  });

  it("prices reasoning tokens as a subset of output tokens", () => {
    expect(
      estimateCostMicros(
        { inputTokens: 10, outputTokens: 100, reasoningTokens: 80 },
        {
          inputTokenPriceMicros: 2,
          outputTokenPriceMicros: 8,
          reasoningTokenPriceMicros: 20
        }
      )
    ).toBe(1780);
  });

  it("does not double count reasoning tokens when no separate reasoning price exists", () => {
    expect(
      estimateCostMicros(
        { inputTokens: 10, outputTokens: 100, reasoningTokens: 80 },
        {
          inputTokenPriceMicros: 2,
          outputTokenPriceMicros: 8
        }
      )
    ).toBe(820);
  });
});
