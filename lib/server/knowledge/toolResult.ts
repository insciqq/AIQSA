import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ToolExecutionResult } from "../tools/types";
import {
  KNOWLEDGE_MAX_INVOCATIONS,
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeBaseRetrievalEvidence,
  type KnowledgeEmbeddingExecutionEvidence,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeRetrievedPassageEvidence,
  type KnowledgeRetrievalUsageAttribution
} from "./retrievalTypes";

const persistedContentMarker = Object.freeze({
  type: "json" as const,
  value: Object.freeze({ aiqsaType: "knowledge_result", version: KNOWLEDGE_RESULT_VERSION })
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
  return typeof value === "string" && value.length <= maximum &&
    (allowEmpty || value.length > 0) && !/\u0000/u.test(value)
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumber(value) ?? undefined;
}

function nullablePositiveRank(value: unknown): number | null | undefined {
  if (value === null) return null;
  const rank = nonNegativeInteger(value);
  return rank !== null && rank >= 1 ? rank : undefined;
}

function outcome(value: unknown): KnowledgeRetrievalOutcome | null {
  return value === "base_empty" || value === "base_indexing" || value === "complete" ||
    value === "embedding_model_unavailable" || value === "zero_above_threshold"
    ? value
    : null;
}

function decodeBase(value: unknown): KnowledgeBaseRetrievalEvidence | null {
  if (!isRecord(value)) return null;
  const baseContentRevision = nonNegativeInteger(value.baseContentRevision);
  const baseName = boundedString(value.baseName, 512);
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const indexedContentRevision = nonNegativeInteger(value.indexedContentRevision);
  const indexGenerationId = boundedString(value.indexGenerationId, 512);
  const knowledgeBaseId = boundedString(value.knowledgeBaseId, 512);
  const ordinal = nonNegativeInteger(value.ordinal);
  const vectorSpaceFingerprint = boundedString(value.vectorSpaceFingerprint, 64);
  if (
    baseContentRevision === null || !baseName || candidateCount === null ||
    indexedContentRevision === null || !indexGenerationId || !knowledgeBaseId ||
    ordinal === null || ordinal > 2 ||
    (value.state !== "empty" && value.state !== "indexing" && value.state !== "ready") ||
    (value.targetDimension !== 1024 && value.targetDimension !== 1536) ||
    !vectorSpaceFingerprint || !/^[0-9a-f]{64}$/u.test(vectorSpaceFingerprint)
  ) return null;
  return {
    baseContentRevision,
    baseName,
    candidateCount,
    indexedContentRevision,
    indexGenerationId,
    knowledgeBaseId,
    ordinal,
    state: value.state,
    targetDimension: value.targetDimension,
    vectorSpaceFingerprint
  };
}

function decodeEmbedding(value: unknown): KnowledgeEmbeddingExecutionEvidence | null {
  if (!isRecord(value) || !Array.isArray(value.bindingOrdinals) ||
    value.bindingOrdinals.length < 1 || value.bindingOrdinals.length > 3) return null;
  const bindingOrdinals = value.bindingOrdinals.map(nonNegativeInteger);
  const durationMs = nonNegativeInteger(value.durationMs);
  const inputTokens = nonNegativeInteger(value.inputTokens);
  const modelId = boundedString(value.modelId, 512);
  const provider = boundedString(value.provider, 256);
  const providerModelId = boundedString(value.providerModelId, 512);
  const requestId = value.requestId === null ? null : boundedString(value.requestId, 512);
  const totalTokens = nonNegativeInteger(value.totalTokens);
  if (
    bindingOrdinals.some((ordinal) => ordinal === null || ordinal > 2) ||
    new Set(bindingOrdinals).size !== bindingOrdinals.length ||
    durationMs === null || inputTokens === null || !modelId || !provider || !providerModelId ||
    requestId === null && value.requestId !== null ||
    (value.status !== "complete" && value.status !== "error") ||
    totalTokens === null
  ) return null;
  return {
    bindingOrdinals: bindingOrdinals as number[],
    durationMs,
    inputTokens,
    modelId,
    provider,
    providerModelId,
    requestId,
    status: value.status,
    totalTokens
  };
}

function decodePassage(value: unknown): KnowledgeRetrievedPassageEvidence | null {
  if (!isRecord(value)) return null;
  const annRank = nullablePositiveRank(value.annRank);
  const baseName = boundedString(value.baseName, 512);
  const bindingOrdinal = nonNegativeInteger(value.bindingOrdinal);
  const chunkId = boundedString(value.chunkId, 512);
  const chunkIndex = nonNegativeInteger(value.chunkIndex);
  const documentId = boundedString(value.documentId, 512);
  const documentVersionId = boundedString(value.documentVersionId, 512);
  const documentVersionNumber = value.documentVersionNumber === undefined
    ? undefined
    : nonNegativeInteger(value.documentVersionNumber);
  const fileName = boundedString(value.fileName, 1_024);
  const ftsRank = nullablePositiveRank(value.ftsRank);
  const ftsScore = nullableFiniteNumber(value.ftsScore);
  const fusedScore = finiteNumber(value.fusedScore);
  const handle = boundedString(value.handle, 32);
  const includedText = boundedString(value.includedText, 64 * 1024, true);
  const includedTextBytes = nonNegativeInteger(value.includedTextBytes);
  const knowledgeBaseId = boundedString(value.knowledgeBaseId, 512);
  const page = nonNegativeInteger(value.page);
  const sourceTextBytes = nonNegativeInteger(value.sourceTextBytes);
  const vectorDistance = nullableFiniteNumber(value.vectorDistance);
  const vectorScore = nullableFiniteNumber(value.vectorScore);
  const expectedFusedScore = (annRank === null || annRank === undefined ? 0 : 1 / (60 + annRank)) +
    (ftsRank === null || ftsRank === undefined ? 0 : 1 / (60 + ftsRank));
  if (
    annRank === undefined || !baseName || bindingOrdinal === null || bindingOrdinal > 2 ||
    !chunkId || chunkIndex === null || !documentId || !documentVersionId ||
    (documentVersionNumber !== undefined &&
      (documentVersionNumber === null || documentVersionNumber < 1)) || !fileName ||
    ftsRank === undefined || ftsScore === undefined || fusedScore === null || fusedScore < 0 ||
    !handle || !/^K[1-3]\.[1-8]$/u.test(handle) || includedText === null ||
    includedTextBytes === null || includedTextBytes !== Buffer.byteLength(includedText, "utf8") ||
    !knowledgeBaseId || page === null || page < 1 || sourceTextBytes === null ||
    sourceTextBytes < includedTextBytes || typeof value.textTruncated !== "boolean" ||
    value.textTruncated !== (includedTextBytes < sourceTextBytes) ||
    vectorDistance === undefined || vectorScore === undefined ||
    (annRank === null) !== (vectorDistance === null) ||
    (annRank === null) !== (vectorScore === null) ||
    (ftsRank === null) !== (ftsScore === null) ||
    vectorDistance !== null && (vectorDistance < 0 || vectorDistance > 2) ||
    vectorScore !== null && (vectorScore < -1 || vectorScore > 1 ||
      Math.abs(vectorScore - (1 - vectorDistance!)) > 1e-12) ||
    ftsScore !== null && ftsScore < 0 ||
    Math.abs(fusedScore - expectedFusedScore) > 1e-12
  ) return null;
  return {
    annRank,
    baseName,
    bindingOrdinal,
    chunkId,
    chunkIndex,
    documentId,
    documentVersionId,
    ...(documentVersionNumber !== undefined && documentVersionNumber !== null
      ? { documentVersionNumber }
      : {}),
    fileName,
    ftsRank,
    ftsScore,
    fusedScore,
    handle,
    includedText,
    includedTextBytes,
    knowledgeBaseId,
    page,
    sourceTextBytes,
    textTruncated: value.textTruncated,
    vectorDistance,
    vectorScore
  };
}

export function knowledgeToolResultText(evidence: KnowledgeRetrievalEvidence): string {
  if (evidence.outcome === "complete") {
    return [
      "Knowledge passages:",
      ...evidence.results.map((result) => [
        `[${result.handle}] page ${result.page}`,
        result.includedText + (result.textTruncated ? "\n… [passage truncated]" : "")
      ].join("\n")),
      "Use the citation handles exactly when referencing these passages."
    ].join("\n\n");
  }
  const message: Record<Exclude<KnowledgeRetrievalOutcome, "complete">, string> = {
    base_empty: "Knowledge retrieval returned no indexed passages: base_empty.",
    base_indexing: "Knowledge retrieval is not ready: base_indexing.",
    embedding_model_unavailable:
      "Knowledge retrieval could not embed the query: embedding_model_unavailable.",
    zero_above_threshold:
      "Knowledge retrieval found no passage above the configured threshold: zero_above_threshold."
  };
  return message[evidence.outcome];
}

export function decodeKnowledgeRetrievalEvidence(value: unknown): KnowledgeRetrievalEvidence | null {
  if (!isRecord(value) || value.version !== KNOWLEDGE_RESULT_VERSION ||
    !Array.isArray(value.bases) || value.bases.length < 1 || value.bases.length > 3 ||
    !Array.isArray(value.embeddingExecutions) || value.embeddingExecutions.length > 3 ||
    !Array.isArray(value.results) || value.results.length > KNOWLEDGE_RESULT_LIMIT) return null;
  const bases = value.bases.map(decodeBase);
  const embeddingExecutions = value.embeddingExecutions.map(decodeEmbedding);
  const results = value.results.map(decodePassage);
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const candidateLimit = nonNegativeInteger(value.candidateLimit);
  const durationMs = nonNegativeInteger(value.durationMs);
  const invocationOrdinal = nonNegativeInteger(value.invocationOrdinal);
  const decodedOutcome = outcome(value.outcome);
  const providerText = boundedString(value.providerText, 64 * 1024);
  const query = boundedString(value.query, 500);
  const resultLimit = nonNegativeInteger(value.resultLimit);
  const threshold = finiteNumber(value.threshold);
  const failureCode = value.failureCode === undefined
    ? undefined
    : boundedString(value.failureCode, 128);
  if (
    bases.some((base) => base === null) || embeddingExecutions.some((entry) => entry === null) ||
    results.some((result) => result === null) || candidateCount === null || candidateLimit === null ||
    candidateLimit < 1 || durationMs === null || invocationOrdinal === null || invocationOrdinal < 1 ||
    invocationOrdinal > KNOWLEDGE_MAX_INVOCATIONS || !decodedOutcome || value.fusion !== "rrf_k60" ||
    !providerText || !query || value.rerankerBinding !== null || value.preRerankOrder !== null ||
    value.postRerankOrder !== null || resultLimit === null || resultLimit < 1 ||
    resultLimit > KNOWLEDGE_RESULT_LIMIT || threshold === null || threshold < 0 || threshold > 1 ||
    (value.failureCode !== undefined && !failureCode)
  ) return null;
  const decodedBases = bases as KnowledgeBaseRetrievalEvidence[];
  const decodedEmbeddings = embeddingExecutions as KnowledgeEmbeddingExecutionEvidence[];
  const decodedResults = results as KnowledgeRetrievedPassageEvidence[];
  const evidence: KnowledgeRetrievalEvidence = {
    bases: decodedBases,
    candidateCount,
    candidateLimit,
    durationMs,
    embeddingExecutions: embeddingExecutions as KnowledgeEmbeddingExecutionEvidence[],
    ...(failureCode ? { failureCode } : {}),
    fusion: "rrf_k60",
    invocationOrdinal,
    outcome: decodedOutcome,
    postRerankOrder: null,
    preRerankOrder: null,
    providerText,
    query,
    rerankerBinding: null,
    resultLimit,
    results: decodedResults,
    threshold,
    version: KNOWLEDGE_RESULT_VERSION
  };
  const ordinals = decodedBases.map((base) => base.ordinal);
  const embeddedOrdinals = decodedEmbeddings.flatMap((entry) => entry.bindingOrdinals);
  const retrievalCompleted = decodedOutcome === "base_empty" || decodedOutcome === "complete" ||
    decodedOutcome === "zero_above_threshold";
  if (
    new Set(ordinals).size !== ordinals.length ||
    decodedBases.some((base, index) => base.ordinal !== index) ||
    decodedBases.some((base) => base.state !== (
      base.indexedContentRevision < base.baseContentRevision
        ? "indexing"
        : base.candidateCount === 0 ? "empty" : "ready"
    )) ||
    decodedBases.reduce((total, base) => total + base.candidateCount, 0) !== candidateCount ||
    decodedResults.length > resultLimit ||
    decodedResults.some((result, index) =>
      result.handle !== `K${invocationOrdinal}.${index + 1}` ||
      result.annRank !== null && result.annRank > candidateLimit ||
      result.ftsRank !== null && result.ftsRank > candidateLimit ||
      result.fusedScore < threshold ||
      !decodedBases[result.bindingOrdinal] ||
      decodedBases[result.bindingOrdinal]?.knowledgeBaseId !== result.knowledgeBaseId) ||
    candidateCount < decodedResults.length ||
    (retrievalCompleted && (
      decodedEmbeddings.some((entry) => entry.status !== "complete") ||
      embeddedOrdinals.length !== decodedBases.length ||
      new Set(embeddedOrdinals).size !== decodedBases.length ||
      decodedBases.some((base) => !embeddedOrdinals.includes(base.ordinal))
    )) ||
    Buffer.byteLength(providerText, "utf8") > KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES ||
    providerText !== knowledgeToolResultText(evidence) ||
    (decodedOutcome === "complete" && decodedResults.length === 0) ||
    (decodedOutcome !== "complete" && decodedResults.length !== 0) ||
    (decodedOutcome === "base_empty" && candidateCount !== 0) ||
    (decodedOutcome === "base_indexing" && (
      candidateCount !== 0 || decodedEmbeddings.length !== 0 ||
      !decodedBases.some((base) => base.state === "indexing")
    )) ||
    (decodedOutcome !== "base_indexing" &&
      decodedBases.some((base) => base.state === "indexing")) ||
    (decodedOutcome === "embedding_model_unavailable" &&
      !decodedEmbeddings.some((entry) =>
        entry.status === "error") && !failureCode) ||
    (decodedOutcome === "zero_above_threshold" && candidateCount === 0)
  ) return null;
  return evidence;
}

function evidenceFromPreview(result: ToolExecutionResult): KnowledgeRetrievalEvidence | null {
  const preview = result.rawPreview?.finalProviderResponsePreview;
  return isRecord(preview)
    ? decodeKnowledgeRetrievalEvidence(preview.knowledgeRetrieval)
    : null;
}

export function knowledgeEvidenceFromToolResult(
  result: ToolExecutionResult
): KnowledgeRetrievalEvidence | null {
  return evidenceFromPreview(result);
}

export function knowledgeUsageAttributionsFromToolResult(
  result: ToolExecutionResult
): KnowledgeRetrievalUsageAttribution[] {
  return evidenceFromPreview(result)?.embeddingExecutions.flatMap((execution) =>
    execution.status === "complete"
      ? [{
          modelId: execution.modelId,
          provider: execution.provider,
          usage: {
            inputTokens: execution.inputTokens,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: execution.totalTokens
          }
        }]
      : []) ?? [];
}

export function aggregateKnowledgeUsage(
  executions: readonly KnowledgeEmbeddingExecutionEvidence[]
): ModelRunUsage {
  return executions.reduce<ModelRunUsage>((usage, execution) => execution.status === "complete"
    ? {
        inputTokens: usage.inputTokens + execution.inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: (usage.totalTokens ?? usage.inputTokens) + execution.totalTokens
      }
    : usage, {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  });
}

export function knowledgeToolResultContent(
  evidence: KnowledgeRetrievalEvidence
): ToolExecutionResult["content"] {
  return [{ text: knowledgeToolResultText(evidence), type: "text" }];
}

function markerContent(result: ToolExecutionResult): boolean {
  const [entry] = result.content;
  return result.content.length === 1 && entry?.type === "json" && isRecord(entry.value) &&
    entry.value.aiqsaType === "knowledge_result" &&
    entry.value.version === KNOWLEDGE_RESULT_VERSION && Object.keys(entry.value).length === 2;
}

export function compactKnowledgeToolExecutionResult(
  result: ToolExecutionResult
): ToolExecutionResult | null {
  const version = result.rawPreview?.knowledgeResultVersion;
  if (version === undefined) return result;
  if (version !== KNOWLEDGE_RESULT_VERSION || markerContent(result) || result.status !== "complete") {
    return null;
  }
  const evidence = evidenceFromPreview(result);
  if (!evidence || result.content.length !== 1 || result.content[0]?.type !== "text" ||
    result.content[0].text !== knowledgeToolResultText(evidence)) return null;
  return { ...result, content: [persistedContentMarker] };
}

export function rehydratePersistedKnowledgeToolExecutionResult(
  result: ToolExecutionResult
): ToolExecutionResult | null {
  const version = result.rawPreview?.knowledgeResultVersion;
  if (version === undefined) return result;
  if (version !== KNOWLEDGE_RESULT_VERSION || !markerContent(result) || result.status !== "complete") {
    return null;
  }
  const evidence = evidenceFromPreview(result);
  return evidence ? { ...result, content: knowledgeToolResultContent(evidence) } : null;
}
