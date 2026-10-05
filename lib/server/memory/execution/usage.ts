import { estimateCostMicros, normalizeTokenUsage, type ModelTokenPricing } from "../../../domain/usage";
import type { MemoryReportedUsage } from "./lifecycle";

export function memoryReportedUsage(
  value: (Parameters<typeof normalizeTokenUsage>[0] & { estimatedCostMicros?: unknown }) | null
): MemoryReportedUsage {
  const usage = normalizeTokenUsage(value ?? {});
  const estimated = value?.estimatedCostMicros;
  return {
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    completeness: usage.completeness === "unavailable" ? "UNAVAILABLE"
      : usage.completeness === "complete" ? "COMPLETE" : "PARTIAL",
    estimatedCostMicros: usage.completeness !== "unavailable" && typeof estimated === "number" &&
      Number.isSafeInteger(estimated) && estimated >= 0 ? estimated : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens
  };
}

/** Prices complete usage with the catalog estimate answer runs use. A
 * provider-reported cost wins; partial or unavailable usage and an unpriced
 * model keep an unknown cost. */
export function memoryUsageWithCatalogCost(
  usage: MemoryReportedUsage,
  pricing: ModelTokenPricing | null
): MemoryReportedUsage {
  if (!pricing || usage.estimatedCostMicros !== null || usage.completeness !== "COMPLETE") {
    return usage;
  }
  const estimatedCostMicros = estimateCostMicros({
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
    completeness: "complete",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens
  }, pricing);
  return estimatedCostMicros === null ? usage : { ...usage, estimatedCostMicros };
}
