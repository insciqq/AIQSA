import type { ErrorResponse, SessionErrorCode } from "./http";
import { decodeThreadToolActivity, type ThreadToolActivity } from "./toolActivity";
import { decodeKnowledgePlan, type KnowledgePlan } from "./knowledge";
import {
  decodeMemoryActionFeedback,
  decodeMemoryReceipt,
  type MemoryActionFeedback,
  type MemoryReceipt
} from "./memory";

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

export type ModelRunInspectionParameter = Readonly<{
  name:
    | "background"
    | "max_output_tokens"
    | "reasoning_effort"
    | "reasoning_mode"
    | "stream"
    | "temperature";
  value: boolean | number | string;
}>;

export type ModelRunInspectionMcpServer = Readonly<{
  externalAccountLabel: string | null;
  name: string;
  toolNames: readonly string[];
}>;

/**
 * Positive, content-free inspection facts computed from the exact accepted
 * request. Raw normalized request content, ids, schemas, fingerprints,
 * endpoints, credentials, and provider payloads are deliberately absent.
 */
export type ModelRunInspectionProjection = Readonly<{
  acceptedAt: string;
  answerMessageId: string | null;
  attachmentCount: number;
  branchMessageCount: number;
  firstPartyTools: readonly string[];
  knowledgeBaseCount: number;
  mcpServers: readonly ModelRunInspectionMcpServer[];
  memoryContextItemCount: number;
  parameters: readonly ModelRunInspectionParameter[];
  searchBindings: readonly Readonly<{ displayName: string }>[];
  searchMode: "all_selected" | "model_choice" | null;
  toolMode: "auto" | "none";
}>;

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

export type KnowledgeRunBaseEvidenceProjection = {
  baseContentRevision: number;
  baseName: string;
  candidateCount: number;
  indexedContentRevision: number;
  knowledgeBaseId: string;
  ordinal: number;
  state: "empty" | "indexing" | "ready";
};

export type KnowledgeRunResultProjection = {
  baseName: string;
  bindingOrdinal: number;
  documentVersionNumber?: number;
  fileName: string;
  fusedScore: number;
  handle: string;
  includedText: string;
  includedTextBytes: number;
  knowledgeBaseId: string;
  page: number;
  sourceTextBytes: number;
  textTruncated: boolean;
};

export type KnowledgeRunProjection = {
  baseEvidence: KnowledgeRunBaseEvidenceProjection[];
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
  results: KnowledgeRunResultProjection[];
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
  inspection?: ModelRunInspectionProjection;
  knowledgeBindings?: KnowledgeRunBindingProjection[];
  knowledgePlan?: KnowledgePlan;
  knowledgeRuns?: KnowledgeRunProjection[];
  memoryAction?: MemoryActionFeedback;
  memoryReceipt?: MemoryReceipt;
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

function boundedInspectionLabel(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(label)
    ? label
    : null;
}

function decodeModelRunInspectionParameter(
  value: unknown
): ModelRunInspectionParameter | null {
  if (!isRecord(value)) return null;
  const names = new Set<ModelRunInspectionParameter["name"]>([
    "background",
    "max_output_tokens",
    "reasoning_effort",
    "reasoning_mode",
    "stream",
    "temperature"
  ]);
  if (typeof value.name !== "string" || !names.has(value.name as ModelRunInspectionParameter["name"])) {
    return null;
  }
  if (
    typeof value.value !== "boolean" &&
    typeof value.value !== "string" &&
    (typeof value.value !== "number" || !Number.isFinite(value.value))
  ) return null;
  if (typeof value.value === "string" && !boundedInspectionLabel(value.value, 80)) return null;
  return {
    name: value.name as ModelRunInspectionParameter["name"],
    value: value.value
  };
}

function decodeModelRunInspection(value: unknown): ModelRunInspectionProjection | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.firstPartyTools) ||
    !Array.isArray(value.mcpServers) ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.searchBindings)
  ) return null;
  const acceptedAt = boundedInspectionLabel(value.acceptedAt, 64);
  const answerMessageId = value.answerMessageId === null
    ? null
    : boundedInspectionLabel(value.answerMessageId, 512);
  const attachmentCount = nonNegativeInteger(value.attachmentCount);
  const branchMessageCount = nonNegativeInteger(value.branchMessageCount);
  const knowledgeBaseCount = nonNegativeInteger(value.knowledgeBaseCount);
  const memoryContextItemCount = nonNegativeInteger(value.memoryContextItemCount);
  if (
    !acceptedAt || Number.isNaN(Date.parse(acceptedAt)) ||
    (value.answerMessageId !== null && !answerMessageId) ||
    attachmentCount === null || attachmentCount > 20 ||
    branchMessageCount === null || branchMessageCount > 10_000 ||
    knowledgeBaseCount === null || knowledgeBaseCount > 3 ||
    memoryContextItemCount === null || memoryContextItemCount > 50 ||
    value.firstPartyTools.length > 4 ||
    value.mcpServers.length > 16 ||
    value.parameters.length > 6 ||
    value.searchBindings.length > 3 ||
    (value.searchMode !== null &&
      value.searchMode !== "all_selected" && value.searchMode !== "model_choice") ||
    (value.toolMode !== "auto" && value.toolMode !== "none")
  ) return null;
  const firstPartyTools = value.firstPartyTools.map((label) => boundedInspectionLabel(label));
  if (firstPartyTools.some((label) => label === null) ||
    new Set(firstPartyTools).size !== firstPartyTools.length) return null;
  const parameters = value.parameters.map(decodeModelRunInspectionParameter);
  if (parameters.some((parameter) => parameter === null) ||
    new Set(parameters.map((parameter) => parameter?.name)).size !== parameters.length) return null;
  const searchBindings = value.searchBindings.map((binding) => {
    if (!isRecord(binding)) return null;
    const displayName = boundedInspectionLabel(binding.displayName);
    return displayName ? { displayName } : null;
  });
  if (searchBindings.some((binding) => binding === null)) return null;
  const mcpServers = value.mcpServers.map((server): ModelRunInspectionMcpServer | null => {
    if (!isRecord(server) || !Array.isArray(server.toolNames) || server.toolNames.length > 128) {
      return null;
    }
    const name = boundedInspectionLabel(server.name);
    const externalAccountLabel = server.externalAccountLabel === null
      ? null
      : boundedInspectionLabel(server.externalAccountLabel);
    const toolNames = server.toolNames.map((toolName) => boundedInspectionLabel(toolName));
    if (!name || (server.externalAccountLabel !== null && !externalAccountLabel) ||
      toolNames.some((toolName) => toolName === null) ||
      new Set(toolNames).size !== toolNames.length) return null;
    return {
      externalAccountLabel,
      name,
      toolNames: toolNames as string[]
    };
  });
  if (mcpServers.some((server) => server === null)) return null;
  return {
    acceptedAt,
    answerMessageId,
    attachmentCount,
    branchMessageCount,
    firstPartyTools: firstPartyTools as string[],
    knowledgeBaseCount,
    mcpServers: mcpServers as ModelRunInspectionMcpServer[],
    memoryContextItemCount,
    parameters: parameters as ModelRunInspectionParameter[],
    searchBindings: searchBindings as { displayName: string }[],
    searchMode: value.searchMode as ModelRunInspectionProjection["searchMode"],
    toolMode: value.toolMode
  };
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

function decodeKnowledgeRunBaseEvidence(
  value: unknown
): KnowledgeRunBaseEvidenceProjection | null {
  if (!isRecord(value)) return null;
  const baseContentRevision = nonNegativeInteger(value.baseContentRevision);
  const baseName = nonEmptyString(value.baseName);
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const indexedContentRevision = nonNegativeInteger(value.indexedContentRevision);
  const knowledgeBaseId = nonEmptyString(value.knowledgeBaseId);
  const ordinal = nonNegativeInteger(value.ordinal);
  const state = value.state === "empty" || value.state === "indexing" || value.state === "ready"
    ? value.state
    : null;
  if (
    baseContentRevision === null || !baseName || candidateCount === null ||
    indexedContentRevision === null || !knowledgeBaseId || ordinal === null || ordinal > 2 ||
    !state
  ) return null;
  return {
    baseContentRevision,
    baseName,
    candidateCount,
    indexedContentRevision,
    knowledgeBaseId,
    ordinal,
    state
  };
}

function decodeKnowledgeRunResult(value: unknown): KnowledgeRunResultProjection | null {
  if (!isRecord(value)) return null;
  const baseName = nonEmptyString(value.baseName);
  const bindingOrdinal = nonNegativeInteger(value.bindingOrdinal);
  const documentVersionNumber = value.documentVersionNumber === undefined
    ? undefined
    : nonNegativeInteger(value.documentVersionNumber);
  const fileName = nonEmptyString(value.fileName);
  const fusedScore = finiteNumber(value.fusedScore);
  const handle = nonEmptyString(value.handle);
  const includedTextBytes = nonNegativeInteger(value.includedTextBytes);
  const knowledgeBaseId = nonEmptyString(value.knowledgeBaseId);
  const page = nonNegativeInteger(value.page);
  const sourceTextBytes = nonNegativeInteger(value.sourceTextBytes);
  if (
    !baseName || bindingOrdinal === null || bindingOrdinal > 2 ||
    (documentVersionNumber !== undefined &&
      (documentVersionNumber === null || documentVersionNumber < 1)) ||
    !fileName || fusedScore === null || fusedScore < 0 || !handle ||
    !/^K[1-3]\.[1-8]$/u.test(handle) || typeof value.includedText !== "string" ||
    includedTextBytes === null || !knowledgeBaseId || page === null || page < 1 ||
    sourceTextBytes === null || sourceTextBytes < includedTextBytes ||
    typeof value.textTruncated !== "boolean" ||
    value.textTruncated !== (includedTextBytes < sourceTextBytes)
  ) return null;
  return {
    baseName,
    bindingOrdinal,
    ...(documentVersionNumber !== undefined && documentVersionNumber !== null
      ? { documentVersionNumber }
      : {}),
    fileName,
    fusedScore,
    handle,
    includedText: value.includedText,
    includedTextBytes,
    knowledgeBaseId,
    page,
    sourceTextBytes,
    textTruncated: value.textTruncated
  };
}

export function decodeKnowledgeRunProjection(value: unknown): KnowledgeRunProjection | null {
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
  const baseEvidence = value.baseEvidence.map(decodeKnowledgeRunBaseEvidence);
  const results = value.results.map(decodeKnowledgeRunResult);
  if (
    !id || invocationOrdinal === null || invocationOrdinal < 1 || invocationOrdinal > 3 ||
    !modelRunToolCallId || typeof value.createdAt !== "string" ||
    candidateCount === null || candidateLimit === null || candidateLimit < 1 || candidateLimit > 100 ||
    durationMs === null || value.failureCode !== null && typeof value.failureCode !== "string" ||
    value.fusion !== "rrf_k60" || !outcome || typeof value.providerText !== "string" ||
    !value.providerText || typeof value.query !== "string" || !value.query ||
    resultLimit === null || resultLimit < 1 || resultLimit > 8 ||
    candidateLimit < resultLimit || threshold === null ||
    threshold < 0 || threshold > 1 || value.baseEvidence.length < 1 ||
    value.baseEvidence.length > 3 || value.embeddingUsage.length > 3 || value.results.length > 8 ||
    baseEvidence.some((base) => base === null) || results.some((result) => result === null) ||
    value.preRerankOrder !== null || value.postRerankOrder !== null || value.rerankerBinding !== null
  ) return null;
  const decodedBaseEvidence = baseEvidence.filter(
    (base): base is KnowledgeRunBaseEvidenceProjection => base !== null
  );
  const decodedResults = results.filter(
    (result): result is KnowledgeRunResultProjection => result !== null
  );
  const completed = outcome === "base_empty" || outcome === "complete" ||
    outcome === "zero_above_threshold";
  if (
    decodedBaseEvidence.some((base, index) => base.ordinal !== index) ||
    decodedBaseEvidence.some((base) => base.state !== (
      base.indexedContentRevision < base.baseContentRevision
        ? "indexing"
        : base.candidateCount === 0 ? "empty" : "ready"
    )) ||
    decodedBaseEvidence.reduce((total, base) => total + base.candidateCount, 0) !== candidateCount ||
    decodedResults.length > resultLimit || candidateCount < decodedResults.length ||
    decodedResults.some((result, index) => {
      const base = decodedBaseEvidence[result.bindingOrdinal];
      return result.handle !== `K${invocationOrdinal}.${index + 1}` ||
        result.fusedScore < threshold || !base ||
        base.knowledgeBaseId !== result.knowledgeBaseId || base.baseName !== result.baseName;
    }) ||
    (outcome === "complete" && decodedResults.length === 0) ||
    (outcome !== "complete" && decodedResults.length !== 0) ||
    (outcome === "base_empty" && candidateCount !== 0) ||
    (outcome === "base_indexing" && (
      candidateCount !== 0 || !decodedBaseEvidence.some((base) => base.state === "indexing")
    )) ||
    (outcome !== "base_indexing" && decodedBaseEvidence.some((base) => base.state === "indexing")) ||
    (outcome === "zero_above_threshold" && candidateCount === 0) ||
    (completed && value.embeddingUsage.length === 0)
  ) return null;
  return {
    baseEvidence: decodedBaseEvidence,
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
    results: decodedResults,
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
  const knowledgeRuns = knowledgeRunsInput.map(decodeKnowledgeRunProjection);
  if (knowledgeRuns.some((receipt) => receipt === null)) return null;
  const decodedKnowledgeRuns = knowledgeRuns.filter(
    (receipt): receipt is KnowledgeRunProjection => receipt !== null
  );
  if (decodedKnowledgeRuns.some((receipt, index) => receipt.invocationOrdinal !== index + 1)) {
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

  let memoryAction: MemoryActionFeedback | undefined;
  if (run.memoryAction !== undefined) {
    const decoded = decodeMemoryActionFeedback(run.memoryAction);
    if (!decoded.ok) return null;
    memoryAction = decoded.value;
  }
  let memoryReceipt: MemoryReceipt | undefined;
  if (run.memoryReceipt !== undefined) {
    const decoded = decodeMemoryReceipt(run.memoryReceipt);
    if (!decoded.ok) return null;
    memoryReceipt = decoded.value;
  }
  let inspection: ModelRunInspectionProjection | undefined;
  if (run.inspection !== undefined) {
    const decoded = decodeModelRunInspection(run.inspection);
    if (!decoded) return null;
    inspection = decoded;
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
    ...(inspection ? { inspection } : {}),
    knowledgeBindings: knowledgeBindings.filter(
      (binding): binding is KnowledgeRunBindingProjection => binding !== null
    ),
    knowledgePlan: decodedKnowledgePlan.plan,
    knowledgeRuns: decodedKnowledgeRuns,
    ...(memoryAction ? { memoryAction } : {}),
    ...(memoryReceipt ? { memoryReceipt } : {}),
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
