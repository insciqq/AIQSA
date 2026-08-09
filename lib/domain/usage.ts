export type TokenUsage = {
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens?: number;
};

export type NormalizedTokenUsage = {
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type ModelTokenPricing = {
  inputTokenPriceMicros: number;
  outputTokenPriceMicros: number;
  reasoningTokenPriceMicros?: number;
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function tokenUsageTotal(usage: TokenUsage): number {
  return tokenCount(usage.totalTokens) || tokenCount(usage.inputTokens) + tokenCount(usage.outputTokens);
}

export function normalizeTokenUsage(usage: TokenUsage): NormalizedTokenUsage {
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);

  return {
    cachedInputTokens: tokenCount(usage.cachedInputTokens),
    cacheWriteInputTokens: tokenCount(usage.cacheWriteInputTokens),
    inputTokens,
    outputTokens,
    reasoningTokens: tokenCount(usage.reasoningTokens),
    totalTokens: tokenCount(usage.totalTokens) || inputTokens + outputTokens
  };
}

export function sumTokenUsage(usages: TokenUsage[]): NormalizedTokenUsage {
  return usages.reduce<NormalizedTokenUsage>(
    (total, usage) => {
      const normalized = normalizeTokenUsage(usage);

      return {
        cachedInputTokens: total.cachedInputTokens + normalized.cachedInputTokens,
        cacheWriteInputTokens: total.cacheWriteInputTokens + normalized.cacheWriteInputTokens,
        inputTokens: total.inputTokens + normalized.inputTokens,
        outputTokens: total.outputTokens + normalized.outputTokens,
        reasoningTokens: total.reasoningTokens + normalized.reasoningTokens,
        totalTokens: total.totalTokens + normalized.totalTokens
      };
    },
    {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    }
  );
}

export function subtractTokenUsage(
  total: TokenUsage,
  subtrahend: TokenUsage
): NormalizedTokenUsage | null {
  const normalizedTotal = normalizeTokenUsage(total);
  const normalizedSubtrahend = normalizeTokenUsage(subtrahend);
  const fields = [
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens"
  ] as const;
  if (fields.some((field) => normalizedSubtrahend[field] > normalizedTotal[field])) {
    return null;
  }
  return {
    cachedInputTokens: normalizedTotal.cachedInputTokens - normalizedSubtrahend.cachedInputTokens,
    cacheWriteInputTokens:
      normalizedTotal.cacheWriteInputTokens - normalizedSubtrahend.cacheWriteInputTokens,
    inputTokens: normalizedTotal.inputTokens - normalizedSubtrahend.inputTokens,
    outputTokens: normalizedTotal.outputTokens - normalizedSubtrahend.outputTokens,
    reasoningTokens: normalizedTotal.reasoningTokens - normalizedSubtrahend.reasoningTokens,
    totalTokens: normalizedTotal.totalTokens - normalizedSubtrahend.totalTokens
  };
}

export function estimateCostMicros(usage: TokenUsage, pricing: ModelTokenPricing): number {
  const normalized = normalizeTokenUsage(usage);
  const reasoningPrice = pricing.reasoningTokenPriceMicros ?? pricing.outputTokenPriceMicros;
  const reasoningTokens = Math.min(normalized.reasoningTokens, normalized.outputTokens);
  const nonReasoningOutputTokens = normalized.outputTokens - reasoningTokens;

  return (
    normalized.inputTokens * pricing.inputTokenPriceMicros +
    nonReasoningOutputTokens * pricing.outputTokenPriceMicros +
    reasoningTokens * reasoningPrice
  );
}
