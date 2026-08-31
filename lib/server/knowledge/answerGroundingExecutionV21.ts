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
  KNOWLEDGE_ANSWER_DRAFT_LIMITS,
  KNOWLEDGE_DRAFT_MALFORMED,
  decodeKnowledgeAnswerDraftMalformed,
  isKnowledgeDraftMalformed,
  isKnowledgeSelectorValidationFailureReason,
  knowledgeAnswerCanonicalJson,
  knowledgeAnswerDraftMalformed,
  knowledgeAnswerHash,
  knowledgeSelectorEvidenceFromManifest,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeAnswerSettlementV5,
  type KnowledgeSelectorValidationFailureReason
} from "./answerGroundingV5";
import { KnowledgeAnswerOperationDeferredError } from "./answerGroundingExecutionV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_V21_AUDIT_V2_CONTRACT_VERSIONS,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_SCHEMA_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_V17_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_V17_MAX_OUTPUT_TOKENS,
  buildKnowledgeSupportedAnswerViewV1,
  createKnowledgeAnswerOperationRequestSnapshotV21,
  decodeKnowledgeAnswerDraftSupplementV21,
  decodeKnowledgeAnswerDraftV21,
  decodeKnowledgeAnswerOperationRequestSnapshotV21,
  decodeKnowledgeGroundedSelectorFailureV17,
  decodeKnowledgeGroundedSelectorFinalV17,
  decodeKnowledgeGroundedSelectorV17,
  knowledgeAnswerDraftPromptV21,
  knowledgeEmptyGroundedSelectorV17,
  knowledgeGroundedSelectorPromptV17,
  knowledgeGroundedSelectorV17Fallback,
  mergeKnowledgeAnswerDraftsV21,
  settleKnowledgeAnswerV21FromAudit,
  settleKnowledgeAnswerV21FromFinalSelector,
  validateKnowledgeAnswerDraftSupplementV21,
  validateKnowledgeAnswerDraftV21,
  validateKnowledgeGroundedSelectorFinalV17,
  validateKnowledgeGroundedSelectorV17,
  type KnowledgeAnswerOperationRequestSnapshotV21,
  type KnowledgeAnswerOperationAuditV2,
  type KnowledgeAnswerOperationV21,
  type KnowledgeAnswerV21AuditV2ContractVersions,
  type KnowledgeGroundedSelectorFailureReasonV17,
  type KnowledgeGroundedSelectorV17
} from "./answerGroundingV21";
import {
  KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_AUDITOR_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
  KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V2,
  decodeKnowledgeCoverageAuditFailureV2,
  decodeKnowledgeCoverageAuditV2,
  deriveKnowledgeCoverageV2,
  isKnowledgeCoverageAuditValidationFailureReasonV2,
  knowledgeCoverageAuditFailureV2,
  knowledgeCoverageAuditMissingDimensionsV2,
  knowledgeCoverageAuditPromptV2,
  validateKnowledgeCoverageAuditV2,
  type KnowledgeCoverageAuditFailureReasonV2,
  type KnowledgeCoverageAuditSelectorStateV1,
  type KnowledgeCoverageAuditValidationFailureReasonV2
} from "./coverageAuditV2";
import {
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1
} from "./groundingExecutionPolicy";

export type KnowledgeAnswerOperationExecutionV21 = Readonly<{
  output: Readonly<Record<string, unknown>>;
  providerResponseId: string | null;
  usage: ModelRunUsage;
}>;

export type KnowledgeAnswerOperationExecutionOptionsV21 = Readonly<{
  providerResponseId: string | null;
}>;

export type KnowledgeAnswerGroundingExecutionV21AuditV2Result = Readonly<{
  contracts: KnowledgeAnswerV21AuditV2ContractVersions;
  operations: readonly Readonly<{
    operation: KnowledgeAnswerOperationAuditV2;
    ordinal: 1 | 2 | 3 | 4 | 5 | 6;
    providerResponseId: string | null;
    usage: ModelRunUsage;
  }>[];
  settlement: KnowledgeAnswerSettlementV5;
}>;

export type OperationAcceptedResultV21 = Readonly<Record<string, unknown>>;
export type OperationOrdinalV21 = 1 | 2 | 3 | 4 | 5 | 6;
type OperationAcceptedResult = OperationAcceptedResultV21;
type OperationOrdinal = OperationOrdinalV21;

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
  left: KnowledgeAnswerOperationRequestSnapshotV21,
  right: KnowledgeAnswerOperationRequestSnapshotV21
): boolean {
  return knowledgeAnswerCanonicalJson(left) === knowledgeAnswerCanonicalJson(right);
}

function selectorFallbackReason(error: unknown): KnowledgeGroundedSelectorFailureReasonV17 {
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

function auditFallbackReason(error: unknown): KnowledgeCoverageAuditFailureReasonV2 {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "timeouterror" || message.includes("timeout") ||
    message.includes("deadline")) return "coverage_audit_timeout";
  if (message.includes("refusal") || message.includes("refused") ||
    message.includes("safety")) return "coverage_audit_refusal";
  if (error instanceof TypeError || message.includes("network") ||
    message.includes("transport") || message.includes("fetch")) {
    return "coverage_audit_transport_failure";
  }
  return "coverage_audit_provider_error";
}

export async function acceptedOperation(input: Readonly<{
  acceptedFailure(error: unknown): OperationAcceptedResult;
  acceptedOutput(output: Readonly<Record<string, unknown>>): OperationAcceptedResult;
  acceptedRequest: KnowledgeAnswerOperationRequestSnapshotV21;
  authorize(): Promise<void>;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  execute(
    request: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV21
  ): Promise<KnowledgeAnswerOperationExecutionV21>;
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  operation: KnowledgeAnswerOperationV21;
  ordinal: OperationOrdinal | 7;
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
    const storedRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
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
  let execution: KnowledgeAnswerOperationExecutionV21;
  let acceptedResult: OperationAcceptedResult;
  try {
    execution = await input.execute({
      maxOutputTokens: input.acceptedRequest.maxOutputTokens,
      name: input.acceptedRequest.name,
      reasoningEffort: input.acceptedRequest.reasoningEffort,
      schema: input.acceptedRequest.schema,
      systemPrompt: input.acceptedRequest.systemPrompt,
      userPrompt: input.acceptedRequest.userPrompt
    }, { providerResponseId: recoveryProviderResponseId });
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

function selectorState(
  selector: KnowledgeGroundedSelectorV17
): KnowledgeCoverageAuditSelectorStateV1 {
  return Object.freeze({
    contradictedClaimCount: selector.claims.filter(
      ({ verdict }) => verdict === "contradicted"
    ).length,
    selectedLiteralCount: selector.extractIds.length,
    supportedClaimCount: selector.claims.filter(
      ({ verdict }) => verdict === "supported"
    ).length,
    unsupportedClaimCount: selector.claims.filter(
      ({ verdict }) => verdict === "unsupported"
    ).length
  });
}

/**
 * Executes the V21 Draft -> support-only Selector -> Coverage Auditor protocol.
 * One validation-only Selector repair may precede the Auditor. One missing-
 * coverage correction may add Supplement and Final Selector; all operations
 * reuse the same immutable evidence receipt and the total is capped at six.
 */
export async function executeKnowledgeAnswerGroundingV21AuditV2(input: Readonly<{
  authorize(): Promise<void>;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  execute(
    request: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV21
  ): Promise<KnowledgeAnswerOperationExecutionV21>;
  forbiddenIdentityFragments?: readonly string[];
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  executionPolicy?: KnowledgeGroundingEffectiveExecutionPolicyV1;
  reasoningEffort?: string | null;
  recoveryProviderResponseIds?: Partial<Record<OperationOrdinal, string | null>>;
  request: string;
  routeInstruction: string;
  shouldAbort(error: unknown): boolean;
  transport: "native_strict" | "provider_neutral_json";
}>): Promise<KnowledgeAnswerGroundingExecutionV21AuditV2Result> {
  const executionPolicy = input.executionPolicy === undefined
    ? null
    : decodeKnowledgeGroundingEffectiveExecutionPolicyV1(input.executionPolicy);
  if (input.executionPolicy !== undefined && !executionPolicy ||
    input.executionPolicy !== undefined && input.reasoningEffort !== undefined) {
    throw new Error("knowledge_grounding_execution_policy_invalid");
  }
  const requestExecutionPolicy = executionPolicy
    ? { executionPolicy }
    : { reasoningEffort: input.reasoningEffort };
  const evidence = knowledgeSelectorEvidenceFromManifest(input.draft);
  const handles = evidence.map(({ handle }) => handle);
  const operations: Array<
    KnowledgeAnswerGroundingExecutionV21AuditV2Result["operations"][number]
  > = [];
  const pushOperation = (
    ordinal: OperationOrdinal,
    operation: KnowledgeAnswerOperationAuditV2,
    result: Readonly<{
      providerResponseId: string | null;
      usage: ModelRunUsage;
    }>
  ) => {
    if (operations.length + 1 !== ordinal || operations.length >= 6) {
      throw new Error("knowledge_answer_operation_sequence_invalid");
    }
    operations.push(Object.freeze({
      operation,
      ordinal,
      providerResponseId: result.providerResponseId,
      usage: result.usage
    }));
  };
  const result = (
    settlement: KnowledgeAnswerSettlementV5
  ): KnowledgeAnswerGroundingExecutionV21AuditV2Result => Object.freeze({
    contracts: KNOWLEDGE_ANSWER_V21_AUDIT_V2_CONTRACT_VERSIONS,
    operations: Object.freeze([...operations]),
    settlement
  });

  const draftPrompt = knowledgeAnswerDraftPromptV21({
    draftPass: "primary",
    evidenceManifest: input.draft.message,
    request: input.request,
    routeInstruction: input.routeInstruction
  });
  const draftRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
    contractVersion: KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
    ...requestExecutionPolicy,
    schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
    systemPrompt: draftPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: draftPrompt.userPrompt
  });
  const draftOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => {
      const validation = validateKnowledgeAnswerDraftV21(output, {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments
      });
      return operationRecord(validation.kind === "accepted"
        ? output
        : knowledgeAnswerDraftMalformed(validation.reason));
    },
    acceptedRequest: draftRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
    ordinal: 1,
    recoveryProviderResponseId: input.recoveryProviderResponseIds?.[1],
    shouldAbort: input.shouldAbort
  });
  pushOperation(1, KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21, draftOperation);
  const primaryDraft = decodeKnowledgeAnswerDraftMalformed(draftOperation.acceptedResult) ??
    decodeKnowledgeAnswerDraftV21(draftOperation.acceptedResult, {
      availableHandles: handles,
      forbiddenIdentityFragments: input.forbiddenIdentityFragments
    });
  if (!primaryDraft) throw new Error("knowledge_answer_draft_result_invalid");

  const runSelector = async (selectorInput: Readonly<{
    draft: KnowledgeAnswerDraftSelectorInput;
    ordinal: OperationOrdinal;
    repairReason?: KnowledgeSelectorValidationFailureReason;
  }>) => {
    const prompt = knowledgeGroundedSelectorPromptV17({
      draft: selectorInput.draft,
      evidence,
      evidenceManifest: input.draft.message,
      ...(selectorInput.repairReason
        ? { repairReason: selectorInput.repairReason }
        : {}),
      request: input.request,
      selectorPass: selectorInput.repairReason ? "repair" : "initial"
    });
    const request = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V17_CONTRACT_VERSION,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V17_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      ...requestExecutionPolicy,
      schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V17,
      systemPrompt: prompt.systemPrompt,
      transport: input.transport,
      userPrompt: prompt.userPrompt
    });
    return acceptedOperation({
      acceptedFailure: (error) => operationRecord(
        knowledgeGroundedSelectorV17Fallback(selectorFallbackReason(error))
      ),
      acceptedOutput: (output) => {
        const validation = validateKnowledgeGroundedSelectorV17(output, {
          draft: selectorInput.draft,
          evidence
        });
        return operationRecord(validation.kind === "accepted"
          ? output
          : knowledgeGroundedSelectorV17Fallback(validation.reason));
      },
      acceptedRequest: request,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      ordinal: selectorInput.ordinal,
      recoveryProviderResponseId:
        input.recoveryProviderResponseIds?.[selectorInput.ordinal],
      shouldAbort: input.shouldAbort
    });
  };

  const initialSelectorOperation = await runSelector({
    draft: primaryDraft,
    ordinal: 2
  });
  pushOperation(2, KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17, initialSelectorOperation);
  let selectorFailure = decodeKnowledgeGroundedSelectorFailureV17(
    initialSelectorOperation.acceptedResult
  );
  let acceptedSelector = selectorFailure
    ? null
    : decodeKnowledgeGroundedSelectorV17(initialSelectorOperation.acceptedResult, {
        draft: primaryDraft,
        evidence
      });
  if (!selectorFailure && !acceptedSelector) {
    throw new Error("knowledge_grounded_selector_result_invalid");
  }

  let nextOrdinal: OperationOrdinal = 3;
  if (!isKnowledgeDraftMalformed(primaryDraft) && selectorFailure &&
    isKnowledgeSelectorValidationFailureReason(selectorFailure.reason)) {
    const repairOperation = await runSelector({
      draft: primaryDraft,
      ordinal: 3,
      repairReason: selectorFailure.reason
    });
    pushOperation(3, KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17, repairOperation);
    selectorFailure = decodeKnowledgeGroundedSelectorFailureV17(
      repairOperation.acceptedResult
    );
    acceptedSelector = selectorFailure
      ? null
      : decodeKnowledgeGroundedSelectorV17(repairOperation.acceptedResult, {
          draft: primaryDraft,
          evidence
        });
    if (!selectorFailure && !acceptedSelector) {
      throw new Error("knowledge_grounded_selector_result_invalid");
    }
    nextOrdinal = 4;
  }

  const selectorForAudit = acceptedSelector ?? knowledgeEmptyGroundedSelectorV17(primaryDraft);
  const supportedView = buildKnowledgeSupportedAnswerViewV1({
    draft: primaryDraft,
    evidence,
    selector: selectorForAudit
  });
  const executeAudit = async (
    ordinal: OperationOrdinal,
    auditPass: "initial" | "repair",
    repairReason?: KnowledgeCoverageAuditValidationFailureReasonV2
  ) => {
    const auditPrompt = knowledgeCoverageAuditPromptV2({
      auditPass,
      evidence,
      evidenceManifest: input.draft.message,
      ...(repairReason ? { repairReason } : {}),
      request: input.request,
      ...(acceptedSelector ? { selectorState: selectorState(acceptedSelector) } : {}),
      supportedView
    });
    const auditRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_VERSION,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_AUDITOR_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      ...requestExecutionPolicy,
      schema: KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V2,
      systemPrompt: auditPrompt.systemPrompt,
      transport: input.transport,
      userPrompt: auditPrompt.userPrompt
    });
    const operation = await acceptedOperation({
      acceptedFailure: (error) => operationRecord(
        knowledgeCoverageAuditFailureV2(auditFallbackReason(error))
      ),
      acceptedOutput: (output) => {
        const validation = validateKnowledgeCoverageAuditV2(output, {
          evidence,
          request: input.request,
          supportedView
        });
        return operationRecord(validation.kind === "accepted"
          ? output
          : knowledgeCoverageAuditFailureV2(validation.reason));
      },
      acceptedRequest: auditRequest,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      ordinal,
      recoveryProviderResponseId: input.recoveryProviderResponseIds?.[ordinal],
      shouldAbort: input.shouldAbort
    });
    pushOperation(ordinal, KNOWLEDGE_COVERAGE_AUDITOR_OPERATION, operation);
    return operation;
  };
  let auditOrdinal: OperationOrdinal = nextOrdinal;
  let auditOperation = await executeAudit(auditOrdinal, "initial");
  const initialAuditFailure = decodeKnowledgeCoverageAuditFailureV2(
    auditOperation.acceptedResult
  );
  if (initialAuditFailure &&
    isKnowledgeCoverageAuditValidationFailureReasonV2(initialAuditFailure.reason)) {
    auditOrdinal = (auditOrdinal + 1) as OperationOrdinal;
    if (auditOrdinal > 6) throw new Error("knowledge_answer_operation_limit_exceeded");
    auditOperation = await executeAudit(
      auditOrdinal,
      "repair",
      initialAuditFailure.reason
    );
  }
  if (decodeKnowledgeCoverageAuditFailureV2(auditOperation.acceptedResult)) {
    throw new Error("knowledge_coverage_audit_unaccepted");
  }
  const audit = decodeKnowledgeCoverageAuditV2(auditOperation.acceptedResult, {
    evidence,
    request: input.request,
    supportedView
  });
  if (!audit) throw new Error("knowledge_coverage_audit_unaccepted");
  const auditPayloadHash = knowledgeAnswerHash(auditOperation.acceptedResult);
  const coverage = deriveKnowledgeCoverageV2(audit);
  const primaryClaimCount = isKnowledgeDraftMalformed(primaryDraft)
    ? 0
    : primaryDraft.claims.length;
  const correctionRequired = coverage.missingInformation.length > 0 &&
    primaryClaimCount < KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaims &&
    auditOrdinal + 2 <= 6;
  if (!correctionRequired) {
    if (!acceptedSelector) {
      throw new Error("knowledge_grounded_selector_result_invalid");
    }
    return result(settleKnowledgeAnswerV21FromAudit({
      audit,
      draft: primaryDraft,
      evidence,
      request: input.request,
      selector: acceptedSelector
    }));
  }

  const supplementOrdinal = (auditOrdinal + 1) as OperationOrdinal;
  const missingDimensions = knowledgeCoverageAuditMissingDimensionsV2(audit);
  const supplementPrompt = knowledgeAnswerDraftPromptV21({
    auditDimensions: missingDimensions,
    draftPass: "supplement",
    evidenceManifest: input.draft.message,
    primaryDraft,
    request: input.request,
    routeInstruction: input.routeInstruction
  });
  const supplementRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
    auditPayloadHash,
    contractVersion: KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
    ...requestExecutionPolicy,
    schema: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_SCHEMA_V21,
    systemPrompt: supplementPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: supplementPrompt.userPrompt
  });
  const supplementOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => {
      const validation = validateKnowledgeAnswerDraftSupplementV21(output, {
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
    operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
    ordinal: supplementOrdinal,
    recoveryProviderResponseId: input.recoveryProviderResponseIds?.[supplementOrdinal],
    shouldAbort: input.shouldAbort
  });
  pushOperation(
    supplementOrdinal,
    KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
    supplementOperation
  );
  const supplement = decodeKnowledgeAnswerDraftMalformed(
    supplementOperation.acceptedResult
  ) ?? decodeKnowledgeAnswerDraftSupplementV21(supplementOperation.acceptedResult, {
    availableHandles: handles,
    forbiddenIdentityFragments: input.forbiddenIdentityFragments
  });
  if (!supplement) throw new Error("knowledge_answer_draft_result_invalid");
  if (isKnowledgeDraftMalformed(supplement)) {
    if (!acceptedSelector) {
      throw new Error("knowledge_grounded_selector_result_invalid");
    }
    return result(settleKnowledgeAnswerV21FromAudit({
      audit,
      draft: primaryDraft,
      evidence,
      request: input.request,
      selector: acceptedSelector
    }));
  }

  const finalDraft = mergeKnowledgeAnswerDraftsV21({
    primary: primaryDraft,
    supplement
  });
  const finalOrdinal = (supplementOrdinal + 1) as OperationOrdinal;
  if (finalOrdinal > 6) throw new Error("knowledge_answer_operation_limit_exceeded");
  const finalPrompt = knowledgeGroundedSelectorPromptV17({
    audit,
    draft: finalDraft,
    evidence,
    evidenceManifest: input.draft.message,
    request: input.request,
    selectorPass: "final"
  });
  const finalRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
    auditPayloadHash,
    contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V17_CONTRACT_VERSION,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V17_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
    ...requestExecutionPolicy,
    schema: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_SCHEMA_V17,
    systemPrompt: finalPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: finalPrompt.userPrompt
  });
  const finalOperation = await acceptedOperation({
    acceptedFailure: (error) => operationRecord(
      knowledgeGroundedSelectorV17Fallback(selectorFallbackReason(error))
    ),
    acceptedOutput: (output) => {
      const validation = validateKnowledgeGroundedSelectorFinalV17(output, {
        audit,
        draft: finalDraft,
        evidence
      });
      return operationRecord(validation.kind === "accepted"
        ? output
        : knowledgeGroundedSelectorV17Fallback(validation.reason));
    },
    acceptedRequest: finalRequest,
    authorize: input.authorize,
    draft: input.draft,
    evidenceBindings: input.evidenceBindings,
    execute: input.execute,
    lifecycle: input.lifecycle,
    modelRunId: input.modelRunId,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
    ordinal: finalOrdinal,
    recoveryProviderResponseId: input.recoveryProviderResponseIds?.[finalOrdinal],
    shouldAbort: input.shouldAbort
  });
  pushOperation(finalOrdinal, KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17, finalOperation);
  const finalSelector = decodeKnowledgeGroundedSelectorFailureV17(
    finalOperation.acceptedResult
  ) ? null : decodeKnowledgeGroundedSelectorFinalV17(finalOperation.acceptedResult, {
      audit,
      draft: finalDraft,
      evidence
    });
  if (!finalSelector) {
    throw new Error("knowledge_grounded_selector_result_invalid");
  }
  return result(settleKnowledgeAnswerV21FromFinalSelector({
    draft: finalDraft,
    evidence,
    selector: finalSelector
  }));
}
