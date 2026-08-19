import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import type { ToolExecutionResult } from "../tools/types";
import {
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  type KnowledgeBaseRetrievalEvidence,
  type KnowledgeEvidenceScopeAlias,
  type KnowledgeEmbeddingExecutionEvidence,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeRetrievedPassageEvidence,
  type KnowledgeStructuredRetrievalEvidence,
  type KnowledgeVisualRetrievalEvidence,
  type KnowledgeRetrievalUsageAttribution,
  type KnowledgeVectorSearchEvidence
} from "./retrievalTypes";
import {
  isKnowledgeOperationKind,
  knowledgeBudgetStopReasons,
  type KnowledgeBudgetEvidence,
  type KnowledgeBudgetUsage
} from "./knowledgeBudget";
import { decodeStructuredAnalysisResult } from "./structuredData";
import { decodeKnowledgeVisualAnalysisResult } from "./visualEvidence";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRerankerBindingEvidence,
  KnowledgeRetrievalLane
} from "./retrievalRanking";

const persistedContentMarker = Object.freeze({
  type: "json" as const,
  value: Object.freeze({ aiqsaType: "knowledge_result", version: KNOWLEDGE_RESULT_VERSION })
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
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
  return value === "base_empty" || value === "base_indexing" ||
    value === "budget_exhausted" || value === "complete" ||
    value === "embedding_model_unavailable" || value === "structured_clarification_required" ||
    value === "source_location_unavailable" ||
    value === "zero_above_threshold"
    ? value
    : null;
}

function decodeVectorSearch(value: unknown): KnowledgeVectorSearchEvidence | null {
  if (!isRecord(value) || !isRecord(value.scan)) return null;
  const bindingOrdinal = nonNegativeInteger(value.bindingOrdinal);
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const eligibleRows = nonNegativeInteger(value.eligibleRows);
  const efSearch = value.scan.efSearch === null ? null : nonNegativeInteger(value.scan.efSearch);
  const maxScanTuples = value.scan.maxScanTuples === null
    ? null
    : nonNegativeInteger(value.scan.maxScanTuples);
  const retrievalBucket = nonNegativeInteger(value.scan.retrievalBucket);
  if (
    bindingOrdinal === null || bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS || candidateCount === null ||
    eligibleRows === null ||
    retrievalBucket === null || retrievalBucket > 15 ||
    candidateCount > eligibleRows ||
    (value.mode !== "ann" && value.mode !== "exact" && value.mode !== "unavailable") ||
    (value.targetDimension !== 1024 && value.targetDimension !== 1536) ||
    (value.scan.iterativeScan !== null && value.scan.iterativeScan !== "strict_order") ||
    efSearch === null && value.scan.efSearch !== null ||
    maxScanTuples === null && value.scan.maxScanTuples !== null ||
    (value.mode === "ann" && (
      eligibleRows <= 512 || efSearch === null || efSearch < 1 ||
      maxScanTuples === null || maxScanTuples < 1 ||
      value.scan.iterativeScan !== "strict_order"
    )) ||
    (value.mode === "exact" && eligibleRows > 512) ||
    (value.mode !== "ann" && (
      efSearch !== null || maxScanTuples !== null || value.scan.iterativeScan !== null
    )) ||
    (value.mode === "unavailable" && candidateCount !== 0)
  ) return null;
  return {
    bindingOrdinal,
    candidateCount,
    eligibleRows,
    mode: value.mode,
    scan: {
      efSearch,
      iterativeScan: value.scan.iterativeScan,
      maxScanTuples,
      retrievalBucket
    },
    targetDimension: value.targetDimension
  };
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
  const vectorSearch = value.vectorSearch === undefined
    ? undefined
    : decodeVectorSearch(value.vectorSearch) ?? null;
  if (
    baseContentRevision === null || !baseName || candidateCount === null ||
    indexedContentRevision === null || !indexGenerationId || !knowledgeBaseId ||
    ordinal === null || ordinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    (value.state !== "empty" && value.state !== "indexing" && value.state !== "ready") ||
    (value.targetDimension !== 1024 && value.targetDimension !== 1536) ||
    !vectorSpaceFingerprint || !/^[0-9a-f]{64}$/u.test(vectorSpaceFingerprint) ||
    vectorSearch === null ||
    vectorSearch !== undefined && (
      vectorSearch.bindingOrdinal !== ordinal || vectorSearch.targetDimension !== value.targetDimension
    )
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
    ...(vectorSearch ? { vectorSearch } : {}),
    vectorSpaceFingerprint
  };
}

function decodeEmbedding(value: unknown): KnowledgeEmbeddingExecutionEvidence | null {
  if (!isRecord(value) || !Array.isArray(value.bindingOrdinals) ||
    value.bindingOrdinals.length < 1 ||
    value.bindingOrdinals.length > KNOWLEDGE_SCOPE_MAX_BINDINGS) return null;
  const bindingOrdinals = value.bindingOrdinals.map(nonNegativeInteger);
  const durationMs = nonNegativeInteger(value.durationMs);
  const inputTokens = nonNegativeInteger(value.inputTokens);
  const modelId = boundedString(value.modelId, 512);
  const provider = boundedString(value.provider, 256);
  const providerModelId = boundedString(value.providerModelId, 512);
  const requestId = value.requestId === null ? null : boundedString(value.requestId, 512);
  const totalTokens = nonNegativeInteger(value.totalTokens);
  if (
    bindingOrdinals.some((ordinal) =>
      ordinal === null || ordinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS) ||
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

const retrievalLanes = new Set<KnowledgeRetrievalLane>([
  "document_lexical",
  "exact",
  "metadata",
  "neighbor",
  "passage_lexical",
  "passage_semantic",
  "section_lexical"
]);

function decodeSignal(value: unknown): KnowledgeCandidateSignal | null {
  if (!isRecord(value)) return null;
  const rank = nonNegativeInteger(value.rank);
  const rawScore = finiteNumber(value.rawScore);
  const vectorDistance = value.vectorDistance === null
    ? null
    : finiteNumber(value.vectorDistance);
  if (
    typeof value.lane !== "string" || !retrievalLanes.has(value.lane as KnowledgeRetrievalLane) ||
    rank === null || rank < 1 || rank > 100 || rawScore === null ||
    (value.exactKind !== null && typeof value.exactKind !== "string") ||
    (value.vectorMode !== null && value.vectorMode !== "ann" && value.vectorMode !== "exact") ||
    (value.vectorMode === null) !== (vectorDistance === null) ||
    vectorDistance !== null && (vectorDistance < 0 || vectorDistance > 2)
  ) return null;
  return {
    exactKind: value.exactKind as string | null,
    lane: value.lane as KnowledgeRetrievalLane,
    rank,
    rawScore,
    vectorDistance,
    vectorMode: value.vectorMode as "ann" | "exact" | null
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
  const documentVersionNumber = nonNegativeInteger(value.documentVersionNumber);
  const fileName = boundedString(value.fileName, 1_024);
  const ftsRank = nullablePositiveRank(value.ftsRank);
  const ftsScore = nullableFiniteNumber(value.ftsScore);
  const fusedScore = finiteNumber(value.fusedScore);
  const handle = boundedString(value.handle, 32);
  const includedText = boundedString(value.includedText, 64 * 1024, true);
  const includedTextBytes = nonNegativeInteger(value.includedTextBytes);
  const knowledgeBaseId = boundedString(value.knowledgeBaseId, 512);
  const layoutKind = value.layoutKind === undefined
    ? undefined
    : value.layoutKind === "body" || value.layoutKind === "table_ambiguous" ||
      value.layoutKind === "table_row"
      ? value.layoutKind
      : null;
  const page = nonNegativeInteger(value.page);
  const sourceAlias = value.sourceAlias === undefined
    ? undefined
    : typeof value.sourceAlias === "string" && /^S[1-9]\d{0,2}$/u.test(value.sourceAlias)
      ? value.sourceAlias
      : null;
  const sourceTextBytes = nonNegativeInteger(value.sourceTextBytes);
  const vectorDistance = nullableFiniteNumber(value.vectorDistance);
  const vectorScore = nullableFiniteNumber(value.vectorScore);
  const confidence = value.confidence === undefined ? undefined : finiteNumber(value.confidence);
  const contentHash = value.contentHash === undefined
    ? undefined
    : boundedString(value.contentHash, 64);
  const headingPath = value.headingPath === undefined
    ? undefined
    : Array.isArray(value.headingPath) && value.headingPath.length <= 64 &&
      value.headingPath.every((entry) =>
      typeof entry === "string" && entry.length <= 512)
      ? value.headingPath as string[]
      : null;
  const rerankScore = value.rerankScore === undefined
    ? undefined
    : value.rerankScore === null ? null : finiteNumber(value.rerankScore);
  const sectionId = value.sectionId === undefined
    ? undefined
    : value.sectionId === null ? null : boundedString(value.sectionId, 512);
  const sourceArtifactId = value.sourceArtifactId === undefined
    ? undefined
    : value.sourceArtifactId === null ? null : boundedString(value.sourceArtifactId, 512);
  const sourceName = value.sourceName === undefined
    ? undefined
    : boundedString(value.sourceName, 1_024);
  const signalProvenance = value.signalProvenance === undefined
    ? undefined
    : Array.isArray(value.signalProvenance) && value.signalProvenance.length <= 100
      ? value.signalProvenance.map(decodeSignal)
      : null;
  const structuredAnalysis = value.structuredAnalysis === undefined
    ? undefined
    : decodeStructuredAnalysisResult(value.structuredAnalysis) ?? null;
  const visualAnalysis = value.visualAnalysis === undefined
    ? undefined
    : decodeKnowledgeVisualAnalysisResult(value.visualAnalysis) ?? null;
  const advanced = signalProvenance !== undefined;
  const expectedFusedScore = (annRank === null || annRank === undefined ? 0 : 1 / (60 + annRank)) +
    (ftsRank === null || ftsRank === undefined ? 0 : 1 / (60 + ftsRank));
  if (
    annRank === undefined || !baseName || bindingOrdinal === null ||
    bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    !chunkId || chunkIndex === null || !documentId || !documentVersionId ||
    (documentVersionNumber === null || documentVersionNumber < 1) || !fileName ||
    ftsRank === undefined || ftsScore === undefined || fusedScore === null || fusedScore < 0 ||
    !handle || !decodeKnowledgeCitationHandle(handle) ||
    includedText === null ||
    includedTextBytes === null || includedTextBytes !== Buffer.byteLength(includedText, "utf8") ||
    layoutKind === null || sourceAlias === null ||
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
    structuredAnalysis === null || visualAnalysis === null ||
    structuredAnalysis !== undefined && visualAnalysis !== undefined ||
    (!advanced && Math.abs(fusedScore - expectedFusedScore) > 1e-12) ||
    (advanced && (
      signalProvenance === null || signalProvenance.length < 1 ||
      signalProvenance.some((signal) => signal === null) ||
      confidence === null || confidence === undefined || confidence < 0 || confidence > 1 ||
      !contentHash || !/^[0-9a-f]{64}$/u.test(contentHash) || headingPath === null ||
      rerankScore === undefined || rerankScore !== null && (rerankScore < 0 || rerankScore > 1) ||
      sectionId === null && value.sectionId !== null ||
      sourceArtifactId === null && value.sourceArtifactId !== null ||
      !sourceName || fusedScore > 1
    ))
  ) return null;
  return {
    annRank,
    baseName,
    bindingOrdinal,
    chunkId,
    chunkIndex,
    ...(confidence !== undefined ? { confidence: confidence as number } : {}),
    ...(contentHash !== undefined ? { contentHash: contentHash as string } : {}),
    documentId,
    documentVersionId,
    documentVersionNumber,
    fileName,
    ftsRank,
    ftsScore,
    fusedScore,
    ...(headingPath !== undefined ? { headingPath: headingPath as string[] } : {}),
    handle,
    includedText,
    includedTextBytes,
    knowledgeBaseId,
    ...(layoutKind !== undefined ? { layoutKind } : {}),
    page,
    ...(rerankScore !== undefined ? { rerankScore } : {}),
    ...(sectionId !== undefined ? { sectionId: sectionId as string | null } : {}),
    ...(signalProvenance !== undefined
      ? { signalProvenance: signalProvenance as KnowledgeCandidateSignal[] }
      : {}),
    ...(sourceArtifactId !== undefined
      ? { sourceArtifactId: sourceArtifactId as string | null }
      : {}),
    ...(sourceName !== undefined ? { sourceName: sourceName as string } : {}),
    ...(sourceAlias !== undefined ? { sourceAlias } : {}),
    sourceTextBytes,
    ...(structuredAnalysis ? { structuredAnalysis } : {}),
    textTruncated: value.textTruncated,
    vectorDistance,
    vectorScore,
    ...(visualAnalysis ? { visualAnalysis } : {})
  };
}

function decodeStructuredEvidence(value: unknown): KnowledgeStructuredRetrievalEvidence | null {
  if (!isRecord(value) || value.version !== 1 ||
    value.status !== "complete" && value.status !== "needs_clarification" ||
    (value.status === "complete" && (value.question !== undefined || Object.keys(value).length !== 2)) ||
    (value.status === "needs_clarification" && (
      !boundedString(value.question, 2_000) || Object.keys(value).length !== 3
    ))) return null;
  return {
    ...(value.status === "needs_clarification" ? { question: value.question as string } : {}),
    status: value.status,
    version: 1
  };
}

function decodeVisualEvidence(value: unknown): KnowledgeVisualRetrievalEvidence | null {
  return isRecord(value) && Object.keys(value).length === 2 && value.version === 1 &&
    (value.status === "available" || value.status === "unavailable")
    ? { status: value.status, version: 1 }
    : null;
}

/** Strict decoder for one persisted result used by reauthorized citation reads. */
export function decodeKnowledgeRetrievedPassage(
  value: unknown
): KnowledgeRetrievedPassageEvidence | null {
  return decodePassage(value);
}

export function knowledgeToolResultText(
  evidence: Pick<KnowledgeRetrievalEvidence,
    "budget" | "outcome" | "results" | "scopeAliases" | "structured" | "visual">
): string {
  if (evidence.structured?.status === "needs_clarification") {
    return `Structured analysis needs clarification: ${evidence.structured.question} ` +
      "Do not guess the sheet, columns, or hidden-data policy.";
  }
  if (evidence.outcome === "complete") {
    const compact = (
      value: string | undefined,
      fallback: string,
      maximum = 240
    ): string => (value?.replace(/\s+/gu, " ").trim() || fallback).slice(0, maximum);
    const groups = new Map<string, KnowledgeRetrievedPassageEvidence[]>();
    for (const result of evidence.results) {
      const key = result.sourceAlias ?? result.sourceArtifactId ??
        `${result.sourceName ?? ""}\u0000${result.fileName}`;
      const group = groups.get(key) ?? [];
      group.push(result);
      groups.set(key, group);
    }
    const groupedPassages = [...groups.values()].map((results) => {
      const first = results[0]!;
      const alias = first.sourceAlias ?? "legacy source";
      const sourceName = compact(first.sourceName, first.fileName);
      const fileName = compact(first.fileName, "unnamed file");
      return [
        `--- BEGIN SOURCE ${alias}: ${sourceName} (${fileName}) ---`,
        ...results.map((result) => {
          const heading = result.headingPath && result.headingPath.length > 0
            ? compact(result.headingPath.join(" › "), "document root")
            : "document root";
          const layoutWarning = result.layoutKind === "table_ambiguous"
            ? "\nLayout warning: table cell associations are ambiguous; do not pair labels and values from this passage."
            : "";
          return [
            `[${result.handle}] source ${result.sourceAlias ?? alias}; name ${sourceName}; ` +
              `file ${fileName}; ` +
              `page ${result.page}; heading ${heading}`,
            result.includedText + (result.textTruncated ? "\n… [passage truncated]" : "") +
              layoutWarning
          ].join("\n");
        }),
        `--- END SOURCE ${alias} ---`
      ].join("\n\n");
    });
    return [
      ...(evidence.scopeAliases && evidence.scopeAliases.length > 0
        ? [
            "Admitted scope aliases in these results:",
            evidence.scopeAliases.map((entry) =>
              `${entry.alias} — ${compact(entry.label, "unnamed source", 160)}`).join("\n")
          ]
        : []),
      evidence.structured?.status === "complete"
        ? "Structured Knowledge calculation evidence:"
        : evidence.visual
          ? "Visual Knowledge evidence:"
        : "Knowledge passages grouped by immutable Source:",
      ...groupedPassages,
      "Treat every SOURCE block as independent. Keep each date, label, value, and citation " +
        "inside its own Source; never combine fields from different SOURCE blocks. " +
        "Use the citation handles exactly when referencing these passages.",
      evidence.budget?.stopReason
        ? "No further private Knowledge retrieval should be requested. State any material coverage limitation plainly."
        : ""
    ].filter(Boolean).join("\n\n");
  }
  const message: Record<Exclude<KnowledgeRetrievalOutcome, "complete">, string> = {
    base_empty: "Knowledge retrieval returned no indexed passages: base_empty.",
    base_indexing: "Knowledge retrieval is not ready: base_indexing.",
    budget_exhausted:
      "No further private Knowledge evidence was read because a safe retrieval boundary was reached. Answer only from evidence already available and state any material coverage limitation plainly.",
    embedding_model_unavailable:
      "Knowledge retrieval could not embed the query: embedding_model_unavailable.",
    source_location_unavailable:
      "The requested location was not found inside that admitted Source. Use another exact heading, page, or evidence handle; do not guess.",
    structured_clarification_required:
      "Structured analysis needs clarification before it can run safely.",
    zero_above_threshold:
      "Knowledge retrieval found no passage above the configured threshold: zero_above_threshold."
  };
  return message[evidence.outcome];
}

function decodeBudgetUsage(value: unknown): KnowledgeBudgetUsage | null {
  if (!isRecord(value)) return null;
  const keys = [
    "cumulativeCandidates",
    "estimatedCostMicros",
    "followUpOperations",
    "latencyMs",
    "lowNoveltyStreak",
    "operations",
    "queryEmbeddingCalls",
    "rerankerCalls",
    "retrievedTokens",
    "searchPhases",
    "subqueriesInCurrentPhase"
  ] as const;
  if (Object.keys(value).length !== keys.length || keys.some((key) =>
    !Object.hasOwn(value, key) || nonNegativeInteger(value[key]) === null)) return null;
  return Object.fromEntries(keys.map((key) => [key, Number(value[key])])) as KnowledgeBudgetUsage;
}

function decodeBudgetEvidence(value: unknown): KnowledgeBudgetEvidence | null {
  if (!isRecord(value) || value.version !== 1 || !isKnowledgeOperationKind(value.operation) ||
    value.stopReason !== null && !knowledgeBudgetStopReasons.includes(
      value.stopReason as (typeof knowledgeBudgetStopReasons)[number]
    ) || value.noveltyRatio !== null && (
      typeof value.noveltyRatio !== "number" || !Number.isFinite(value.noveltyRatio) ||
      value.noveltyRatio < 0 || value.noveltyRatio > 1
    )) return null;
  const usage = decodeBudgetUsage(value.usage);
  if (!usage) return null;
  return {
    noveltyRatio: value.noveltyRatio as number | null,
    operation: value.operation,
    stopReason: value.stopReason as KnowledgeBudgetEvidence["stopReason"],
    usage,
    version: 1
  };
}

function decodeScopeAlias(value: unknown): KnowledgeEvidenceScopeAlias | null {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
    typeof value.alias !== "string" || !/^[BS][1-9]\d{0,2}$/u.test(value.alias) ||
    value.kind !== "base" && value.kind !== "source" ||
    typeof value.label !== "string" || !value.label || value.label.length > 1_024 ||
    /\u0000/u.test(value.label) ||
    (value.kind === "base") !== value.alias.startsWith("B")) return null;
  return { alias: value.alias, kind: value.kind, label: value.label };
}

function decodeRerankerBinding(value: unknown): KnowledgeRerankerBindingEvidence | null {
  if (!isRecord(value) || !Array.isArray(value.languages)) return null;
  if (
    value.egress !== "none" || value.kind !== "local_hybrid_policy" ||
    value.profile !== "aiqsa-multilingual-hybrid-v1" || value.version !== 1 ||
    (value.status !== "complete" && value.status !== "degraded") ||
    value.languages.length !== 2 || value.languages[0] !== "en" || value.languages[1] !== "ru" ||
    (value.status === "complete" && value.failureCode !== undefined) ||
    (value.status === "degraded" && value.failureCode !== "knowledge_reranker_unavailable")
  ) return null;
  return {
    egress: "none",
    ...(value.status === "degraded"
      ? { failureCode: "knowledge_reranker_unavailable" as const }
      : {}),
    kind: "local_hybrid_policy",
    languages: ["en", "ru"],
    profile: "aiqsa-multilingual-hybrid-v1",
    status: value.status,
    version: 1
  };
}

function decodeCandidateOrder(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) || value.length > 1_000 ||
    value.some((entry) => typeof entry !== "string" || !entry || entry.length > 512) ||
    new Set(value).size !== value.length
  ) return null;
  return value as string[];
}

export function decodeKnowledgeRetrievalEvidence(value: unknown): KnowledgeRetrievalEvidence | null {
  if (!isRecord(value) || value.version !== KNOWLEDGE_RESULT_VERSION ||
    !Array.isArray(value.bases) || value.bases.length < 1 ||
    value.bases.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    !Array.isArray(value.embeddingExecutions) ||
    value.embeddingExecutions.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    !Array.isArray(value.results) || value.results.length > KNOWLEDGE_RESULT_LIMIT) return null;
  const bases = value.bases.map(decodeBase);
  const budget = value.budget === undefined ? undefined : decodeBudgetEvidence(value.budget);
  const embeddingExecutions = value.embeddingExecutions.map(decodeEmbedding);
  const results = value.results.map(decodePassage);
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const candidateLimit = nonNegativeInteger(value.candidateLimit);
  const durationMs = nonNegativeInteger(value.durationMs);
  const invocationOrdinal = nonNegativeInteger(value.invocationOrdinal);
  const operation = value.operation === undefined
    ? undefined
    : isKnowledgeOperationKind(value.operation) ? value.operation : null;
  const scopeAliases = value.scopeAliases === undefined
    ? undefined
    : Array.isArray(value.scopeAliases) && value.scopeAliases.length <= 256
      ? value.scopeAliases.map(decodeScopeAlias)
      : null;
  const structured = value.structured === undefined
    ? undefined
    : decodeStructuredEvidence(value.structured) ?? null;
  const visual = value.visual === undefined
    ? undefined
    : decodeVisualEvidence(value.visual) ?? null;
  const decodedOutcome = outcome(value.outcome);
  const providerText = boundedString(value.providerText, 64 * 1024);
  const query = boundedString(value.query, 500);
  const resultLimit = nonNegativeInteger(value.resultLimit);
  const threshold = finiteNumber(value.threshold);
  const fusion = value.fusion === "rrf_k60" || value.fusion === "weighted_rrf_v2"
    ? value.fusion
    : null;
  const rerankerBinding = value.rerankerBinding === null
    ? null
    : decodeRerankerBinding(value.rerankerBinding);
  const preRerankOrder = value.preRerankOrder === null
    ? null
    : decodeCandidateOrder(value.preRerankOrder);
  const postRerankOrder = value.postRerankOrder === null
    ? null
    : decodeCandidateOrder(value.postRerankOrder);
  const failureCode = value.failureCode === undefined
    ? undefined
    : boundedString(value.failureCode, 128);
  if (
    bases.some((base) => base === null) || budget === null || operation === null ||
    structured === null || visual === null || structured !== undefined && visual !== undefined ||
    scopeAliases === null || scopeAliases?.some((alias) => alias === null) ||
    (budget === undefined) !== (operation === undefined) ||
    budget !== undefined && budget.operation !== operation ||
    embeddingExecutions.some((entry) => entry === null) ||
    results.some((result) => result === null) || candidateCount === null || candidateLimit === null ||
    candidateLimit < 1 || durationMs === null || invocationOrdinal === null || invocationOrdinal < 1 ||
    invocationOrdinal > 256 || !decodedOutcome || !fusion ||
    !providerText || !query ||
    (value.rerankerBinding !== null && rerankerBinding === null) ||
    (value.preRerankOrder !== null && preRerankOrder === null) ||
    (value.postRerankOrder !== null && postRerankOrder === null) ||
    (fusion === "rrf_k60" && (
      rerankerBinding !== null || preRerankOrder !== null || postRerankOrder !== null
    )) ||
    (fusion === "weighted_rrf_v2" && (
      rerankerBinding === null || preRerankOrder === null || postRerankOrder === null
    )) ||
    resultLimit === null || resultLimit < 1 ||
    resultLimit > KNOWLEDGE_RESULT_LIMIT || threshold === null || threshold < 0 || threshold > 1 ||
    (value.failureCode !== undefined && !failureCode)
  ) return null;
  const decodedBases = bases as KnowledgeBaseRetrievalEvidence[];
  const decodedEmbeddings = embeddingExecutions as KnowledgeEmbeddingExecutionEvidence[];
  const decodedResults = results as KnowledgeRetrievedPassageEvidence[];
  const evidence: KnowledgeRetrievalEvidence = {
    bases: decodedBases,
    ...(budget ? { budget } : {}),
    candidateCount,
    candidateLimit,
    durationMs,
    embeddingExecutions: embeddingExecutions as KnowledgeEmbeddingExecutionEvidence[],
    ...(failureCode ? { failureCode } : {}),
    fusion,
    invocationOrdinal,
    ...(operation ? { operation } : {}),
    outcome: decodedOutcome,
    postRerankOrder,
    preRerankOrder,
    providerText,
    query,
    rerankerBinding,
    resultLimit,
    results: decodedResults,
    ...(scopeAliases ? { scopeAliases: scopeAliases as KnowledgeEvidenceScopeAlias[] } : {}),
    ...(structured ? { structured } : {}),
    threshold,
    version: KNOWLEDGE_RESULT_VERSION,
    ...(visual ? { visual } : {})
  };
  const ordinals = decodedBases.map((base) => base.ordinal);
  const basesByOrdinal = new Map(decodedBases.map((base) => [base.ordinal, base]));
  const embeddedOrdinals = decodedEmbeddings.flatMap((entry) => entry.bindingOrdinals);
  const completedEmbeddingOrdinals = new Set(decodedEmbeddings
    .filter((entry) => entry.status === "complete")
    .flatMap((entry) => entry.bindingOrdinals));
  const failedEmbeddingOrdinals = new Set(decodedEmbeddings
    .filter((entry) => entry.status === "error")
    .flatMap((entry) => entry.bindingOrdinals));
  const advanced = fusion === "weighted_rrf_v2";
  const structuredComplete = structured?.status === "complete";
  const structuredClarification = structured?.status === "needs_clarification";
  const visualComplete = visual !== undefined;
  const resultHandles = decodedResults.map((result) =>
    decodeKnowledgeCitationHandle(result.handle));
  const retrievalCompleted = decodedOutcome === "base_empty" || decodedOutcome === "complete" ||
    decodedOutcome === "zero_above_threshold";
  const embeddingDegraded = Boolean(failureCode) || failedEmbeddingOrdinals.size > 0;
  const deterministicRead = operation === "read_source";
  if (
    new Set(ordinals).size !== ordinals.length ||
    new Set(embeddedOrdinals).size !== embeddedOrdinals.length ||
    embeddedOrdinals.some((ordinal) => !ordinals.includes(ordinal)) ||
    decodedBases.some((base, index) => index > 0 &&
      base.ordinal <= decodedBases[index - 1]!.ordinal) ||
    decodedBases.some((base) => base.state !== (
      base.indexedContentRevision < base.baseContentRevision
        ? "indexing"
        : base.candidateCount === 0 && !deterministicRead ? "empty" : "ready"
    )) ||
    decodedBases.reduce((total, base) => total + base.candidateCount, 0) !== candidateCount ||
    (deterministicRead && (
      decodedEmbeddings.length !== 0 || fusion !== "rrf_k60" || Boolean(failureCode) ||
      structured !== undefined || visual !== undefined || rerankerBinding !== null ||
      preRerankOrder !== null || postRerankOrder !== null ||
      decodedBases.some((base) => base.vectorSearch !== undefined)
    )) ||
    decodedResults.length > resultLimit ||
    resultHandles.some((handle, index) => !handle ||
      ("invocationOrdinal" in handle && (
        handle.invocationOrdinal !== invocationOrdinal || handle.resultOrdinal !== index + 1
      ))) ||
    new Set(decodedResults.map((result) => result.handle)).size !== decodedResults.length ||
    decodedResults.some((result) =>
      result.annRank !== null && result.annRank > (advanced ? 100 : candidateLimit) ||
      result.ftsRank !== null && result.ftsRank > (advanced ? 100 : candidateLimit) ||
      (structuredComplete
        ? result.structuredAnalysis === undefined
        : result.structuredAnalysis !== undefined) ||
      (visualComplete
        ? result.visualAnalysis === undefined
        : result.visualAnalysis !== undefined) ||
      (structuredComplete || visualComplete || deterministicRead
        ? false
        : advanced
        ? result.confidence === undefined || result.confidence < threshold
        : result.fusedScore < threshold) ||
      !basesByOrdinal.has(result.bindingOrdinal) ||
      basesByOrdinal.get(result.bindingOrdinal)?.knowledgeBaseId !== result.knowledgeBaseId) ||
    decodedResults.some((result) => result.sourceAlias !== undefined &&
      !scopeAliases?.some((alias) => alias !== null && alias.kind === "source" &&
        alias.alias === result.sourceAlias)) ||
    candidateCount < decodedResults.length ||
    (!structured && !visual && !deterministicRead && retrievalCompleted && !embeddingDegraded && (
      decodedEmbeddings.some((entry) => entry.status !== "complete") ||
      embeddedOrdinals.length !== decodedBases.length ||
      decodedBases.some((base) => !completedEmbeddingOrdinals.has(base.ordinal))
    )) ||
    Buffer.byteLength(providerText, "utf8") > KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES ||
    providerText !== knowledgeToolResultText(evidence) ||
    (decodedOutcome === "complete" && decodedResults.length === 0) ||
    (decodedOutcome !== "complete" && decodedResults.length !== 0) ||
    (decodedOutcome === "base_empty" && candidateCount !== 0) ||
    (decodedOutcome === "budget_exhausted" && (
      decodedResults.length !== 0 || budget?.stopReason == null
    )) ||
    (decodedOutcome === "base_indexing" && (
      candidateCount !== 0 ||
      !decodedBases.some((base) => base.state === "indexing")
    )) ||
    (decodedOutcome === "embedding_model_unavailable" &&
      !decodedEmbeddings.some((entry) =>
        entry.status === "error") && !failureCode) ||
    (decodedOutcome === "source_location_unavailable" && (
      operation !== "read_source" || candidateCount !== 0 || decodedResults.length !== 0 ||
      decodedEmbeddings.length !== 0
    )) ||
    (decodedOutcome === "zero_above_threshold" && candidateCount === 0) ||
    (structuredComplete && (
      decodedOutcome !== "complete" || decodedResults.length < 1 ||
      decodedEmbeddings.length !== 0 || candidateCount !== decodedResults.length ||
      fusion !== "rrf_k60"
    )) ||
    (structuredClarification && (
      decodedOutcome !== "structured_clarification_required" || decodedResults.length !== 0 ||
      decodedEmbeddings.length !== 0 || candidateCount !== 0 || fusion !== "rrf_k60"
    )) ||
    (!structured && decodedOutcome === "structured_clarification_required") ||
    (visualComplete && (
      decodedOutcome !== "complete" || decodedResults.length !== 1 ||
      decodedEmbeddings.length !== 0 || candidateCount !== 1 || fusion !== "rrf_k60" ||
      decodedResults[0]?.visualAnalysis?.status !== visual.status ||
      decodedResults.some((result) => result.annRank !== null || result.ftsRank !== null ||
        result.ftsScore !== null || result.vectorDistance !== null || result.vectorScore !== null ||
        result.fusedScore !== 0 || result.signalProvenance !== undefined)
    )) ||
    (advanced && !structured && (
      decodedResults.some((result) => result.signalProvenance === undefined) ||
      preRerankOrder!.length !== candidateCount ||
      postRerankOrder!.length !== candidateCount ||
      decodedResults.some((result) => !postRerankOrder!.includes(result.chunkId)) ||
      decodedBases.some((base) => base.vectorSearch === undefined) ||
      decodedBases.some((base) => {
        const vectorSearch = base.vectorSearch!;
        return vectorSearch.mode === "unavailable"
          ? failedEmbeddingOrdinals.has(base.ordinal) === false &&
              vectorSearch.eligibleRows > 0 && completedEmbeddingOrdinals.has(base.ordinal)
          : !completedEmbeddingOrdinals.has(base.ordinal) ||
              failedEmbeddingOrdinals.has(base.ordinal);
      })
    ))
  ) return null;
  return evidence;
}

function evidenceFromPreview(result: ToolExecutionResult): KnowledgeRetrievalEvidence | null {
  const preview = result.rawPreview;
  return preview?.knowledgeResultVersion === KNOWLEDGE_RESULT_VERSION &&
    preview.providerCall === true &&
    hasOnlyKeys(preview, ["knowledgeResultVersion", "knowledgeRetrieval", "providerCall"])
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
  const evidence = evidenceFromPreview(result);
  if (!evidence) return [];
  return [
    ...evidence.embeddingExecutions.flatMap((execution) => execution.status === "complete"
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
      : []),
    ...evidence.results.flatMap((passage) => passage.visualAnalysis?.provider
      ? [{
          modelId: passage.visualAnalysis.provider.modelId,
          provider: passage.visualAnalysis.provider.provider,
          usage: passage.visualAnalysis.provider.usage
        }]
      : [])
  ];
}

export function aggregateKnowledgeUsage(
  executions: readonly KnowledgeEmbeddingExecutionEvidence[],
  results: readonly KnowledgeRetrievedPassageEvidence[] = []
): ModelRunUsage {
  const usages: ModelRunUsage[] = [
    ...executions.flatMap((execution) => execution.status === "complete" ? [{
      inputTokens: execution.inputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: execution.totalTokens
    }] : []),
    ...results.flatMap((passage) => passage.visualAnalysis?.provider
      ? [passage.visualAnalysis.provider.usage]
      : [])
  ];
  const normalized = usages.map(normalizeTokenUsage);
  return normalized.reduce<ModelRunUsage>((total, usage) => ({
    cachedInputTokens: (total.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    cacheWriteInputTokens: (total.cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
    totalTokens: (total.totalTokens ?? 0) + usage.totalTokens
  }), {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
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
  return {
    ...result,
    content: [persistedContentMarker],
    rawPreview: {
      knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
      knowledgeRetrieval: evidence,
      providerCall: true
    }
  };
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
