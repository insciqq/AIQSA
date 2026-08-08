import type { ErrorResponse, SessionErrorCode } from "./http";
import { decodeThreadToolActivity, type ThreadToolActivity } from "./toolActivity";
import { decodeKnowledgePlan, type KnowledgePlan } from "./knowledge";

export type RunEventView = {
  data: unknown;
  type: string;
};

export type ModelRunEventProjection = {
  eventType: string;
  payload: unknown;
  sequence: number;
};

export type ModelRunStatus =
  | "cancelled"
  | "complete"
  | "error"
  | "in_progress"
  | "queued"
  | "streaming";

/**
 * The client-visible model-run fields. Persistence adapters may return
 * additional inspection fields without making them part of the wire contract.
 */
export type ModelRunAssistantProvenance = {
  assistantId: string;
  name: string;
  revisionNumber: number;
};

export type KnowledgeRunBindingProjection = {
  baseContentRevision: number;
  embeddingConnectionId: string;
  embeddingCredentialSource: "default" | "group" | "user";
  embeddingProviderModelId: string;
  indexedContentRevision: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  ordinal: number;
  targetDimension: number;
  vectorSpaceFingerprint: string;
};

export type KnowledgeRunProjection = {
  baseEvidence: unknown[];
  candidateCount: number;
  candidateLimit: number;
  createdAt: string;
  durationMs: number;
  embeddingUsage: unknown[];
  failureCode: string | null;
  fusion: "rrf_k60";
  id: string;
  invocationOrdinal: number;
  modelRunToolCallId: string;
  outcome:
    | "base_empty"
    | "base_indexing"
    | "complete"
    | "embedding_model_unavailable"
    | "zero_above_threshold";
  postRerankOrder: unknown | null;
  preRerankOrder: unknown | null;
  providerText: string;
  query: string;
  rerankerBinding: unknown | null;
  resultLimit: number;
  results: unknown[];
  threshold: number;
};

export type ModelRunResponseProjection = {
  assistant?: ModelRunAssistantProvenance | null;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  errorPayload: unknown;
  estimatedCostMicros: number | null;
  events: ModelRunEventProjection[];
  id: string;
  inputTokens: number;
  knowledgeBindings?: KnowledgeRunBindingProjection[];
  knowledgePlan?: KnowledgePlan;
  knowledgeRuns?: KnowledgeRunProjection[];
  modelId: string;
  outputTokens: number;
  provider: string;
  reasoningTokens: number;
  searchRuns: unknown[];
  status: ModelRunStatus;
  toolCalls: ThreadToolActivity[];
  totalTokens: number;
};

export type PersistedRun = ModelRunResponseProjection;

export type GetModelRunResponse = {
  run: ModelRunResponseProjection;
};

export type CancelModelRunProjection = {
  id: string;
  providerCancelPreview?: Record<string, unknown>;
  providerResponseId?: string | null;
  status: ModelRunStatus;
};

export type CancelModelRunSuccessResponse = {
  run: CancelModelRunProjection & {
    status: "cancelled";
  };
};

export type CancelModelRunNotCancelableResponse = {
  error: "model_run_not_cancelable";
  run: CancelModelRunProjection;
};

export type CancelModelRunResponse =
  | CancelModelRunSuccessResponse
  | CancelModelRunNotCancelableResponse;

export type DecodedCancelModelRunResponse =
  | {
      kind: "cancelled";
      run: CancelModelRunProjection & {
        status: "cancelled";
      };
    }
  | {
      kind: "not_cancelled";
      run: CancelModelRunProjection;
    };

export type ModelRunServerErrorCode =
  | SessionErrorCode
  | "model_run_not_cancelable"
  | "model_run_not_found";

export type ModelRunErrorResponse = ErrorResponse<ModelRunServerErrorCode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function modelRunStatus(value: unknown): ModelRunStatus | null {
  return value === "cancelled" ||
    value === "complete" ||
    value === "error" ||
    value === "in_progress" ||
    value === "queued" ||
    value === "streaming"
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function decodeKnowledgeRunBinding(value: unknown): KnowledgeRunBindingProjection | null {
  if (!isRecord(value)) return null;
  const baseContentRevision = nonNegativeInteger(value.baseContentRevision);
  const indexedContentRevision = nonNegativeInteger(value.indexedContentRevision);
  const ordinal = nonNegativeInteger(value.ordinal);
  const targetDimension = nonNegativeInteger(value.targetDimension);
  const knowledgeBaseId = nonEmptyString(value.knowledgeBaseId);
  const indexGenerationId = nonEmptyString(value.indexGenerationId);
  const vectorSpaceFingerprint = nonEmptyString(value.vectorSpaceFingerprint);
  const embeddingConnectionId = nonEmptyString(value.embeddingConnectionId);
  const embeddingProviderModelId = nonEmptyString(value.embeddingProviderModelId);
  if (
    baseContentRevision === null ||
    indexedContentRevision === null ||
    ordinal === null ||
    ordinal > 2 ||
    (targetDimension !== 1024 && targetDimension !== 1536) ||
    !knowledgeBaseId ||
    !indexGenerationId ||
    !/^[0-9a-f]{64}$/u.test(vectorSpaceFingerprint ?? "") ||
    !embeddingConnectionId ||
    !embeddingProviderModelId ||
    (value.embeddingCredentialSource !== "default" &&
      value.embeddingCredentialSource !== "group" &&
      value.embeddingCredentialSource !== "user")
  ) {
    return null;
  }
  return {
    baseContentRevision,
    embeddingConnectionId,
    embeddingCredentialSource: value.embeddingCredentialSource,
    embeddingProviderModelId,
    indexedContentRevision,
    indexGenerationId,
    knowledgeBaseId,
    ordinal,
    targetDimension,
    vectorSpaceFingerprint: vectorSpaceFingerprint!
  };
}

function decodeKnowledgeRun(value: unknown): KnowledgeRunProjection | null {
  if (!isRecord(value) || !Array.isArray(value.baseEvidence) ||
    !Array.isArray(value.embeddingUsage) || !Array.isArray(value.results)) return null;
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const candidateLimit = nonNegativeInteger(value.candidateLimit);
  const durationMs = nonNegativeInteger(value.durationMs);
  const id = nonEmptyString(value.id);
  const invocationOrdinal = nonNegativeInteger(value.invocationOrdinal);
  const modelRunToolCallId = nonEmptyString(value.modelRunToolCallId);
  const resultLimit = nonNegativeInteger(value.resultLimit);
  const threshold = finiteNumber(value.threshold);
  const outcome = value.outcome === "base_empty" || value.outcome === "base_indexing" ||
    value.outcome === "complete" || value.outcome === "embedding_model_unavailable" ||
    value.outcome === "zero_above_threshold"
    ? value.outcome
    : null;
  if (
    !id || invocationOrdinal === null || invocationOrdinal < 1 || invocationOrdinal > 3 ||
    !modelRunToolCallId || typeof value.createdAt !== "string" ||
    candidateCount === null || candidateLimit === null || candidateLimit < 1 ||
    durationMs === null || value.failureCode !== null && typeof value.failureCode !== "string" ||
    value.fusion !== "rrf_k60" || !outcome || typeof value.providerText !== "string" ||
    !value.providerText || typeof value.query !== "string" || !value.query ||
    resultLimit === null || resultLimit < 1 || resultLimit > 8 || threshold === null ||
    threshold < 0 || threshold > 1 || value.baseEvidence.length < 1 ||
    value.baseEvidence.length > 3 || value.embeddingUsage.length > 3 || value.results.length > 8
  ) return null;
  return {
    baseEvidence: value.baseEvidence,
    candidateCount,
    candidateLimit,
    createdAt: value.createdAt,
    durationMs,
    embeddingUsage: value.embeddingUsage,
    failureCode: value.failureCode as string | null,
    fusion: "rrf_k60",
    id,
    invocationOrdinal,
    modelRunToolCallId,
    outcome,
    postRerankOrder: value.postRerankOrder ?? null,
    preRerankOrder: value.preRerankOrder ?? null,
    providerText: value.providerText,
    query: value.query,
    rerankerBinding: value.rerankerBinding ?? null,
    resultLimit,
    results: value.results,
    threshold
  };
}

export function decodeCancelModelRunResponse(
  value: unknown
): DecodedCancelModelRunResponse | null {
  if (!isRecord(value) || !isRecord(value.run)) {
    return null;
  }

  const id = nonEmptyString(value.run.id);
  const status = modelRunStatus(value.run.status);
  if (!id || !status) {
    return null;
  }

  if (!("error" in value)) {
    return status === "cancelled"
      ? {
          kind: "cancelled",
          run: {
            id,
            status
          }
        }
      : null;
  }

  if (value.error !== "model_run_not_cancelable") {
    return null;
  }

  return {
    kind: "not_cancelled",
    run: {
      id,
      status
    }
  };
}

export function decodeGetModelRunResponse(value: unknown): PersistedRun | null {
  if (!isRecord(value) || !isRecord(value.run)) {
    return null;
  }

  const run = value.run;
  if (!Array.isArray(run.events) || !Array.isArray(run.toolCalls)) {
    return null;
  }

  const id = nonEmptyString(run.id);
  const inputTokens = finiteNumber(run.inputTokens);
  const modelId = nonEmptyString(run.modelId);
  const provider = nonEmptyString(run.provider);
  const status = modelRunStatus(run.status);
  if (!id || inputTokens === null || !modelId || !provider || !status) {
    return null;
  }

  const events: ModelRunEventProjection[] = [];
  for (const event of run.events) {
    if (!isRecord(event)) {
      return null;
    }

    const eventType = nonEmptyString(event.eventType);
    const sequence = finiteNumber(event.sequence);
    if (!eventType || sequence === null) {
      return null;
    }

    events.push({
      eventType,
      payload: event.payload,
      sequence
    });
  }

  const toolCalls = run.toolCalls.map(decodeThreadToolActivity);
  if (toolCalls.some((toolCall) => toolCall === null)) {
    return null;
  }
  const decodedKnowledgePlan = decodeKnowledgePlan(run.knowledgePlan);
  const knowledgeBindingsInput = run.knowledgeBindings ?? [];
  if (
    !decodedKnowledgePlan.ok ||
    !Array.isArray(knowledgeBindingsInput) ||
    knowledgeBindingsInput.length !== decodedKnowledgePlan.plan.baseIds.length
  ) {
    return null;
  }
  const knowledgeBindings = knowledgeBindingsInput.map(decodeKnowledgeRunBinding);
  if (
    knowledgeBindings.some((binding) => binding === null) ||
    knowledgeBindings.some((binding, index) =>
      binding?.ordinal !== index ||
      binding.knowledgeBaseId !== decodedKnowledgePlan.plan.baseIds[index])
  ) {
    return null;
  }
  const knowledgeRunsInput = run.knowledgeRuns ?? [];
  if (!Array.isArray(knowledgeRunsInput) || knowledgeRunsInput.length > 3) return null;
  const knowledgeRuns = knowledgeRunsInput.map(decodeKnowledgeRun);
  if (knowledgeRuns.some((receipt) => receipt === null)) return null;
  const decodedKnowledgeRuns = knowledgeRuns.filter(
    (receipt): receipt is KnowledgeRunProjection => receipt !== null
  );
  if (decodedKnowledgeRuns.some((receipt, index) =>
    index > 0 && receipt.invocationOrdinal <= decodedKnowledgeRuns[index - 1]!.invocationOrdinal)) {
    return null;
  }

  let assistant: ModelRunAssistantProvenance | null = null;
  if (run.assistant !== undefined && run.assistant !== null) {
    const candidate = isRecord(run.assistant) ? run.assistant : null;
    const assistantId = candidate ? nonEmptyString(candidate.assistantId) : null;
    const assistantName = candidate ? nonEmptyString(candidate.name) : null;
    const revisionNumber = candidate?.revisionNumber;
    if (
      !assistantId ||
      !assistantName ||
      typeof revisionNumber !== "number" ||
      !Number.isInteger(revisionNumber) ||
      revisionNumber < 1
    ) {
      return null;
    }
    assistant = {
      assistantId,
      name: assistantName,
      revisionNumber
    };
  }

  const cachedInputTokens = finiteNumber(run.cachedInputTokens) ?? 0;
  const cacheWriteInputTokens = finiteNumber(run.cacheWriteInputTokens) ?? 0;
  const estimatedCostMicros = finiteNumber(run.estimatedCostMicros);
  const outputTokens = finiteNumber(run.outputTokens) ?? 0;
  const reasoningTokens = finiteNumber(run.reasoningTokens) ?? 0;
  const totalTokens = finiteNumber(run.totalTokens) ?? inputTokens + outputTokens;

  return {
    assistant,
    cachedInputTokens,
    cacheWriteInputTokens,
    errorPayload: run.errorPayload,
    estimatedCostMicros:
      estimatedCostMicros !== null && estimatedCostMicros > 0 ? estimatedCostMicros : null,
    events,
    id,
    inputTokens,
    knowledgeBindings: knowledgeBindings.filter(
      (binding): binding is KnowledgeRunBindingProjection => binding !== null
    ),
    knowledgePlan: decodedKnowledgePlan.plan,
    knowledgeRuns: decodedKnowledgeRuns,
    modelId,
    outputTokens,
    provider,
    reasoningTokens,
    searchRuns: Array.isArray(run.searchRuns) ? run.searchRuns : [],
    status,
    toolCalls: toolCalls.filter((toolCall): toolCall is ThreadToolActivity => toolCall !== null),
    totalTokens
  };
}
