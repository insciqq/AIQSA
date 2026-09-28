import type { DecisionModelRoleResolution } from "../../providerRuntime/decisionModelRole";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import type { createAcceptedDecisionRuntime } from "../../providerRuntime/decisionRuntime";
import {
  DecisionAdapterError,
  type DecisionReceipt,
  type DecisionResult
} from "../../providers/decisions";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import {
  MemoryExecutionError,
  type MemoryExecutionOwner,
  type MemoryExecutionVersions,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { memoryReportedUsage } from "../execution/usage";
import { abortableMemoryRead } from "../retrieval/deadline";
import type { MemoryActionIntentContext } from "./intentService";
import {
  MEMORY_CONTROL_SCREEN_QUESTION,
  MEMORY_CONTROL_SCREEN_VERSION,
  qualifiedMemoryControlScreenModel,
  screenOutMemoryControl,
  type MemoryControlScreenResult
} from "./controlScreenPolicy";

export const MEMORY_CONTROL_SCREEN_COOLDOWN_MS = 30_000;
const versions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_CONTROL_SCREEN_VERSION,
  policyVersion: "memory-control-screen-policy-v1",
  promptVersion: "memory-control-screen-question-v1",
  retrievalConfigFingerprint: memoryExecutionSha256({
    question: MEMORY_CONTROL_SCREEN_QUESTION,
    bypassThreshold: 0.05,
    recentMessages: 8,
    recentCharacters: 8_000
  }),
  schemaVersion: "memory-control-screen-result-v1"
});

type Runtime = ReturnType<typeof createAcceptedDecisionRuntime>;
type Dependencies = Readonly<{
  execution: PrismaMemoryExecutionService;
  runtime: Runtime;
  resolveRole(): Promise<DecisionModelRoleResolution>;
  clock?: () => number;
}>;
export type MemoryControlScreenInput = Readonly<{
  attemptId: string;
  context: Pick<MemoryActionIntentContext, "currentUserMessage" | "recentMessages">;
  signal: AbortSignal;
  userId: string;
}>;
export type MemoryControlScreenService = (input: MemoryControlScreenInput) =>
  Promise<MemoryControlScreenResult>;

export function emptyMemoryControlScreenDiagnostics() {
  return {
    bindingCount: 0, externalCallCount: 0, completedCallCount: 0,
    inputTokens: 0, outputTokens: 0, knownReportedCostUsd: 0,
    unknownCostCallCount: 0
  };
}

function safeFailure(error: unknown): string {
  if (error instanceof DecisionAdapterError || error instanceof ProviderAdmissionError ||
    error instanceof MemoryExecutionError) return error.code;
  return "memory_control_screen_unavailable";
}

function responseId(receipt: DecisionReceipt | null): string | null {
  return receipt?.requestId && /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(receipt.requestId)
    ? receipt.requestId : null;
}

function usage(receipt: DecisionReceipt | null) {
  if (!receipt) return memoryReportedUsage(null);
  const reportedCost = receipt.usage.costUsd;
  return memoryReportedUsage({
    inputTokens: receipt.usage.inputTokens,
    outputTokens: receipt.usage.outputTokens,
    totalTokens: receipt.usage.inputTokens + receipt.usage.outputTokens,
    estimatedCostMicros: reportedCost === null ? null : Math.round(reportedCost * 1_000_000)
  });
}

function recentMessages(context: MemoryControlScreenInput["context"]) {
  let remaining = 8_000;
  return (context.recentMessages ?? []).slice(-8).flatMap((message) => {
    if (remaining <= 0 || !message.text || message.text.includes("\u0000")) return [];
    const text = message.text.slice(0, remaining);
    remaining -= text.length;
    return text ? [{ role: message.role, text }] : [];
  });
}

export function createMemoryControlScreenService(deps: Dependencies): MemoryControlScreenService {
  const clock = deps.clock ?? Date.now;
  let cooldown: { key: string; until: number } | null = null;

  return async (input) => {
    const diagnostics = emptyMemoryControlScreenDiagnostics();
    const result = (status: MemoryControlScreenResult["status"], reason: string | null,
      possibleCommand = true): MemoryControlScreenResult => Object.freeze({
      status, reason, possibleCommand, diagnostics: Object.freeze({ ...diagnostics })
    });
    input.signal.throwIfAborted();
    if (!input.context.currentUserMessage.trim() ||
      input.context.currentUserMessage.includes("\u0000")) {
      return result("UNAVAILABLE", "decision_input_invalid");
    }
    let resolution: DecisionModelRoleResolution;
    try {
      resolution = await abortableMemoryRead(deps.resolveRole(), input.signal);
      input.signal.throwIfAborted();
    } catch {
      return result("UNAVAILABLE", input.signal.aborted
        ? "memory_control_screen_cancelled" : "memory_control_screen_unavailable");
    }
    if (!resolution.ok) return result(resolution.code === "decision_model_unavailable"
      ? "UNAVAILABLE" : "SKIPPED", resolution.code);
    const expected = resolution.role.snapshot;
    if (!qualifiedMemoryControlScreenModel(expected)) {
      return result("SKIPPED", "memory_control_screen_unqualified");
    }
    const key = memoryExecutionSha256({ snapshot: expected, version: MEMORY_CONTROL_SCREEN_VERSION });
    if (cooldown?.key === key && cooldown.until > clock()) {
      return result("UNAVAILABLE", "memory_control_screen_cooldown");
    }

    const request = {
      state: {
        current_user_message: input.context.currentUserMessage,
        recent_messages: recentMessages(input.context)
      },
      questions: { possible_memory_control: MEMORY_CONTROL_SCREEN_QUESTION }
    };
    let bindingId: string | null = null;
    let boundPending = false;
    let started = false;
    let dispatched = false;
    let receipt: DecisionReceipt | null = null;
    let settled = false;
    let pending: Promise<DecisionResult> | null = null;
    const captureReceipt = () => {
      if (!dispatched) return;
      diagnostics.externalCallCount = 1;
      if (!receipt) diagnostics.unknownCostCallCount = 1;
      else {
        diagnostics.completedCallCount = 1;
        diagnostics.inputTokens = receipt.usage.inputTokens;
        diagnostics.outputTokens = receipt.usage.outputTokens;
        if (receipt.usage.costUsd === null) diagnostics.unknownCostCallCount = 1;
        else diagnostics.knownReportedCostUsd = receipt.usage.costUsd;
      }
    };
    const owner: MemoryExecutionOwner = {
      type: "RETRIEVAL_ATTEMPT", retrievalAttemptId: input.attemptId
    };
    try {
      input.signal.throwIfAborted();
      const binding = await deps.execution.admission.bind(input.userId, {
        inputHash: memoryExecutionSha256(request), ordinal: 0, owner,
        role: "MEMORY_CONTROL_SCREEN", versions
      });
      bindingId = binding.id;
      diagnostics.bindingCount = 1;
      if (binding.state !== "PENDING") {
        return result("UNAVAILABLE", "memory_control_screen_already_attempted");
      }
      boundPending = true;
      const admitted = await deps.execution.admission.start(input.userId, bindingId);
      started = true;
      const snapshot: ProviderExecutionSnapshot = admitted.snapshot.providerExecutionSnapshot;
      if (admitted.snapshot.logicalRole !== "MEMORY_CONTROL_SCREEN" ||
        !qualifiedMemoryControlScreenModel(snapshot) ||
        memoryExecutionSha256(snapshot) !== memoryExecutionSha256(expected)) {
        throw new MemoryExecutionError("memory_execution_policy_drift");
      }
      const runtime = await abortableMemoryRead(deps.runtime.resolve({
        connectionId: snapshot.connectionId,
        credentialId: snapshot.credentialId!,
        credentialVersionId: snapshot.credentialVersionId!,
        providerModelId: snapshot.providerModelId,
        executionSnapshot: snapshot
      }), input.signal);
      input.signal.throwIfAborted();
      dispatched = true;
      pending = runtime.adapter.decide({ ...request, signal: input.signal });
      const output = await abortableMemoryRead(pending, input.signal);
      receipt = output;
      input.signal.throwIfAborted();
      const answer = output.answers.possible_memory_control;
      if (answer?.type !== "noul" || !Number.isFinite(answer.noul) ||
        answer.noul < 0 || answer.noul > 1 ||
        Object.keys(output.answers).length !== 1) {
        throw new DecisionAdapterError("decision_response_invalid", { receipt });
      }
      const acceptedOutputHash = memoryExecutionSha256({
        possibleCommandProbability: answer.noul,
        version: MEMORY_CONTROL_SCREEN_VERSION
      });
      await deps.execution.lifecycle.settle(input.userId, bindingId, {
        acceptedOutputHash, errorCode: null, providerResponseId: responseId(receipt),
        state: "SUCCEEDED", usage: usage(receipt)
      });
      settled = true;
      await deps.execution.lifecycle.withAuthorizedResultCommit(input.userId,
        { acceptedOutputHash, bindingId }, async () => true);
      input.signal.throwIfAborted();
      cooldown = null;
      captureReceipt();
      return result("READY", null, !screenOutMemoryControl(answer.noul));
    } catch (error) {
      if (error instanceof DecisionAdapterError && error.receipt) receipt = error.receipt;
      if (receipt === null && (error instanceof ProviderAdmissionError ||
        error instanceof DecisionAdapterError &&
        ["decision_input_invalid", "decision_request_too_large"].includes(error.code))) {
        dispatched = false;
      }
      let failure = input.signal.aborted ? "memory_control_screen_cancelled" : safeFailure(error);
      if (error instanceof DecisionAdapterError && (
        error.code === "decision_provider_request_failed" ||
        error.code === "decision_request_timed_out" ||
        error.code === "decision_provider_http_error" &&
          (error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)
      )) {
        cooldown = { key, until: clock() + Math.max(
          MEMORY_CONTROL_SCREEN_COOLDOWN_MS, error.retryAfterMs ?? 0
        ) };
      }
      if (input.signal.aborted && input.signal.reason?.code === "memory_control_screen_timeout") {
        cooldown = { key, until: clock() + MEMORY_CONTROL_SCREEN_COOLDOWN_MS };
      }
      // A lost start CAS may mean another worker owns this binding. Settle a
      // newly bound PENDING row only when start failed for another reason.
      const startOwnershipConflict = !started && error instanceof MemoryExecutionError &&
        error.code === "memory_execution_state_conflict";
      if (bindingId && (started || boundPending && !startOwnershipConflict) && !settled) {
        const uncertain = started && dispatched && !receipt &&
          (input.signal.aborted || !(error instanceof DecisionAdapterError) ||
            ["decision_provider_request_failed", "decision_request_timed_out"].includes(error.code));
        await deps.execution.lifecycle.settle(input.userId, bindingId, {
          acceptedOutputHash: null, errorCode: failure,
          providerResponseId: responseId(receipt),
          state: uncertain ? "OUTCOME_UNKNOWN" : input.signal.aborted ? "CANCELLED" : "FAILED",
          usage: usage(receipt)
        }).then(() => { settled = true; })
          .catch(() => { failure = "memory_control_screen_settlement_unavailable"; });
        if (uncertain && settled && pending) {
          const ownedBindingId = bindingId;
          void pending.then((output) => output as DecisionReceipt,
            (lateError: unknown) => lateError instanceof DecisionAdapterError
              ? lateError.receipt : null).then(async (lateReceipt) => {
            if (!lateReceipt) return;
            await deps.execution.lifecycle.recoverOutcome(input.userId, ownedBindingId, {
              acceptedOutputHash: null, errorCode: "memory_control_screen_cancelled",
              state: "CANCELLED", usage: usage(lateReceipt)
            });
          }).catch(() => undefined);
        }
      }
      captureReceipt();
      return result("UNAVAILABLE", failure);
    }
  };
}
