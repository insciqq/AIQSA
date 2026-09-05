import {
  isKnowledgeDraftMalformed,
  knowledgeAnswerHash,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeSelectorValidationFailureReason
} from "./answerGroundingV5";
import { acceptedOperation } from "./answerGroundingExecutionV21";
import type {
  executeKnowledgeAnswerGroundingV21,
  KnowledgeAnswerGroundingExecutionV21ScopeV6Result
} from "./answerGroundingExecutionV21ScopeV6";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V22,
  buildKnowledgePublicationPlanV1,
  knowledgeGroundedSelectorPromptV22,
  knowledgeSelectorPayloadV22,
  renderKnowledgePublicationPlanV1,
  validateKnowledgeGroundedSelectorV22,
  type KnowledgeGroundedSelectorV22,
  type KnowledgePublicationInputV1,
  type KnowledgeSelectorInputV22
} from "./answerGroundingSelectorV22";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V3,
  applyKnowledgeCoverageScopeClosureV3,
  knowledgeCoverageScopeClosurePromptV3,
  validateKnowledgeCoverageScopeClosureV3
} from "./coverageScopeClosureV3";
import {
  EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3,
  admitKnowledgeCorrectionV2,
  knowledgeCorrectionDeltaPromptV2,
  knowledgeCorrectionDeltaSchemaV2,
  knowledgeCorrectionOperationPlanV2,
  knowledgeCorrectionSupplementPromptV3,
  knowledgeCorrectionSupplementSchemaV3,
  mergeKnowledgeCorrectionDraftV3,
  validateKnowledgeCorrectionDeltaV2,
  validateKnowledgeCorrectionSupplementV3,
  type KnowledgeCorrectionSupplementV3
} from "./answerGroundingCorrectionV22";
import {
  KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V22,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V22,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22,
  createKnowledgeAnswerOperationRequestSnapshotV40,
  type KnowledgeAnswerOperationV40
} from "./answerGroundingSnapshotV40";
import { KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS } from "./answerGroundingSelectorV21";
import { KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS } from "./answerGroundingV21";
import { KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_MAX_OUTPUT_TOKENS } from "./coverageScopeClosureV2";
import { KnowledgeAnswerContractError } from "./grounding";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from "./groundingExecutionPolicy";
import type { KnowledgeCoverageLimitationsV1 } from "./searchFailure";
import { decodeKnowledgeContributionOperationFailureV1,
  knowledgeContributionOperationFailureV1 as failure } from "./answerGroundingOperationFailureV1";

export type KnowledgeContributionExecutionReceiptV1 = Readonly<{
  coverageLimitations: KnowledgeCoverageLimitationsV1;
  completeness: Readonly<{
    addedDimensionCount: number;
    initialDimensionCount: number;
    initialScopePayloadHash: string;
    payloadHash: string;
    status: "accepted";
  }>;
  closure: Readonly<{
    initialCoveredDimensionCount: number;
    initialExcludedDimensionCount: number;
    payloadHash: string;
    reopenedCoveredDimensionCount: number;
    reopenedDimensionCount: number;
    reopenedExcludedDimensionCount: number;
    status: "accepted";
  }> | null;
  correctionAccepted: boolean;
  coverage: Readonly<{
    coveredDimensionCount: number;
    excludedDimensionCount: number;
    missingDimensionCount: number;
    selectorPayloadHash: string;
    status: "accepted";
  }>;
  coverageScope: Readonly<{ dimensionCount: number; pendingRequirementCount: number;
    requestAnalysisIncomplete: boolean; payloadHash: string; status: "accepted" }>;
  draftClaimCount: number;
  publicationPlanHash: string;
}>;

function failureReason(value: unknown) {
  return decodeKnowledgeContributionOperationFailureV1(value)?.reason ?? null;
}
function providerFailure(error: unknown): Readonly<Record<string, unknown>> {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return failure(name === "timeouterror" || /timeout|deadline/u.test(message) ? "timeout"
    : /refusal|refused|safety/u.test(message) ? "refusal"
    : error instanceof TypeError || /network|transport|fetch/u.test(message) ? "transport" : "provider_error");
}
function operationRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

/** Runs after the immutable request/evidence-only Scope and completeness.
 * Every decision is reconstructed from accepted operations on replay. Optional
 * correction failures leave the last validated publication checkpoint intact. */
export async function executeKnowledgeAnswerContributionsV40(input: Readonly<{
  completeness: KnowledgeContributionExecutionReceiptV1["completeness"];
  execution: Parameters<typeof executeKnowledgeAnswerGroundingV21>[0];
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  operations: KnowledgeAnswerGroundingExecutionV21ScopeV6Result["operations"];
  primaryDraft: KnowledgeAnswerDraftSelectorInput;
  selectorInput: Omit<KnowledgeSelectorInputV22, "draft">;
}>): Promise<KnowledgeAnswerGroundingExecutionV21ScopeV6Result> {
  const operations = [...input.operations];
  const execution = input.execution;
  const selectorInput = { ...input.selectorInput, coverageLimitations: execution.draft.coverageLimitations, draft: input.primaryDraft,
    ...(execution.workflowVersion === 7 ? { literalClaimText: true as const } : {}) };
  const coverageScopePayloadHash = knowledgeAnswerHash(selectorInput.scope);
  const run = async (step: Readonly<{
    operation: KnowledgeAnswerOperationV40;
    contractVersion: number;
    maxOutputTokens: number;
    schema: Readonly<Record<string, unknown>>;
    prompt: Readonly<{ systemPrompt: string; userPrompt: string }>;
    accept(output: unknown): Readonly<Record<string, unknown>>;
  }>) => {
    if (operations.length >= 8) throw new Error("knowledge_answer_operation_limit_exceeded");
    const ordinal = (operations.length + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    const request = createKnowledgeAnswerOperationRequestSnapshotV40({
      ...step.prompt,
      ...(execution.workflowVersion !== undefined ? { workflowVersion: execution.workflowVersion } : {}),
      contractVersion: step.contractVersion,
      coverageScopePayloadHash,
      evidenceReceiptHash: execution.draft.manifestHash,
      executionPolicy: input.executionPolicy,
      maxOutputTokens: step.maxOutputTokens,
      operation: step.operation,
      schema: step.schema,
      transport: execution.transport
    });
    const operation = await acceptedOperation({
      acceptedFailure: providerFailure,
      acceptedOutput: step.accept,
      acceptedRequest: request,
      authorize: execution.authorize,
      draft: execution.draft,
      evidenceBindings: execution.evidenceBindings,
      execute: execution.execute,
      lifecycle: execution.lifecycle,
      modelRunId: execution.modelRunId,
      operation: step.operation,
      ordinal,
      recoveryProviderResponseId: execution.recoveryProviderResponseIds?.[ordinal],
      shouldAbort: execution.shouldAbort
    });
    operations.push(Object.freeze({ operation: step.operation, ordinal,
      providerResponseId: operation.providerResponseId, usage: operation.usage }));
    return operation.acceptedResult;
  };

  let selector: KnowledgeGroundedSelectorV22 | null = null;
  let selectorRepairReason: KnowledgeSelectorValidationFailureReason = "selector_malformed";
  for (const selectorPass of ["initial", "repair"] as const) {
    const output = await run({
      contractVersion: 22,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22,
      prompt: knowledgeGroundedSelectorPromptV22({
        ...selectorInput,
        ...(execution.workflowVersion !== undefined ? { workflowVersion: execution.workflowVersion } : {}),
        evidenceManifest: execution.draft.message,
        ...(selectorPass === "repair" ? { repairReason: selectorRepairReason } : {}),
        selectorPass
      }),
      schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V22,
      accept: (output) => {
        const validation = validateKnowledgeGroundedSelectorV22(output, selectorInput);
        return validation.kind === "accepted" ? knowledgeSelectorPayloadV22(validation.value) : failure("invalid_output", validation.reason);
      }
    });
    const reason = failureReason(output);
    if (reason) {
      if (reason !== "invalid_output") throw new Error("knowledge_grounded_selector_result_invalid");
      if (reason === "invalid_output" && selectorPass === "initial" && operations.length < 8 &&
        !isKnowledgeDraftMalformed(input.primaryDraft)) {
        selectorRepairReason = decodeKnowledgeContributionOperationFailureV1(output)?.validationReason ?? "selector_malformed";
        continue;
      }
      throw new KnowledgeAnswerContractError("knowledge_answer_contract_failed", "The Knowledge answer contributions could not be verified.");
    }
    const validation = validateKnowledgeGroundedSelectorV22(output, selectorInput);
    if (validation.kind !== "accepted") throw new KnowledgeAnswerContractError(
      "knowledge_answer_contract_failed", "The Knowledge answer contributions could not be verified.");
    selector = validation.value;
    break;
  }
  if (!selector) throw new KnowledgeAnswerContractError(
    "knowledge_answer_contract_failed", "The Knowledge answer contributions could not be verified.");
  let checkpoint: KnowledgePublicationInputV1 = { ...selectorInput, selector };
  let closureReceipt: KnowledgeContributionExecutionReceiptV1["closure"] = null;
  let correctionAccepted = false;

  if (selector.coverage.some(({ status }) => status !== "missing")) {
    let closureAccepted = false;
    for (const closurePass of ["initial", "repair"] as const) {
      if (operations.length >= 8) break;
      const prompt = knowledgeCoverageScopeClosurePromptV3({ ...checkpoint, closurePass,
        ...(closurePass === "repair" ? { repairReason: "coverage_scope_closure_shape_invalid" as const } : {}) });
      const output = await run({
        contractVersion: 3,
        maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3,
        prompt,
        schema: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V3,
        accept: (output) => {
          const validation = validateKnowledgeCoverageScopeClosureV3(output, checkpoint);
          return validation.kind === "accepted" ? operationRecord(validation.value) : failure("invalid_output");
        }
      });
      const reason = failureReason(output);
      if (reason) {
        if (reason === "invalid_output" && closurePass === "initial") continue;
        break;
      }
      const closure = validateKnowledgeCoverageScopeClosureV3(output, checkpoint);
      if (closure.kind !== "accepted") throw new Error("knowledge_coverage_scope_closure_unaccepted");
      const initialCoveredDimensionCount = selector.coverage.filter(({ status }) => status === "covered").length;
      const initialExcludedDimensionCount = selector.coverage.filter(({ status }) => status === "excluded").length;
      checkpoint = { ...checkpoint, selector: applyKnowledgeCoverageScopeClosureV3({ ...checkpoint, closure: closure.value }) };
      const reopenedCoveredDimensionCount = initialCoveredDimensionCount -
        checkpoint.selector.coverage.filter(({ status }) => status === "covered").length;
      const reopenedExcludedDimensionCount = initialExcludedDimensionCount -
        checkpoint.selector.coverage.filter(({ status }) => status === "excluded").length;
      closureReceipt = Object.freeze({ initialCoveredDimensionCount, initialExcludedDimensionCount,
        payloadHash: knowledgeAnswerHash(closure.value), reopenedCoveredDimensionCount, reopenedExcludedDimensionCount,
        reopenedDimensionCount: reopenedCoveredDimensionCount + reopenedExcludedDimensionCount, status: "accepted" });
      closureAccepted = true;
      break;
    }
    if (!closureAccepted) {
      // No accepted collective-completeness verdict. Keep the proven content
      // and reopen every unconfirmed dimension before deterministic settlement.
      const reopened = validateKnowledgeGroundedSelectorV22({
        ...knowledgeSelectorPayloadV22(checkpoint.selector),
        coverage: checkpoint.selector.coverage.map(({ id, contributionIds }) => ({ id, contributionIds, status: "missing" }))
      }, selectorInput);
      if (reopened.kind !== "accepted") throw new Error("knowledge_coverage_scope_closure_unaccepted");
      checkpoint = { ...checkpoint, selector: reopened.value };
    }
  }

  const admission = admitKnowledgeCorrectionV2(checkpoint);
  const plan = admission ? knowledgeCorrectionOperationPlanV2({ admission, operationCount: operations.length }) : null;
  if (admission && plan) {
    // Freeze this base for both attempts. Unverified supplemental text cannot
    // become a checkpoint, even if the following provider call is unavailable.
    const base = checkpoint;
    let supplement: KnowledgeCorrectionSupplementV3 = EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3;
    if (plan === "supplement_and_mapping") {
      const output = await run({
        contractVersion: 22,
        maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V22,
        prompt: knowledgeCorrectionSupplementPromptV3(base),
        schema: knowledgeCorrectionSupplementSchemaV3(admission),
        accept: (output) => validateKnowledgeCorrectionSupplementV3(output, {
          ...base, forbiddenIdentityFragments: execution.forbiddenIdentityFragments
        }).kind === "accepted" ? operationRecord(output) : failure("invalid_output")
      });
      if (!failureReason(output)) {
        const validation = validateKnowledgeCorrectionSupplementV3(output, {
          ...base, forbiddenIdentityFragments: execution.forbiddenIdentityFragments
        });
        if (validation.kind !== "accepted") throw new Error("knowledge_correction_supplement_invalid");
        supplement = validation.value;
      }
    }
    const correction = { ...base, supplement };
    for (const deltaPass of ["initial", "repair"] as const) {
      if (operations.length >= 8) break;
      const prompt = knowledgeCorrectionDeltaPromptV2(correction);
      const output = await run({
        contractVersion: 22,
        maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V22,
        prompt: { ...prompt, userPrompt: JSON.stringify({ deltaPass, input: JSON.parse(prompt.userPrompt) as unknown }) },
        schema: knowledgeCorrectionDeltaSchemaV2(correction),
        accept: (output) => validateKnowledgeCorrectionDeltaV2(output, correction).kind === "accepted"
          ? operationRecord(output) : failure("invalid_output")
      });
      const reason = failureReason(output);
      if (reason) {
        if (reason === "invalid_output" && deltaPass === "initial") continue;
        break;
      }
      const validation = validateKnowledgeCorrectionDeltaV2(output, correction);
      if (validation.kind !== "accepted") throw new Error("knowledge_correction_delta_invalid");
      checkpoint = { ...base, draft: mergeKnowledgeCorrectionDraftV3(correction), selector: validation.selector };
      correctionAccepted = true;
      break;
    }
  }
  const publicationPlan = buildKnowledgePublicationPlanV1(checkpoint);
  return Object.freeze({
    contributionReceipt: Object.freeze({
      coverageLimitations: publicationPlan.coverageLimitations,
      completeness: input.completeness,
      closure: closureReceipt,
      correctionAccepted,
      coverage: Object.freeze({
        coveredDimensionCount: checkpoint.selector.coverage.filter(({ status }) => status === "covered").length,
        excludedDimensionCount: checkpoint.selector.coverage.filter(({ status }) => status === "excluded").length,
        missingDimensionCount: checkpoint.selector.coverage.filter(({ status }) => status === "missing").length,
        selectorPayloadHash: knowledgeAnswerHash(knowledgeSelectorPayloadV22(checkpoint.selector)),
        status: "accepted" as const
      }),
      coverageScope: Object.freeze({ dimensionCount: checkpoint.scope.scope.length,
        pendingRequirementCount: publicationPlan.overflow.pending.length,
        requestAnalysisIncomplete: publicationPlan.overflow.unparsedRemainder,
        payloadHash: coverageScopePayloadHash, status: "accepted" as const }),
      draftClaimCount: isKnowledgeDraftMalformed(checkpoint.draft) ? 0 : checkpoint.draft.claims.length,
      publicationPlanHash: knowledgeAnswerHash(publicationPlan)
    }),
    contracts: KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1,
    crossTargetExactRepeatCount: 0,
    operations: Object.freeze(operations),
    settlement: renderKnowledgePublicationPlanV1({ ...checkpoint, plan: publicationPlan,
      ...(execution.workflowVersion !== undefined ? { labelVersion: execution.workflowVersion === 7 ? 3 as const : 2 as const } : {}) })
  });
}
