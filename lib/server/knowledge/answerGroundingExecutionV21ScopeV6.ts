import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type {
  ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import type { KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import type { KnowledgeEvidenceDispatchBinding } from "./evidenceDispatchRepository";
import type { KnowledgeProviderDispatchLifecycle } from "./providerDispatchLifecycle";
import {
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
  normalizeKnowledgeClaimPayloadV1,
  normalizeKnowledgeTargetedSupplementPayloadV2
} from "./answerClaimSurfaceV1";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
  KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2,
  KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS,
  buildKnowledgeSupportedAnswerViewV1,
  createKnowledgeAnswerOperationRequestSnapshotV21,
  decodeKnowledgeAnswerDraftV21CommonMarkV1,
  knowledgeAnswerScopeV6CorrectionFitsV2,
  knowledgeAnswerDraftPromptV21,
  settleKnowledgeAnswerV21FromFinalSelector,
  validateKnowledgeAnswerDraftV21CommonMarkV1,
  type KnowledgeAnswerOperationScopeV6ClosureV1,
  type KnowledgeAnswerV21ContractVersions
} from "./answerGroundingV21";
import {
  knowledgeAnswerTargetedSupplementSchemaV3,
  decodeKnowledgeTargetedSupplementFailureV1,
  decodeKnowledgeTargetedSupplementV4,
  isKnowledgeTargetedSupplementFailureReasonV1,
  knowledgeTargetableMissingDimensionsV1,
  knowledgeTargetedEvidenceAtomIndex,
  knowledgeTargetedSupplementFailureV1,
  knowledgeTargetedSupplementFitsV1,
  knowledgeGroundedDeltaCoverageReviewRequiredV1,
  mergeKnowledgeGroundedCorrectionV2,
  mergeKnowledgeTargetedSupplementV2,
  validateKnowledgeTargetedSupplementV4,
  type KnowledgeTargetedSupplementClaimBindingV1
} from "./answerGroundingCorrectionV21";
import {
  knowledgeAnswerTargetedSupplementPromptV7,
  knowledgeGroundedDeltaSelectorPromptV6,
  knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1
} from "./answerGroundingAnswerLevelCompressionV1";
import {
  decodeKnowledgeGroundedSelectorDiagnosticFailureV1,
  diagnoseKnowledgeGroundedSelectorDimensionV1,
  knowledgeGroundedSelectorDiagnosticFailureV1,
  type KnowledgeSelectorRepairDiagnosticV1
} from "./answerGroundingSelectorRepairDiagnosticV1";
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
  decodeKnowledgeCoverageScopeV6,
  isKnowledgeCoverageScopeValidationFailureReasonV6,
  knowledgeCoverageEvidenceFromManifestV6,
  type KnowledgeCoverageScopeFailureReasonV6,
  type KnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";
import {
  type KnowledgeCoverageScopeRepairDiagnosticV1
} from "./coverageScopeRepairFeedbackV1";
import {
  collectKnowledgeCoverageScopeRepairDiagnosticsV1
} from "./coverageScopeMultiDiagnosticRepairV1";
import {
  decodeKnowledgeCoverageScopeRepairCandidateV1,
  decodeKnowledgeCoverageScopeVerifiedPatchFailureV1,
  knowledgeCoverageScopeRepairBaseHashV1,
  knowledgeCoverageScopeVerifiedPatchFailureV1,
  mergeKnowledgeCoverageScopeVerifiedPatchesV1,
  rejectKnowledgeCoverageScopeForeignLocalFindingsV1,
  type KnowledgeCoverageScopeRepairCandidateV1
} from "./coverageScopeVerifiedPatchRepairV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1,
  decodeKnowledgeCoverageScopeCompletenessFailureV1,
  decodeKnowledgeCoverageScopeCompletenessV1,
  isKnowledgeCoverageScopeCompletenessValidationFailureReasonV1,
  knowledgeCoverageScopeCompletenessFailureV1,
  validateKnowledgeCoverageScopeCompletenessV1,
  type KnowledgeCoverageScopeCompletenessFailureReasonV1,
  type KnowledgeCoverageScopeCompletenessValidationFailureReasonV1
} from "./coverageScopeCompletenessV1";
import {
  knowledgeCoverageScopeCompletenessPromptV4,
  knowledgeCoverageScopePromptV6AnswerGranularityV2
} from "./coverageScopeAnswerGranularityV2";
import {
  resolveKnowledgeCoverageRequestAnchorIdsV1
} from "./coverageScopeRequestAnchorIdsV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V1,
  applyKnowledgeCoverageScopeClosureV1,
  decodeKnowledgeCoverageScopeClosureFailureV1,
  decodeKnowledgeCoverageScopeClosureV1,
  isKnowledgeCoverageScopeClosureValidationFailureReasonV1,
  knowledgeCoverageScopeClosureFailureV1,
  knowledgeCoverageScopeClosurePromptV1,
  validateKnowledgeCoverageScopeClosureV1,
  type KnowledgeCoverageScopeClosureFailureReasonV1,
  type KnowledgeCoverageScopeClosureValidationFailureReasonV1
} from "./coverageScopeClosureV1";
import { KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2 } from "./coverageScopeV4";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
  decodeKnowledgeGroundedSelectorFailureV21,
  decodeKnowledgeGroundedSelectorV21,
  knowledgeCoverageMissingDimensionsV6,
  knowledgeGroundedSelectorV21Fallback,
  normalizeKnowledgeGroundedSelectorSupportEdgesV2,
  validateKnowledgeGroundedSelectorV21,
  type KnowledgeGroundedSelectorFailureReasonV21,
  type KnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import {
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1
} from "./groundingExecutionPolicy";

type OperationOrdinalScopeV6 = OperationOrdinalV21 | 7 | 8;

export type KnowledgeAnswerGroundingExecutionV21ScopeV6Result = Readonly<{
  contracts: KnowledgeAnswerV21ContractVersions;
  operations: readonly Readonly<{
    operation: KnowledgeAnswerOperationScopeV6ClosureV1;
    ordinal: OperationOrdinalScopeV6;
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

function completenessFallbackReason(
  error: unknown
): KnowledgeCoverageScopeCompletenessFailureReasonV1 {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "timeouterror" || message.includes("timeout") ||
    message.includes("deadline")) return "coverage_scope_completeness_timeout";
  if (message.includes("refusal") || message.includes("refused") ||
    message.includes("safety")) return "coverage_scope_completeness_refusal";
  if (error instanceof TypeError || message.includes("network") ||
    message.includes("transport") || message.includes("fetch")) {
    return "coverage_scope_completeness_transport_failure";
  }
  return "coverage_scope_completeness_provider_error";
}

function closureFallbackReason(
  error: unknown
): KnowledgeCoverageScopeClosureFailureReasonV1 {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "timeouterror" || message.includes("timeout") ||
    message.includes("deadline")) return "coverage_scope_closure_timeout";
  if (message.includes("refusal") || message.includes("refused") ||
    message.includes("safety")) return "coverage_scope_closure_refusal";
  if (error instanceof TypeError || message.includes("network") ||
    message.includes("transport") || message.includes("fetch")) {
    return "coverage_scope_closure_transport_failure";
  }
  return "coverage_scope_closure_provider_error";
}

/** Executes Draft -> positive-finding Scope -> append-only completeness -> Selector
 * -> independent semantic closure veto.
 * Scope and completeness are physically separate request/evidence-only operations.
 * Completeness may only add validated findings to immutable Scope; it cannot rewrite
 * or remove one. Every downstream request pins the resulting Scope hash. Adjacent
 * structural repairs and one correction remain bounded by the eight-call hard cap.
 * Admission is atomic for the two-call semantic correction: the normal path and
 * any path with one adjacent structural repair retain both correction slots. */
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
  recoveryProviderResponseIds?: Partial<Record<OperationOrdinalScopeV6, string | null>>;
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
    ordinal: OperationOrdinalScopeV6,
    operation: KnowledgeAnswerOperationScopeV6ClosureV1,
    result: Readonly<{
      providerResponseId: string | null;
      usage: ModelRunUsage;
    }>
  ) => {
    if (operations.length + 1 !== ordinal || operations.length >=
      KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
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
    protocol:
      KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
    schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
    systemPrompt: draftPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: draftPrompt.userPrompt
  });
  const draftOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => {
      const normalizedOutput = normalizeKnowledgeClaimPayloadV1(output);
      const validation = validateKnowledgeAnswerDraftV21CommonMarkV1(normalizedOutput, {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments
      });
      return operationRecord(validation.kind === "accepted"
        ? normalizedOutput
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
    decodeKnowledgeAnswerDraftV21CommonMarkV1(draftOperation.acceptedResult, {
      availableHandles: handles,
      forbiddenIdentityFragments: input.forbiddenIdentityFragments
    });
  if (!primaryDraft) throw new Error("knowledge_answer_draft_result_invalid");

  let transientScopeRepairBase: KnowledgeCoverageScopeRepairCandidateV1 | null = null;
  let transientScopeRepairDiagnostics:
    readonly KnowledgeCoverageScopeRepairDiagnosticV1[] | null = null;
  const runScope = async (
    ordinal: OperationOrdinalScopeV6,
    scopePass: "initial" | "repair",
    repair?: Readonly<{
      diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
      diagnostics: readonly KnowledgeCoverageScopeRepairDiagnosticV1[];
      reason: KnowledgeCoverageScopeValidationFailureReasonV6;
      repairBase: KnowledgeCoverageScopeRepairCandidateV1 | null;
      repairBaseHash: string | null;
    }>
  ) => {
    const prompt = knowledgeCoverageScopePromptV6AnswerGranularityV2({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence,
      evidenceManifest: input.draft.message,
      repairBaseHash: repair?.repairBaseHash ?? null,
      ...(repair ? {
        repairDiagnostics: repair.diagnostics,
        repairReason: repair.reason
      } : {}),
      request: input.request,
      scopePass
    });
    const request = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_COVERAGE_SCOPE_V6_CONTRACT_VERSION,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      ...requestExecutionPolicy,
      protocol:
        KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
      schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
      systemPrompt: prompt.systemPrompt,
      transport: input.transport,
      userPrompt: prompt.userPrompt
    });
    const operation = await acceptedOperation({
      acceptedFailure: (error) => operationRecord(
        knowledgeCoverageScopeVerifiedPatchFailureV1(scopeFallbackReason(error))
      ),
      acceptedOutput: (output) => {
        const resolvedOutput = resolveKnowledgeCoverageRequestAnchorIdsV1(
          output,
          input.request
        );
        if (repair?.repairBase &&
          decodeKnowledgeCoverageScopeRepairCandidateV1(resolvedOutput)) {
          const merge = mergeKnowledgeCoverageScopeVerifiedPatchesV1({
            atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
            base: repair.repairBase,
            diagnostic: repair.diagnostic,
            evidence,
            rejectForeignLocalFindings: true,
            repair: resolvedOutput,
            request: input.request
          });
          return operationRecord(merge.kind === "accepted"
            ? merge.output
            : knowledgeCoverageScopeVerifiedPatchFailureV1(
                merge.reason,
                merge.diagnostic
              ));
        }
        const localRejection = rejectKnowledgeCoverageScopeForeignLocalFindingsV1(
          resolvedOutput,
          {
          atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
          evidence,
          request: input.request
          }
        );
        const validation = localRejection.validation;
        if (scopePass === "initial" && validation.kind === "rejected") {
          transientScopeRepairBase = validation.repairBase;
          transientScopeRepairDiagnostics =
            collectKnowledgeCoverageScopeRepairDiagnosticsV1({
              atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
              base: validation.repairBase,
              evidence,
              initialDiagnostic: validation.diagnostic,
              request: input.request
            });
        }
        return operationRecord(validation.kind === "accepted"
          ? validation.output
          : knowledgeCoverageScopeVerifiedPatchFailureV1(
              validation.reason,
              validation.diagnostic,
              knowledgeCoverageScopeRepairBaseHashV1(validation.repairBase)
            ));
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

  let scopeOrdinal: OperationOrdinalScopeV6 = 2;
  let scopeOperation = await runScope(scopeOrdinal, "initial");
  const initialScopeFailure = decodeKnowledgeCoverageScopeVerifiedPatchFailureV1(
    scopeOperation.acceptedResult
  );
  if (initialScopeFailure?.diagnostic &&
    isKnowledgeCoverageScopeValidationFailureReasonV6(initialScopeFailure.reason)) {
    const transientScopeRepairBaseHash = knowledgeCoverageScopeRepairBaseHashV1(
      transientScopeRepairBase
    );
    if (transientScopeRepairBaseHash !== initialScopeFailure.repairBaseHash) {
      throw new Error("knowledge_coverage_scope_repair_base_unavailable");
    }
    if (!transientScopeRepairDiagnostics ||
      transientScopeRepairDiagnostics.length < 1) {
      throw new Error("knowledge_coverage_scope_repair_diagnostics_unavailable");
    }
    scopeOrdinal = 3;
    scopeOperation = await runScope(
      scopeOrdinal,
      "repair",
      {
        diagnostic: initialScopeFailure.diagnostic,
        diagnostics: transientScopeRepairDiagnostics,
        reason: initialScopeFailure.reason,
        repairBase: transientScopeRepairBase,
        repairBaseHash: initialScopeFailure.repairBaseHash
      }
    );
  }
  if (decodeKnowledgeCoverageScopeVerifiedPatchFailureV1(
    scopeOperation.acceptedResult
  )) {
    throw new Error("knowledge_coverage_scope_unaccepted");
  }
  let scope = decodeKnowledgeCoverageScopeV6(scopeOperation.acceptedResult, {
    atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
    evidence,
    request: input.request
  });
  if (!scope) throw new Error("knowledge_coverage_scope_unaccepted");
  const initialScopePayloadHash = knowledgeAnswerHash(scope);

  const runCompleteness = async (
    ordinal: OperationOrdinalScopeV6,
    completenessPass: "initial" | "repair",
    repairReason?: KnowledgeCoverageScopeCompletenessValidationFailureReasonV1
  ) => {
    const prompt = knowledgeCoverageScopeCompletenessPromptV4({
      acceptedScope: scope!,
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      completenessPass,
      evidence,
      evidenceManifest: input.draft.message,
      ...(repairReason ? { repairReason } : {}),
      request: input.request
    });
    const request = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_CONTRACT_VERSION,
      coverageScopePayloadHash: initialScopePayloadHash,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      ...requestExecutionPolicy,
      protocol:
        KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
      schema: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1,
      systemPrompt: prompt.systemPrompt,
      transport: input.transport,
      userPrompt: prompt.userPrompt
    });
    const operation = await acceptedOperation({
      acceptedFailure: (error) => operationRecord(
        knowledgeCoverageScopeCompletenessFailureV1(
          completenessFallbackReason(error)
        )
      ),
      acceptedOutput: (output) => {
        const resolvedOutput = resolveKnowledgeCoverageRequestAnchorIdsV1(
          output,
          input.request
        );
        const validation = validateKnowledgeCoverageScopeCompletenessV1(
          resolvedOutput,
          {
          acceptedScope: scope!,
          atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
          evidence,
          request: input.request
          }
        );
        return operationRecord(validation.kind === "accepted"
          ? resolvedOutput
          : knowledgeCoverageScopeCompletenessFailureV1(validation.reason));
      },
      acceptedRequest: request,
      authorize: input.authorize,
      draft: input.draft,
      evidenceBindings: input.evidenceBindings,
      execute: input.execute,
      lifecycle: input.lifecycle,
      modelRunId: input.modelRunId,
      operation: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      ordinal,
      recoveryProviderResponseId: input.recoveryProviderResponseIds?.[ordinal],
      shouldAbort: input.shouldAbort
    });
    pushOperation(ordinal, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION, operation);
    return operation;
  };

  let completenessOrdinal = (scopeOrdinal + 1) as OperationOrdinalScopeV6;
  let completenessOperation = await runCompleteness(completenessOrdinal, "initial");
  const initialCompletenessFailure = decodeKnowledgeCoverageScopeCompletenessFailureV1(
    completenessOperation.acceptedResult
  );
  if (initialCompletenessFailure &&
    isKnowledgeCoverageScopeCompletenessValidationFailureReasonV1(
      initialCompletenessFailure.reason
    )) {
    completenessOrdinal = (completenessOrdinal + 1) as OperationOrdinalScopeV6;
    completenessOperation = await runCompleteness(
      completenessOrdinal,
      "repair",
      initialCompletenessFailure.reason
    );
  }
  if (decodeKnowledgeCoverageScopeCompletenessFailureV1(
    completenessOperation.acceptedResult
  )) {
    throw new Error("knowledge_coverage_scope_completeness_unaccepted");
  }
  const completeness = decodeKnowledgeCoverageScopeCompletenessV1(
    completenessOperation.acceptedResult,
    {
      acceptedScope: scope,
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence,
      request: input.request
    }
  );
  if (!completeness) {
    throw new Error("knowledge_coverage_scope_completeness_unaccepted");
  }
  scope = completeness.scope;
  const coverageScopePayloadHash = knowledgeAnswerHash(scope);

  const runSelector = async (selectorInput: Readonly<{
    correction?: Readonly<{
      bindings: readonly KnowledgeTargetedSupplementClaimBindingV1[];
      initialSelector: KnowledgeGroundedSelectorV21;
    }>;
    draft: KnowledgeAnswerDraftSelectorInput;
    operation: typeof KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21 |
      typeof KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21;
    repairDiagnostic?: KnowledgeSelectorRepairDiagnosticV1;
    ordinal: OperationOrdinalScopeV6;
    repairReason?: KnowledgeSelectorValidationFailureReason;
    selectorPass: "final" | "final_repair" | "initial" | "repair";
  }>) => {
    const correctionPass = selectorInput.selectorPass === "final" ||
      selectorInput.selectorPass === "final_repair";
    const repairPass = selectorInput.selectorPass === "repair" ||
      selectorInput.selectorPass === "final_repair";
    if (correctionPass !== Boolean(selectorInput.correction) ||
      repairPass !== Boolean(selectorInput.repairReason) ||
      selectorInput.repairDiagnostic !== undefined &&
        selectorInput.repairReason !== "selector_dimension_invalid") {
      throw new Error("knowledge_grounded_selector_correction_state_invalid");
    }
    const prompt = selectorInput.correction
      ? knowledgeGroundedDeltaSelectorPromptV6({
          atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
          bindings: selectorInput.correction.bindings,
          draft: selectorInput.draft,
          evidence,
          initialSelector: selectorInput.correction.initialSelector,
          ...(selectorInput.repairReason
            ? { repairReason: selectorInput.repairReason }
            : {}),
          request: input.request,
          scope
        })
      : knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1({
          atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
          draft: selectorInput.draft,
          evidence,
          evidenceManifest: input.draft.message,
          ...(selectorInput.repairReason
            ? { repairReason: selectorInput.repairReason }
            : {}),
          ...(selectorInput.repairDiagnostic
            ? { repairDiagnostic: selectorInput.repairDiagnostic }
            : {}),
          request: input.request,
          scope,
          scopeProtocol: "append_only_completeness_v1",
          selectorPass: selectorInput.selectorPass
        });
    const request = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
      coverageScopePayloadHash,
      evidenceReceiptHash: input.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
      operation: selectorInput.operation,
      ...requestExecutionPolicy,
      protocol:
        KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
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
        const validationInput = {
          atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
          draft: selectorInput.draft,
          evidence,
          request: input.request,
          scope,
          scopeProtocol: "append_only_completeness_v1" as const
        };
        const normalizedOutput = normalizeKnowledgeGroundedSelectorSupportEdgesV2(
          output,
          validationInput
        );
        const candidate = normalizedOutput ?? output;
        const validation = validateKnowledgeGroundedSelectorV21(
          candidate,
          validationInput
        );
        if (validation.kind === "rejected") {
          if (!correctionPass && validation.reason === "selector_dimension_invalid") {
            return operationRecord(knowledgeGroundedSelectorDiagnosticFailureV1(
              diagnoseKnowledgeGroundedSelectorDimensionV1(candidate, validationInput)
            ));
          }
          return operationRecord(knowledgeGroundedSelectorV21Fallback(validation.reason));
        }
        const coverageReviewRequired = selectorInput.correction !== undefined &&
          selectorInput.selectorPass === "final" && selectorInput.ordinal <
            KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2 &&
          knowledgeGroundedDeltaCoverageReviewRequiredV1({
            bindings: selectorInput.correction.bindings,
            finalSelector: validation.value,
            initialSelector: selectorInput.correction.initialSelector,
            primaryClaimCount: selectorInput.correction.initialSelector.claims.length
          });
        return operationRecord(coverageReviewRequired
          ? knowledgeGroundedSelectorV21Fallback("selector_coverage_invalid")
          : candidate);
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

  let selectorOrdinal = (completenessOrdinal + 1) as OperationOrdinalScopeV6;
  let selectorOperation = await runSelector({
    draft: primaryDraft,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
    ordinal: selectorOrdinal,
    selectorPass: "initial"
  });
  let selectorDiagnosticFailure =
    decodeKnowledgeGroundedSelectorDiagnosticFailureV1(
      selectorOperation.acceptedResult
    );
  let selectorFailure = selectorDiagnosticFailure ??
    decodeKnowledgeGroundedSelectorFailureV21(selectorOperation.acceptedResult);
  let acceptedSelector: KnowledgeGroundedSelectorV21 | null = selectorFailure
    ? null
    : decodeKnowledgeGroundedSelectorV21(selectorOperation.acceptedResult, {
        atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
        draft: primaryDraft,
        evidence,
        request: input.request,
        scope,
        scopeProtocol: "append_only_completeness_v1"
      });
  if (!selectorFailure && !acceptedSelector) {
    throw new Error("knowledge_grounded_selector_result_invalid");
  }
  if (!isKnowledgeDraftMalformed(primaryDraft) && selectorFailure &&
    isKnowledgeSelectorValidationFailureReason(selectorFailure.reason)) {
    selectorOrdinal = (selectorOrdinal + 1) as OperationOrdinalScopeV6;
    if (selectorOrdinal > KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
      throw new Error("knowledge_answer_operation_limit_exceeded");
    }
    selectorOperation = await runSelector({
      draft: primaryDraft,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      ordinal: selectorOrdinal,
      ...(selectorDiagnosticFailure
        ? { repairDiagnostic: selectorDiagnosticFailure.diagnostic }
        : {}),
      repairReason: selectorFailure.reason,
      selectorPass: "repair"
    });
    selectorDiagnosticFailure = decodeKnowledgeGroundedSelectorDiagnosticFailureV1(
      selectorOperation.acceptedResult
    );
    selectorFailure = selectorDiagnosticFailure ??
      decodeKnowledgeGroundedSelectorFailureV21(selectorOperation.acceptedResult);
    acceptedSelector = selectorFailure
      ? null
      : decodeKnowledgeGroundedSelectorV21(selectorOperation.acceptedResult, {
          atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
          draft: primaryDraft,
          evidence,
          request: input.request,
          scope,
          scopeProtocol: "append_only_completeness_v1"
        });
    if (!selectorFailure && !acceptedSelector) {
      throw new Error("knowledge_grounded_selector_result_invalid");
    }
  }
  if (!acceptedSelector) throw new Error("knowledge_grounded_selector_result_invalid");

  let correctionBaseSelector = acceptedSelector;
  let postSelectorOrdinal = selectorOrdinal;
  if (acceptedSelector.coverage.some(({ status }) => status === "covered")) {
    const supportedView = buildKnowledgeSupportedAnswerViewV1({
      draft: primaryDraft,
      evidence,
      selector: Object.freeze({
        claims: acceptedSelector.claims,
        extractIds: acceptedSelector.extractIds,
        insufficientReason: acceptedSelector.insufficientReason,
        version: acceptedSelector.version
      })
    });
    const closureInput = {
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence,
      request: input.request,
      scope,
      selector: acceptedSelector,
      supportedView
    } as const;
    const runClosure = async (
      ordinal: OperationOrdinalScopeV6,
      closurePass: "initial" | "repair",
      repairReason?: KnowledgeCoverageScopeClosureValidationFailureReasonV1
    ) => {
      const prompt = knowledgeCoverageScopeClosurePromptV1({
        ...closureInput,
        closurePass,
        ...(repairReason ? { repairReason } : {})
      });
      const request = createKnowledgeAnswerOperationRequestSnapshotV21({
        contractVersion: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_CONTRACT_VERSION,
        coverageScopePayloadHash,
        evidenceReceiptHash: input.draft.manifestHash,
        maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
        ...requestExecutionPolicy,
        protocol:
          KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
        schema: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V1,
        systemPrompt: prompt.systemPrompt,
        transport: input.transport,
        userPrompt: prompt.userPrompt
      });
      const operation = await acceptedOperation({
        acceptedFailure: (error) => operationRecord(
          knowledgeCoverageScopeClosureFailureV1(closureFallbackReason(error))
        ),
        acceptedOutput: (output) => {
          const validation = validateKnowledgeCoverageScopeClosureV1(
            output,
            closureInput
          );
          return operationRecord(validation.kind === "accepted"
            ? output
            : knowledgeCoverageScopeClosureFailureV1(validation.reason));
        },
        acceptedRequest: request,
        authorize: input.authorize,
        draft: input.draft,
        evidenceBindings: input.evidenceBindings,
        execute: input.execute,
        lifecycle: input.lifecycle,
        modelRunId: input.modelRunId,
        operation: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
        ordinal,
        recoveryProviderResponseId: input.recoveryProviderResponseIds?.[ordinal],
        shouldAbort: input.shouldAbort
      });
      pushOperation(ordinal, KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION, operation);
      return operation;
    };

    postSelectorOrdinal = (selectorOrdinal + 1) as OperationOrdinalScopeV6;
    if (postSelectorOrdinal >
      KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
      throw new Error("knowledge_answer_operation_limit_exceeded");
    }
    let closureOperation = await runClosure(postSelectorOrdinal, "initial");
    const initialClosureFailure = decodeKnowledgeCoverageScopeClosureFailureV1(
      closureOperation.acceptedResult
    );
    if (initialClosureFailure &&
      isKnowledgeCoverageScopeClosureValidationFailureReasonV1(
        initialClosureFailure.reason
      ) && postSelectorOrdinal <
        KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
      postSelectorOrdinal = (postSelectorOrdinal + 1) as OperationOrdinalScopeV6;
      closureOperation = await runClosure(
        postSelectorOrdinal,
        "repair",
        initialClosureFailure.reason
      );
    }
    if (decodeKnowledgeCoverageScopeClosureFailureV1(
      closureOperation.acceptedResult
    )) {
      throw new Error("knowledge_coverage_scope_closure_unaccepted");
    }
    const closure = decodeKnowledgeCoverageScopeClosureV1(
      closureOperation.acceptedResult,
      closureInput
    );
    if (!closure) throw new Error("knowledge_coverage_scope_closure_unaccepted");
    correctionBaseSelector = applyKnowledgeCoverageScopeClosureV1({
      closure,
      selector: acceptedSelector
    });
  }

  const primaryClaimCount = isKnowledgeDraftMalformed(primaryDraft)
    ? 0
    : primaryDraft.claims.length;
  const missingDimensions = knowledgeCoverageMissingDimensionsV6(correctionBaseSelector);
  const targetableMissingDimensions = knowledgeTargetableMissingDimensionsV1(
    missingDimensions
  );
  const targetEvidenceAvailable = knowledgeTargetedEvidenceAtomIndex({
    evidence,
    targetDimensions: targetableMissingDimensions
  }, KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2) !== null;
  const correctionRequired = targetEvidenceAvailable && knowledgeTargetedSupplementFitsV1({
    primaryClaimCount,
    targetableDimensionCount: targetableMissingDimensions.length
  }) &&
    knowledgeAnswerScopeV6CorrectionFitsV2(postSelectorOrdinal);
  if (!correctionRequired) {
    return result(settleKnowledgeAnswerV21FromFinalSelector({
      draft: primaryDraft,
      evidence,
      selector: correctionBaseSelector
    }));
  }

  const supplementOrdinal = (postSelectorOrdinal + 1) as OperationOrdinalScopeV6;
  const supplementPrompt = knowledgeAnswerTargetedSupplementPromptV7({
    atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
    auditDimensions: targetableMissingDimensions,
    evidence,
    primaryClaimCount,
    request: input.request,
    routeInstruction: input.routeInstruction
  });
  const supplementSchema = knowledgeAnswerTargetedSupplementSchemaV3({
    primaryClaimCount,
    targetDimensions: targetableMissingDimensions
  });
  const supplementRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
    contractVersion: KNOWLEDGE_ANSWER_DRAFT_V21_CONTRACT_VERSION,
    coverageScopePayloadHash,
    evidenceReceiptHash: input.draft.manifestHash,
    maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
    ...requestExecutionPolicy,
    protocol:
      KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
    schema: supplementSchema,
    systemPrompt: supplementPrompt.systemPrompt,
    transport: input.transport,
    userPrompt: supplementPrompt.userPrompt
  });
  const supplementOperation = await acceptedOperation({
    acceptedFailure: () => operationRecord(KNOWLEDGE_DRAFT_MALFORMED),
    acceptedOutput: (output) => {
      const normalizedOutput = normalizeKnowledgeTargetedSupplementPayloadV2(output);
      const validation = validateKnowledgeTargetedSupplementV4(normalizedOutput, {
        availableHandles: handles,
        forbiddenIdentityFragments: input.forbiddenIdentityFragments,
        missingDimensions,
        primaryDraft
      });
      return operationRecord(validation.kind === "accepted"
        ? normalizedOutput
        : isKnowledgeTargetedSupplementFailureReasonV1(validation.reason)
          ? knowledgeTargetedSupplementFailureV1(validation.reason)
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
  const malformedSupplement = decodeKnowledgeAnswerDraftMalformed(
    supplementOperation.acceptedResult
  );
  const targetedSupplementFailure = decodeKnowledgeTargetedSupplementFailureV1(
    supplementOperation.acceptedResult
  );
  if (malformedSupplement || targetedSupplementFailure) {
    return result(settleKnowledgeAnswerV21FromFinalSelector({
      draft: primaryDraft,
      evidence,
      selector: correctionBaseSelector
    }));
  }
  const supplement = decodeKnowledgeTargetedSupplementV4(
    supplementOperation.acceptedResult,
    {
      availableHandles: handles,
      forbiddenIdentityFragments: input.forbiddenIdentityFragments,
      missingDimensions,
      primaryDraft
    }
  );
  if (!supplement) throw new Error("knowledge_answer_draft_result_invalid");
  const merged = mergeKnowledgeTargetedSupplementV2({
    primaryDraft,
    supplement
  });
  const finalDraft = merged.draft;
  let finalOrdinal = (supplementOrdinal + 1) as OperationOrdinalScopeV6;
  if (finalOrdinal > KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
    throw new Error("knowledge_answer_operation_limit_exceeded");
  }
  let finalOperation = await runSelector({
    correction: {
      bindings: merged.bindings,
      initialSelector: correctionBaseSelector
    },
    draft: finalDraft,
    operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
    ordinal: finalOrdinal,
    selectorPass: "final"
  });
  let finalFailure = decodeKnowledgeGroundedSelectorFailureV21(
    finalOperation.acceptedResult
  );
  if (finalFailure && isKnowledgeSelectorValidationFailureReason(finalFailure.reason) &&
    finalOrdinal < KNOWLEDGE_ANSWER_SCOPE_V6_REPAIR_RESERVED_MAX_OPERATION_COUNT_V2) {
    finalOrdinal = (finalOrdinal + 1) as OperationOrdinalScopeV6;
    finalOperation = await runSelector({
      correction: {
        bindings: merged.bindings,
        initialSelector: correctionBaseSelector
      },
      draft: finalDraft,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
      ordinal: finalOrdinal,
      repairReason: finalFailure.reason,
      selectorPass: "final_repair"
    });
    finalFailure = decodeKnowledgeGroundedSelectorFailureV21(
      finalOperation.acceptedResult
    );
  }
  const finalSelector = finalFailure ? null : decodeKnowledgeGroundedSelectorV21(
    finalOperation.acceptedResult,
    {
    atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
    draft: finalDraft,
    evidence,
    request: input.request,
    scope,
    scopeProtocol: "append_only_completeness_v1"
  });
  if (!finalSelector) throw new Error("knowledge_grounded_selector_result_invalid");
  const correctedSelector = mergeKnowledgeGroundedCorrectionV2({
    bindings: merged.bindings,
    finalSelector,
    initialSelector: correctionBaseSelector,
    primaryClaimCount
  });
  return result(settleKnowledgeAnswerV21FromFinalSelector({
    draft: finalDraft,
    evidence,
    selector: correctedSelector
  }));
}
