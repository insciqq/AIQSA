import { describe, expect, it } from "vitest";
import {
  estimateCostMicros,
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
      totalTokens: 41
    });
  });

  it("fills rich token fields from coarse provider usage", () => {
    expect(normalizeTokenUsage({ inputTokens: 5, outputTokens: 7, reasoningTokens: 2 })).toEqual({
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 5,
      outputTokens: 7,
      reasoningTokens: 2,
      totalTokens: 12
    });
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
      totalTokens: 13
    });
    expect(subtractTokenUsage(
      { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      { inputTokens: 2, outputTokens: 0, reasoningTokens: 0 }
    )).toBeNull();
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
