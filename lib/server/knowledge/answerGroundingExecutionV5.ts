import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import type {
  ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import type { KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import type { KnowledgeEvidenceDispatchBinding } from "./evidenceDispatchRepository";
import type {
  KnowledgeProviderDispatchLifecycle,
  PreparedKnowledgeProviderDispatch
} from "./providerDispatchLifecycle";
import {
  createKnowledgeAnswerOperationRequestSnapshotV1,
  decodeKnowledgeAnswerDraftV5,
  decodeKnowledgeAnswerOperationRequestSnapshotV1,
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_VERSION,
  KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_DRAFT_OPERATION,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V5,
  KNOWLEDGE_DRAFT_MALFORMED,
  KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3,
  knowledgeAnswerCanonicalJson,
  knowledgeAnswerDraftPrompt,
  knowledgeAnswerGroundingPromptEnvelopeFits,
  knowledgeGroundedSelectorPrompt,
  knowledgeSelectorEvidenceFromManifest,
  knowledgeSelectorFailureV3,
  validateKnowledgeGroundedSelectorV3,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeAnswerOperationRequestSnapshotV1,
  type KnowledgeAnswerFallbackReason
} from "./answerGroundingV5";

export type KnowledgeAnswerOperationExecutionV5 = Readonly<{
  output: Readonly<Record<string, unknown>>;
  providerResponseId: string | null;
  usage: ModelRunUsage;
}>;

export type KnowledgeAnswerOperationExecutionOptionsV5 = Readonly<{
  providerResponseId: string | null;
}>;

export class KnowledgeAnswerOperationDeferredError extends Error {
  constructor(message = "knowledge_answer_operation_deferred") {
    super(message);
    this.name = "KnowledgeAnswerOperationDeferredError";
  }
}

export type KnowledgeAnswerGroundingExecutionV5Result = Readonly<{
  contracts: Readonly<{
    draftContractVersion: 5;
    selectorContractVersion: 3;
  }>;
  operations: readonly Readonly<{
    operation: typeof KNOWLEDGE_ANSWER_DRAFT_OPERATION |
      typeof KNOWLEDGE_GROUNDED_SELECTOR_OPERATION;
    providerResponseId: string | null;
    usage: ModelRunUsage;
  }>[];
}>;

type OperationAcceptedResult = Readonly<Record<string, unknown>>;

const zeroUsage: ModelRunUsage = Object.freeze({
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0
});

function operationRecord(value: unknown): OperationAcceptedResult {
  return value as OperationAcceptedResult;
}

function storedUsage(value: Readonly<{
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}>): ModelRunUsage {
  return normalizeTokenUsage({
    cachedInputTokens: value.cachedInputTokens ?? 0,
    cacheWriteInputTokens: value.cacheWriteInputTokens ?? 0,
    inputTokens: value.inputTokens ?? 0,
    outputTokens: value.outputTokens ?? 0,
    reasoningTokens: value.reasoningTokens ?? 0,
    totalTokens: value.totalTokens ?? 0
  });
}

function exactSnapshot(
  left: KnowledgeAnswerOperationRequestSnapshotV1,
  right: KnowledgeAnswerOperationRequestSnapshotV1
): boolean {
  return knowledgeAnswerCanonicalJson(left) === knowledgeAnswerCanonicalJson(right);
}

function fallbackReason(error: unknown): KnowledgeAnswerFallbackReason {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "timeouterror" || message.includes("timeout") ||
    message.includes("deadline")) return "selector_timeout";
  if (message.includes("refusal") || message.includes("refused") ||
    message.includes("safety")) return "selector_refusal";
  if (error instanceof TypeError || message.includes("network") ||
    message.includes("transport") || message.includes("fetch")) {
    return "selector_transport_failure";
  }
  return "selector_provider_error";
}

async function acceptedOperation(input: Readonly<{
  acceptedFailure(error: unknown): OperationAcceptedResult;
  acceptedOutput(output: Readonly<Record<string, unknown>>): OperationAcceptedResult;
  acceptedRequest: KnowledgeAnswerOperationRequestSnapshotV1;
  authorize(): Promise<void>;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  execute(
    request: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV5
  ): Promise<KnowledgeAnswerOperationExecutionV5>;
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  operation: typeof KNOWLEDGE_ANSWER_DRAFT_OPERATION |
    typeof KNOWLEDGE_GROUNDED_SELECTOR_OPERATION;
  ordinal: 1 | 2;
  recoveryProviderResponseId?: string | null;
  shouldAbort(error: unknown): boolean;
}>): Promise<Readonly<{
  acceptedResult: OperationAcceptedResult;
  providerResponseId: string | null;
  usage: ModelRunUsage;
}>> {
  const existing = await input.lifecycle.inspect({
    modelRunId: input.modelRunId,
    ordinal: input.ordinal
  });
  let prepared: PreparedKnowledgeProviderDispatch | null = null;
  let dispatchRequired = true;
  let recoveryProviderResponseId: string | null = null;
  if (existing) {
    const storedRequest = decodeKnowledgeAnswerOperationRequestSnapshotV1(
      existing.attempt.acceptedRequest
    );
    if (!storedRequest || !exactSnapshot(storedRequest, input.acceptedRequest) ||
      existing.attempt.purpose !== input.operation ||
      existing.attempt.contractVersion !== input.acceptedRequest.contractVersion ||
      existing.attempt.evidenceReceiptHash !== input.draft.manifestHash ||
      existing.draft.manifestHash !== input.draft.manifestHash) {
      throw new Error("knowledge_answer_operation_snapshot_conflict");
    }
    if (existing.attempt.state !== "settled" ||
      !existing.attempt.acceptedResult || !existing.attempt.actualUsage) {
      const recovery = await input.lifecycle.recover({
        modelRunId: input.modelRunId,
        ordinal: input.ordinal,
        providerResponseId: existing.attempt.providerResponseId ??
          input.recoveryProviderResponseId ?? null,
        requestPreview: input.acceptedRequest
      });
      if (recovery.kind === "busy") {
        throw new Error("knowledge_answer_operation_busy");
      }
      if (recovery.kind === "dispatch") {
        prepared = recovery.prepared;
      } else if (recovery.kind === "resume") {
        prepared = recovery.prepared;
        dispatchRequired = false;
        recoveryProviderResponseId = recovery.providerResponseId;
      } else if (recovery.kind === "settled" &&
        recovery.dispatch.attempt.acceptedResult &&
        recovery.dispatch.attempt.actualUsage) {
        return Object.freeze({
          acceptedResult: recovery.dispatch.attempt.acceptedResult,
          providerResponseId: recovery.dispatch.attempt.providerResponseId,
          usage: storedUsage(recovery.dispatch.attempt.actualUsage)
        });
      } else {
        throw new Error("knowledge_answer_operation_recovery_failed");
      }
    } else {
      return Object.freeze({
        acceptedResult: existing.attempt.acceptedResult,
        providerResponseId: existing.attempt.providerResponseId,
        usage: storedUsage(existing.attempt.actualUsage)
      });
    }
  }

  if (!prepared) {
    prepared = await input.lifecycle.prepare({
      acceptedRequest: input.acceptedRequest,
      contractVersion: input.acceptedRequest.contractVersion,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      evidenceReceiptHash: input.draft.manifestHash,
      modelRunId: input.modelRunId,
      ordinal: input.ordinal,
      providerBindingKey: "answer",
      purpose: input.operation,
      requestPreview: input.acceptedRequest,
      roundIndex: 0
    });
  }

  try {
    await input.authorize();
  } catch (error) {
    if (dispatchRequired) {
      await input.lifecycle.release(prepared, "provider_dispatch_not_started")
        .catch(() => undefined);
    }
    throw error;
  }

  if (dispatchRequired) await input.lifecycle.dispatch(prepared);
  let execution: KnowledgeAnswerOperationExecutionV5;
  let acceptedResult: OperationAcceptedResult;
  try {
    execution = await input.execute({
        maxOutputTokens: input.acceptedRequest.maxOutputTokens,
        name: input.acceptedRequest.name,
        reasoningEffort: input.acceptedRequest.reasoningEffort,
        schema: input.acceptedRequest.schema,
        systemPrompt: input.acceptedRequest.systemPrompt,
        userPrompt: input.acceptedRequest.userPrompt
      }, {
        providerResponseId: recoveryProviderResponseId
      });
    acceptedResult = input.acceptedOutput(execution.output);
  } catch (error) {
    if (error instanceof KnowledgeAnswerOperationDeferredError) throw error;
    if (input.shouldAbort(error)) {
      await input.lifecycle.markAmbiguous(prepared, {
        reason: "provider_dispatch_cancelled"
      }).catch(() => undefined);
      throw error;
    }
    execution = {
      output: Object.freeze({}),
      providerResponseId: null,
      usage: zeroUsage
    };
    acceptedResult = input.acceptedFailure(error);
  }
  await input.lifecycle.settle(prepared, {
    acceptedResult,
    providerResponseId: execution.providerResponseId,
    usage: execution.usage
  });
  return Object.freeze({
    acceptedResult,
    providerResponseId: execution.providerResponseId,
    usage: normalizeTokenUsage(execution.usage)
  });
}

/**
 * Executes or reuses the only two provider operations allowed to turn
 * immutable Knowledge evidence into a user-visible answer. Provider payloads
 * never leave this private boundary; only the deterministic repository
 * finalizer may publish text.
 */
export async function executeKnowledgeAnswerGroundingV5(input: Readonly<{
  authorize(): Promise<void>;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  execute(
    request: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV5
  ): Promise<KnowledgeAnswerOperationExecutionV5>;
  forbiddenIdentityFragments?: readonly string[];
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  reasoningEffort?: string | null;
  recoveryProviderResponseIds?: Partial<Record<
    typeof KNOWLEDGE_ANSWER_DRAFT_OPERATION |
      typeof KNOWLEDGE_GROUNDED_SELECTOR_OPERATION,
    string | null
  >>;
  request: string;
  routeInstruction: string;
  shouldAbort(error: unknown): boolean;
  transport: "native_strict" | "provider_neutral_json";
}>): Promise<KnowledgeAnswerGroundingExecutionV5Result> {
  const evidence = knowledgeSelectorEvidenceFromManifest(input.draft);
  if (!knowledgeAnswerGroundingPromptEnvelopeFits({
    evidence,
    evidenceManifest: input.draft.message,
    request: input.request,
    routeInstruction: input.routeInstruction
  })) {
    throw new Error("knowledge_answer_operation_request_invalid");
  }
  const handles = evidence.map((item) => item.handle);
  const draftPrompt = knowledgeAnswerDraftPrompt({
    evidenceManifest: input.draft.message,
    request: input.request,
    routeInstruction: input.routeInstruction
  });
  const draftRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
    contractVersion: KNOWLEDGE_ANSWER_DRAFT_CONTRACT_VERSION,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION,
    reasoningEffort: input.reasoningEffort,
    schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V5,
    systemPrompt: draftPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: draftPrompt.userPrompt
  });
  const draftOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => operationRecord(
      decodeKnowledgeAnswerDraftV5(output, {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments
      }) ?? KNOWLEDGE_DRAFT_MALFORMED
    ),
    acceptedRequest: draftRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION,
    ordinal: 1,
    recoveryProviderResponseId:
      input.recoveryProviderResponseIds?.[KNOWLEDGE_ANSWER_DRAFT_OPERATION],
    shouldAbort: input.shouldAbort
  });
  const draft = draftOperation.acceptedResult.kind === "draft_malformed"
    ? KNOWLEDGE_DRAFT_MALFORMED
    : decodeKnowledgeAnswerDraftV5(draftOperation.acceptedResult, {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments
      });
  if (!draft) throw new Error("knowledge_answer_draft_result_invalid");

  const selectorPrompt = knowledgeGroundedSelectorPrompt({
    draft: draft as KnowledgeAnswerDraftSelectorInput,
    evidence,
    evidenceManifest: input.draft.message,
    request: input.request
  });
  const selectorRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
    contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_VERSION,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION,
    reasoningEffort: input.reasoningEffort,
    schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3,
    systemPrompt: selectorPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: selectorPrompt.userPrompt
  });
  const selectorOperation = await acceptedOperation({
    acceptedFailure: (error) => operationRecord(knowledgeSelectorFailureV3(
      fallbackReason(error)
    )),
    acceptedOutput: (output) => {
      const validation = validateKnowledgeGroundedSelectorV3(output, { draft, evidence });
      return operationRecord(validation.kind === "accepted"
        ? validation.value
        : knowledgeSelectorFailureV3(validation.reason));
    },
    acceptedRequest: selectorRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION,
    ordinal: 2,
    recoveryProviderResponseId:
      input.recoveryProviderResponseIds?.[KNOWLEDGE_GROUNDED_SELECTOR_OPERATION],
    shouldAbort: input.shouldAbort
  });

  return Object.freeze({
    contracts: Object.freeze({
      draftContractVersion: KNOWLEDGE_ANSWER_DRAFT_CONTRACT_VERSION,
      selectorContractVersion: KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_VERSION
    }),
    operations: Object.freeze([
      Object.freeze({
        operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION,
        providerResponseId: draftOperation.providerResponseId,
        usage: draftOperation.usage
      }),
      Object.freeze({
        operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION,
        providerResponseId: selectorOperation.providerResponseId,
        usage: selectorOperation.usage
      })
    ])
  });
}
