import { makeContextCompactionStatus, type ContextCompactionStatus, type ContextPlanMeasurement } from "../../contracts/contextCompaction";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import { ContextSummaryError, executeContextSummary, summaryNeedsProvider } from "./contextCompactionSummarizer";
import { applyProviderRequestContextBudget, type ProviderRequestContextBudgetResult } from "./runContextBudget";
import type { RunOutputArtifactEvent } from "./runOutputEvents";

export function contextCompactionArtifact(status: ContextCompactionStatus): RunOutputArtifactEvent {
  return {
    data: { artifactType: "context_compaction", payload: status },
    type: "artifact"
  };
}

export function contextCompactionFailureOutcome(code: string): ContextCompactionStatus["outcome"] {
  if (code === "context_compaction_source_unavailable") return "source_unavailable";
  if (code === "context_too_large") return "irreducible_overflow";
  if (code.startsWith("context_compaction_summary_")) return "summary_failed";
  if (code.startsWith("provider_") || code === "model_not_available") return "provider_failed";
  return "unknown";
}

export function createContextCompactionPublisher(
  append: (status: ContextCompactionStatus) => Promise<void>,
  initial?: ContextCompactionStatus | null
) {
  let latest = initial ?? null;
  let beforeTokens = latest?.beforeTokens ?? null;
  let closed = false;
  let queue = Promise.resolve();
  function serialize(operation: () => Promise<void>): Promise<void> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function publish(status: ContextCompactionStatus): Promise<void> {
    const cycle = latest ? latest.cycle + (latest.state === "running" ? 0 : 1) : 1;
    const next = { ...status, cycle };
    await append(next);
    latest = next;
    beforeTokens = next.beforeTokens;
  }
  return {
    get running() { return !closed && latest?.state === "running"; },
    begin: (measurement: ContextPlanMeasurement | undefined) => serialize(async () => {
      if (closed || latest?.state === "running") return;
      await publish(makeContextCompactionStatus({ beforeTokens: measurement?.beforeTokens, outcome: "pending", state: "running" }));
    }),
    settle: (outcome: ContextCompactionStatus["outcome"], measurement?: ContextPlanMeasurement) => serialize(async () => {
      if (closed || latest?.state !== "running" && !measurement) return;
      await publish(makeContextCompactionStatus({
        afterTokens: measurement?.afterTokens,
        beforeTokens: latest?.state === "running" ? beforeTokens : measurement?.beforeTokens,
        outcome,
        state: outcome === "summary_applied" || outcome === "masking_applied" ? "complete" : "failed"
      }));
    }),
    /** Stop and terminal settlement close the feed: an unfinished cycle fails
     * with the terminal outcome once, and no later cycle can start. */
    terminate: (outcome?: ContextCompactionStatus["outcome"]) => serialize(async () => {
      if (closed) return;
      closed = true;
      if (!outcome || latest?.state !== "running") return;
      await publish(makeContextCompactionStatus({
        beforeTokens,
        outcome: outcome === "summary_applied" || outcome === "masking_applied" || outcome === "pending" ? "unknown" : outcome,
        state: "failed"
      }));
    })
  };
}

export type ContextCompactionPublisher = ReturnType<typeof createContextCompactionPublisher>;

function failureCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function appliedSummary(request: ProviderRunRequest): boolean {
  const summary = request.contextCompactionSummary;
  return summary !== undefined &&
    request.context?.messages.some((message) => message.id === `__context-summary-${summary.id}`) === true;
}

export type CompactedProviderRequestInput = Readonly<{
  /** Rechecks answer authority immediately before paid summary I/O. */
  authorize?(): Promise<void>;
  bridge?: ProviderToolBridge;
  /** The owner's classified error for a compaction or budget failure. */
  failure(code: string, message: string): Error;
  onSummaryUsage(usage: ModelRunUsage, request: ProviderRunRequest): Promise<void> | void;
  onTruncation?(truncation: ContextTruncationSummary): Promise<void> | void;
  publisher: ContextCompactionPublisher;
  request: ProviderRunRequest;
  signal: AbortSignal;
  /** The accepted answer binding, used directly so summary text never becomes answer output. */
  summaryAdapter: Pick<ProviderAdapter, "stream">;
}>;

const SUMMARY_CYCLES_PER_REQUEST = 2;

/**
 * The single compaction consumer for an answer dispatch, live or recovered.
 * It measures the request's actual messages first and decides only from that
 * fresh measurement; a measurement carried from an earlier round never buys or
 * skips a summary. The returned request is exactly what may be dispatched and
 * checkpointed, and a hybrid request that still needs a summary is never
 * returned: a committed summary that cannot fit fails instead of falling back
 * to legacy trimming. The published cycle uses this request's own numbers.
 */
export async function prepareCompactedProviderRequest(
  input: CompactedProviderRequestInput
): Promise<ProviderRunRequest> {
  const { publisher } = input;
  const budget = (request: ProviderRunRequest) => applyProviderRequestContextBudget({
    ...(input.bridge ? { bridge: input.bridge } : {}),
    request
  });
  const measured = budget(input.request);
  if (!measured.ok) {
    if (publisher.running) await publisher.settle(contextCompactionFailureOutcome(measured.error.code));
    throw input.failure("context_too_large", measured.error.message);
  }
  const measurement = measured.request.contextCompaction;
  let prepared: Extract<ProviderRequestContextBudgetResult, { ok: true }> = measured;
  let summaries = 0;
  while (summaryNeedsProvider(prepared.request)) {
    if (summaries >= SUMMARY_CYCLES_PER_REQUEST) {
      await publisher.settle("summary_failed");
      throw input.failure("context_compaction_summary_failed", "Context compaction did not make bounded progress.");
    }
    input.signal.throwIfAborted();
    await publisher.begin(measurement);
    try {
      await input.authorize?.();
    } catch (error) {
      const code = failureCode(error);
      await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
      throw error;
    }
    const source = prepared.request;
    let summarized: Awaited<ReturnType<typeof executeContextSummary>>;
    try {
      summarized = await executeContextSummary({
        adapter: input.summaryAdapter,
        existingAttempts: source.contextCompactionSummaryAttempts,
        existingSummary: source.contextCompactionSummary,
        onUsage: (usage) => input.onSummaryUsage(usage, source),
        request: source,
        signal: input.signal
      });
    } catch (error) {
      if (error instanceof ContextSummaryError) {
        await publisher.settle(contextCompactionFailureOutcome(error.code));
        throw input.failure(error.code, error.message);
      }
      await publisher.settle("provider_failed");
      throw error;
    }
    summaries += 1;
    const next = budget(summarized.request);
    if (!next.ok) {
      await publisher.settle(next.error.code === "context_too_large" ? "irreducible_overflow" : "summary_failed");
      throw input.failure("context_compaction_summary_failed", next.error.message);
    }
    prepared = next;
  }
  const after = prepared.request.contextCompaction;
  if (summaries > 0) {
    await publisher.settle("summary_applied", after);
  } else if (publisher.running) {
    // A cycle left running by a lost executor: a summary committed to the
    // checkpoint has been applied again; otherwise its outcome is unknown.
    if (appliedSummary(prepared.request)) await publisher.settle("summary_applied", after);
    else await publisher.settle("unknown");
  } else if (after?.outcome === "masking_applied") {
    // Masking is reported in the round that masked, with that round's numbers.
    // A summary carried from an earlier round does not make it a summary cycle.
    await publisher.settle("masking_applied", after);
  }
  if (prepared.contextTruncation) await input.onTruncation?.(prepared.contextTruncation);
  return prepared.request;
}

/**
 * Knowledge answer routes have no summary consumer. Their grounded answer
 * operations carry only the frozen evidence manifest and effective question,
 * and model-derived notes must never stand beside citation evidence. Their
 * evidence fit check therefore keeps the exact legacy whole-turn guard even
 * for a hybrid admission: prior turns may be trimmed, pinned evidence stays
 * whole, irreducible overflow is rejected, and no over-budget request results.
 */
export function applyKnowledgeAnswerContextBudget(input: Readonly<{
  bridge?: ProviderToolBridge;
  request: ProviderRunRequest;
}>): ProviderRequestContextBudgetResult {
  const { contextCompactionPolicy: _hybridPolicy, ...legacy } = input.request;
  void _hybridPolicy;
  return applyProviderRequestContextBudget({
    ...(input.bridge ? { bridge: input.bridge } : {}),
    request: legacy
  });
}
