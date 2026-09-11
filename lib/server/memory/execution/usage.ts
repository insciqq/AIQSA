import { normalizeTokenUsage } from "../../../domain/usage";
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
