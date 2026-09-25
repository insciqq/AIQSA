import type { ContextPlanMeasurement } from "../../contracts/contextCompaction";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import { ObservationStoreError } from "../toolObservations/contract";
import type { ObservationActor } from "../toolObservations/repository";
import type { ToolObservationService } from "../toolObservations/sourceAdapters";
import type { ProviderToolBridge } from "../tools/types";
import { contextSummaryMessageId, type ContextObservation } from "./contextCompactionContract";
import { contextCompactionFailureOutcome, type ContextCompactionPublisher } from "./contextCompactionEvents";
import {
  applyReusedContextSummary,
  ContextSummaryError,
  executeContextSummary,
  summaryNeedsProvider,
  type ContextSummaryReceipts
} from "./contextCompactionSummarizer";
import {
  applyProviderRequestContextBudget,
  withSummaryHistoryOmission,
  type ProviderRequestContextBudgetResult
} from "./runContextBudget";

function failureCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/** Notes this run bought (not notes carried from an earlier turn) are applied. */
function appliedOwnSummary(request: ProviderRunRequest): boolean {
  const summary = request.contextCompactionSummary;
  return summary !== undefined && summary.id !== request.contextCompactionPolicy?.reuse?.summary.id &&
    request.context?.messages.some((message) => message.id === contextSummaryMessageId(summary)) === true;
}

type BudgetedRequest = Extract<ProviderRequestContextBudgetResult, { ok: true }>;

/**
 * Carried checkpoint notes, frozen at admission, replace the covered branch
 * prefix only when the exact branch would need a summary, the projection fits
 * this binding, and every retained source the notes cite is still readable by
 * this run through the observation authority. Otherwise the exact branch takes
 * the ordinary bounded path, which never sees another run's notes.
 */
async function withCarriedSummary(
  input: CompactedProviderRequestInput,
  budget: (request: ProviderRunRequest) => ProviderRequestContextBudgetResult
): Promise<Readonly<{ beforeTokens: number; result: BudgetedRequest }> | null> {
  const { request } = input;
  const reuse = request.contextCompactionPolicy?.reuse;
  if (!reuse || request.contextCompactionPolicy?.mode !== "hybrid" || request.contextCompactionSummary) return null;
  const exact = budget(request);
  if (!exact.ok || exact.request.contextCompaction?.outcome !== "needs_summary") return null;
  const projected = applyReusedContextSummary(exact.request);
  const fitted = projected ? budget(projected) : null;
  if (!fitted?.ok) return null;
  const handles = reuse.summary.sourceRefs.filter((ref) => ref.startsWith("tor1_"));
  if (handles.length > 0 && input.sourceAvailable) {
    input.signal.throwIfAborted();
    if (!(await input.sourceAvailable(handles, input.signal))) return null;
  }
  return { beforeTokens: exact.request.contextCompaction.beforeTokens, result: fitted };
}

export type CompactedProviderRequestInput = Readonly<{
  /** Rechecks answer authority immediately before paid summary I/O. */
  authorize?(): Promise<void>;
  bridge?: ProviderToolBridge;
  /** The owner's classified error for a compaction or budget failure. */
  failure(code: string, message: string): Error;
  /** Server-minted observations of the run's settled calls: the only authority
   * for masking a result or citing its handle in a summary. */
  observations?: readonly ContextObservation[];
  onTruncation?(truncation: ContextTruncationSummary): Promise<void> | void;
  publisher: ContextCompactionPublisher;
  /** Durable claim/settlement and usage accounting of every paid summary call. */
  receipts: ContextSummaryReceipts;
  request: ProviderRunRequest;
  signal: AbortSignal;
  /** Real availability of retained originals the summary source only references. */
  sourceAvailable?(handles: readonly string[], signal?: AbortSignal): Promise<boolean>;
  /** The accepted answer binding, used directly so summary text never becomes answer output. */
  summaryAdapter: Pick<ProviderAdapter, "stream">;
}>;

/**
 * The single compaction consumer for an answer dispatch, live or recovered.
 * It measures the request's actual messages first and decides only from that
 * fresh measurement; a measurement carried from an earlier round never buys or
 * skips a summary. The returned request is exactly what may be dispatched and
 * checkpointed. At most one summary cycle runs per request: notes bought here
 * cover all prior history (carried notes plus the exact messages after them),
 * so the planner never asks again, and a request that still does not fit fails
 * as irreducible overflow instead of falling back to legacy trimming. The
 * published outcome and the thrown code always agree.
 */
export async function prepareCompactedProviderRequest(
  input: CompactedProviderRequestInput
): Promise<ProviderRunRequest> {
  const { publisher } = input;
  const budget = (request: ProviderRunRequest) => applyProviderRequestContextBudget({
    ...(input.bridge ? { bridge: input.bridge } : {}),
    ...(input.observations ? { observations: input.observations } : {}),
    request
  });
  const carried = await withCarriedSummary(input, budget);
  const measured = carried?.result ?? budget(input.request);
  if (!measured.ok) {
    if (publisher.running) await publisher.settle(contextCompactionFailureOutcome("context_too_large"));
    throw input.failure("context_too_large", measured.error.message);
  }
  // Carried notes compact this request: its cycle reports the exact branch's estimate.
  const cycleMeasurement = (measurement: ContextPlanMeasurement | undefined) =>
    carried && measurement ? { ...measurement, beforeTokens: carried.beforeTokens } : measurement;
  let prepared: BudgetedRequest = measured;
  if (summaryNeedsProvider(measured.request)) {
    input.signal.throwIfAborted();
    const source = measured.request;
    await publisher.begin(cycleMeasurement(source.contextCompaction));
    try {
      await input.authorize?.();
    } catch (error) {
      const code = failureCode(error);
      await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
      throw error;
    }
    let summarized: Awaited<ReturnType<typeof executeContextSummary>>;
    try {
      summarized = await executeContextSummary({
        adapter: input.summaryAdapter,
        existingAttempts: source.contextCompactionSummaryAttempts,
        existingSummary: source.contextCompactionSummary,
        ...(input.observations ? { observations: input.observations } : {}),
        receipts: input.receipts,
        request: source,
        signal: input.signal,
        ...(input.sourceAvailable ? { sourceAvailable: input.sourceAvailable } : {})
      });
    } catch (error) {
      // Stop: the run's cancellation settles the open cycle as unknown.
      if (input.signal.aborted) throw error;
      if (error instanceof ContextSummaryError) {
        await publisher.settle(contextCompactionFailureOutcome(error.code));
        throw input.failure(error.code, error.message);
      }
      const code = failureCode(error);
      await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
      throw error;
    }
    const next = budget(summarized.request);
    if (!next.ok) {
      await publisher.settle(contextCompactionFailureOutcome("context_too_large"));
      throw input.failure("context_too_large", next.error.message);
    }
    // The notes (with the covered history they allow to leave) must lower
    // the estimate; a cycle that does not is never kept or bought again.
    const before = source.contextCompaction?.afterTokens;
    const after = next.request.contextCompaction?.afterTokens;
    if (before !== undefined && after !== undefined && after >= before) {
      await publisher.settle(contextCompactionFailureOutcome("context_compaction_summary_no_progress"));
      throw input.failure("context_compaction_summary_no_progress", "The new notes do not reduce the context estimate.");
    }
    // History older than the span a bounded summary could cover leaves as
    // whole-turn truncation evidence, as the legacy guard would drop it.
    prepared = summarized.omitted
      ? withSummaryHistoryOmission({ ...(input.bridge ? { bridge: input.bridge } : {}), omitted: summarized.omitted, result: next })
      : next;
    await publisher.settle("summary_applied", prepared.request.contextCompaction);
  } else if (publisher.running) {
    // A cycle left running by a lost executor: a summary committed to the
    // checkpoint has been applied again; otherwise its outcome is unknown.
    if (carried || appliedOwnSummary(prepared.request)) {
      await publisher.settle("summary_applied", cycleMeasurement(prepared.request.contextCompaction));
    } else await publisher.settle("unknown");
  } else if (carried) {
    // Applying carried notes is this request's compaction, reported once with
    // the reduction from the exact branch; nothing was bought.
    await publisher.settle("summary_applied", cycleMeasurement(prepared.request.contextCompaction));
  } else if (prepared.request.contextCompaction?.outcome === "masking_applied") {
    // Masking is reported in the round that masked, with that round's numbers.
    // A summary carried from an earlier round does not make it a summary cycle.
    await publisher.settle("masking_applied", prepared.request.contextCompaction);
  }
  if (prepared.contextTruncation) await input.onTruncation?.(prepared.contextTruncation);
  return prepared.request;
}

/** Availability of retained originals by a bounded authorized read of each
 * handle. A busy store is a transient refusal that keeps the handle valid;
 * any other refusal means the original cannot be recalled. */
export function observationSourceAvailability(
  service: () => Promise<Pick<ToolObservationService, "read">>,
  actor: ObservationActor
): (handles: readonly string[], signal?: AbortSignal) => Promise<boolean> {
  return async (handles, signal) => {
    const reader = await service();
    for (const handle of handles) {
      try {
        await reader.read(actor, { handle, maxBytes: 4 }, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ObservationStoreError && error.code === "tool_observation_busy") continue;
        return false;
      }
    }
    return true;
  };
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
