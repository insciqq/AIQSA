import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type {
  ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import type { KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import type { KnowledgeEvidenceDispatchBinding } from "./evidenceDispatchRepository";
import type { KnowledgeProviderDispatchLifecycle } from "./providerDispatchLifecycle";
import {
  KNOWLEDGE_ANSWER_DRAFT_LIMITS,
  KNOWLEDGE_DRAFT_MALFORMED,
  decodeKnowledgeAnswerDraftMalformed,
  isKnowledgeDraftMalformed,
  isKnowledgeSelectorValidationFailureReason,
  knowledgeAnswerDraftMalformed,
  knowledgeAnswerHash,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeAnswerSettlementV5,
  type KnowledgeSelectorValidationFailureReason
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS,
  createKnowledgeAnswerOperationRequestSnapshotV21,
  decodeKnowledgeAnswerDraftSupplementV21,
  decodeKnowledgeAnswerDraftV21,
  knowledgeAnswerDraftPromptV21,
  mergeKnowledgeAnswerDraftsV21,
  settleKnowledgeAnswerV21FromFinalSelector,
  validateKnowledgeAnswerDraftSupplementV21,
  validateKnowledgeAnswerDraftV21,
  type KnowledgeAnswerOperationScopeV6,
  type KnowledgeAnswerV21ContractVersions
} from "./answerGroundingV21";
import {
  acceptedOperation,
  type KnowledgeAnswerOperationExecutionOptionsV21,
  type KnowledgeAnswerOperationExecutionV21,
  type OperationOrdinalV21
} from "./answerGroundingExecutionV21";
import {
  KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
  KNOWLEDGE_COVERAGE_SCOPE_V6_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
  decodeKnowledgeCoverageScopeFailureV6,
  decodeKnowledgeCoverageScopeV6,
  isKnowledgeCoverageScopeValidationFailureReasonV6,
  knowledgeCoverageEvidenceFromManifestV6,
  knowledgeCoverageScopeFailureV6,
  knowledgeCoverageScopePromptV6,
  validateKnowledgeCoverageScopeV6,
  type KnowledgeCoverageScopeFailureReasonV6,
  type KnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
  decodeKnowledgeGroundedSelectorFailureV21,
  decodeKnowledgeGroundedSelectorV21,
  deriveKnowledgeCoverageV6,
  knowledgeCoverageMissingDimensionsV6,
  knowledgeGroundedSelectorPromptV21,
  knowledgeGroundedSelectorV21Fallback,
  validateKnowledgeGroundedSelectorV21,
  type KnowledgeGroundedSelectorFailureReasonV21,
  type KnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import {
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1
} from "./groundingExecutionPolicy";

export type KnowledgeAnswerGroundingExecutionV21ScopeV6Result = Readonly<{
  contracts: KnowledgeAnswerV21ContractVersions;
  operations: readonly Readonly<{
    operation: KnowledgeAnswerOperationScopeV6;
    ordinal: OperationOrdinalV21;
    providerResponseId: string | null;
    usage: ModelRunUsage;
  }>[];
  settlement: KnowledgeAnswerSettlementV5;
}>;

function operationRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function selectorFallbackReason(error: unknown): KnowledgeGroundedSelectorFailureReasonV21 {
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

function scopeFallbackReason(error: unknown): KnowledgeCoverageScopeFailureReasonV6 {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "timeouterror" || message.includes("timeout") ||
    message.includes("deadline")) return "coverage_scope_timeout";
  if (message.includes("refusal") || message.includes("refused") ||
    message.includes("safety")) return "coverage_scope_refusal";
  if (error instanceof TypeError || message.includes("network") ||
    message.includes("transport") || message.includes("fetch")) {
    return "coverage_scope_transport_failure";
  }
  return "coverage_scope_provider_error";
}

/** Executes Draft -> positive-finding Coverage Scope -> Selector. Scope remains
 * a physically separate request/evidence-only operation. Every accepted positive
 * unit or joint finding is materialized losslessly as a final dimension; there is
 * no second model-owned atom-to-scope projection. Every downstream request pins the
 * accepted result hash. One adjacent structural repair is allowed per Scope and
 * initial Selector, and one correction keeps the six-call hard cap. */
export async function executeKnowledgeAnswerGroundingV21(input: Readonly<{
  authorize(): Promise<void>;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  execute(
    request: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV21
  ): Promise<KnowledgeAnswerOperationExecutionV21>;
  executionPolicy?: KnowledgeGroundingEffectiveExecutionPolicyV1;
  forbiddenIdentityFragments?: readonly string[];
  lifecycle: KnowledgeProviderDispatchLifecycle;
  modelRunId: string;
  recoveryProviderResponseIds?: Partial<Record<OperationOrdinalV21, string | null>>;
  reasoningEffort?: string | null;
  request: string;
  routeInstruction: string;
  shouldAbort(error: unknown): boolean;
  transport: "native_strict" | "provider_neutral_json";
}>): Promise<KnowledgeAnswerGroundingExecutionV21ScopeV6Result> {
  const inheritedReasoningEffort = input.reasoningEffort ?? null;
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(
    input.executionPolicy ?? Object.freeze({
      auditorReasoningEffort: inheritedReasoningEffort,
      draftReasoningEffort: inheritedReasoningEffort,
      egressDestination: "answer_provider" as const,
      overriddenRoles: Object.freeze([]),
      providerBindingKey: "answer" as const,
      selectorReasoningEffort: inheritedReasoningEffort,
      supplementReasoningEffort: inheritedReasoningEffort,
      version: 1 as const
    })
  );
  if (!executionPolicy || input.executionPolicy !== undefined &&
    input.reasoningEffort !== undefined) {
    throw new Error("knowledge_grounding_execution_policy_invalid");
  }
  const requestExecutionPolicy = { executionPolicy } as const;
  const evidence = knowledgeCoverageEvidenceFromManifestV6(input.draft);
  const handles = evidence.map(({ handle }) => handle);
  const operations: Array<
    KnowledgeAnswerGroundingExecutionV21ScopeV6Result["operations"][number]
  > = [];
  const pushOperation = (
    ordinal: OperationOrdinalV21,
    operation: KnowledgeAnswerOperationScopeV6,
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
  ): KnowledgeAnswerGroundingExecutionV21ScopeV6Result => Object.freeze({
    contracts: KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS,
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
    protocol: "scope_v6",
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

  const runScope = async (
    ordinal: OperationOrdinalV21,
    scopePass: "initial" | "repair",
    repairReason?: KnowledgeCoverageScopeValidationFailureReasonV6
  ) => {
    const prompt = knowledgeCoverageScopePromptV6({
      evidence,
      evidenceManifest: input.draft.message,
      ...(repairReason ? { repairReason } : {}),
      request: input.request,
      scopePass
    });
    const request = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_COVERAGE_SCOPE_V6_CONTRACT_VERSION,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      ...requestExecutionPolicy,
      protocol: "scope_v6",
      schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
      systemPrompt: prompt.systemPrompt,
      transport: input.transport,
      userPrompt: prompt.userPrompt
    });
    const operation = await acceptedOperation({
      acceptedFailure: (error) => operationRecord(
        knowledgeCoverageScopeFailureV6(scopeFallbackReason(error))
      ),
      acceptedOutput: (output) => {
        const validation = validateKnowledgeCoverageScopeV6(output, {
          evidence,
          request: input.request
        });
        return operationRecord(validation.kind === "accepted"
          ? output
          : knowledgeCoverageScopeFailureV6(validation.reason));
      },
      acceptedRequest: request,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      ordinal,
      recoveryProviderResponseId: input.recoveryProviderResponseIds?.[ordinal],
      shouldAbort: input.shouldAbort
    });
    pushOperation(ordinal, KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION, operation);
    return operation;
  };

  let scopeOrdinal: OperationOrdinalV21 = 2;
  let scopeOperation = await runScope(scopeOrdinal, "initial");
  const initialScopeFailure = decodeKnowledgeCoverageScopeFailureV6(
    scopeOperation.acceptedResult
  );
  if (initialScopeFailure &&
    isKnowledgeCoverageScopeValidationFailureReasonV6(initialScopeFailure.reason)) {
    scopeOrdinal = 3;
    scopeOperation = await runScope(
      scopeOrdinal,
      "repair",
      initialScopeFailure.reason
    );
  }
  if (decodeKnowledgeCoverageScopeFailureV6(scopeOperation.acceptedResult)) {
    throw new Error("knowledge_coverage_scope_unaccepted");
  }
  const scope = decodeKnowledgeCoverageScopeV6(scopeOperation.acceptedResult, {
    evidence,
    request: input.request
  });
  if (!scope) throw new Error("knowledge_coverage_scope_unaccepted");
  const coverageScopePayloadHash = knowledgeAnswerHash(scopeOperation.acceptedResult);

  const runSelector = async (selectorInput: Readonly<{
    draft: KnowledgeAnswerDraftSelectorInput;
    operation: typeof KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21 |
      typeof KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21;
    ordinal: OperationOrdinalV21;
    repairReason?: KnowledgeSelectorValidationFailureReason;
    selectorPass: "final" | "initial" | "repair";
  }>) => {
    const prompt = knowledgeGroundedSelectorPromptV21({
      draft: selectorInput.draft,
      evidence,
      evidenceManifest: input.draft.message,
      ...(selectorInput.repairReason
        ? { repairReason: selectorInput.repairReason }
        : {}),
      request: input.request,
      scope,
      selectorPass: selectorInput.selectorPass
    });
    const request = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
      coverageScopePayloadHash,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
      operation: selectorInput.operation,
      ...requestExecutionPolicy,
      protocol: "scope_v6",
      schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
      systemPrompt: prompt.systemPrompt,
      transport: input.transport,
      userPrompt: prompt.userPrompt
    });
    const operation = await acceptedOperation({
      acceptedFailure: (error) => operationRecord(
        knowledgeGroundedSelectorV21Fallback(selectorFallbackReason(error))
      ),
      acceptedOutput: (output) => {
        const validation = validateKnowledgeGroundedSelectorV21(output, {
          draft: selectorInput.draft,
          evidence,
          request: input.request,
          scope
        });
        return operationRecord(validation.kind === "accepted"
          ? output
          : knowledgeGroundedSelectorV21Fallback(validation.reason));
      },
      acceptedRequest: request,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: selectorInput.operation,
      ordinal: selectorInput.ordinal,
      recoveryProviderResponseId: input.recoveryProviderResponseIds?.[selectorInput.ordinal],
      shouldAbort: input.shouldAbort
    });
    pushOperation(selectorInput.ordinal, selectorInput.operation, operation);
    return operation;
  };

  let selectorOrdinal = (scopeOrdinal + 1) as OperationOrdinalV21;
  let selectorOperation = await runSelector({
    draft: primaryDraft,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
    ordinal: selectorOrdinal,
    selectorPass: "initial"
  });
  let selectorFailure = decodeKnowledgeGroundedSelectorFailureV21(
    selectorOperation.acceptedResult
  );
  let acceptedSelector: KnowledgeGroundedSelectorV21 | null = selectorFailure
    ? null
    : decodeKnowledgeGroundedSelectorV21(selectorOperation.acceptedResult, {
        draft: primaryDraft,
        evidence,
        request: input.request,
        scope
      });
  if (!selectorFailure && !acceptedSelector) {
    throw new Error("knowledge_grounded_selector_result_invalid");
  }
  if (!isKnowledgeDraftMalformed(primaryDraft) && selectorFailure &&
    isKnowledgeSelectorValidationFailureReason(selectorFailure.reason)) {
    selectorOrdinal = (selectorOrdinal + 1) as OperationOrdinalV21;
    if (selectorOrdinal > 6) throw new Error("knowledge_answer_operation_limit_exceeded");
    selectorOperation = await runSelector({
      draft: primaryDraft,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      ordinal: selectorOrdinal,
      repairReason: selectorFailure.reason,
      selectorPass: "repair"
    });
    selectorFailure = decodeKnowledgeGroundedSelectorFailureV21(
      selectorOperation.acceptedResult
    );
    acceptedSelector = selectorFailure
      ? null
      : decodeKnowledgeGroundedSelectorV21(selectorOperation.acceptedResult, {
          draft: primaryDraft,
          evidence,
          request: input.request,
          scope
        });
    if (!selectorFailure && !acceptedSelector) {
      throw new Error("knowledge_grounded_selector_result_invalid");
    }
  }
  if (!acceptedSelector) throw new Error("knowledge_grounded_selector_result_invalid");

  const coverage = deriveKnowledgeCoverageV6(acceptedSelector);
  const primaryClaimCount = isKnowledgeDraftMalformed(primaryDraft)
    ? 0
    : primaryDraft.claims.length;
  const correctionRequired = coverage.missingInformation.length > 0 &&
    primaryClaimCount < KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaims &&
    selectorOrdinal + 2 <= 6;
  if (!correctionRequired) {
    return result(settleKnowledgeAnswerV21FromFinalSelector({
      draft: primaryDraft,
      evidence,
      selector: acceptedSelector
    }));
  }

  const supplementOrdinal = (selectorOrdinal + 1) as OperationOrdinalV21;
  const missingDimensions = knowledgeCoverageMissingDimensionsV6(acceptedSelector);
  const supplementPrompt = knowledgeAnswerDraftPromptV21({
    auditDimensions: missingDimensions,
    draftPass: "supplement",
    evidenceManifest: input.draft.message,
    primaryDraft,
    request: input.request,
    routeInstruction: input.routeInstruction
  });
  const supplementRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
    contractVersion: KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
    coverageScopePayloadHash,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
    ...requestExecutionPolicy,
    protocol: "scope_v6",
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
    return result(settleKnowledgeAnswerV21FromFinalSelector({
      draft: primaryDraft,
      evidence,
      selector: acceptedSelector
    }));
  }

  const finalDraft = mergeKnowledgeAnswerDraftsV21({
    primary: primaryDraft,
    supplement
  });
  const finalOrdinal = (supplementOrdinal + 1) as OperationOrdinalV21;
  if (finalOrdinal > 6) throw new Error("knowledge_answer_operation_limit_exceeded");
  const finalOperation = await runSelector({
    draft: finalDraft,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
    ordinal: finalOrdinal,
    selectorPass: "final"
  });
  const finalSelector = decodeKnowledgeGroundedSelectorFailureV21(
    finalOperation.acceptedResult
  ) ? null : decodeKnowledgeGroundedSelectorV21(finalOperation.acceptedResult, {
      draft: finalDraft,
      evidence,
      request: input.request,
      scope
    });
  if (!finalSelector) throw new Error("knowledge_grounded_selector_result_invalid");
  return result(settleKnowledgeAnswerV21FromFinalSelector({
    draft: finalDraft,
    evidence,
    selector: finalSelector
  }));
}
