import type { AdminProviderModelClass } from "../../../contracts/adminProviders";
import { normalizeTokenUsage, reportedCostMicros, usageCostMicros, type ModelTokenPricing } from "../../../domain/usage";
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

const UNAVAILABLE_VECTOR_CALL_USAGE: MemoryReportedUsage = Object.freeze({
  cachedInputTokens: null,
  completeness: "UNAVAILABLE",
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
});

/** Usage of one embedding or reranker call as settlement input: its reported
 * tokens (it generates no output) and its provider-reported cost. A reported
 * cost without token counts is still partial usage, never unavailable. */
export function memoryVectorCallUsage(usage: Readonly<{
  costUsd?: number | null;
  inputTokens: number | null;
  totalTokens: number | null;
}>): MemoryReportedUsage {
  const { inputTokens, totalTokens } = usage;
  const estimatedCostMicros = usage.costUsd == null ? null : reportedCostMicros(usage.costUsd);
  if (inputTokens === null && totalTokens === null && estimatedCostMicros === null) {
    return UNAVAILABLE_VECTOR_CALL_USAGE;
  }
  return {
    cachedInputTokens: 0,
    completeness: inputTokens !== null && totalTokens !== null ? "COMPLETE" : "PARTIAL",
    estimatedCostMicros,
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens
  };
}

/** Prices usage the provider reported no cost for with the shared cost rule:
 * the frozen catalog prices of the executed model's class. A provider-reported
 * cost wins; unavailable usage, usage the class cannot price (an answer needs
 * complete counts) and an unpriced model keep an unknown cost. */
export function memoryUsageWithCatalogCost(
  usage: MemoryReportedUsage,
  pricing: ModelTokenPricing | null,
  modelClass: AdminProviderModelClass
): MemoryReportedUsage {
  if (!pricing || usage.estimatedCostMicros !== null || usage.completeness === "UNAVAILABLE") {
    return usage;
  }
  const estimatedCostMicros = usageCostMicros({
    modelClass,
    pricing,
    reportedCostUsd: null,
    usage: {
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
      completeness: usage.completeness === "COMPLETE" ? "complete" : "partial",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens
    }
  });
  return estimatedCostMicros === null ? usage : { ...usage, estimatedCostMicros };
}
