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
  decodeKnowledgeCoveragePlanAcceptedResultV1,
  decodeKnowledgeSelectorFailureV3,
  decodeKnowledgeAnswerDraftAcceptedResultForPair,
  decodeKnowledgeAnswerDraftSupplementAcceptedResultV1,
  decodeKnowledgeAnswerDraftV5,
  decodeKnowledgeGroundedSelectorV5,
  decodeKnowledgeGroundedSelectorV6,
  decodeKnowledgeGroundedSelectorV7,
  decodeKnowledgeGroundedSelectorV8,
  decodeKnowledgeAnswerOperationRequestSnapshotV1,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  KNOWLEDGE_ANSWER_DRAFT_LIMITS,
  KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V5,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V6,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V7,
  KNOWLEDGE_COVERAGE_PLAN_MALFORMED,
  KNOWLEDGE_COVERAGE_PLAN_SCHEMA_V1,
  KNOWLEDGE_COVERAGE_PLANNER_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_DRAFT_MALFORMED,
  KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V4,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V5,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V6,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V7,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V8,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V9,
  isKnowledgeDraftMalformed,
  isKnowledgeSelectorValidationFailureReason,
  knowledgeAnswerCanonicalJson,
  knowledgeCoveragePlannerPrompt,
  knowledgeAnswerDraftMalformed,
  knowledgeAnswerDraftPromptForPair,
  knowledgeAnswerGroundingPromptEnvelopeFits,
  knowledgeGroundedSelectorPromptForPair,
  mergeKnowledgeAnswerDraftsV1,
  knowledgeSelectorEvidenceFromManifest,
  knowledgeSelectorFailureV3,
  validateKnowledgeAnswerDraftV6,
  validateKnowledgeAnswerDraftSupplementV1,
  validateKnowledgeGroundedSelectorV3,
  validateKnowledgeGroundedSelectorV4,
  validateKnowledgeGroundedSelectorV5,
  validateKnowledgeGroundedSelectorV6,
  validateKnowledgeGroundedSelectorV7,
  validateKnowledgeGroundedSelectorV8,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeAnswerContractPair,
  type KnowledgeAnswerContractVersions,
  type KnowledgeAnswerOperationRequestSnapshotV1,
  type KnowledgeAnswerFallbackReason,
  type KnowledgeCoveragePlanV1,
  type KnowledgeSelectorValidationFailureReason
} from "./answerGroundingV5";

export type KnowledgeAnswerOperationExecutionV8 = Readonly<{
  output: Readonly<Record<string, unknown>>;
  providerResponseId: string | null;
  usage: ModelRunUsage;
}>;

export type KnowledgeAnswerOperationExecutionOptionsV8 = Readonly<{
  providerResponseId: string | null;
}>;

export class KnowledgeAnswerOperationDeferredError extends Error {
  constructor(message = "knowledge_answer_operation_deferred") {
    super(message);
    this.name = "KnowledgeAnswerOperationDeferredError";
  }
}

export type KnowledgeAnswerGroundingExecutionV8Result = Readonly<{
  contracts: KnowledgeAnswerContractVersions;
  operations: readonly Readonly<{
    operation: KnowledgeAnswerOperationRequestSnapshotV1["operation"];
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
    options: KnowledgeAnswerOperationExecutionOptionsV8
  ): Promise<KnowledgeAnswerOperationExecutionV8>;
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  operation: KnowledgeAnswerOperationRequestSnapshotV1["operation"];
  ordinal: 1 | 2 | 3 | 4 | 5;
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
  let execution: KnowledgeAnswerOperationExecutionV8;
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
    const providerStatus = typeof error === "object" && error !== null &&
      "status" in error && typeof error.status === "number" &&
      Number.isSafeInteger(error.status)
      ? error.status
      : null;
    const providerErrorName = error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)
      ? error.name
      : "UnknownError";
    console.error(JSON.stringify({
      event: "knowledge_answer_provider_operation_failed",
      operation: input.operation,
      providerErrorName,
      providerStatus
    }));
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
 * Executes or reuses the bounded Knowledge answer protocol. V20/V16 first
 * persists one immutable Coverage Plan, then runs Draft and Selector.
 * Adaptive V20/V16 through V12/V8 runs may add exactly one focused
 * Draft and one final Selector only after an accepted partial-coverage verdict.
 * Provider payloads never leave this private boundary; only the deterministic
 * repository finalizer may publish text.
 */
export async function executeKnowledgeAnswerGroundingV8(input: Readonly<{
  authorize(): Promise<void>;
  contractPair?: KnowledgeAnswerContractPair;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  execute(
    request: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV8
  ): Promise<KnowledgeAnswerOperationExecutionV8>;
  forbiddenIdentityFragments?: readonly string[];
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  reasoningEffort?: string | null;
  recoveryProviderResponseIds?: Partial<Record<
    KnowledgeAnswerOperationRequestSnapshotV1["operation"],
    string | null
  >>;
  request: string;
  routeInstruction: string;
  shouldAbort(error: unknown): boolean;
  transport: "native_strict" | "provider_neutral_json";
}>): Promise<KnowledgeAnswerGroundingExecutionV8Result> {
  const pair = input.contractPair ?? KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16;
  const evidence = knowledgeSelectorEvidenceFromManifest(input.draft);
  if (!knowledgeAnswerGroundingPromptEnvelopeFits({
    contractPair: pair,
    evidence,
    evidenceManifest: input.draft.message,
    request: input.request,
    routeInstruction: input.routeInstruction
  })) {
    throw new Error("knowledge_answer_operation_request_invalid");
  }
  const handles = evidence.map((item) => item.handle);
  let coveragePlan: KnowledgeCoveragePlanV1 | undefined;
  let coveragePlannerOperation: Readonly<{
    acceptedResult: Readonly<Record<string, unknown>>;
    providerResponseId: string | null;
    usage: ModelRunUsage;
  }> | null = null;
  if (pair.coveragePlannerOperation) {
    const plannerPrompt = knowledgeCoveragePlannerPrompt({
      evidenceManifest: input.draft.message,
      request: input.request
    });
    const plannerRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
      contractVersion: 20,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_PLANNER_MAX_OUTPUT_TOKENS,
      operation: pair.coveragePlannerOperation,
      reasoningEffort: input.reasoningEffort,
      schema: KNOWLEDGE_COVERAGE_PLAN_SCHEMA_V1,
      systemPrompt: plannerPrompt.systemPrompt,
      transport: input.transport,
      userPrompt: plannerPrompt.userPrompt
    });
    coveragePlannerOperation = await acceptedOperation({
      acceptedFailure: () => operationRecord(KNOWLEDGE_COVERAGE_PLAN_MALFORMED),
      acceptedOutput: (output) => operationRecord(
        decodeKnowledgeCoveragePlanAcceptedResultV1(output) ??
          KNOWLEDGE_COVERAGE_PLAN_MALFORMED
      ),
      acceptedRequest: plannerRequest,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: pair.coveragePlannerOperation,
      ordinal: 1,
      recoveryProviderResponseId:
        input.recoveryProviderResponseIds?.[pair.coveragePlannerOperation],
      shouldAbort: input.shouldAbort
    });
    const acceptedPlan = decodeKnowledgeCoveragePlanAcceptedResultV1(
      coveragePlannerOperation.acceptedResult
    );
    if (!acceptedPlan || "kind" in acceptedPlan) {
      throw new Error("knowledge_coverage_plan_result_invalid");
    }
    coveragePlan = acceptedPlan;
  }
  const draftOrdinal = pair.coveragePlannerOperation ? 2 as const : 1 as const;
  const selectorOrdinal = pair.coveragePlannerOperation ? 3 as const : 2 as const;
  const adaptiveOrdinal = pair.coveragePlannerOperation ? 4 as const : 3 as const;
  const finalOrdinal = pair.coveragePlannerOperation ? 5 as const : 4 as const;
  const draftPrompt = knowledgeAnswerDraftPromptForPair({
    ...(coveragePlan ? { coveragePlan } : {}),
    draftPass: "primary",
    evidenceManifest: input.draft.message,
    missingInformation: [],
    request: input.request,
    routeInstruction: input.routeInstruction
  }, pair);
  const draftRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
    contractVersion: pair.draftContractVersion,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
    operation: pair.draftOperation,
    reasoningEffort: input.reasoningEffort,
    schema: pair.draftContractVersion === 20 || pair.draftContractVersion === 19 ||
      pair.draftContractVersion === 18 ||
      pair.draftContractVersion === 17 ||
      pair.draftContractVersion === 16 ||
      pair.draftContractVersion === 15 ||
      pair.draftContractVersion === 14 ||
      pair.draftContractVersion === 13 ||
      pair.draftContractVersion === 12 ||
      pair.draftContractVersion === 11
      ? KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V6
      : KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V5,
    systemPrompt: draftPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: draftPrompt.userPrompt
  });
  const draftOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => {
      const draftInput = {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments
      };
      if (pair.draftContractVersion === 20 || pair.draftContractVersion === 19 ||
        pair.draftContractVersion === 18 ||
        pair.draftContractVersion === 17 ||
        pair.draftContractVersion === 16 ||
        pair.draftContractVersion === 15 ||
        pair.draftContractVersion === 14 ||
        pair.draftContractVersion === 13 ||
        pair.draftContractVersion === 12 ||
        pair.draftContractVersion === 11) {
        const validation = validateKnowledgeAnswerDraftV6(output, draftInput);
        return operationRecord(validation.kind === "accepted"
          ? output
          : knowledgeAnswerDraftMalformed(validation.reason));
      }
      return operationRecord(
        decodeKnowledgeAnswerDraftV5(output, draftInput) ?? KNOWLEDGE_DRAFT_MALFORMED
      );
    },
    acceptedRequest: draftRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: pair.draftOperation,
    ordinal: draftOrdinal,
    recoveryProviderResponseId:
      input.recoveryProviderResponseIds?.[pair.draftOperation],
    shouldAbort: input.shouldAbort
  });
  const draft = decodeKnowledgeAnswerDraftAcceptedResultForPair(
    draftOperation.acceptedResult,
    {
      availableHandles: handles,
      forbiddenIdentityFragments: input.forbiddenIdentityFragments
    },
    pair
  );
  if (!draft) throw new Error("knowledge_answer_draft_result_invalid");

  const selectorPrompt = knowledgeGroundedSelectorPromptForPair({
    ...(coveragePlan ? { coveragePlan } : {}),
    draft: draft as KnowledgeAnswerDraftSelectorInput,
    evidence,
    evidenceManifest: input.draft.message,
    request: input.request,
    selectorPass: "initial"
  }, pair);
  const selectorRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
    contractVersion: pair.selectorContractVersion,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
    operation: pair.selectorOperation,
    reasoningEffort: input.reasoningEffort,
    schema: pair.selectorContractVersion === 16
      ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V9
      : pair.selectorContractVersion === 15 || pair.selectorContractVersion === 14
      ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V8
      : pair.selectorContractVersion === 13
      ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V7
      : pair.selectorContractVersion === 12 || pair.selectorContractVersion === 11 ||
      pair.selectorContractVersion === 10
      ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V6
      : pair.selectorContractVersion === 9 || pair.selectorContractVersion === 8
        ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V5
      : pair.selectorContractVersion === 7
        ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V4
        : KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3,
    systemPrompt: selectorPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: selectorPrompt.userPrompt
  });
  const selectorOperation = await acceptedOperation({
    acceptedFailure: (error) => operationRecord(knowledgeSelectorFailureV3(
      fallbackReason(error)
    )),
    acceptedOutput: (output) => {
      const validation = pair.selectorContractVersion === 16 && coveragePlan
        ? validateKnowledgeGroundedSelectorV8(output, { coveragePlan, draft, evidence })
        : pair.selectorContractVersion === 15 ||
        pair.selectorContractVersion === 14 ||
        pair.selectorContractVersion === 13
        ? validateKnowledgeGroundedSelectorV7(output, { draft, evidence })
        : pair.selectorContractVersion === 12 ||
        pair.selectorContractVersion === 11 ||
        pair.selectorContractVersion === 10
        ? validateKnowledgeGroundedSelectorV6(output, { draft, evidence })
        : pair.selectorContractVersion === 9 || pair.selectorContractVersion === 8
          ? validateKnowledgeGroundedSelectorV5(output, { draft, evidence })
        : pair.selectorContractVersion === 7
          ? validateKnowledgeGroundedSelectorV4(output, { draft, evidence })
          : validateKnowledgeGroundedSelectorV3(output, { draft, evidence });
      return operationRecord(validation.kind === "accepted"
        ? output
        : knowledgeSelectorFailureV3(validation.reason));
    },
    acceptedRequest: selectorRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: pair.selectorOperation,
    ordinal: selectorOrdinal,
    recoveryProviderResponseId:
      input.recoveryProviderResponseIds?.[pair.selectorOperation],
    shouldAbort: input.shouldAbort
  });

  const operations: Array<KnowledgeAnswerGroundingExecutionV8Result["operations"][number]> = [
    ...(coveragePlannerOperation && pair.coveragePlannerOperation ? [Object.freeze({
      operation: pair.coveragePlannerOperation,
      providerResponseId: coveragePlannerOperation.providerResponseId,
      usage: coveragePlannerOperation.usage
    })] : []),
    Object.freeze({
      operation: pair.draftOperation,
      providerResponseId: draftOperation.providerResponseId,
      usage: draftOperation.usage
    }),
    Object.freeze({
      operation: pair.selectorOperation,
      providerResponseId: selectorOperation.providerResponseId,
      usage: selectorOperation.usage
    })
  ];
  const result = (): KnowledgeAnswerGroundingExecutionV8Result => Object.freeze({
    contracts: Object.freeze({
      draftContractVersion: pair.draftContractVersion,
      selectorContractVersion: pair.selectorContractVersion
    }) as KnowledgeAnswerContractVersions,
    operations: Object.freeze([...operations])
  });

  const runFinalSelector = async (finalInput: Readonly<{
    finalDraft: KnowledgeAnswerDraftSelectorInput;
    ordinal: 3 | 4 | 5;
    repairReason?: KnowledgeSelectorValidationFailureReason;
    selectorPass: "final" | "repair";
  }>) => {
    if (!pair.finalSelectorOperation) {
      throw new Error("knowledge_answer_final_selector_unavailable");
    }
    const finalSelectorOperationName = pair.finalSelectorOperation;
    const finalSelectorPrompt = knowledgeGroundedSelectorPromptForPair({
      ...(coveragePlan ? { coveragePlan } : {}),
      draft: finalInput.finalDraft,
      evidence,
      evidenceManifest: input.draft.message,
      ...(finalInput.repairReason ? { repairReason: finalInput.repairReason } : {}),
      request: input.request,
      selectorPass: finalInput.selectorPass
    }, pair);
    const finalSelectorRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
      contractVersion: pair.selectorContractVersion,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
      operation: finalSelectorOperationName,
      reasoningEffort: input.reasoningEffort,
      schema: pair.selectorContractVersion === 16
        ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V9
        : pair.selectorContractVersion === 15 || pair.selectorContractVersion === 14
        ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V8
        : pair.selectorContractVersion === 13
        ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V7
        : pair.selectorContractVersion === 12 ||
        pair.selectorContractVersion === 11 || pair.selectorContractVersion === 10
        ? KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V6
        : KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V5,
      systemPrompt: finalSelectorPrompt.systemPrompt,
      transport: input.transport,
      userPrompt: finalSelectorPrompt.userPrompt
    });
    return acceptedOperation({
      acceptedFailure: (error) => operationRecord(knowledgeSelectorFailureV3(
        fallbackReason(error)
      )),
      acceptedOutput: (output) => {
        const validation = pair.selectorContractVersion === 16 && coveragePlan
          ? validateKnowledgeGroundedSelectorV8(output, {
              coveragePlan,
              draft: finalInput.finalDraft,
              evidence
            })
          : pair.selectorContractVersion === 15 ||
          pair.selectorContractVersion === 14 ||
          pair.selectorContractVersion === 13
          ? validateKnowledgeGroundedSelectorV7(output, {
              draft: finalInput.finalDraft,
              evidence
            })
          : pair.selectorContractVersion === 12 ||
          pair.selectorContractVersion === 11 ||
          pair.selectorContractVersion === 10
          ? validateKnowledgeGroundedSelectorV6(output, {
              draft: finalInput.finalDraft,
              evidence
            })
          : validateKnowledgeGroundedSelectorV5(output, {
              draft: finalInput.finalDraft,
              evidence
            });
        return operationRecord(validation.kind === "accepted"
          ? output
          : knowledgeSelectorFailureV3(validation.reason));
      },
      acceptedRequest: finalSelectorRequest,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: finalSelectorOperationName,
      ordinal: finalInput.ordinal,
      recoveryProviderResponseId:
        input.recoveryProviderResponseIds?.[finalSelectorOperationName],
      shouldAbort: input.shouldAbort
    });
  };

  const initialSelectorFailure = decodeKnowledgeSelectorFailureV3(
    selectorOperation.acceptedResult
  );
  const initialSelector = initialSelectorFailure
    ? null
    : pair.selectorContractVersion === 16 && coveragePlan
      ? decodeKnowledgeGroundedSelectorV8(
          selectorOperation.acceptedResult,
          { coveragePlan, draft, evidence }
        )
    : pair.selectorContractVersion === 15 || pair.selectorContractVersion === 14 ||
      pair.selectorContractVersion === 13
      ? decodeKnowledgeGroundedSelectorV7(
          selectorOperation.acceptedResult,
          { draft, evidence }
        )
      : pair.selectorContractVersion === 12 || pair.selectorContractVersion === 11 ||
      pair.selectorContractVersion === 10
      ? decodeKnowledgeGroundedSelectorV6(
          selectorOperation.acceptedResult,
          { draft, evidence }
        )
      : pair.selectorContractVersion === 9 || pair.selectorContractVersion === 8
        ? decodeKnowledgeGroundedSelectorV5(
            selectorOperation.acceptedResult,
            { draft, evidence }
          )
        : null;
  if (!initialSelectorFailure && pair.selectorContractVersion >= 8 && !initialSelector) {
    throw new Error("knowledge_grounded_selector_result_invalid");
  }

  const selectorValidationRepairRequired = (pair.draftContractVersion === 20 &&
    pair.selectorContractVersion === 16 || pair.draftContractVersion === 19 &&
    pair.selectorContractVersion === 15 || pair.draftContractVersion === 18 &&
    pair.selectorContractVersion === 14 || pair.draftContractVersion === 17 &&
    pair.selectorContractVersion === 13 || pair.draftContractVersion === 16 &&
    pair.selectorContractVersion === 12 || pair.draftContractVersion === 15 &&
    pair.selectorContractVersion === 11) && !isKnowledgeDraftMalformed(draft) &&
    initialSelectorFailure !== null &&
    isKnowledgeSelectorValidationFailureReason(initialSelectorFailure.reason);
  if (selectorValidationRepairRequired) {
    const repairOperation = await runFinalSelector({
      finalDraft: draft,
      ordinal: adaptiveOrdinal,
      repairReason: initialSelectorFailure.reason as KnowledgeSelectorValidationFailureReason,
      selectorPass: "repair"
    });
    operations.push(Object.freeze({
      operation: pair.finalSelectorOperation!,
      providerResponseId: repairOperation.providerResponseId,
      usage: repairOperation.usage
    }));
    return result();
  }

  if (!(
    pair.draftContractVersion === 20 && pair.selectorContractVersion === 16 ||
    pair.draftContractVersion === 19 && pair.selectorContractVersion === 15 ||
    pair.draftContractVersion === 18 && pair.selectorContractVersion === 14 ||
    pair.draftContractVersion === 17 && pair.selectorContractVersion === 13 ||
    pair.draftContractVersion === 16 && pair.selectorContractVersion === 12 ||
    pair.draftContractVersion === 15 && pair.selectorContractVersion === 11 ||
    pair.draftContractVersion === 14 && pair.selectorContractVersion === 10 ||
    pair.draftContractVersion === 13 && pair.selectorContractVersion === 9 ||
    pair.draftContractVersion === 12 && pair.selectorContractVersion === 8
  ) ||
    !pair.supplementalDraftOperation || !pair.finalSelectorOperation ||
    isKnowledgeDraftMalformed(draft) ||
    draft.claims.length >= KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaims) return result();

  if (!initialSelector || initialSelector.requestCoverage !== "partial") return result();

  const supplementOperationName = pair.supplementalDraftOperation;
  const supplementPrompt = knowledgeAnswerDraftPromptForPair({
    ...(coveragePlan ? { coveragePlan } : {}),
    draftPass: "supplement",
    evidenceManifest: input.draft.message,
    missingInformation: initialSelector.missingInformation,
    request: input.request,
    routeInstruction: input.routeInstruction
  }, pair);
  const supplementRequest = createKnowledgeAnswerOperationRequestSnapshotV1({
    contractVersion: pair.draftContractVersion,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
    operation: supplementOperationName,
    reasoningEffort: input.reasoningEffort,
    schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V7,
    systemPrompt: supplementPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: supplementPrompt.userPrompt
  });
  const supplementalOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => {
      const validation = validateKnowledgeAnswerDraftSupplementV1(output, {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments
      });
      return operationRecord(validation.kind === "accepted"
        ? output
        : knowledgeAnswerDraftMalformed(validation.reason));
    },
    acceptedRequest: supplementRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: supplementOperationName,
    ordinal: adaptiveOrdinal,
    recoveryProviderResponseId:
      input.recoveryProviderResponseIds?.[supplementOperationName],
    shouldAbort: input.shouldAbort
  });
  operations.push(Object.freeze({
    operation: supplementOperationName,
    providerResponseId: supplementalOperation.providerResponseId,
    usage: supplementalOperation.usage
  }));
  const supplement = decodeKnowledgeAnswerDraftSupplementAcceptedResultV1(
    supplementalOperation.acceptedResult,
    {
      availableHandles: handles,
      forbiddenIdentityFragments: input.forbiddenIdentityFragments
    }
  );
  if (!supplement) throw new Error("knowledge_answer_draft_result_invalid");
  if (isKnowledgeDraftMalformed(supplement)) return result();

  const mergedDraft = mergeKnowledgeAnswerDraftsV1({ primary: draft, supplement });
  const finalSelectorOperation = await runFinalSelector({
    finalDraft: mergedDraft,
    ordinal: finalOrdinal,
    selectorPass: "final"
  });
  operations.push(Object.freeze({
    operation: pair.finalSelectorOperation!,
    providerResponseId: finalSelectorOperation.providerResponseId,
    usage: finalSelectorOperation.usage
  }));
  return result();
}
