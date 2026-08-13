import type {
  ThreadArtifactSummary,
  ThreadRunEvidenceSummary
} from "../../contracts/chats";

const TERMINAL_RUN_STATUSES = new Set(["cancelled", "complete", "error"]);

type TerminalEvidenceRun = Readonly<{
  artifactSummary: ThreadArtifactSummary | null;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  inputTokens: number;
  normalizedRequest: unknown;
  outputTokens: number;
  reasoningTokens: number;
  status: string;
  totalTokens: number;
  usageEventCount: number;
}>;

function exactAttachmentCount(normalizedRequest: unknown): number {
  if (
    typeof normalizedRequest !== "object" || normalizedRequest === null ||
    !("attachmentIds" in normalizedRequest)
  ) {
    return 0;
  }
  const attachmentIds = (normalizedRequest as { attachmentIds?: unknown }).attachmentIds;
  if (
    !Array.isArray(attachmentIds) ||
    attachmentIds.some((value) =>
      typeof value !== "string" || value.length === 0 || value.length > 2_048)
  ) {
    return 0;
  }
  return new Set(attachmentIds).size;
}

function exactSourceCount(summary: ThreadArtifactSummary | null): number {
  if (!summary) return 0;
  const searchSourceCount = (summary.searchActivity ?? []).reduce((total, activity) => {
    const count = activity.sourceCount ?? activity.sources.length;
    return total + count;
  }, 0);

  // Search activity and citation artifacts can describe the same sources. The
  // larger persisted projection is exact without presenting the same proof twice.
  return Math.max(summary.citationCount, searchSourceCount);
}

export function summarizeThreadRunEvidence(
  run: TerminalEvidenceRun
): ThreadRunEvidenceSummary | null {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return null;

  return {
    fileCount: exactAttachmentCount(run.normalizedRequest),
    hasUsage: run.usageEventCount > 0 || [
      run.cachedInputTokens,
      run.cacheWriteInputTokens,
      run.inputTokens,
      run.outputTokens,
      run.reasoningTokens,
      run.totalTokens
    ].some((value) => Number.isFinite(value) && value > 0),
    sourceCount: exactSourceCount(run.artifactSummary),
    toolCallCount: run.artifactSummary?.toolCallCount ?? 0
  };
}
