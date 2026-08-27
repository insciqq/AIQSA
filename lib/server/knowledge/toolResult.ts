import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import type { ToolExecutionResult } from "../tools/types";
import {
  KNOWLEDGE_LEGACY_RESULT_VERSION,
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_RESULT_VERSIONS,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  type KnowledgeBaseRetrievalEvidence,
  type KnowledgeEvidenceScopeAlias,
  type KnowledgeEmbeddingExecutionEvidence,
  type KnowledgeExactMatchEvidence,
  type KnowledgeExactRetrievalEvidence,
  type KnowledgeReadResolvedSource,
  type KnowledgeReadReceipt,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeResultVersion,
  type KnowledgeRetrievedPassageEvidence,
  type KnowledgeSourceDiscoveryEvidence,
  type KnowledgeSourceDiscoveryField,
  type KnowledgeRetrievalUsageAttribution,
  type KnowledgeVectorSearchEvidence
} from "./retrievalTypes";
import {
  isKnowledgeOperationKind,
  knowledgeBudgetStopReasons,
  type KnowledgeBudgetEvidence,
  type KnowledgeBudgetUsage,
  type LegacyKnowledgeBudgetEvidence,
  type LegacyKnowledgeBudgetUsage
} from "./knowledgeBudget";
import {
  canonicalReadSourceLocator,
  normalizeReadSourceRequest,
  type ReadSourceLocator
} from "./readSourceLocator";
import {
  decodeKnowledgeDocumentContext,
  isCompleteKnowledgeTableRowProjectionSequence,
  type KnowledgeTableRowProjectionLocatorV1
} from "./documentContext";
import { decodeStructuredAnalysisResult } from "./structuredData";
import { decodeKnowledgeVisualAnalysisResult } from "./visualEvidence";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRerankerBindingEvidence,
  KnowledgeRetrievalLane
} from "./retrievalRanking";
import {
  decodeKnowledgeRerankerBindingEvidenceV2,
  KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
  type KnowledgeRerankerBindingEvidenceV2
} from "./rerankEvidence";
import { decodeKnowledgeParentExpansionEvidence } from "./parentContextExpansion";

function persistedContentMarker(version: KnowledgeResultVersion) {
  return Object.freeze({
    type: "json" as const,
    value: Object.freeze({ aiqsaType: "knowledge_result", version })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isKnowledgeResultVersion(value: unknown): value is KnowledgeResultVersion {
  return KNOWLEDGE_RESULT_VERSIONS.includes(value as KnowledgeResultVersion);
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
    value === "embedding_model_unavailable" || value === "source_location_unavailable" ||
    value === "no_relevant_evidence" || value === "zero_above_threshold"
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
      eligibleRows < 1 || efSearch === null || efSearch < 1 ||
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
  const tokenizerProfile = value.tokenizerProfile === undefined
    ? undefined
    : boundedString(value.tokenizerProfile, 128);
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
    tokenizerProfile === null ||
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
    ...(tokenizerProfile ? { tokenizerProfile } : {}),
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

function decodePassage(
  value: unknown,
  version: KnowledgeResultVersion,
  historicalAnalysis = false
): KnowledgeRetrievedPassageEvidence | null {
  if (!isRecord(value)) return null;
  const annRank = nullablePositiveRank(value.annRank);
  const baseName = boundedString(value.baseName, 512);
  const bindingOrdinal = nonNegativeInteger(value.bindingOrdinal);
  const chunkId = boundedString(value.chunkId, 512);
  const chunkIndex = nonNegativeInteger(value.chunkIndex);
  const documentId = boundedString(value.documentId, 512);
  const documentContext = value.documentContext === undefined
    ? undefined
    : value.documentContext === null
      ? null
      : decodeKnowledgeDocumentContext(value.documentContext);
  const documentVersionId = boundedString(value.documentVersionId, 512);
  const documentVersionNumber = nonNegativeInteger(value.documentVersionNumber);
  const expandedContext = value.expandedContext === undefined
    ? undefined
    : boundedString(value.expandedContext, 64 * 1024, true);
  const expansion = value.expansion === undefined
    ? undefined
    : decodeKnowledgeParentExpansionEvidence(value.expansion);
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
    : value.layoutKind === "body" || value.layoutKind === "field_ambiguous" ||
      value.layoutKind === "field_pair" || value.layoutKind === "table_ambiguous" ||
      value.layoutKind === "table_row" || value.layoutKind === "table_row_projection"
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
    : historicalAnalysis
      ? decodeStructuredAnalysisResult(value.structuredAnalysis) ?? null
      : null;
  const visualAnalysis = value.visualAnalysis === undefined
    ? undefined
    : historicalAnalysis
      ? decodeKnowledgeVisualAnalysisResult(value.visualAnalysis) ?? null
      : null;
  const advanced = signalProvenance !== undefined;
  const legacyRankingMetrics = version === KNOWLEDGE_LEGACY_RESULT_VERSION;
  const expectedFusedScore = (annRank === null || annRank === undefined ? 0 : 1 / (60 + annRank)) +
    (ftsRank === null || ftsRank === undefined ? 0 : 1 / (60 + ftsRank));
  if (
    annRank === undefined || !baseName || bindingOrdinal === null ||
    bindingOrdinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    !chunkId || chunkIndex === null || !documentId || !documentVersionId ||
    documentContext === null && value.documentContext !== null ||
    (documentVersionNumber === null || documentVersionNumber < 1) || !fileName ||
    expandedContext === null || expansion === null ||
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
    (version === KNOWLEDGE_RESULT_VERSION && (
      !sourceAlias || !sourceArtifactId || !sourceName ||
      confidence !== undefined ||
      rerankScore !== undefined && rerankScore !== null &&
        (rerankScore < 0 || rerankScore > 1)
    )) ||
    (!advanced && Math.abs(fusedScore - expectedFusedScore) > 1e-12) ||
    (advanced && (
      signalProvenance === null || signalProvenance.length < 1 ||
      signalProvenance.some((signal) => signal === null) ||
      !contentHash || !/^[0-9a-f]{64}$/u.test(contentHash) || headingPath === null ||
      legacyRankingMetrics && (
        confidence === null || confidence === undefined || confidence < 0 || confidence > 1 ||
        rerankScore === undefined || rerankScore !== null && (rerankScore < 0 || rerankScore > 1)
      ) ||
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
    ...(documentContext !== undefined ? { documentContext } : {}),
    documentVersionId,
    documentVersionNumber,
    ...(expandedContext !== undefined ? { expandedContext } : {}),
    ...(expansion !== undefined ? { expansion } : {}),
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

/** Strict decoder for one persisted result used by reauthorized citation reads. */
export function decodeKnowledgeRetrievedPassage(
  value: unknown
): KnowledgeRetrievedPassageEvidence | null {
  return decodePassage(value, KNOWLEDGE_LEGACY_RESULT_VERSION, true);
}

export function decodeKnowledgeRetrievedPassageForVersion(
  value: unknown,
  version: KnowledgeResultVersion
): KnowledgeRetrievedPassageEvidence | null {
  return decodePassage(value, version);
}

type KnowledgeProviderEvidence = Pick<KnowledgeRetrievalEvidence,
  "budget" | "discovery" | "embeddingExecutions" | "exact" | "failureCode" | "outcome" |
  "results" | "scopeAliases"> &
  Partial<Pick<KnowledgeRetrievalEvidence, "version">>;

function legacyKnowledgeToolResultText(evidence: KnowledgeProviderEvidence): string {
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
          const layoutWarning = result.layoutKind === "table_ambiguous" ||
            result.layoutKind === "field_ambiguous" ||
            (result.documentContext?.ambiguityReasons.length ?? 0) > 0
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
      "Knowledge passages grouped by immutable Source:",
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
    no_relevant_evidence:
      "No relevant Knowledge evidence was found. Do not infer or invent an answer from Knowledge.",
    source_location_unavailable:
      "The requested location was not found inside that admitted Source. Use another exact heading, page, or evidence handle; do not guess.",
    zero_above_threshold:
      "Knowledge retrieval found no passage above the configured threshold: zero_above_threshold."
  };
  return message[evidence.outcome];
}

function sourceBoundKnowledgeToolResultText(evidence: KnowledgeProviderEvidence): string {
  const compact = (value: string, maximum = 240): string => value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
  if (evidence.discovery) {
    if (evidence.outcome !== "complete") {
      return "No admitted ready Source matched the requested metadata fields. " +
        "No passage or document body was searched.";
    }
    const sources = evidence.discovery.sources.map((source) => [
      `--- BEGIN DISCOVERED SOURCE ${source.sourceAlias} ---`,
      `Alias: ${source.sourceAlias}`,
      `Source: ${compact(source.sourceName)}`,
      `File: ${compact(source.fileName)}`,
      `Version: ${source.sourceVersionNumber}`,
      `Readiness: ${source.readiness}`,
      `Matched metadata: ${source.matchedFields.join(", ")}`,
      `Ambiguous: ${source.ambiguous ? "yes" : "no"}`,
      `--- END DISCOVERED SOURCE ${source.sourceAlias} ---`
    ].join("\n"));
    return [
      "Admitted ready Sources matched by metadata only (document bodies were not searched):",
      ...sources,
      "Use only these S-number aliases for a subsequent scoped Knowledge request."
    ].join("\n\n");
  }
  if (evidence.exact && evidence.outcome !== "complete") {
    return `No exact ${evidence.exact.match} match was found in field ` +
      `${evidence.exact.field} with ${evidence.exact.caseMode} case matching.`;
  }
  if (evidence.outcome !== "complete") return legacyKnowledgeToolResultText(evidence);
  const sourceAliases = new Set(evidence.scopeAliases?.flatMap((entry) =>
    entry.kind === "source" ? [entry.alias] : []) ?? []);
  const exactByResult = new Map(evidence.exact?.matches.map((match) => [
    match.resultOrdinal,
    match.field
  ]) ?? []);
  const atomicProjectionGroups = new Map<string, Array<{
    handle: string;
    locator: KnowledgeTableRowProjectionLocatorV1;
  }>>();
  for (const result of evidence.results) {
    const context = result.documentContext;
    const locator = context?.locator;
    if (result.textTruncated || context?.ambiguityReasons.length !== 0 ||
      locator?.kind !== "table_row_projection") continue;
    const key = [
      result.sourceAlias,
      result.sourceArtifactId,
      result.documentId,
      result.documentVersionId,
      locator.blockId,
      locator.rowId,
      locator.rowIndex
    ].join("\u001f");
    const group = atomicProjectionGroups.get(key) ?? [];
    group.push({ handle: result.handle, locator });
    atomicProjectionGroups.set(key, group);
  }
  const combinableRows = [...atomicProjectionGroups.values()].flatMap((group) => {
    const ordered = [...group].sort((left, right) =>
      left.locator.projectionIndex - right.locator.projectionIndex);
    if (!isCompleteKnowledgeTableRowProjectionSequence(
      ordered.map((item) => item.locator)
    ) || ordered.some((item) =>
      item.locator.blockId !== ordered[0]!.locator.blockId ||
      item.locator.rowId !== ordered[0]!.locator.rowId ||
      item.locator.rowIndex !== ordered[0]!.locator.rowIndex
    )) return [];
    const locator = canonicalReadSourceLocator({
      kind: "row",
      rowId: ordered[0]!.locator.rowId
    });
    return locator ? [{
      handles: ordered.map((item) => item.handle),
      locator
    }] : [];
  });
  const blocks = evidence.results.map((result, resultOrdinal) => {
    const sourceName = result.sourceName ? compact(result.sourceName) : "";
    const fileName = result.fileName ? compact(result.fileName) : "";
    const sourceArtifactId = typeof result.sourceArtifactId === "string"
      ? result.sourceArtifactId.trim()
      : "";
    const sourceAlias = result.sourceAlias;
    if (
      !sourceName || !fileName || !sourceArtifactId || !sourceAlias ||
      !/^S[1-9]\d{0,2}$/u.test(sourceAlias) || !sourceAliases.has(sourceAlias) ||
      !result.documentVersionId || !Number.isSafeInteger(result.documentVersionNumber) ||
      result.documentVersionNumber < 1
    ) throw new Error("knowledge_v2_source_binding_required");
    const heading = result.headingPath && result.headingPath.length > 0
      ? compact(result.headingPath.join(" › "))
      : "document root";
    const ambiguity = result.layoutKind === "table_ambiguous" ||
      result.layoutKind === "field_ambiguous" ||
      (result.documentContext?.ambiguityReasons.length ?? 0) > 0
      ? "table cell associations are ambiguous; do not pair labels and values"
      : "none";
    const documentLocator = result.documentContext?.locator;
    const rowLocator = documentLocator?.kind === "table_row" ||
      documentLocator?.kind === "table_row_projection"
      ? canonicalReadSourceLocator({ kind: "row", rowId: documentLocator.rowId })
      : null;
    return [
      `--- BEGIN SOURCE EVIDENCE ${result.handle} ---`,
      `[${result.handle}] [${sourceAlias}]`,
      `Source: ${sourceName}`,
      `File: ${fileName}`,
      `Version/date: version ${result.documentVersionNumber}`,
      `Page: ${result.page}`,
      `Heading: ${heading}`,
      `Locator: page=${result.page}; heading=${heading}`,
      ...(rowLocator ? [`Read locator: ${rowLocator}`] : []),
      `Truncated: ${result.textTruncated ? "yes" : "no"}`,
      `Ambiguity: ${ambiguity}`,
      ...(evidence.exact ? [
        `Exact match: mode=${evidence.exact.match}; case=${evidence.exact.caseMode}; ` +
          `field=${exactByResult.get(resultOrdinal) ?? "unknown"}`
      ] : []),
      "Evidence:",
      result.includedText,
      ...(result.expandedContext ? [
        "Related same-Source context (each labeled segment is independent evidence):",
        result.expandedContext
      ] : []),
      `--- END SOURCE EVIDENCE ${result.handle} ---`
    ].join("\n");
  });
  return [
    "Knowledge passages as atomic Source-bound evidence:",
    ...blocks,
    "Treat every SOURCE EVIDENCE block as independent. Keep each date, label, value, and " +
      "citation inside its own Source; never combine fields from different blocks" +
      (combinableRows.length > 0 ? " except within an explicitly listed complete atomic row" : "") +
      ". Use the citation handles exactly when referencing these passages.",
    ...(combinableRows.length > 0 ? [
      "Complete atomic row groups (combine fields only within each listed group):\n" +
        combinableRows.map((row) =>
          `${row.locator}: ${row.handles.map((handle) => `[${handle}]`).join(" ")}`
        ).join("\n")
    ] : []),
    evidence.budget?.stopReason
      ? ""
      : "For a request with several rows, fields, or items, verify each one independently. " +
        "The requested label and value must occur together inside the primary Evidence section, " +
        "one labeled related-context segment, or one listed complete atomic row; never combine " +
        "fields across those segments. Call search_knowledge again with one exact missing " +
        "item per query. When earlier evidence identifies the relevant Source, pass only its " +
        "exact [S…] alias in sourceAliases. Do not finalize or declare insufficient evidence " +
        "until each such source-scoped follow-up has been attempted while budget remains; a " +
        "nearby or similarly named row is not a substitute.",
    evidence.budget?.stopReason
      ? "No further private Knowledge retrieval should be requested. State any material coverage limitation plainly."
      : ""
  ].filter(Boolean).join("\n\n");
}

export function knowledgeToolResultText(evidence: KnowledgeProviderEvidence): string {
  if (evidence.version === undefined || evidence.version === KNOWLEDGE_LEGACY_RESULT_VERSION) {
    return legacyKnowledgeToolResultText(evidence);
  }
  if (evidence.version === KNOWLEDGE_RESULT_VERSION) {
    const text = sourceBoundKnowledgeToolResultText(evidence);
    const limitations = [
      ...(evidence.failureCode === "partial_sources_ready" ? [
        "Coverage limitation: partial_sources_ready. Some selected Knowledge sources were " +
          "still processing or unavailable, so this bounded result covers only the ready subset."
      ] : []),
      ...(evidence.failureCode === "semantic_retrieval_unavailable" ||
        evidence.embeddingExecutions.some((execution) => execution.status === "error") ? [
        "Coverage limitation: semantic_retrieval_unavailable. Retrieval used lexical, metadata, " +
          "and exact evidence only; do not infer unavailable semantic matches."
      ] : [])
    ];
    return limitations.length > 0 ? `${text}\n\n${limitations.join("\n\n")}` : text;
  }
  throw new Error("knowledge_result_version_unsupported");
}

function decodeBudgetUsage(value: unknown): KnowledgeBudgetUsage | null {
  if (!isRecord(value)) return null;
  const keys = [
    "cumulativeCandidates",
    "estimatedCostMicros",
    "latencyMs",
    "operations",
    "queryEmbeddingCalls",
    "retrievedTokens"
  ] as const;
  if (Object.keys(value).length !== keys.length || keys.some((key) =>
    !Object.hasOwn(value, key) || nonNegativeInteger(value[key]) === null)) return null;
  return Object.fromEntries(keys.map((key) => [key, Number(value[key])])) as KnowledgeBudgetUsage;
}

function decodeLegacyBudgetUsage(value: unknown): LegacyKnowledgeBudgetUsage | null {
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
  if (!isRecord(value) || !exactKeys(value, keys) || keys.some((key) =>
    nonNegativeInteger(value[key]) === null)) return null;
  return Object.fromEntries(keys.map((key) => [key, Number(value[key])])) as
    LegacyKnowledgeBudgetUsage;
}

function decodeBudgetEvidence(value: unknown): KnowledgeBudgetEvidence | null {
  if (!isRecord(value) || !exactKeys(value, ["operation", "stopReason", "usage", "version"]) ||
    value.version !== 1 || !isKnowledgeOperationKind(value.operation) ||
    value.stopReason !== null && !knowledgeBudgetStopReasons.includes(
      value.stopReason as (typeof knowledgeBudgetStopReasons)[number]
    )) return null;
  const usage = decodeBudgetUsage(value.usage);
  if (!usage) return null;
  return {
    operation: value.operation,
    stopReason: value.stopReason as KnowledgeBudgetEvidence["stopReason"],
    usage,
    version: 1
  };
}

function decodeLegacyBudgetEvidence(value: unknown): LegacyKnowledgeBudgetEvidence | null {
  const legacyStopReasons = new Set([
    ...knowledgeBudgetStopReasons,
    "follow_up_budget",
    "low_novelty",
    "phase_budget",
    "reranker_budget",
    "subquery_budget"
  ]);
  if (!isRecord(value) || !exactKeys(value, [
    "noveltyRatio", "operation", "stopReason", "usage", "version"
  ]) || value.version !== 1 || !isKnowledgeOperationKind(value.operation) ||
    value.stopReason !== null && (
      typeof value.stopReason !== "string" || !legacyStopReasons.has(value.stopReason)
    ) || value.noveltyRatio !== null && (
      typeof value.noveltyRatio !== "number" || !Number.isFinite(value.noveltyRatio) ||
      value.noveltyRatio < 0 || value.noveltyRatio > 1
    )) return null;
  const usage = decodeLegacyBudgetUsage(value.usage);
  if (!usage) return null;
  return {
    noveltyRatio: value.noveltyRatio as number | null,
    operation: value.operation,
    stopReason: value.stopReason as LegacyKnowledgeBudgetEvidence["stopReason"],
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
  if (value.egress !== "none" || value.version !== 1 ||
    value.languages.length !== 2 || value.languages[0] !== "en" ||
    value.languages[1] !== "ru") return null;
  if (value.status === "complete") {
    return value.kind === "deterministic_token_vector_heuristic" &&
      value.profile === "deterministic-token-vector-heuristic-v1" &&
      value.failureCode === undefined
      ? {
          egress: "none",
          kind: "deterministic_token_vector_heuristic",
          languages: ["en", "ru"],
          profile: "deterministic-token-vector-heuristic-v1",
          status: "complete",
          version: 1
        }
      : null;
  }
  return value.status === "degraded" &&
    value.kind === "deterministic_weighted_rrf_fallback" &&
    value.profile === "weighted-rrf-v2" &&
    value.failureCode === "knowledge_reranker_unavailable"
    ? {
        egress: "none",
        failureCode: "knowledge_reranker_unavailable",
        kind: "deterministic_weighted_rrf_fallback",
        languages: ["en", "ru"],
        profile: "weighted-rrf-v2",
        status: "degraded",
        version: 1
      }
    : null;
}

function decodeCandidateOrder(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) || value.length > 1_000 ||
    value.some((entry) => typeof entry !== "string" || !entry || entry.length > 512) ||
    new Set(value).size !== value.length
  ) return null;
  return value as string[];
}

function readSourceTargetMatches(value: unknown, target: ReadSourceLocator): boolean {
  if (!isRecord(value) || value.kind !== target.kind) return false;
  switch (target.kind) {
    case "evidence_handle":
      return hasOnlyKeys(value, ["handle", "kind"]) && value.handle === target.handle;
    case "page":
      return hasOnlyKeys(value, ["kind", "page"]) && value.page === target.page;
    case "heading":
      return hasOnlyKeys(value, ["headingPath", "kind"]) &&
        Array.isArray(value.headingPath) && value.headingPath.length === target.headingPath.length &&
        value.headingPath.every((entry, index) => entry === target.headingPath[index]);
    case "section":
      return hasOnlyKeys(value, ["kind", "sectionId"]) && value.sectionId === target.sectionId;
    case "passage":
      return hasOnlyKeys(value, ["kind", "passageId"]) && value.passageId === target.passageId;
    case "block":
      return hasOnlyKeys(value, ["blockId", "kind"]) && value.blockId === target.blockId;
    case "row":
      return hasOnlyKeys(value, ["kind", "rowId"]) && value.rowId === target.rowId;
    case "structured_range":
      return hasOnlyKeys(value, ["kind", "range", "sheet"]) &&
        value.range === target.range && value.sheet === target.sheet;
  }
}

function decodeReadResolvedSource(value: unknown): KnowledgeReadResolvedSource | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "sourceAlias",
    "sourceArtifactId",
    "sourceId",
    "sourceName",
    "sourceVersionId"
  ]) || Object.keys(value).length !== 5 ||
    typeof value.sourceAlias !== "string" || !/^S[1-9]\d{0,2}$/u.test(value.sourceAlias)) {
    return null;
  }
  const sourceArtifactId = boundedString(value.sourceArtifactId, 512);
  const sourceId = boundedString(value.sourceId, 512);
  const sourceName = boundedString(value.sourceName, 1_024);
  const sourceVersionId = boundedString(value.sourceVersionId, 512);
  return sourceArtifactId && sourceId && sourceName && sourceVersionId
    ? {
        sourceAlias: value.sourceAlias,
        sourceArtifactId,
        sourceId,
        sourceName,
        sourceVersionId
      }
    : null;
}

function decodeReadReceipt(value: unknown): KnowledgeReadReceipt | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "contractVersion",
    "direction",
    "embedding",
    "locator",
    "resolution",
    "resolvedSource",
    "target",
    "version",
    "window"
  ]) || Object.keys(value).length !== 9 || value.version !== 1 ||
    value.contractVersion !== 1 || value.embedding !== "forbidden" ||
    value.resolution !== "exact") return null;
  const normalized = normalizeReadSourceRequest({
    direction: value.direction,
    locator: value.locator,
    window: value.window
  });
  const resolvedSource = decodeReadResolvedSource(value.resolvedSource);
  return normalized && resolvedSource && readSourceTargetMatches(value.target, normalized.target)
    ? Object.freeze({ ...normalized, resolvedSource, version: 1 as const })
    : null;
}

const discoveryFieldOrder: readonly KnowledgeSourceDiscoveryField[] = [
  "filename",
  "heading",
  "source_name",
  "tag",
  "title"
];
const discoveryFieldSet = new Set<KnowledgeSourceDiscoveryField>(discoveryFieldOrder);
const exactFieldSet = new Set(["any", "body", "filename", "heading", "tag", "title"]);
const exactResultFieldSet = new Set(["body", "filename", "heading", "tag", "title"]);

function exactCursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const match = /^1:(0|[1-9]\d*)$/u.exec(decoded);
  const offset = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 10_000 &&
    Buffer.from(`1:${offset}`, "utf8").toString("base64url") === value
    ? value
    : undefined;
}

function decodeExactEvidence(value: unknown): KnowledgeExactRetrievalEvidence | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "caseMode",
    "cursor",
    "field",
    "limit",
    "match",
    "matches",
    "nextCursor",
    "scannedBytes",
    "scanTruncated",
    "value",
    "version"
  ]) || Object.keys(value).length !== 11 || value.version !== 1 ||
    value.caseMode !== "insensitive" && value.caseMode !== "sensitive" ||
    typeof value.field !== "string" || !exactFieldSet.has(value.field) ||
    value.match !== "pattern" && value.match !== "phrase" && value.match !== "token" ||
    !Array.isArray(value.matches) || value.matches.length > 100 ||
    typeof value.scanTruncated !== "boolean") return null;
  const cursor = exactCursor(value.cursor);
  const nextCursor = exactCursor(value.nextCursor);
  const limit = nonNegativeInteger(value.limit);
  const scannedBytes = nonNegativeInteger(value.scannedBytes);
  const exactValue = boundedString(value.value, 500);
  const matches = value.matches.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 ||
      typeof entry.field !== "string" || !exactResultFieldSet.has(entry.field)) return null;
    const resultOrdinal = nonNegativeInteger(entry.resultOrdinal);
    return resultOrdinal === null || resultOrdinal >= 100
      ? null
      : { field: entry.field, resultOrdinal };
  });
  if (cursor === undefined || nextCursor === undefined || limit === null || limit < 1 ||
    limit > 100 || !exactValue || scannedBytes === null || scannedBytes > 4 * 1024 * 1024 ||
    matches.some((entry) => entry === null)) return null;
  return Object.freeze({
    caseMode: value.caseMode,
    cursor,
    field: value.field as KnowledgeExactRetrievalEvidence["field"],
    limit,
    match: value.match,
    matches: Object.freeze(matches as KnowledgeExactMatchEvidence[]),
    nextCursor,
    scannedBytes,
    scanTruncated: value.scanTruncated,
    value: exactValue,
    version: 1
  });
}

function decodeDiscoveryEvidence(value: unknown): KnowledgeSourceDiscoveryEvidence | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "cursor",
    "fields",
    "limit",
    "nextCursor",
    "query",
    "sources",
    "version"
  ]) || Object.keys(value).length !== 7 || value.version !== 1 ||
    !Array.isArray(value.fields) || value.fields.length < 1 ||
    value.fields.length > discoveryFieldOrder.length ||
    !Array.isArray(value.sources) || value.sources.length > 100) return null;
  const cursor = exactCursor(value.cursor);
  const nextCursor = exactCursor(value.nextCursor);
  const limit = nonNegativeInteger(value.limit);
  const query = boundedString(value.query, 3_000);
  const fields = value.fields as unknown[];
  if (fields.some((field) => typeof field !== "string" ||
    !discoveryFieldSet.has(field as KnowledgeSourceDiscoveryField)) ||
    new Set(fields).size !== fields.length ||
    fields.some((field, index) => discoveryFieldOrder[index] !== field &&
      discoveryFieldOrder.indexOf(field as KnowledgeSourceDiscoveryField) <=
        discoveryFieldOrder.indexOf(fields[index - 1] as KnowledgeSourceDiscoveryField)) ||
    cursor === undefined || nextCursor === undefined || limit === null || limit < 1 ||
    limit > 100 || !query || query.length < 2) return null;
  const selectedFields = new Set(fields as KnowledgeSourceDiscoveryField[]);
  const sources = value.sources.map((source) => {
    if (!isRecord(source) || !hasOnlyKeys(source, [
      "ambiguous",
      "fileName",
      "matchedFields",
      "readiness",
      "sourceAlias",
      "sourceName",
      "sourceVersionNumber"
    ]) || Object.keys(source).length !== 7 || typeof source.ambiguous !== "boolean" ||
      typeof source.sourceAlias !== "string" || !/^S[1-9]\d{0,2}$/u.test(source.sourceAlias) ||
      source.readiness !== "ready" || !Array.isArray(source.matchedFields) ||
      source.matchedFields.length < 1 || source.matchedFields.length > fields.length) return null;
    const fileName = boundedString(source.fileName, 1_024);
    const sourceName = boundedString(source.sourceName, 1_024);
    const sourceVersionNumber = nonNegativeInteger(source.sourceVersionNumber);
    const matchedFields = source.matchedFields as unknown[];
    if (!fileName || !sourceName || sourceVersionNumber === null || sourceVersionNumber < 1 ||
      matchedFields.some((field) => typeof field !== "string" ||
        !selectedFields.has(field as KnowledgeSourceDiscoveryField)) ||
      new Set(matchedFields).size !== matchedFields.length) return null;
    const selected = new Set(matchedFields as KnowledgeSourceDiscoveryField[]);
    return Object.freeze({
      ambiguous: source.ambiguous,
      fileName,
      matchedFields: Object.freeze(discoveryFieldOrder.filter((field) => selected.has(field))),
      readiness: "ready" as const,
      sourceAlias: source.sourceAlias,
      sourceName,
      sourceVersionNumber
    });
  });
  if (sources.some((source) => source === null)) return null;
  return Object.freeze({
    cursor,
    fields: Object.freeze(fields as KnowledgeSourceDiscoveryField[]),
    limit,
    nextCursor,
    query,
    sources: Object.freeze(sources as NonNullable<typeof sources[number]>[]),
    version: 1
  });
}

export function decodeKnowledgeRetrievalEvidence(value: unknown): KnowledgeRetrievalEvidence | null {
  if (!isRecord(value) || !isKnowledgeResultVersion(value.version) ||
    !Array.isArray(value.bases) || value.bases.length < 1 ||
    value.bases.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    !Array.isArray(value.embeddingExecutions) ||
    value.embeddingExecutions.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
    !Array.isArray(value.results) || value.results.length > 100) return null;
  const bases = value.bases.map(decodeBase);
  const budget = value.budget === undefined
    ? undefined
    : value.version === KNOWLEDGE_LEGACY_RESULT_VERSION
      ? decodeLegacyBudgetEvidence(value.budget)
      : decodeBudgetEvidence(value.budget);
  const embeddingExecutions = value.embeddingExecutions.map(decodeEmbedding);
  const version = value.version;
  const results = value.results.map((entry) => decodePassage(entry, version));
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const candidateLimit = nonNegativeInteger(value.candidateLimit);
  const durationMs = nonNegativeInteger(value.durationMs);
  const invocationOrdinal = nonNegativeInteger(value.invocationOrdinal);
  const operation = value.operation === undefined
    ? undefined
    : isKnowledgeOperationKind(value.operation) ? value.operation : null;
  const read = value.read === undefined
    ? undefined
    : version === KNOWLEDGE_RESULT_VERSION
      ? decodeReadReceipt(value.read) ?? null
      : null;
  const exact = value.exact === undefined
    ? undefined
    : version === KNOWLEDGE_RESULT_VERSION
      ? decodeExactEvidence(value.exact) ?? null
      : null;
  const discovery = value.discovery === undefined
    ? undefined
    : version === KNOWLEDGE_RESULT_VERSION
      ? decodeDiscoveryEvidence(value.discovery) ?? null
      : null;
  const scopeAliases = value.scopeAliases === undefined
    ? undefined
    : Array.isArray(value.scopeAliases) && value.scopeAliases.length <= 256
      ? value.scopeAliases.map(decodeScopeAlias)
      : null;
  const decodedOutcome = outcome(value.outcome);
  const providerText = boundedString(value.providerText, 64 * 1024);
  const query = boundedString(value.query, 3_000);
  const resultLimit = nonNegativeInteger(value.resultLimit);
  const threshold = value.threshold === undefined ? undefined : finiteNumber(value.threshold);
  const fusion = value.fusion === "none" || value.fusion === "rrf_k60" ||
    value.fusion === "weighted_rrf_v2"
    ? value.fusion
    : null;
  const rerankerBinding = value.rerankerBinding === undefined
    ? undefined
    : value.rerankerBinding === null
      ? null
      : isRecord(value.rerankerBinding) &&
          value.rerankerBinding.version === KNOWLEDGE_RERANKER_EVIDENCE_VERSION
        ? decodeKnowledgeRerankerBindingEvidenceV2(value.rerankerBinding)
        : decodeRerankerBinding(value.rerankerBinding);
  const rerankerBindingV2: KnowledgeRerankerBindingEvidenceV2 | null =
    rerankerBinding && rerankerBinding.version === KNOWLEDGE_RERANKER_EVIDENCE_VERSION
      ? rerankerBinding
      : null;
  const preRerankOrder = value.preRerankOrder === undefined
    ? undefined
    : value.preRerankOrder === null ? null : decodeCandidateOrder(value.preRerankOrder);
  const postRerankOrder = value.postRerankOrder === undefined
    ? undefined
    : value.postRerankOrder === null ? null : decodeCandidateOrder(value.postRerankOrder);
  const legacyRankingFields = value.threshold !== undefined ||
    value.preRerankOrder !== undefined || value.postRerankOrder !== undefined ||
    value.rerankerBinding !== undefined && !rerankerBindingV2;
  const completeLegacyRankingFields = value.threshold !== undefined &&
    value.rerankerBinding !== undefined && value.preRerankOrder !== undefined &&
    value.postRerankOrder !== undefined;
  const failureCode = value.failureCode === undefined
    ? undefined
    : boundedString(value.failureCode, 128);
  if (
    bases.some((base) => base === null) || budget === null || operation === null || read === null ||
    exact === null || discovery === null || value.structured !== undefined ||
    value.visual !== undefined ||
    [read, exact, discovery].filter((entry) => entry !== undefined).length > 1 ||
    scopeAliases === null || scopeAliases?.some((alias) => alias === null) ||
    (version === KNOWLEDGE_LEGACY_RESULT_VERSION &&
      (budget === undefined) !== (operation === undefined)) ||
    budget !== undefined && budget.operation !== operation ||
    read !== undefined && (operation !== "read_source" || query !== read.locator) ||
    exact !== undefined && (operation !== "find_exact" || query !== exact.value) ||
    discovery !== undefined && (operation !== "discover_sources" || query !== discovery.query) ||
    embeddingExecutions.some((entry) => entry === null) ||
    results.some((result) => result === null) || candidateCount === null || candidateLimit === null ||
    candidateLimit < 1 || durationMs === null || invocationOrdinal === null || invocationOrdinal < 1 ||
    invocationOrdinal > 256 || !decodedOutcome || !fusion ||
    !providerText || !query ||
    (value.rerankerBinding !== undefined && value.rerankerBinding !== null &&
      rerankerBinding === null) ||
    (value.preRerankOrder !== undefined && value.preRerankOrder !== null &&
      preRerankOrder === null) ||
    (value.postRerankOrder !== undefined && value.postRerankOrder !== null &&
      postRerankOrder === null) ||
    (version === KNOWLEDGE_RESULT_VERSION && legacyRankingFields) ||
    (version === KNOWLEDGE_RESULT_VERSION && value.rerankerBinding === null) ||
    (version === KNOWLEDGE_LEGACY_RESULT_VERSION &&
      (!completeLegacyRankingFields || rerankerBindingV2 !== null)) ||
    (fusion === "none" && (
      rerankerBinding != null || preRerankOrder != null || postRerankOrder != null
    )) ||
    (fusion === "rrf_k60" && (
      rerankerBinding != null || preRerankOrder != null || postRerankOrder != null
    )) ||
    (version === KNOWLEDGE_LEGACY_RESULT_VERSION && fusion === "weighted_rrf_v2" && (
      rerankerBinding == null || preRerankOrder == null || postRerankOrder == null
    )) ||
    resultLimit === null || resultLimit < 1 ||
    resultLimit > (exact || discovery
      ? 100
      : KNOWLEDGE_RESULT_LIMIT) ||
    threshold !== undefined && (threshold === null || threshold < 0 || threshold > 1) ||
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
    ...(discovery ? { discovery } : {}),
    durationMs,
    embeddingExecutions: embeddingExecutions as KnowledgeEmbeddingExecutionEvidence[],
    ...(exact ? { exact } : {}),
    ...(failureCode ? { failureCode } : {}),
    fusion,
    invocationOrdinal,
    ...(operation ? { operation } : {}),
    outcome: decodedOutcome,
    ...(postRerankOrder !== undefined ? { postRerankOrder } : {}),
    ...(preRerankOrder !== undefined ? { preRerankOrder } : {}),
    providerText,
    query,
    ...(read ? { read } : {}),
    ...(rerankerBinding !== undefined ? { rerankerBinding } : {}),
    resultLimit,
    results: decodedResults,
    ...(scopeAliases ? { scopeAliases: scopeAliases as KnowledgeEvidenceScopeAlias[] } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    version
  };
  let renderedProviderText: string | null = null;
  try {
    renderedProviderText = knowledgeToolResultText(evidence);
  } catch {
    // Current evidence must be renderable without synthesizing Source labels.
  }
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
  const resultHandles = decodedResults.map((result) =>
    decodeKnowledgeCitationHandle(result.handle));
  const sourceAliases = scopeAliases?.filter((alias): alias is KnowledgeEvidenceScopeAlias =>
    alias !== null && alias.kind === "source") ?? [];
  const v2SourceBindings = new Map<string, Set<string>>();
  const v2Aliases = new Map<string, Set<string>>();
  if (version === KNOWLEDGE_RESULT_VERSION) {
    for (const result of decodedResults) {
      const identity = `${result.sourceArtifactId}\u0000${result.documentVersionId}`;
      const binding = [
        result.sourceAlias,
        result.sourceName,
        result.fileName,
        String(result.documentVersionNumber)
      ].join("\u0000");
      const bindings = v2SourceBindings.get(identity) ?? new Set<string>();
      bindings.add(binding);
      v2SourceBindings.set(identity, bindings);
      const identities = v2Aliases.get(result.sourceAlias!) ?? new Set<string>();
      identities.add(identity);
      v2Aliases.set(result.sourceAlias!, identities);
    }
  }
  const invalidV2SourceBindings = version === KNOWLEDGE_RESULT_VERSION && (
    new Set(sourceAliases.map((alias) => alias.alias)).size !== sourceAliases.length ||
    new Set(decodedResults.map((result) => [
      result.sourceArtifactId,
      result.documentVersionId,
      result.chunkId
    ].join("\u0000"))).size !== decodedResults.length ||
    [...v2SourceBindings.values()].some((bindings) => bindings.size !== 1) ||
    [...v2Aliases.values()].some((identities) => identities.size !== 1)
  );
  const invalidReadSource = read !== undefined && (
    !sourceAliases.some((alias) => alias.alias === read.resolvedSource.sourceAlias &&
      alias.label === read.resolvedSource.sourceName) ||
    decodedResults.some((result) =>
      result.sourceAlias !== read.resolvedSource.sourceAlias ||
      result.sourceArtifactId !== read.resolvedSource.sourceArtifactId ||
      result.documentId !== read.resolvedSource.sourceId ||
      result.documentVersionId !== read.resolvedSource.sourceVersionId)
  );
  const retrievalCompleted = decodedOutcome === "base_empty" || decodedOutcome === "complete" ||
    decodedOutcome === "no_relevant_evidence" || decodedOutcome === "zero_above_threshold";
  const embeddingDegraded = Boolean(failureCode) || failedEmbeddingOrdinals.size > 0;
  const deterministicRead = operation === "read_source";
  const deterministicExact = operation === "find_exact";
  const deterministicDiscovery = operation === "discover_sources";
  const deterministicOperation = deterministicRead || deterministicExact ||
    deterministicDiscovery;
  const embeddingForbidden = deterministicOperation;
  const invalidExact = exact !== undefined && (
    fusion !== "none" || (threshold ?? 0) !== 0 || candidateCount !== decodedResults.length ||
    exact.limit !== resultLimit || exact.limit !== candidateLimit ||
    exact.matches.length !== decodedResults.length ||
    exact.matches.some((match, index) => match.resultOrdinal !== index ||
      exact.field !== "any" && match.field !== exact.field) ||
    decodedResults.some((result) => result.annRank !== null || result.ftsRank !== null ||
      result.ftsScore !== null || result.vectorDistance !== null || result.vectorScore !== null ||
      result.fusedScore !== 0 || result.signalProvenance !== undefined)
  );
  const discoveryAliases = new Map(sourceAliases.map((alias) => [alias.alias, alias.label]));
  const invalidDiscovery = discovery !== undefined && (
    fusion !== "none" || (threshold ?? 0) !== 0 || decodedResults.length !== 0 ||
    candidateCount !== discovery.sources.length || discovery.limit !== resultLimit ||
    discovery.limit !== candidateLimit || sourceAliases.length !== discovery.sources.length ||
    discovery.sources.some((source) =>
      discoveryAliases.get(source.sourceAlias) !== source.sourceName)
  );
  if (
    new Set(ordinals).size !== ordinals.length ||
    new Set(embeddedOrdinals).size !== embeddedOrdinals.length ||
    embeddedOrdinals.some((ordinal) => !ordinals.includes(ordinal)) ||
    decodedBases.some((base, index) => index > 0 &&
      base.ordinal <= decodedBases[index - 1]!.ordinal) ||
    decodedBases.some((base) => base.state !== (
      base.indexedContentRevision < base.baseContentRevision
        ? "indexing"
        : base.candidateCount === 0 && !deterministicOperation ? "empty" : "ready"
    )) ||
    decodedBases.reduce((total, base) => total + base.candidateCount, 0) !== candidateCount ||
    (embeddingForbidden && (
      decodedEmbeddings.length !== 0 ||
      decodedBases.some((base) => base.vectorSearch !== undefined)
    )) ||
    (deterministicRead && (
      decodedEmbeddings.length !== 0 || fusion !== "rrf_k60" || Boolean(failureCode) ||
      rerankerBinding != null || preRerankOrder != null || postRerankOrder != null
    )) ||
    (deterministicExact && exact === undefined) ||
    (deterministicDiscovery && discovery === undefined) ||
    (!deterministicExact && exact !== undefined) ||
    (!deterministicDiscovery && discovery !== undefined) ||
    invalidExact || invalidDiscovery ||
    decodedResults.length > resultLimit ||
    resultHandles.some((handle, index) => !handle ||
      (version === KNOWLEDGE_RESULT_VERSION
        ? !("evidenceOrdinal" in handle)
        : "invocationOrdinal" in handle && (
            handle.invocationOrdinal !== invocationOrdinal || handle.resultOrdinal !== index + 1
          ))) ||
    new Set(decodedResults.map((result) => result.handle)).size !== decodedResults.length ||
    decodedResults.some((result) =>
      result.annRank !== null && result.annRank > (advanced ? 100 : candidateLimit) ||
      result.ftsRank !== null && result.ftsRank > (advanced ? 100 : candidateLimit) ||
      result.structuredAnalysis !== undefined || result.visualAnalysis !== undefined ||
      (deterministicRead || deterministicExact
        ? false
        : version === KNOWLEDGE_LEGACY_RESULT_VERSION && advanced
        ? result.confidence === undefined || result.confidence < (threshold ?? 0)
        : version === KNOWLEDGE_LEGACY_RESULT_VERSION &&
          result.fusedScore < (threshold ?? 0)) ||
      !basesByOrdinal.has(result.bindingOrdinal) ||
      basesByOrdinal.get(result.bindingOrdinal)?.knowledgeBaseId !== result.knowledgeBaseId) ||
    decodedResults.some((result) => result.sourceAlias !== undefined &&
      !scopeAliases?.some((alias) => alias !== null && alias.kind === "source" &&
        alias.alias === result.sourceAlias)) ||
    invalidReadSource ||
    (version === KNOWLEDGE_RESULT_VERSION &&
      (operation === "read_source") !== (read !== undefined)) ||
    invalidV2SourceBindings ||
    (version === KNOWLEDGE_RESULT_VERSION && rerankerBindingV2 !== null && (
      (operation ?? "automatic_search") !== "automatic_search" ||
      (rerankerBindingV2.status === "complete" || rerankerBindingV2.status === "partial"
        ? decodedResults.some((result) => result.rerankScore === undefined) ||
          rerankerBindingV2.status === "complete" &&
            rerankerBindingV2.relevanceScores.some((score) => score !== null) &&
            decodedResults.some((result) => result.rerankScore == null)
        : decodedResults.some((result) => result.rerankScore !== undefined))
    )) ||
    (version === KNOWLEDGE_RESULT_VERSION && rerankerBindingV2 === null &&
      decodedResults.some((result) => result.rerankScore !== undefined)) ||
    candidateCount < decodedResults.length ||
    (!embeddingForbidden && retrievalCompleted && !embeddingDegraded && (
      decodedEmbeddings.some((entry) => entry.status !== "complete") ||
      embeddedOrdinals.length !== decodedBases.length ||
      decodedBases.some((base) => !completedEmbeddingOrdinals.has(base.ordinal))
    )) ||
    Buffer.byteLength(providerText, "utf8") > KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES ||
    providerText !== renderedProviderText ||
    (decodedOutcome === "complete" && decodedResults.length === 0 && !deterministicDiscovery) ||
    (decodedOutcome !== "complete" && decodedResults.length !== 0) ||
    (decodedOutcome === "base_empty" && candidateCount !== 0) ||
    (decodedOutcome === "no_relevant_evidence" && candidateCount !== 0) ||
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
    (failureCode === "semantic_retrieval_unavailable" && failedEmbeddingOrdinals.size === 0) ||
    (decodedOutcome === "source_location_unavailable" && (
      operation !== "read_source" || candidateCount !== 0 || decodedResults.length !== 0 ||
      decodedEmbeddings.length !== 0
    )) ||
    (decodedOutcome === "zero_above_threshold" && (
      version !== KNOWLEDGE_LEGACY_RESULT_VERSION || candidateCount === 0) &&
      !deterministicExact && !deterministicDiscovery) ||
    (deterministicExact && (decodedOutcome === "complete") !== (candidateCount > 0)) ||
    (deterministicDiscovery && (decodedOutcome === "complete") !== (candidateCount > 0)) ||
    (deterministicOperation && fusion === "weighted_rrf_v2") ||
    (!deterministicExact && !deterministicDiscovery && fusion === "none") ||
    (advanced && (
      decodedResults.some((result) => result.signalProvenance === undefined) ||
      version === KNOWLEDGE_LEGACY_RESULT_VERSION && (
        preRerankOrder?.length !== candidateCount ||
        postRerankOrder?.length !== candidateCount ||
        decodedResults.some((result) => !postRerankOrder?.includes(result.chunkId))
      ) ||
      !embeddingForbidden && (
        decodedBases.some((base) => base.vectorSearch === undefined) ||
        decodedBases.some((base) => {
          const vectorSearch = base.vectorSearch!;
          return vectorSearch.mode === "unavailable"
            ? failedEmbeddingOrdinals.has(base.ordinal) === false &&
                vectorSearch.eligibleRows > 0 && completedEmbeddingOrdinals.has(base.ordinal)
            : !completedEmbeddingOrdinals.has(base.ordinal) ||
                failedEmbeddingOrdinals.has(base.ordinal);
        })
      )
    ))
  ) return null;
  return evidence;
}

function evidenceFromPreview(result: ToolExecutionResult): KnowledgeRetrievalEvidence | null {
  const preview = result.rawPreview;
  if (!isKnowledgeResultVersion(preview?.knowledgeResultVersion) ||
    preview.providerCall !== true ||
    !hasOnlyKeys(preview, ["knowledgeResultVersion", "knowledgeRetrieval", "providerCall"])) {
    return null;
  }
  const evidence = decodeKnowledgeRetrievalEvidence(preview.knowledgeRetrieval);
  return evidence?.version === preview.knowledgeResultVersion ? evidence : null;
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
  ];
}

export function aggregateKnowledgeUsage(
  executions: readonly KnowledgeEmbeddingExecutionEvidence[]
): ModelRunUsage {
  const usages: ModelRunUsage[] = executions.flatMap((execution) =>
    execution.status === "complete" ? [{
      inputTokens: execution.inputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: execution.totalTokens
    }] : []);
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

function markerContent(result: ToolExecutionResult, version: KnowledgeResultVersion): boolean {
  const [entry] = result.content;
  return result.content.length === 1 && entry?.type === "json" && isRecord(entry.value) &&
    entry.value.aiqsaType === "knowledge_result" &&
    entry.value.version === version && Object.keys(entry.value).length === 2;
}

export function compactKnowledgeToolExecutionResult(
  result: ToolExecutionResult
): ToolExecutionResult | null {
  const version = result.rawPreview?.knowledgeResultVersion;
  if (version === undefined) return result;
  if (!isKnowledgeResultVersion(version) || markerContent(result, version) ||
    result.status !== "complete") {
    return null;
  }
  const evidence = evidenceFromPreview(result);
  if (!evidence || result.content.length !== 1 || result.content[0]?.type !== "text" ||
    result.content[0].text !== knowledgeToolResultText(evidence)) return null;
  return {
    ...result,
    content: [persistedContentMarker(version)],
    rawPreview: {
      knowledgeResultVersion: version,
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
  if (!isKnowledgeResultVersion(version) || !markerContent(result, version) ||
    result.status !== "complete") {
    return null;
  }
  const evidence = evidenceFromPreview(result);
  return evidence ? { ...result, content: knowledgeToolResultContent(evidence) } : null;
}
