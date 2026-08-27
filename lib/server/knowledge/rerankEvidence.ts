/**
 * Content-free hosted reranker execution evidence for Knowledge retrieval
 * receipts. Version 2 replaces the decode-only planner-era
 * `KnowledgeRerankerBindingEvidence` (version 1). It never stores query text,
 * passage text, source titles, headings, or raw provider payloads — only
 * immutable identifiers, counts, scores, and bounded operational facts.
 */

export const KNOWLEDGE_RERANKER_EVIDENCE_VERSION = 2 as const;

/** Reranker execution stage outcome recorded with the retrieval receipt. */
export type KnowledgeRerankerEvidenceStatus =
  | "complete"
  | "degraded"
  | "disabled"
  | "partial";

export type KnowledgeRerankerUsageEvidence = Readonly<{
  searchUnits: number | null;
  totalTokens: number | null;
}>;

export type KnowledgeRerankerBindingEvidenceV2 = Readonly<{
  adapterVersion: string | null;
  candidateFormatterVersion: number | null;
  connectionSnapshotId: string | null;
  credentialSnapshotRef: string | null;
  durationMs: number;
  fallbackReason: string | null;
  inputCandidateCount: number;
  orderedCandidateChunkIds: readonly string[];
  outputOrder: readonly string[];
  policyVersion: number | null;
  provider: string | null;
  providerModelId: string | null;
  providerRequestId: string | null;
  rankingProfileVersion: number;
  relevanceScores: readonly (number | null)[];
  status: KnowledgeRerankerEvidenceStatus;
  timedOut: boolean;
  upstreamModelId: string | null;
  usage: KnowledgeRerankerUsageEvidence;
  version: typeof KNOWLEDGE_RERANKER_EVIDENCE_VERSION;
}>;

const EVIDENCE_KEYS = Object.freeze([
  "adapterVersion",
  "candidateFormatterVersion",
  "connectionSnapshotId",
  "credentialSnapshotRef",
  "durationMs",
  "fallbackReason",
  "inputCandidateCount",
  "orderedCandidateChunkIds",
  "outputOrder",
  "policyVersion",
  "provider",
  "providerModelId",
  "providerRequestId",
  "rankingProfileVersion",
  "relevanceScores",
  "status",
  "timedOut",
  "upstreamModelId",
  "usage",
  "version"
] as const);

const MAX_INPUT_CANDIDATES = 96;
const MAX_DURATION_MS = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableBoundedIdentifier(value: unknown): boolean {
  return value === null || typeof value === "string" && value.length >= 1 &&
    value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableNonNegativeInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedChunkId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f\s]/u.test(value);
}

function boundedFailureCode(value: unknown): boolean {
  return value === null ||
    typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value);
}

export function isKnowledgeRerankerBindingEvidenceV2(
  value: unknown
): value is KnowledgeRerankerBindingEvidenceV2 {
  return decodeKnowledgeRerankerBindingEvidenceV2(value) !== null;
}

export function decodeKnowledgeRerankerBindingEvidenceV2(
  value: unknown
): KnowledgeRerankerBindingEvidenceV2 | null {
  if (!isRecord(value) || Object.keys(value).length !== EVIDENCE_KEYS.length ||
    EVIDENCE_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    value.version !== KNOWLEDGE_RERANKER_EVIDENCE_VERSION) return null;
  const status = value.status;
  if (status !== "complete" && status !== "degraded" && status !== "disabled" &&
    status !== "partial") return null;
  const usage = value.usage;
  if (
    !isRecord(usage) || Object.keys(usage).length !== 2 ||
    !nullableNonNegativeInteger(usage.searchUnits) ||
    !nullableNonNegativeInteger(usage.totalTokens) ||
    !Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0 ||
    Number(value.durationMs) > MAX_DURATION_MS ||
    !Number.isSafeInteger(value.inputCandidateCount) ||
    Number(value.inputCandidateCount) < 0 ||
    Number(value.inputCandidateCount) > MAX_INPUT_CANDIDATES ||
    !Number.isSafeInteger(value.rankingProfileVersion) ||
    Number(value.rankingProfileVersion) < 2 ||
    typeof value.timedOut !== "boolean" ||
    !boundedFailureCode(value.fallbackReason) ||
    !nullableBoundedIdentifier(value.adapterVersion) ||
    !nullableBoundedIdentifier(value.connectionSnapshotId) ||
    !nullableBoundedIdentifier(value.credentialSnapshotRef) ||
    !nullableBoundedIdentifier(value.provider) ||
    !nullableBoundedIdentifier(value.providerModelId) ||
    !nullableBoundedIdentifier(value.providerRequestId) ||
    !nullableBoundedIdentifier(value.upstreamModelId) ||
    (value.candidateFormatterVersion !== null && (
      !Number.isSafeInteger(value.candidateFormatterVersion) ||
      Number(value.candidateFormatterVersion) < 1
    )) ||
    (value.policyVersion !== null && (
      !Number.isSafeInteger(value.policyVersion) || Number(value.policyVersion) < 0
    )) ||
    !Array.isArray(value.orderedCandidateChunkIds) ||
    value.orderedCandidateChunkIds.length > MAX_INPUT_CANDIDATES ||
    value.orderedCandidateChunkIds.some((entry) => !boundedChunkId(entry)) ||
    new Set(value.orderedCandidateChunkIds).size !== value.orderedCandidateChunkIds.length ||
    !Array.isArray(value.outputOrder) ||
    value.outputOrder.some((entry) => !boundedChunkId(entry)) ||
    new Set(value.outputOrder).size !== value.outputOrder.length ||
    !Array.isArray(value.relevanceScores) ||
    value.relevanceScores.length !== value.outputOrder.length ||
    value.relevanceScores.some((entry) => entry !== null && (
      typeof entry !== "number" || !Number.isFinite(entry)
    ))
  ) return null;
  const orderedIds = value.orderedCandidateChunkIds as string[];
  const outputOrder = value.outputOrder as string[];
  const relevanceScores = value.relevanceScores as Array<number | null>;
  const orderedSet = new Set(orderedIds);
  if (outputOrder.some((entry) => !orderedSet.has(entry))) return null;
  const scored = relevanceScores.filter((entry) => entry !== null).length;
  const timedOut = value.timedOut;
  const fallbackReason = value.fallbackReason as string | null;
  const pinFields = [
    value.adapterVersion,
    value.candidateFormatterVersion,
    value.connectionSnapshotId,
    value.credentialSnapshotRef,
    value.policyVersion,
    value.providerModelId,
    value.upstreamModelId
  ];
  if (status === "disabled") {
    if (orderedIds.length !== 0 || outputOrder.length !== 0 ||
      value.inputCandidateCount !== 0 || scored !== 0 || timedOut ||
      fallbackReason !== null || pinFields.some((entry) => entry !== null) ||
      value.provider !== null || value.providerRequestId !== null) return null;
  } else if (status === "degraded") {
    if (outputOrder.length !== 0 || fallbackReason === null ||
      (orderedIds.length !== 0 && orderedIds.length !== value.inputCandidateCount)
    ) return null;
  } else {
    // complete | partial: the deterministic pre-rerank pool order and one
    // output order per pool candidate are both recorded.
    if (orderedIds.length !== value.inputCandidateCount ||
      outputOrder.length !== orderedIds.length || timedOut ||
      fallbackReason !== null ||
      pinFields.some((entry) => entry === null)) return null;
    if (status === "complete") {
      // A real scored response covers every candidate; a deterministic skip
      // (zero or one candidate) records no provider scores.
      if (scored !== relevanceScores.length &&
        !(scored === 0 && value.inputCandidateCount <= 1)) return null;
    } else if (scored >= relevanceScores.length || value.inputCandidateCount < 2) return null;
  }
  return Object.freeze({
    adapterVersion: value.adapterVersion as string | null,
    candidateFormatterVersion: value.candidateFormatterVersion as number | null,
    connectionSnapshotId: value.connectionSnapshotId as string | null,
    credentialSnapshotRef: value.credentialSnapshotRef as string | null,
    durationMs: Number(value.durationMs),
    fallbackReason,
    inputCandidateCount: Number(value.inputCandidateCount),
    orderedCandidateChunkIds: Object.freeze([...orderedIds]),
    outputOrder: Object.freeze([...outputOrder]),
    policyVersion: value.policyVersion as number | null,
    provider: value.provider as string | null,
    providerModelId: value.providerModelId as string | null,
    providerRequestId: value.providerRequestId as string | null,
    rankingProfileVersion: Number(value.rankingProfileVersion),
    relevanceScores: Object.freeze([...relevanceScores]),
    status,
    timedOut,
    upstreamModelId: value.upstreamModelId as string | null,
    usage: Object.freeze({
      searchUnits: usage.searchUnits as number | null,
      totalTokens: usage.totalTokens as number | null
    }),
    version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
  });
}
