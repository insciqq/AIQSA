import { acceptedOperation } from "./answerGroundingExecutionV21";
import type { executeKnowledgeAnswerGroundingV21, KnowledgeAnswerGroundingExecutionV21ScopeV6Result } from "./answerGroundingExecutionV21ScopeV6";
import type { KnowledgeContributionExecutionReceiptV1 } from "./answerGroundingExecutionV40";
import { createKnowledgeAnswerOperationRequestSnapshotV40 } from "./answerGroundingSnapshotV40";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import {
  KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS, decodeKnowledgeCoverageScopeFailureV6,
  isKnowledgeCoverageScopeValidationFailureReasonV6, knowledgeCoverageEvidenceFromManifestV6,
  knowledgeCoverageScopeFailureV6, type KnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_MAX_OUTPUT_TOKENS, decodeKnowledgeCoverageScopeCompletenessFailureV1,
  isKnowledgeCoverageScopeCompletenessValidationFailureReasonV1, knowledgeCoverageScopeCompletenessFailureV1,
  type KnowledgeCoverageScopeCompletenessValidationFailureReasonV1
} from "./coverageScopeCompletenessV1";
import { resolveKnowledgeCoverageRequestAnchorIdsV1 } from "./coverageScopeRequestAnchorIdsV1";
import { knowledgeCoverageScopePromptV7, knowledgeCoverageScopeCompletenessPromptV2 } from "./coverageScopePromptV7";
import {
  KNOWLEDGE_COVERAGE_SCOPE_OPERATION_V7, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION_V2,
  KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V7, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V2,
  validateKnowledgeCoverageScopeV7, validateKnowledgeCoverageScopeCompletenessV2, type KnowledgeCoverageScopeV7
} from "./coverageScopeV7";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from "./groundingExecutionPolicy";

function providerFailureSuffix(error: unknown) {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return name === "timeouterror" || /timeout|deadline/u.test(message) ? "timeout"
    : /refusal|refused|safety/u.test(message) ? "refusal"
    : error instanceof TypeError || /network|transport|fetch/u.test(message) ? "transport_failure" : "provider_error";
}

/** Current request/evidence-only decomposition. Repairs are fresh bounded
 * outputs; replay needs only the immutable accepted operations, never rejected
 * transient payloads. Scope and Completeness each allow one structural repair. */
export async function executeKnowledgeCoverageScopeV7(input: Readonly<{
  execution: Parameters<typeof executeKnowledgeAnswerGroundingV21>[0];
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  operations: KnowledgeAnswerGroundingExecutionV21ScopeV6Result["operations"];
}>): Promise<Readonly<{
  completeness: KnowledgeContributionExecutionReceiptV1["completeness"];
  operations: KnowledgeAnswerGroundingExecutionV21ScopeV6Result["operations"];
  scope: KnowledgeCoverageScopeV7;
}>> {
  const execution = input.execution;
  const operations = [...input.operations];
  const evidence = knowledgeCoverageEvidenceFromManifestV6(execution.draft);
  const validationInput = { evidence, request: execution.request };
  const run = async (step: Readonly<{
    accept(output: unknown): Readonly<Record<string, unknown>>;
    failure(error: unknown): Readonly<Record<string, unknown>>;
    contractVersion: 2 | 7;
    coverageScopePayloadHash?: string;
    maxOutputTokens: number;
    operation: typeof KNOWLEDGE_COVERAGE_SCOPE_OPERATION_V7 | typeof KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION_V2;
    prompt: Readonly<{ systemPrompt: string; userPrompt: string }>;
    schema: Readonly<Record<string, unknown>>;
  }>) => {
    if (operations.length >= 8) throw new Error("knowledge_answer_operation_limit_exceeded");
    const ordinal = (operations.length + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    const acceptedRequest = createKnowledgeAnswerOperationRequestSnapshotV40({ ...step.prompt,
      contractVersion: step.contractVersion, coverageScopePayloadHash: step.coverageScopePayloadHash ?? null,
      evidenceReceiptHash: execution.draft.manifestHash, executionPolicy: input.executionPolicy,
      maxOutputTokens: step.maxOutputTokens, operation: step.operation, schema: step.schema, transport: execution.transport });
    const result = await acceptedOperation({ acceptedFailure: step.failure,
      acceptedOutput: (output) => step.accept(resolveKnowledgeCoverageRequestAnchorIdsV1(output, execution.request)),
      acceptedRequest, authorize: execution.authorize, draft: execution.draft,
      evidenceBindings: execution.evidenceBindings, execute: execution.execute, lifecycle: execution.lifecycle,
      modelRunId: execution.modelRunId, operation: step.operation, ordinal,
      recoveryProviderResponseId: execution.recoveryProviderResponseIds?.[ordinal], shouldAbort: execution.shouldAbort });
    operations.push(Object.freeze({ operation: step.operation, ordinal, providerResponseId: result.providerResponseId, usage: result.usage }));
    return result.acceptedResult;
  };
  const runScope = (repairReason?: KnowledgeCoverageScopeValidationFailureReasonV6) => run({
    contractVersion: 7, maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_COVERAGE_SCOPE_OPERATION_V7, schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V7,
    prompt: knowledgeCoverageScopePromptV7({ ...validationInput, evidenceManifest: execution.draft.message,
      scopePass: repairReason ? "repair" : "initial", ...(repairReason ? { repairReason } : {}) }),
    failure: (error) => knowledgeCoverageScopeFailureV6(`coverage_scope_${providerFailureSuffix(error)}`),
    accept: (output) => {
      const validation = validateKnowledgeCoverageScopeV7(output, validationInput);
      return validation.kind === "accepted" ? output as Readonly<Record<string, unknown>> : knowledgeCoverageScopeFailureV6(validation.reason);
    }
  });
  let scopeOutput = await runScope();
  const scopeFailure = decodeKnowledgeCoverageScopeFailureV6(scopeOutput);
  if (scopeFailure && isKnowledgeCoverageScopeValidationFailureReasonV6(scopeFailure.reason)) scopeOutput = await runScope(scopeFailure.reason);
  const acceptedScope = validateKnowledgeCoverageScopeV7(scopeOutput, validationInput);
  if (acceptedScope.kind !== "accepted") throw new Error("knowledge_coverage_scope_unaccepted");
  const scope = acceptedScope.value;
  const initialScopePayloadHash = knowledgeAnswerHash(scope);
  const completenessInput = { ...validationInput, acceptedScope: scope };
  const runCompleteness = (repairReason?: KnowledgeCoverageScopeCompletenessValidationFailureReasonV1) => run({
    contractVersion: 2, coverageScopePayloadHash: initialScopePayloadHash,
    maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_MAX_OUTPUT_TOKENS,
    operation: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION_V2, schema: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V2,
    prompt: knowledgeCoverageScopeCompletenessPromptV2({ ...completenessInput, evidenceManifest: execution.draft.message,
      completenessPass: repairReason ? "repair" : "initial", ...(repairReason ? { repairReason } : {}) }),
    failure: (error) => knowledgeCoverageScopeCompletenessFailureV1(`coverage_scope_completeness_${providerFailureSuffix(error)}`),
    accept: (output) => {
      const validation = validateKnowledgeCoverageScopeCompletenessV2(output, completenessInput);
      return validation.kind === "accepted" ? output as Readonly<Record<string, unknown>> : knowledgeCoverageScopeCompletenessFailureV1(validation.reason);
    }
  });
  let completenessOutput = await runCompleteness();
  const completenessFailure = decodeKnowledgeCoverageScopeCompletenessFailureV1(completenessOutput);
  if (completenessFailure && isKnowledgeCoverageScopeCompletenessValidationFailureReasonV1(completenessFailure.reason)) {
    completenessOutput = await runCompleteness(completenessFailure.reason);
  }
  const complete = validateKnowledgeCoverageScopeCompletenessV2(completenessOutput, completenessInput);
  if (complete.kind !== "accepted") throw new Error("knowledge_coverage_scope_completeness_unaccepted");
  return Object.freeze({ completeness: Object.freeze({ addedDimensionCount: complete.additionCount,
    initialDimensionCount: scope.scope.length, initialScopePayloadHash,
    payloadHash: knowledgeAnswerHash(completenessOutput), status: "accepted" }),
  operations: Object.freeze(operations), scope: complete.scope });
}
