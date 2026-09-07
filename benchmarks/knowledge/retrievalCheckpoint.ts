import {
  isKnowledgeBenchmarkOfficialId,
  type KnowledgeBenchmarkQuery,
  type KnowledgeQueryOutcome,
  type KnowledgeUsageTotals
} from "./contract";

export const KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION = 3 as const;

export type KnowledgeBenchmarkRerankerDiagnostic = Readonly<{
  fallbackReason: string | null;
  omittedCandidateCount: number;
  omittedRejectedCandidateCount: number;
  status: "complete" | "degraded" | "disabled" | "partial";
  timedOut: boolean;
}>;

export type KnowledgeBenchmarkRerankAdmissionAggregate = Readonly<{
  omittedCandidateCount: number;
  omittedRejectedCandidateCount: number;
  queriesWithOmittedCandidates: number;
  queriesWithOmittedRejections: number;
}>;

export type KnowledgeRetrievalCheckpointOutcome = KnowledgeQueryOutcome & Readonly<{
  rerankerDiagnostic: KnowledgeBenchmarkRerankerDiagnostic;
}>;

export type KnowledgeBenchmarkSchedule = Readonly<{
  concurrency: number;
  queryStartIntervalMs: number;
  rateLimitCooldownMs: number;
}>;

export type KnowledgeRetrievalCheckpointHeader = Readonly<{
  manifestFingerprint: string;
  queryCount: number;
  querySetContentSha256: string;
  runId: string;
  schedule: KnowledgeBenchmarkSchedule;
  schemaVersion: typeof KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION;
}>;

const outcomeKeys = Object.freeze([
  "candidatesAfterRerank",
  "candidatesBeforeRerank",
  "embeddingUsage",
  "queryId",
  "rankedDocumentIds",
  "relevant",
  "rerankApplied",
  "rerankFallback",
  "rerankerDiagnostic",
  "rerankerUsage",
  "rerankMs",
  "retrievalMs"
] as const);
const headerKeys = Object.freeze([
  "manifestFingerprint",
  "queryCount",
  "querySetContentSha256",
  "runId",
  "schedule",
  "schemaVersion"
] as const);
const scheduleKeys = Object.freeze([
  "concurrency",
  "queryStartIntervalMs",
  "rateLimitCooldownMs"
] as const);
const usageKeys = Object.freeze(["costMicros", "requests", "tokens"] as const);
const diagnosticKeys = Object.freeze([
  "fallbackReason",
  "omittedCandidateCount",
  "omittedRejectedCandidateCount",
  "status",
  "timedOut"
] as const);
const checkpointFileKeys = Object.freeze([
  "manifestFingerprint",
  "outcome",
  "schemaVersion"
] as const);
const failureCodePattern = /^[a-z][a-z0-9_]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function boundedNonNegativeInteger(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
    Number(value) <= maximum
    ? Number(value)
    : null;
}

function decodeUsage(value: unknown): KnowledgeUsageTotals | null {
  if (!isRecord(value) || !hasExactKeys(value, usageKeys)) return null;
  const requests = boundedNonNegativeInteger(value.requests, 1_000_000);
  const tokens = boundedNonNegativeInteger(value.tokens, Number.MAX_SAFE_INTEGER);
  const costMicros = value.costMicros === null
    ? null
    : boundedNonNegativeInteger(value.costMicros, Number.MAX_SAFE_INTEGER);
  if (requests === null || tokens === null ||
    value.costMicros !== null && costMicros === null) return null;
  return Object.freeze({ costMicros, requests, tokens });
}

function decodeSchedule(value: unknown): KnowledgeBenchmarkSchedule | null {
  if (!isRecord(value) || !hasExactKeys(value, scheduleKeys)) return null;
  const concurrency = boundedNonNegativeInteger(value.concurrency, 16);
  const queryStartIntervalMs = boundedNonNegativeInteger(
    value.queryStartIntervalMs,
    600_000
  );
  const rateLimitCooldownMs = boundedNonNegativeInteger(
    value.rateLimitCooldownMs,
    3_600_000
  );
  if (concurrency === null || concurrency < 1 || queryStartIntervalMs === null ||
    rateLimitCooldownMs === null) return null;
  return Object.freeze({
    concurrency,
    queryStartIntervalMs,
    rateLimitCooldownMs
  });
}

export function decodeKnowledgeRetrievalCheckpointHeader(
  value: unknown
): KnowledgeRetrievalCheckpointHeader {
  const code = "knowledge_benchmark_retrieval_checkpoint_header_invalid";
  if (!isRecord(value) || !hasExactKeys(value, headerKeys) ||
    value.schemaVersion !== KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION ||
    typeof value.manifestFingerprint !== "string" ||
    !sha256Pattern.test(value.manifestFingerprint) ||
    typeof value.querySetContentSha256 !== "string" ||
    !sha256Pattern.test(value.querySetContentSha256) ||
    typeof value.runId !== "string" || !runIdPattern.test(value.runId)) {
    throw new Error(code);
  }
  const queryCount = boundedNonNegativeInteger(value.queryCount, 1_000_000);
  const schedule = decodeSchedule(value.schedule);
  if (queryCount === null || queryCount < 1 || schedule === null) {
    throw new Error(code);
  }
  return Object.freeze({
    manifestFingerprint: value.manifestFingerprint,
    queryCount,
    querySetContentSha256: value.querySetContentSha256,
    runId: value.runId,
    schedule,
    schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
  });
}

function sameRelevant(
  value: unknown,
  expected: Readonly<Record<string, number>>
): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (entries.length !== expectedEntries.length || entries.some(
    ([id, gain], index) => !isKnowledgeBenchmarkOfficialId(id) ||
      typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 ||
      id !== expectedEntries[index]?.[0] || gain !== expectedEntries[index]?.[1]
  )) return null;
  return Object.freeze(Object.fromEntries(entries) as Record<string, number>);
}

function decodeDiagnostic(value: unknown): KnowledgeBenchmarkRerankerDiagnostic | null {
  if (!isRecord(value) || !hasExactKeys(value, diagnosticKeys)) return null;
  const status = value.status;
  const fallbackReason = value.fallbackReason;
  const omittedCandidateCount = boundedNonNegativeInteger(
    value.omittedCandidateCount,
    96
  );
  const omittedRejectedCandidateCount = boundedNonNegativeInteger(
    value.omittedRejectedCandidateCount,
    96
  );
  if (status !== "complete" && status !== "degraded" && status !== "disabled" &&
    status !== "partial" || typeof value.timedOut !== "boolean" ||
    omittedCandidateCount === null || omittedRejectedCandidateCount === null ||
    omittedRejectedCandidateCount > omittedCandidateCount ||
    (status === "partial") !== (omittedCandidateCount > 0) ||
    (status !== "partial" && omittedRejectedCandidateCount !== 0) ||
    fallbackReason !== null && (typeof fallbackReason !== "string" ||
      !failureCodePattern.test(fallbackReason)) ||
    (status === "degraded") !== (fallbackReason !== null)) return null;
  return Object.freeze({
    fallbackReason: fallbackReason as string | null,
    omittedCandidateCount,
    omittedRejectedCandidateCount,
    status,
    timedOut: value.timedOut
  });
}

/** Aggregate-only, content-free partial-rerank admission diagnostics. */
export function aggregateKnowledgeRerankAdmissionDiagnostics(
  outcomes: readonly KnowledgeRetrievalCheckpointOutcome[]
): KnowledgeBenchmarkRerankAdmissionAggregate {
  return Object.freeze(outcomes.reduce((aggregate, outcome) => {
    const diagnostic = outcome.rerankerDiagnostic;
    return {
      omittedCandidateCount:
        aggregate.omittedCandidateCount + diagnostic.omittedCandidateCount,
      omittedRejectedCandidateCount:
        aggregate.omittedRejectedCandidateCount + diagnostic.omittedRejectedCandidateCount,
      queriesWithOmittedCandidates:
        aggregate.queriesWithOmittedCandidates +
        (diagnostic.omittedCandidateCount > 0 ? 1 : 0),
      queriesWithOmittedRejections:
        aggregate.queriesWithOmittedRejections +
        (diagnostic.omittedRejectedCandidateCount > 0 ? 1 : 0)
    };
  }, {
    omittedCandidateCount: 0,
    omittedRejectedCandidateCount: 0,
    queriesWithOmittedCandidates: 0,
    queriesWithOmittedRejections: 0
  }));
}

export function decodeKnowledgeRetrievalCheckpointOutcome(
  value: unknown,
  expectedQuery: KnowledgeBenchmarkQuery
): KnowledgeRetrievalCheckpointOutcome {
  const code = "knowledge_benchmark_retrieval_checkpoint_outcome_invalid";
  if (!isRecord(value) || !hasExactKeys(value, outcomeKeys) ||
    value.queryId !== expectedQuery.officialId ||
    typeof value.rerankApplied !== "boolean" ||
    typeof value.rerankFallback !== "boolean" ||
    !Array.isArray(value.rankedDocumentIds) ||
    value.rankedDocumentIds.length > 10_000 ||
    value.rankedDocumentIds.some((id) =>
      !isKnowledgeBenchmarkOfficialId(id)) ||
    new Set(value.rankedDocumentIds).size !== value.rankedDocumentIds.length) {
    throw new Error(code);
  }
  const candidatesAfterRerank = boundedNonNegativeInteger(
    value.candidatesAfterRerank,
    10_000
  );
  const candidatesBeforeRerank = boundedNonNegativeInteger(
    value.candidatesBeforeRerank,
    10_000
  );
  const embeddingUsage = decodeUsage(value.embeddingUsage);
  const rerankerUsage = decodeUsage(value.rerankerUsage);
  const relevant = sameRelevant(value.relevant, expectedQuery.relevant);
  const rerankerDiagnostic = decodeDiagnostic(value.rerankerDiagnostic);
  const rerankMs = value.rerankMs === null
    ? null
    : boundedNonNegativeInteger(value.rerankMs, 3_600_000);
  const retrievalMs = boundedNonNegativeInteger(value.retrievalMs, 3_600_000);
  if (candidatesAfterRerank === null || candidatesBeforeRerank === null ||
    embeddingUsage === null || rerankerUsage === null || relevant === null ||
    rerankerDiagnostic === null || retrievalMs === null ||
    value.rerankMs !== null && rerankMs === null ||
    value.rerankFallback !== (rerankerDiagnostic.status === "degraded") ||
    value.rerankApplied && rerankerDiagnostic.status !== "complete" &&
      rerankerDiagnostic.status !== "partial") {
    throw new Error(code);
  }
  return Object.freeze({
    candidatesAfterRerank,
    candidatesBeforeRerank,
    embeddingUsage,
    queryId: expectedQuery.officialId,
    rankedDocumentIds: Object.freeze([...value.rankedDocumentIds as string[]]),
    relevant,
    rerankApplied: value.rerankApplied,
    rerankFallback: value.rerankFallback,
    rerankerDiagnostic,
    rerankerUsage,
    rerankMs,
    retrievalMs
  });
}

export function decodeKnowledgeRetrievalCheckpointFile(
  value: unknown,
  expectedManifestFingerprint: string,
  expectedQuery: KnowledgeBenchmarkQuery
): KnowledgeRetrievalCheckpointOutcome {
  const code = "knowledge_benchmark_retrieval_checkpoint_file_invalid";
  if (!isRecord(value) || !hasExactKeys(value, checkpointFileKeys) ||
    value.schemaVersion !== KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION ||
    value.manifestFingerprint !== expectedManifestFingerprint) {
    throw new Error(code);
  }
  return decodeKnowledgeRetrievalCheckpointOutcome(value.outcome, expectedQuery);
}
