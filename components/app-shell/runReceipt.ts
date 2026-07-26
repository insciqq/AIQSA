import { runActivityLabel, type PipelineSnapshot } from "@/components/app-shell/runState";
import { searchStrategyDescription } from "@/components/app-shell/shellFormatting";
import type {
  PersistedRun,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";

export type RunReceiptFactKind =
  | "citations"
  | "context"
  | "model"
  | "reasoning"
  | "search"
  | "tools"
  | "usage"
  | "warnings";

export type RunReceiptSegmentKind = "status" | RunReceiptFactKind;

export type RunReceiptFact = Readonly<{
  detail?: string;
  kind: RunReceiptFactKind;
  label: string;
}>;

export type RunReceiptStatus = "cancelled" | "complete" | "error" | "running";

export type FactualRunReceipt = Readonly<{
  facts: readonly RunReceiptFact[];
  status: RunReceiptStatus;
  statusLabel: string;
}>;

export type RunReceiptInput = Readonly<{
  artifactSummary?: ThreadArtifactSummary | null;
  messageStatus: ThreadMessage["status"];
  messageRunId?: string | null;
  modelLabel: string | null;
  persistedRun?: PersistedRun | null;
  runActivity?: PipelineSnapshot | null;
  warningCount?: number;
}>;

function factualCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function tokenUsageLabel(run: PersistedRun, messageRunId: string | null | undefined): string | null {
  if (
    !messageRunId ||
    run.id !== messageRunId ||
    (run.status !== "complete" && run.status !== "cancelled" && run.status !== "error")
  ) {
    return null;
  }

  const totalTokens = factualCount(run.totalTokens);
  return totalTokens > 0
    ? `${totalTokens.toLocaleString("en-US")} ${totalTokens === 1 ? "token" : "tokens"} used`
    : null;
}

function receiptStatus(
  messageStatus: ThreadMessage["status"],
  runActivity: PipelineSnapshot | null | undefined
): Pick<FactualRunReceipt, "status" | "statusLabel"> {
  if (messageStatus === "complete") {
    return { status: "complete", statusLabel: "Complete" };
  }

  if (messageStatus === "cancelled") {
    return { status: "cancelled", statusLabel: "Stopped" };
  }

  if (messageStatus === "error") {
    return { status: "error", statusLabel: "Failed" };
  }

  return {
    status: "running",
    statusLabel: runActivity ? runActivityLabel(runActivity) : "Working"
  };
}

/**
 * Projects only facts already bound to this assistant message. It deliberately
 * has no access to current composer settings, display toggles, or estimated
 * values. Persisted usage is accepted only when its run id exactly matches the
 * answer, so a historical receipt cannot borrow the active surface's usage.
 */
export function deriveRunReceipt({
  artifactSummary,
  messageStatus,
  messageRunId,
  modelLabel,
  persistedRun,
  runActivity,
  warningCount = 0
}: RunReceiptInput): FactualRunReceipt {
  const facts: RunReceiptFact[] = [];
  const normalizedModel = modelLabel?.trim();

  if (normalizedModel) {
    facts.push({ kind: "model", label: normalizedModel });
  }

  if (artifactSummary) {
    const searchCount = factualCount(artifactSummary.searchCount);
    if (searchCount > 0) {
      facts.push({
        ...(artifactSummary.searchStrategy
          ? { detail: searchStrategyDescription(artifactSummary.searchStrategy) }
          : {}),
        kind: "search",
        label: countLabel(searchCount, "search call", "search calls")
      });
    }

    const toolCount = factualCount(artifactSummary.toolCallCount);
    if (toolCount > 0) {
      const failedCount = Math.min(
        toolCount,
        artifactSummary.toolCalls.filter((call) => call.status === "error").length
      );
      facts.push({
        kind: "tools",
        label: `${countLabel(toolCount, "tool call", "tool calls")}${
          failedCount > 0 ? ` (${failedCount} failed)` : ""
        }`
      });
    }

    const citationCount = factualCount(artifactSummary.citationCount);
    if (citationCount > 0) {
      facts.push({
        kind: "citations",
        label: countLabel(citationCount, "citation", "citations")
      });
    }

    const reasoningCount = factualCount(artifactSummary.reasoningCount);
    if (reasoningCount > 0) {
      facts.push({
        kind: "reasoning",
        label: countLabel(reasoningCount, "reasoning trace", "reasoning traces")
      });
    }

    if (artifactSummary.contextTruncation) {
      facts.push({ kind: "context", label: "Context trimmed" });
    }
  }

  const usageLabel = persistedRun ? tokenUsageLabel(persistedRun, messageRunId) : null;
  if (usageLabel) {
    facts.push({ kind: "usage", label: usageLabel });
  }

  const warnings = factualCount(warningCount);
  if (warnings > 0) {
    facts.push({
      kind: "warnings",
      label: countLabel(warnings, "warning", "warnings")
    });
  }

  return {
    ...receiptStatus(messageStatus, runActivity),
    facts
  };
}
