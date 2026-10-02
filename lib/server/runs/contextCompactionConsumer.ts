import type { ContextCompactionCheckpoint, ContextPlanMeasurement, ContextSummaryAttempt } from "../../contracts/contextCompaction";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { ProviderRunRequest } from "../providers/types";
import type { ObservationActor } from "../toolObservations/repository";
import type { ToolObservationService } from "../toolObservations/sourceAdapters";
import type { ProviderToolBridge } from "../tools/types";
import {
  CONTEXT_COMPACTION_LIMITS,
  contextSummaryMessageId,
  contextSummaryRefsComplete,
  type ContextObservation
} from "./contextCompactionContract";
import { contextCompactionFailureOutcome, type ContextCompactionPublisher } from "./contextCompactionEvents";
import {
  applyContextSummaryToRequest,
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
 * silently dropping the notes. `projected` is the unplanned request with the
 * notes applied: the source every later pass reads.
 */
async function withCarriedSummary(
  input: Pick<CompactedProviderRequestInput, "request" | "signal" | "sourceAvailable">,
  budget: (request: ProviderRunRequest) => ProviderRequestContextBudgetResult
): Promise<Readonly<{ beforeTokens: number; projected: ProviderRunRequest; result: BudgetedRequest }> | null> {
  const { request } = input;
  const reuse = request.contextCompactionPolicy?.reuse;
  if (!reuse || request.contextCompactionPolicy?.mode !== "hybrid" || request.contextCompactionSummary ||
    !contextSummaryRefsComplete(reuse.summary)) return null;
  const exact = budget(request);
  if (!exact.ok || exact.request.contextCompaction?.outcome !== "needs_summary") return null;
  const projected = applyReusedContextSummary(exact.request);
  const fitted = projected ? budget(projected) : null;
  if (!projected || !fitted?.ok) return null;
  const handles = reuse.summary.sourceRefs.filter((ref) => ref.startsWith("tor1_"));
  if (handles.length > 0 && input.sourceAvailable) {
    input.signal.throwIfAborted();
    if (!(await input.sourceAvailable(handles, input.signal))) return null;
  }
  return { beforeTokens: exact.request.contextCompaction.beforeTokens, projected, result: fitted };
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
 * checkpointed.
 *
 * Nothing leaves the request before notes cover it. While the planner asks
 * for notes, one cycle buys up to `summaryPasses` oldest-first passes; each
 * pass reads the request as it stood before this plan masked or released
 * anything (covered material is already in earlier notes), commits its notes
 * and the request is planned again, so covered results are masked and covered
 * units leave only afterwards. When the passes run out, a fitting request is
 * dispatched with the coverage reached and a request over its budget fails as
 * `context_too_large`; nothing falls back to truncation. The published
 * outcome and the thrown code always agree. A headroom pass (the request
 * already fits) that fails with a tolerated class, including notes that do
 * not lower the estimate (never committed), ends the cycle; the fitting
 * request continues with every pass committed before it and the cycle's
 * settled receipts, and the run buys no further headroom-only summary
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
    await publisher.begin(cycleMeasurement(prepared.request.contextCompaction));
    try {
      await input.authorize?.();
    } catch (error) {
      const code = failureCode(error);
      await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
      throw error;
    }
    // The request every pass reads: this round's messages before planning,
    // with the notes committed so far applied.
    let source: ProviderRunRequest = carried?.projected ?? input.request;
    let committed = false;
    // A failed pass: a request that fits without it continues as planned
    // before the pass, with the passes committed so far and the cycle's
    // settled receipts, so every later checkpoint keeps them.
    const failed = async (rejection: ContextSummaryRejection, attempts: readonly ContextSummaryAttempt[], headroom: boolean) => {
      const tolerated = headroom && HEADROOM_TOLERATED_FAILURES.has(rejection.code);
      // Notes an earlier pass committed stay applied: that is this cycle's outcome.
      if (committed && tolerated) await publisher.settle("summary_applied", prepared.request.contextCompaction);
      else await publisher.settle(contextCompactionFailureOutcome(rejection.code));
      if (!tolerated) throw input.failure(rejection.code, rejection.message);
      if (prepared.contextTruncation) await input.onTruncation?.(prepared.contextTruncation);
      const request = committed ? withoutHeadroomSummary(prepared.request) : prepared.request;
      return attempts.length > 0 ? { ...request, contextCompactionSummaryAttempts: attempts } : request;
    };
    for (let pass = 0; summaryNeedsProvider(prepared.request); pass += 1) {
      const headroom = fitsWithoutSummary(prepared.request, input.bridge);
      if (pass >= CONTEXT_COMPACTION_LIMITS.summaryPasses) {
        if (!headroom) {
          await publisher.settle(contextCompactionFailureOutcome("context_too_large"));
          throw input.failure("context_too_large",
            "The conversation still exceeds the model context budget after the bounded summary passes.");
        }
        prepared = { ...prepared, request: withoutHeadroomSummary(prepared.request) };
        break;
      }
      const current = prepared.request;
      const passSource: ProviderRunRequest = {
        ...source,
        ...(current.contextCompaction ? { contextCompaction: current.contextCompaction } : {}),
        ...(current.contextCompactionSummaryAttempts
          ? { contextCompactionSummaryAttempts: current.contextCompactionSummaryAttempts } : {})
      };
      let summarized: Awaited<ReturnType<typeof executeContextSummary>>;
      try {
        summarized = await executeContextSummary({
          accept: (request) => summaryRejection(current, budget(request), headroom),
          adapter: input.summaryAdapter,
          existingAttempts: current.contextCompactionSummaryAttempts,
          existingSummary: current.contextCompactionSummary,
          ...(input.observations ? { observations: input.observations } : {}),
          receipts: input.receipts,
          request: passSource,
          signal: input.signal,
          ...(input.sourceAvailable ? { sourceAvailable: input.sourceAvailable } : {})
        });
      } catch (error) {
        // Stop: the run's cancellation settles the open cycle as unknown.
        if (input.signal.aborted) throw error;
        if (error instanceof ContextSummaryError) return failed(error, error.attempts, headroom);
        const code = failureCode(error);
        await publisher.settle(code ? contextCompactionFailureOutcome(code) : "unknown");
        throw error;
      }
      // Stop that lands as the last call completes: nothing is applied or
      // reported as success; the run's cancellation settles the open cycle.
      input.signal.throwIfAborted();
      // The notes (with the covered material they allow to leave) must lower
      // the estimate. Bought notes met this check before their commit; notes
      // reused without a call meet it here, and a pass that fails it is never
      // kept.
      const next = budget(summarized.request);
      const rejection = summaryRejection(current, next, headroom);
      if (rejection || !next.ok) return failed(rejection ?? NO_PROGRESS, summarized.attempts, headroom);
      committed = true;
      source = summarized.request;
      prepared = next;
    }
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

/**
 * The request a recovery route rebuilds for a dispatch it may not compact
 * itself: the accepted request with the notes the run committed outside the
 * tool loop (its notes-only checkpoint) or, without them, the carried notes
 * exactly as the live consumer would apply them. It never buys notes: a
 * rebuilt request that still needs them to fit fails as `context_too_large`,
 * while one that fits continues without a headroom purchase.
 */
export async function rebuiltCompactedProviderRequest(input: Readonly<{
  bridge?: ProviderToolBridge;
  checkpoint?: Pick<ContextCompactionCheckpoint, "summary" | "summaryAttempts"> | null;
  request: ProviderRunRequest;
  signal: AbortSignal;
  sourceAvailable?(handles: readonly string[], signal?: AbortSignal): Promise<boolean>;
}>): Promise<ProviderRequestContextBudgetResult> {
  const budget = (request: ProviderRunRequest) => applyProviderRequestContextBudget({
    ...(input.bridge ? { bridge: input.bridge } : {}),
    request
  });
  const summary = input.checkpoint?.summary;
  const attempts = input.checkpoint?.summaryAttempts;
  let result: ProviderRequestContextBudgetResult;
  if (summary) {
    // Applied exactly as the live pass applied it: the tail rule reads the
    // request's measured budget.
    const exact = budget(input.request);
    if (!exact.ok) return exact;
    result = budget(applyContextSummaryToRequest({ ...input.request,
      ...(exact.request.contextCompaction ? { contextCompaction: exact.request.contextCompaction } : {}),
      contextCompactionSummary: summary }, summary, attempts));
  } else {
    result = (await withCarriedSummary(input, budget))?.result ?? budget(input.request);
  }
  if (!result.ok || !summaryNeedsProvider(result.request)) return result;
  if (!fitsWithoutSummary(result.request, input.bridge)) {
    return { error: { code: "context_too_large", message: "The recovered request needs context notes this recovery cannot buy." },
      ok: false, status: 400 };
  }
  return { ...result, request: withoutHeadroomSummary(result.request) };
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
