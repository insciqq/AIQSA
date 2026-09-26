import type { ContextPlanMeasurement, ContextSummaryAttempt } from "../../contracts/contextCompaction";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { ProviderRunRequest } from "../providers/types";
import type { ObservationActor } from "../toolObservations/repository";
import type { ToolObservationService } from "../toolObservations/sourceAdapters";
import type { ProviderToolBridge } from "../tools/types";
import { contextSummaryMessageId, contextSummaryRefsComplete, type ContextObservation } from "./contextCompactionContract";
import { contextCompactionFailureOutcome, type ContextCompactionPublisher } from "./contextCompactionEvents";
import {
  applyReusedContextSummary,
  ContextSummaryError,
  executeContextSummary,
  summaryNeedsProvider,
  type ContextSummaryAdapter,
  type ContextSummaryReceipts,
  type ContextSummaryRejection
} from "./contextCompactionSummarizer";
import {
  applyProviderRequestContextBudget,
  providerRequestFitsContextBudget,
  withSummaryHistoryOmission,
  type ProviderRequestContextBudgetResult
} from "./runContextBudget";

function failureCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/** Summary failures with known outcomes and no committed notes: the cycle
 * failed, but nothing it left behind stands in the way of the request. A call
 * budget or a transient source check is as harmless as a failed provider call
 * to a request that already fits. */
const HEADROOM_TOLERATED_FAILURES: ReadonlySet<string> = new Set([
  "context_compaction_provider_failed",
  "context_compaction_source_check_failed",
  "context_compaction_source_unavailable",
  "context_compaction_summary_failed",
  "context_compaction_summary_invalid",
  "context_compaction_summary_no_progress"
]);

const NO_PROGRESS: ContextSummaryRejection = {
  code: "context_compaction_summary_no_progress",
  message: "The new notes do not reduce the context estimate."
};

/** A summary bought only for headroom: the measured request (after masking)
 * and the exact request as dispatched both already fit the budget. */
function fitsWithoutSummary(request: ProviderRunRequest, bridge: ProviderToolBridge | undefined): boolean {
  const measurement = request.contextCompaction;
  if (!measurement || measurement.budgetTokens === null) return false;
  return measurement.afterTokens <= measurement.budgetTokens && providerRequestFitsContextBudget(request, bridge);
}

/**
 * True when a headroom summary of this run failed with a tolerated class and
 * no summary was committed after it. It is derived only from the run's durable
 * receipts, which the checkpoint keeps and every request the consumer returns
 * carries, so later rounds, follow-up deliveries and recovery cannot reset it:
 * the run buys no further headroom-only summary. A request over its budget
 * still buys within the existing caps, and a committed summary clears it.
 */
export function headroomSummaryDeclined(attempts: readonly ContextSummaryAttempt[] | undefined): boolean {
  let declined = false;
  for (const attempt of attempts ?? []) {
    if (attempt.state === "committed") declined = false;
    else if ((attempt.state === "failed" || attempt.state === "invalid") && attempt.errorCode !== undefined &&
      HEADROOM_TOLERATED_FAILURES.has(attempt.errorCode)) declined = true;
  }
  return declined;
}

/** The request dispatched without the headroom summary its measurement asked
 * for: it reports what this round did (masking, or nothing) instead. */
function withoutHeadroomSummary(request: ProviderRunRequest): ProviderRunRequest {
  const measurement = request.contextCompaction!;
  return { ...request, contextCompaction: { ...measurement,
    outcome: measurement.maskedObservations > 0 ? "masking_applied" : "already_fits" } };
}

/** The consumer's release check of new notes: the summarized request must
 * fit and lower the estimate. Notes that would push a request that fits
 * without them over its budget made no progress either. */
function summaryRejection(
  source: ProviderRunRequest,
  next: ProviderRequestContextBudgetResult,
  headroom: boolean
): ContextSummaryRejection | null {
  if (!next.ok) return headroom ? NO_PROGRESS : { code: "context_too_large", message: next.error.message };
  const before = source.contextCompaction?.afterTokens;
  const after = next.request.contextCompaction?.afterTokens;
  return before !== undefined && after !== undefined && after >= before ? NO_PROGRESS : null;
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
 * the ordinary bounded path, which never sees another run's notes. Notes whose
 * refs could not name every retained source are never carried. A failed
 * availability check (not a refusal) throws its classified error instead of
 * silently dropping the notes.
 */
async function withCarriedSummary(
  input: CompactedProviderRequestInput,
  budget: (request: ProviderRunRequest) => ProviderRequestContextBudgetResult
): Promise<Readonly<{ beforeTokens: number; result: BudgetedRequest }> | null> {
  const { request } = input;
  const reuse = request.contextCompactionPolicy?.reuse;
  if (!reuse || request.contextCompactionPolicy?.mode !== "hybrid" || request.contextCompactionSummary ||
    !contextSummaryRefsComplete(reuse.summary)) return null;
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
  /** Real availability of retained originals the summary source only
   * references; see observationSourceAvailability. */
  sourceAvailable?(handles: readonly string[], signal?: AbortSignal): Promise<boolean>;
  /** The accepted answer binding, used directly so summary text never becomes answer output. */
  summaryAdapter: ContextSummaryAdapter;
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
 * published outcome and the thrown code always agree. A summary bought only
 * for headroom (the request already fits) whose cycle fails with a tolerated
 * class, including notes that do not lower the estimate (never committed),
 * publishes the failed cycle; the fitting request continues unchanged with the
 * cycle's settled receipts, and the run buys no further headroom-only summary
 * (`headroomSummaryDeclined`).
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
  let carried: Awaited<ReturnType<typeof withCarriedSummary>>;
  try {
    carried = await withCarriedSummary(input, budget);
  } catch (error) {
    if (input.signal.aborted || !(error instanceof ContextSummaryError)) throw error;
    if (publisher.running) await publisher.settle(contextCompactionFailureOutcome(error.code));
    throw input.failure(error.code, error.message);
  }
  const measured = carried?.result ?? budget(input.request);
  if (!measured.ok) {
    if (publisher.running) await publisher.settle(contextCompactionFailureOutcome("context_too_large"));
    throw input.failure("context_too_large", measured.error.message);
  }
  // Carried notes compact this request: its cycle reports the exact branch's estimate.
  const cycleMeasurement = (measurement: ContextPlanMeasurement | undefined) =>
    carried && measurement ? { ...measurement, beforeTokens: carried.beforeTokens } : measurement;
  let prepared: BudgetedRequest = measured;
  if (summaryNeedsProvider(measured.request) && fitsWithoutSummary(measured.request, input.bridge) &&
    headroomSummaryDeclined(measured.request.contextCompactionSummaryAttempts)) {
    prepared = { ...measured, request: withoutHeadroomSummary(measured.request) };
  }
  if (summaryNeedsProvider(prepared.request)) {
    input.signal.throwIfAborted();
    const source = prepared.request;
    const headroom = fitsWithoutSummary(source, input.bridge);
    await publisher.begin(cycleMeasurement(source.contextCompaction));
    try {
      await input.authorize?.();
    } catch (error) {
      const code = failureCode(error);
      await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
      throw error;
    }
    // A failed cycle: a request that fits without the summary continues
    // unchanged, without notes or trimming, carrying the cycle's settled
    // receipts so every later checkpoint keeps them.
    const failed = async (rejection: ContextSummaryRejection, attempts: readonly ContextSummaryAttempt[]) => {
      await publisher.settle(contextCompactionFailureOutcome(rejection.code));
      if (!headroom || !HEADROOM_TOLERATED_FAILURES.has(rejection.code)) throw input.failure(rejection.code, rejection.message);
      if (prepared.contextTruncation) await input.onTruncation?.(prepared.contextTruncation);
      return attempts.length > 0 ? { ...source, contextCompactionSummaryAttempts: attempts } : source;
    };
    let summarized: Awaited<ReturnType<typeof executeContextSummary>>;
    try {
      summarized = await executeContextSummary({
        accept: (request) => summaryRejection(source, budget(request), headroom),
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
      if (error instanceof ContextSummaryError) return failed(error, error.attempts);
      const code = failureCode(error);
      await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
      throw error;
    }
    // Stop that lands as the last call completes: nothing is applied or
    // reported as success; the run's cancellation settles the open cycle.
    input.signal.throwIfAborted();
    // The notes (with the covered history they allow to leave) must lower
    // the estimate. Bought notes met this check before their commit; notes
    // reused without a call meet it here, and a cycle that fails it is never
    // kept.
    const next = budget(summarized.request);
    const rejection = summaryRejection(source, next, headroom);
    if (rejection || !next.ok) return failed(rejection ?? NO_PROGRESS, summarized.attempts);
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

/** Availability of retained originals by one authorization-only check of the
 * whole handle set (no object reads; integrity is verified at actual recall).
 * Only an authorization or row-state refusal makes a source unavailable. Any
 * other failure, including obtaining the service, is a transient
 * `context_compaction_source_check_failed`: never a silent refusal of carried
 * notes and never `source_unavailable`. */
export function observationSourceAvailability(
  service: () => Promise<Pick<ToolObservationService, "available">>,
  actor: ObservationActor
): (handles: readonly string[], signal?: AbortSignal) => Promise<boolean> {
  return async (handles, signal) => {
    signal?.throwIfAborted();
    try {
      return await (await service()).available(actor, handles, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new ContextSummaryError("context_compaction_source_check_failed",
        "The availability of retained context sources could not be checked.", { cause: error });
    }
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
