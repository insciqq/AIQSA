import type { DecisionModelRoleResolution } from "../../providerRuntime/decisionModelRole";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import type { createAcceptedDecisionRuntime } from "../../providerRuntime/decisionRuntime";
import { DecisionAdapterError, type DecisionReceipt, type DecisionResult } from "../../providers/decisions";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { MemoryExecutionError, type MemoryExecutionOwner, type MemoryExecutionVersions,
  type PrismaMemoryExecutionService } from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { memoryReportedUsage } from "../execution/usage";
import { abortableMemoryRead } from "./deadline";
import {
  MEMORY_HISTORY_RELEVANCE_QUESTION, MEMORY_HISTORY_RELEVANCE_VERSION,
  qualifiedMemoryHistoryDecisionModel,
  type MemoryHistoryRelevanceDiagnostics, type MemoryHistoryRelevancePassage,
  type MemoryHistoryRelevanceResult, type MemoryHistoryRelevanceScore
} from "./historyRelevancePolicy";

// Match Memory's existing utility fan-out. The enclosing admission deadline
// owns elapsed work; there is no per-user semantic/request-count quota.
export const MEMORY_HISTORY_RELEVANCE_CONCURRENCY = 4;
// Optional quality work should not add a timeout to every chat during an
// outage. This short, single-route cooldown also respects longer Retry-After.
export const MEMORY_HISTORY_RELEVANCE_COOLDOWN_MS = 30_000;
const versions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_HISTORY_RELEVANCE_VERSION,
  policyVersion: "memory-history-usefulness-policy-v1",
  promptVersion: "memory-history-usefulness-rubric-v1",
  retrievalConfigFingerprint: memoryExecutionSha256({ question: MEMORY_HISTORY_RELEVANCE_QUESTION,
    concurrency: MEMORY_HISTORY_RELEVANCE_CONCURRENCY, atomicCoverage: true }),
  schemaVersion: "memory-history-usefulness-result-v1"
});

export type MemoryHistoryRelevanceInput = Readonly<{
  userId: string;
  attemptId: string;
  query: string;
  passages: readonly MemoryHistoryRelevancePassage[];
  signal: AbortSignal;
}>;
type Runtime = ReturnType<typeof createAcceptedDecisionRuntime>;
type Dependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  runtime: Runtime;
  resolveRole(): Promise<DecisionModelRoleResolution>;
  clock?: () => number;
}>;

function safeFailure(error: unknown): string {
  if (error instanceof DecisionAdapterError || error instanceof ProviderAdmissionError || error instanceof MemoryExecutionError) return error.code;
  return "memory_history_relevance_unavailable";
}

function responseId(receipt: DecisionReceipt | null): string | null {
  return receipt?.requestId && /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(receipt.requestId)
    ? receipt.requestId : null;
}

function usage(receipt: DecisionReceipt | null) {
  if (!receipt) return memoryReportedUsage(null);
  const reportedCost = receipt.usage.costUsd;
  return memoryReportedUsage({ inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens,
    totalTokens: receipt.usage.inputTokens + receipt.usage.outputTokens,
    // Existing accounting stores rounded USD micros; diagnostics below retain
    // the exact provider-reported USD rather than presenting this as exact cost.
    estimatedCostMicros: reportedCost === null ? null : Math.round(reportedCost * 1_000_000) });
}

export function createMemoryHistoryRelevanceService(deps: Dependencies) {
  const clock = deps.clock ?? Date.now;
  let cooldown: { key: string; until: number } | null = null;

  return async (input: MemoryHistoryRelevanceInput): Promise<MemoryHistoryRelevanceResult> => {
    const diagnostics = { candidateCount: input.passages.length, bindingCount: 0, externalCallCount: 0,
      completedCallCount: 0, inputTokens: 0, outputTokens: 0, knownReportedCostUsd: 0, unknownCostCallCount: 0 };
    const result = (status: MemoryHistoryRelevanceResult["status"], reason: string | null,
      scores: readonly MemoryHistoryRelevanceScore[] = []): MemoryHistoryRelevanceResult => Object.freeze({
      status, reason, scores: Object.freeze([...scores]), diagnostics: Object.freeze({ ...diagnostics })
    });
    input.signal.throwIfAborted();
    if (!input.passages.length) return result("SKIPPED", "memory_history_relevance_empty");
    if (!input.query.trim() || new Set(input.passages.map(p => p.handle)).size !== input.passages.length ||
      input.passages.some(p => !p.handle || !p.text.trim())) return result("UNAVAILABLE", "decision_input_invalid");
    const resolution = await deps.resolveRole();
    input.signal.throwIfAborted();
    if (!resolution.ok) return result(resolution.code === "decision_model_unavailable" ? "UNAVAILABLE" : "SKIPPED", resolution.code);
    const expected = resolution.role.snapshot;
    if (!qualifiedMemoryHistoryDecisionModel(expected)) return result("SKIPPED", "memory_history_relevance_unqualified");
    const key = memoryExecutionSha256({ snapshot: expected, version: MEMORY_HISTORY_RELEVANCE_VERSION });
    if (cooldown?.key === key && cooldown.until > clock()) return result("UNAVAILABLE", "memory_history_relevance_cooldown");

    const scores: MemoryHistoryRelevanceScore[] = [];
    let next = 0;
    let failure: string | null = null;
    const addReceipt = (receipt: DecisionReceipt | null) => {
      if (!receipt) { diagnostics.unknownCostCallCount += 1; return; }
      diagnostics.completedCallCount += 1;
      diagnostics.inputTokens += receipt.usage.inputTokens;
      diagnostics.outputTokens += receipt.usage.outputTokens;
      if (receipt.usage.costUsd === null) diagnostics.unknownCostCallCount += 1;
      else diagnostics.knownReportedCostUsd += receipt.usage.costUsd;
    };
    const invoke = async (passage: MemoryHistoryRelevancePassage, index: number) => {
      let bindingId: string | null = null;
      let started = false;
      let dispatched = false;
      let receipt: DecisionReceipt | null = null;
      let settled = false;
      let pending: Promise<DecisionResult> | null = null;
      const owner: MemoryExecutionOwner = { type: "RETRIEVAL_ATTEMPT", retrievalAttemptId: input.attemptId };
      try {
        input.signal.throwIfAborted();
        const request = { state: { query: input.query, memory: passage.text }, questions: { useful: MEMORY_HISTORY_RELEVANCE_QUESTION } };
        const binding = await deps.execution.admission.bind(input.userId, { inputHash: memoryExecutionSha256(request),
          ordinal: index + 1, owner, role: "MEMORY_HISTORY_RELEVANCE", versions });
        bindingId = binding.id;
        diagnostics.bindingCount += 1;
        // A settled or ambiguously started request is never dispatched again.
        if (binding.state !== "PENDING") { failure ??= "memory_history_relevance_already_attempted"; return; }
        const admitted = await deps.execution.admission.start(input.userId, bindingId);
        started = true;
        const snapshot: ProviderExecutionSnapshot = admitted.snapshot.providerExecutionSnapshot;
        if (admitted.snapshot.logicalRole !== "MEMORY_HISTORY_RELEVANCE" || !qualifiedMemoryHistoryDecisionModel(snapshot) ||
          memoryExecutionSha256(snapshot) !== memoryExecutionSha256(expected)) {
          throw new MemoryExecutionError("memory_execution_policy_drift");
        }
        const runtime = await deps.runtime.resolve({
          connectionId: snapshot.connectionId, credentialId: snapshot.credentialId!,
          credentialVersionId: snapshot.credentialVersionId!, providerModelId: snapshot.providerModelId,
          executionSnapshot: snapshot
        });
        input.signal.throwIfAborted();
        dispatched = true;
        pending = runtime.adapter.decide({ ...request, signal: input.signal });
        // Cancel the wait even if a transport ignores AbortSignal. Settle this
        // binding before returning the baseline; a late receipt can recover
        // accounting, but can never change the admitted context.
        const output = await abortableMemoryRead(pending, input.signal);
        receipt = output;
        input.signal.throwIfAborted();
        const score = output.answers.useful;
        if (score?.type !== "noul" || !Number.isFinite(score.noul) || score.noul < 0 || score.noul > 1 ||
          Object.keys(output.answers).length !== 1) throw new DecisionAdapterError("decision_response_invalid", { receipt });
        const acceptedOutputHash = memoryExecutionSha256({ usefulness: score.noul, handle: passage.handle });
        await deps.execution.lifecycle.settle(input.userId, bindingId, { acceptedOutputHash, errorCode: null,
          providerResponseId: responseId(receipt), state: "SUCCEEDED", usage: usage(receipt) });
        settled = true;
        await deps.execution.lifecycle.withAuthorizedResultCommit(input.userId, { acceptedOutputHash, bindingId }, async () => true);
        input.signal.throwIfAborted();
        scores[index] = { handle: passage.handle, usefulness: score.noul };
      } catch (error) {
        if (error instanceof DecisionAdapterError && error.receipt) receipt = error.receipt;
        if (receipt === null && (error instanceof ProviderAdmissionError || error instanceof DecisionAdapterError &&
          ["decision_input_invalid", "decision_request_too_large"].includes(error.code))) dispatched = false;
        failure ??= input.signal.aborted ? "memory_history_relevance_cancelled" : safeFailure(error);
        if (error instanceof DecisionAdapterError && (
          error.code === "decision_provider_request_failed" || error.code === "decision_request_timed_out" ||
          error.code === "decision_provider_http_error" && (error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)
        )) cooldown = { key, until: clock() + Math.max(MEMORY_HISTORY_RELEVANCE_COOLDOWN_MS, error.retryAfterMs ?? 0) };
        if (input.signal.aborted && input.signal.reason?.code === "memory_history_relevance_timeout") {
          cooldown = { key, until: clock() + MEMORY_HISTORY_RELEVANCE_COOLDOWN_MS };
        }
        // Never terminalize a binding whose start CAS we did not win, nor
        // overwrite a settled receipt after a later authority check rejects it.
        if (started && bindingId && !settled) {
          const uncertain = dispatched && !receipt && (input.signal.aborted || !(error instanceof DecisionAdapterError) ||
            ["decision_provider_request_failed", "decision_request_timed_out"].includes(error.code));
          await deps.execution.lifecycle.settle(input.userId, bindingId, { acceptedOutputHash: null,
            errorCode: failure, providerResponseId: responseId(receipt),
            state: uncertain ? "OUTCOME_UNKNOWN" : input.signal.aborted ? "CANCELLED" : "FAILED", usage: usage(receipt) })
            .then(() => { settled = true; })
            .catch(() => { failure = "memory_history_relevance_settlement_unavailable"; });
          if (uncertain && settled && pending) {
            const ownedBindingId = bindingId;
            // Recovery updates the existing usage event without dispatching.
            // Missing evidence stays OUTCOME_UNKNOWN for ordinary recovery.
            void pending.then((output) => output as DecisionReceipt, (lateError: unknown) =>
              lateError instanceof DecisionAdapterError ? lateError.receipt : null
            ).then(async (lateReceipt) => {
              if (!lateReceipt) return;
              await deps.execution.lifecycle.recoverOutcome(input.userId, ownedBindingId, {
                acceptedOutputHash: null, errorCode: "memory_history_relevance_cancelled",
                state: "CANCELLED", usage: usage(lateReceipt)
              });
            }).catch(() => undefined);
          }
        }
      } finally {
        if (dispatched) { diagnostics.externalCallCount += 1; addReceipt(receipt); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(input.passages.length, MEMORY_HISTORY_RELEVANCE_CONCURRENCY) }, async () => {
      while (!failure && !input.signal.aborted && next < input.passages.length) {
        const index = next++;
        await invoke(input.passages[index]!, index);
      }
    }));
    if (input.signal.aborted) return result("UNAVAILABLE", "memory_history_relevance_cancelled");
    if (failure || scores.filter(Boolean).length !== input.passages.length) return result("UNAVAILABLE", failure ?? "decision_response_invalid");
    cooldown = null;
    return result("READY", null, scores);
  };
}

export function emptyMemoryHistoryRelevanceDiagnostics(candidateCount: number): MemoryHistoryRelevanceDiagnostics {
  return { candidateCount, bindingCount: 0, externalCallCount: 0, completedCallCount: 0, inputTokens: 0,
    outputTokens: 0, knownReportedCostUsd: 0, unknownCostCallCount: 0 };
}
