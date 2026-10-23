import type { SessionContextStatus } from "../../contracts/sessionStatus";
import { calculateContextBudgetLimits } from "../../domain/contextBudget";
import type { ProviderRunRequest } from "../providers/types";
import type { RunOutputArtifactEvent } from "../runs/runOutputEvents";

/**
 * The chat header's context status of a native request (`context_status`,
 * the snapshot the chat detail reads from the latest run): the engine's own
 * measure (`RunContext.measured`, the provider's last reported input plus the
 * estimate of what was added since, or the compacted transcript's estimate
 * after a compaction), never the old core's estimate of the whole branch. The
 * answer reserve is the one the engine keeps free, and the safety margin is
 * derived as the composer derives its own limits (`calculateContextBudgetLimits`),
 * so an unchanged model and settings read as measured.
 */
export function nativeContextStatus(input: Readonly<{
  /** The output the engine reserves on every request (`execution.ts`). */
  maxOutputTokens: number;
  phase: SessionContextStatus["phase"];
  request: ProviderRunRequest;
  tokens: number;
}>): SessionContextStatus {
  const configured = input.request.modelCapabilities.contextWindow;
  const contextWindow = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : null;
  const limits = calculateContextBudgetLimits({ contextWindow: contextWindow ?? 0, maxOutputTokens: input.maxOutputTokens,
    provider: input.request.provider });
  return {
    approximateInputTokens: Math.max(0, Math.floor(input.tokens)),
    contextWindow,
    droppedMessages: input.request.context?.summary?.truncation?.droppedMessages ?? 0,
    loadedTools: input.request.tools?.length ?? 0,
    maxOutputTokens: limits.maxOutputTokens,
    modelId: input.request.modelId,
    phase: input.phase,
    provider: input.request.provider,
    safetyMarginTokens: limits.safetyMarginTokens,
    version: 1
  };
}

/** Server-minted, so recorded as it is (the provider output projection never keeps capacity statuses). */
export function contextStatusArtifact(status: SessionContextStatus): RunOutputArtifactEvent {
  return { data: { artifactType: "context_status", payload: status }, type: "artifact" };
}
