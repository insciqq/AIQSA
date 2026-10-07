import type { Prisma } from "@prisma/client";
import { normalizeTokenUsage } from "../../domain/usage";
import {
  RUN_USAGE_ATTRIBUTION_PURPOSES,
  isRunUsageAttributionPurpose,
  type RunUsageAttributionPurpose
} from "../../domain/usagePurpose";
import type { RunUsageAttribution } from "./runRepositoryContract";

/**
 * A run's own attribution rows: no purpose flag, no Memory binding and an
 * attribution purpose. The run's accounting reads and rewrites exactly these;
 * title, Vision, PDF, relevance, decision, image, Memory and any other row
 * linked to the run belongs to its own writer and survives every rewrite.
 */
export function runAttributionUsageWhere(runId: string): Prisma.UsageEventWhereInput {
  return {
    chatPdfPreparation: false, chatTitleGeneration: false, imageGeneration: false, knowledgeRelevance: false,
    mcpHubDiscovery: false, optionalDecision: false, visionAnalysis: false,
    memoryExecutionBindingId: null, modelRunId: runId,
    purpose: { in: [...RUN_USAGE_ATTRIBUTION_PURPOSES] }
  };
}

/** Row data for a run's attributions, written after the run's previous attribution rows were deleted. */
export function runAttributionUsageRows(
  scope: Readonly<{ chatId: string; projectId?: string | null; runId: string; userId: string }>,
  attributions: readonly RunUsageAttribution[]
): Prisma.UsageEventCreateManyInput[] {
  return attributions.map((attribution) => {
    const usage = normalizeTokenUsage(attribution.usage);
    return {
      chatId: scope.chatId, operationCount: attribution.operationCount ?? null,
      cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
      estimatedCostMicros: attribution.estimatedCostMicros ?? null, inputTokens: usage.inputTokens,
      modelId: attribution.modelId, modelRunId: scope.runId, outputTokens: usage.outputTokens,
      provider: attribution.provider, purpose: attribution.purpose,
      reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
      usageCompleteness: usage.completeness === "complete" ? "COMPLETE" as const :
        usage.completeness === "partial" ? "PARTIAL" as const : "UNAVAILABLE" as const,
      ...(scope.projectId ? { projectId: scope.projectId } : {}), userId: scope.userId
    };
  });
}

/** The stored purpose of a row read through {@link runAttributionUsageWhere}. */
export function storedRunAttributionPurpose(value: unknown): RunUsageAttributionPurpose {
  if (!isRunUsageAttributionPurpose(value)) throw new Error("run_usage_purpose_invalid");
  return value;
}
