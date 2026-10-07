import { describe, expect, it } from "vitest";
import { storedTokenUsage } from "./usage";

describe("stored token usage", () => {
  it("projects counts and completeness, keeps the search count column and leaves the reported cost to the writer", () => {
    expect(storedTokenUsage({ inputTokens: 10, outputTokens: 4, webSearchCount: 2, costUsd: 0.01 })).toEqual({
      cachedInputTokens: null, cacheWriteInputTokens: null, inputTokens: 10, outputTokens: 4, reasoningTokens: null,
      totalTokens: 14, usageCompleteness: "COMPLETE", webSearchCount: 2
    });
    expect(storedTokenUsage({ inputTokens: 3 })).toEqual({ cachedInputTokens: null, cacheWriteInputTokens: null,
      inputTokens: 3, outputTokens: null, reasoningTokens: null, totalTokens: null, usageCompleteness: "PARTIAL" });
  });
});
