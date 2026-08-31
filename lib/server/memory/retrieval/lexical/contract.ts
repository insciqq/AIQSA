import type { MemoryRetrievalLane } from "../../../../domain/memory/retrieval";

export const MEMORY_LEXICAL_PROVIDER_MAX_VARIANTS = 4;
export const MEMORY_LEXICAL_PROVIDER_MAX_TERMS_PER_VARIANT = 64;
export const MEMORY_LEXICAL_PROVIDER_MAX_CANDIDATES_PER_VARIANT = 500;
export const MEMORY_LEXICAL_PROVIDER_MAX_FINAL_CANDIDATES = 250;
export const MEMORY_LEXICAL_PROVIDER_MAX_SOURCE_CHATS = 24;

/** Lanes whose candidate source is the replaceable lexical-search provider.
 * Exact/entity/digest SQL lanes remain PostgreSQL authority reads and must not
 * be interpreted as a provider fallback during OpenSearch cutover health. */
export const MEMORY_LEXICAL_CANDIDATE_PROVIDER_LANES = Object.freeze([
  "FACT_LEXICAL_UNICODE",
  "FACT_LEXICAL_NGRAM",
  "HISTORY_RECALL_LEXICAL_UNICODE",
  "HISTORY_RECALL_LEXICAL_NGRAM"
] as const satisfies readonly MemoryRetrievalLane[]);

export type MemoryLexicalCandidateProviderLane =
  (typeof MEMORY_LEXICAL_CANDIDATE_PROVIDER_LANES)[number];

export function isMemoryLexicalCandidateProviderLane(
  lane: unknown
): lane is MemoryLexicalCandidateProviderLane {
  return typeof lane === "string" &&
    MEMORY_LEXICAL_CANDIDATE_PROVIDER_LANES.includes(
      lane as MemoryLexicalCandidateProviderLane
    );
}

/** Process-local identity shared only by lexical lanes derived from one
 * authoritative retrieval snapshot. Symbols keep the coordination token out
 * of provider payloads, diagnostics, persistence, and JSON contracts. */
export const memoryLexicalProjectionReadinessScope = Symbol(
  "memory-lexical-projection-readiness-scope"
);

export type MemoryLexicalMatchMode =
  | "FOLDED"
  | "NGRAM"
  | "TRANSLITERATED"
  | "UNICODE";

export type MemoryLexicalLogicalTerm = Readonly<{
  characterLength: number;
  ordinal: number;
  value: string;
}>;

export type MemoryLexicalSearchRequest = Readonly<{
  [memoryLexicalProjectionReadinessScope]?: object;
  activeGenerationId: string;
  analysisProfileVersion: string;
  candidateLimitPerVariant: number;
  deadlineAtMs: number;
  finalLimit: number;
  itemFamily: "FACT" | "HISTORY";
  memoryRevisionSnapshot: number;
  sourceChatIds?: readonly string[];
  userId: string;
  variants: readonly Readonly<{
    logicalTerms: readonly MemoryLexicalLogicalTerm[];
    normalizedText: string;
    ordinal: number;
  }>[];
}>;

export type MemoryLexicalRawCandidate = Readonly<{
  backendScore: number;
  matchedTermCount: number;
  matchMode: MemoryLexicalMatchMode;
  maximumMatchedTermLength: number;
  rankWithinVariant: number;
  safeContentHash: string;
  searchEntryId: string;
  variantOrdinal: number;
}>;

export type MemoryLexicalFailureCode =
  | "memory_lexical_lane_unavailable"
  | "memory_lexical_projection_not_ready"
  | "memory_lexical_shadow_capacity"
  | "memory_lexical_settle_timeout"
  | "memory_opensearch_authentication_failed"
  | "memory_opensearch_canonical_guard"
  | "memory_opensearch_circuit_open"
  | "memory_opensearch_connection_failed"
  | "memory_opensearch_index_incompatible"
  | "memory_opensearch_index_missing"
  | "memory_opensearch_rate_limited"
  | "memory_opensearch_response_invalid"
  | "memory_opensearch_response_too_large"
  | "memory_opensearch_scope_too_large"
  | "memory_opensearch_timeout"
  | "memory_opensearch_unavailable"
  | "memory_read_lock_timeout"
  | "memory_read_statement_timeout";

/** Candidate-source evidence deliberately has no authority counters. Only the
 * PostgreSQL owner can add those after the canonical rejoin. */
export type MemoryLexicalProviderEvidence = Readonly<{
  backend: "OPENSEARCH" | "POSTGRES";
  durationMs: number;
  failureCode: MemoryLexicalFailureCode | null;
  fallbackUsed: boolean;
  lane: MemoryRetrievalLane;
  matchMode: MemoryLexicalMatchMode | null;
  opaqueId: string | null;
  projectionCaughtUp: boolean | null;
  projectionEventLag: number | null;
  projectionRevisionLag: number | null;
  projectionVisibleAgeMs: number | null;
  rawCandidateCount: number;
  requestedLimit: number;
  timedOut: boolean;
}>;

export type MemoryLexicalLaneEvidence = MemoryLexicalProviderEvidence & Readonly<{
  canonicalAcceptedCount: number;
  rejectedAuthorityCount: number;
  rejectedGenerationCount: number;
  rejectedHashCount: number;
}>;

export type MemoryLexicalSearchResult = Readonly<{
  candidates: readonly MemoryLexicalRawCandidate[];
  evidence: MemoryLexicalProviderEvidence;
}>;

export type MemoryLexicalProviderBackend =
  | MemoryLexicalProviderEvidence["backend"]
  | "ROUTED";

export interface MemoryLexicalCandidateProvider {
  readonly backend: MemoryLexicalProviderBackend;
  /** Optional candidate-free admission fence. Retrieval invokes this before
   * database lane fan-out; the provider may coalesce the proof through the
   * process-local snapshot scope carried by the request. */
  prepare?(request: MemoryLexicalSearchRequest): Promise<void>;
  search(request: MemoryLexicalSearchRequest): Promise<MemoryLexicalSearchResult>;
}

/** A fallback may be suppressed only by a complete logical-term match that
 * survived PostgreSQL canonicalization. Partial or rejected provider hits are
 * not proof that a query variant has a usable lexical route. */
export function hasAcceptedCompleteMemoryLexicalVariant(input: Readonly<{
  acceptedSearchEntryIds: readonly string[];
  candidates: readonly MemoryLexicalRawCandidate[];
  request: MemoryLexicalSearchRequest;
}>): boolean {
  const accepted = new Set(input.acceptedSearchEntryIds);
  if (accepted.size !== input.acceptedSearchEntryIds.length ||
    input.acceptedSearchEntryIds.some((id) => !validOpaqueToken(id))) {
    throw new Error("memory_lexical_search_result_invalid");
  }
  const termCounts = new Map(input.request.variants.map((variant) => [
    variant.ordinal,
    variant.logicalTerms.length
  ]));
  return input.candidates.some((candidate) =>
    accepted.has(candidate.searchEntryId) &&
    candidate.matchedTermCount === termCounts.get(candidate.variantOrdinal));
}

const opaqueTokenPattern = /^[^\u0000-\u0020\u007f]{1,256}$/u;
const contentHashPattern = /^[a-f0-9]{64,128}$/u;
const normalizedTextPattern = /^[^\u0000-\u001f\u007f]{1,2000}$/u;
const analysisProfilePattern = /^[A-Za-z0-9._:-]{1,64}$/u;
const lexicalFailureCodes = new Set<MemoryLexicalFailureCode>([
  "memory_lexical_lane_unavailable",
  "memory_lexical_projection_not_ready",
  "memory_lexical_shadow_capacity",
  "memory_lexical_settle_timeout",
  "memory_opensearch_authentication_failed",
  "memory_opensearch_canonical_guard",
  "memory_opensearch_circuit_open",
  "memory_opensearch_connection_failed",
  "memory_opensearch_index_incompatible",
  "memory_opensearch_index_missing",
  "memory_opensearch_rate_limited",
  "memory_opensearch_response_invalid",
  "memory_opensearch_response_too_large",
  "memory_opensearch_scope_too_large",
  "memory_opensearch_timeout",
  "memory_opensearch_unavailable",
  "memory_read_lock_timeout",
  "memory_read_statement_timeout"
]);
const matchModes = new Set<MemoryLexicalMatchMode>([
  "FOLDED",
  "NGRAM",
  "TRANSLITERATED",
  "UNICODE"
]);

function validBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= maximum;
}

function validOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && opaqueTokenPattern.test(value);
}

export function assertMemoryLexicalSearchRequest(
  request: MemoryLexicalSearchRequest
): void {
  if (
    !request || typeof request !== "object" ||
    !validOpaqueToken(request.userId) ||
    !validOpaqueToken(request.activeGenerationId) ||
    (request.itemFamily !== "FACT" && request.itemFamily !== "HISTORY") ||
    !Array.isArray(request.variants) || request.variants.length < 1 ||
    request.variants.length > MEMORY_LEXICAL_PROVIDER_MAX_VARIANTS ||
    !validBoundedInteger(
      request.candidateLimitPerVariant,
      MEMORY_LEXICAL_PROVIDER_MAX_CANDIDATES_PER_VARIANT
    ) ||
    !validBoundedInteger(
      request.finalLimit,
      MEMORY_LEXICAL_PROVIDER_MAX_FINAL_CANDIDATES
    ) ||
    !Number.isSafeInteger(request.memoryRevisionSnapshot) ||
    request.memoryRevisionSnapshot < 0 ||
    !Number.isSafeInteger(request.deadlineAtMs) || request.deadlineAtMs < 1 ||
    !analysisProfilePattern.test(request.analysisProfileVersion)
  ) throw new Error("memory_lexical_search_request_invalid");

  const variantOrdinals = new Set<number>();
  let termCount = 0;
  for (const variant of request.variants) {
    if (!variant || typeof variant !== "object" ||
      !Number.isSafeInteger(variant.ordinal) || variant.ordinal < 0 ||
      variant.ordinal >= MEMORY_LEXICAL_PROVIDER_MAX_VARIANTS ||
      variantOrdinals.has(variant.ordinal) ||
      typeof variant.normalizedText !== "string" ||
      !normalizedTextPattern.test(variant.normalizedText) ||
      variant.normalizedText !== variant.normalizedText.normalize("NFKC") ||
      !Array.isArray(variant.logicalTerms) ||
      variant.logicalTerms.length > MEMORY_LEXICAL_PROVIDER_MAX_TERMS_PER_VARIANT) {
      throw new Error("memory_lexical_search_request_invalid");
    }
    variantOrdinals.add(variant.ordinal);
    const termOrdinals = new Set<number>();
    for (const term of variant.logicalTerms) {
      const characterLength = typeof term?.value === "string"
        ? Array.from(term.value).length
        : 0;
      if (!term || typeof term !== "object" ||
        !Number.isSafeInteger(term.ordinal) || term.ordinal < 0 ||
        term.ordinal >= MEMORY_LEXICAL_PROVIDER_MAX_TERMS_PER_VARIANT ||
        termOrdinals.has(term.ordinal) ||
        typeof term.value !== "string" || !normalizedTextPattern.test(term.value) ||
        term.value !== term.value.normalize("NFKC") ||
        !Number.isSafeInteger(term.characterLength) ||
        term.characterLength !== characterLength) {
        throw new Error("memory_lexical_search_request_invalid");
      }
      termOrdinals.add(term.ordinal);
      termCount += 1;
    }
  }
  if (termCount < 1 || termCount > MEMORY_LEXICAL_PROVIDER_MAX_VARIANTS *
    MEMORY_LEXICAL_PROVIDER_MAX_TERMS_PER_VARIANT) {
    throw new Error("memory_lexical_search_request_invalid");
  }
  if (request.sourceChatIds !== undefined && (
    request.itemFamily !== "HISTORY" || !Array.isArray(request.sourceChatIds) ||
    request.sourceChatIds.length < 1 ||
    request.sourceChatIds.length > MEMORY_LEXICAL_PROVIDER_MAX_SOURCE_CHATS ||
    new Set(request.sourceChatIds).size !== request.sourceChatIds.length ||
    request.sourceChatIds.some((sourceChatId) => !validOpaqueToken(sourceChatId))
  )) throw new Error("memory_lexical_search_request_invalid");
}

export function assertMemoryLexicalSearchResult(
  request: MemoryLexicalSearchRequest,
  result: MemoryLexicalSearchResult,
  backend: MemoryLexicalCandidateProvider["backend"]
): void {
  if (!result || typeof result !== "object" || !Array.isArray(result.candidates) ||
    result.candidates.length > request.variants.length *
      request.candidateLimitPerVariant ||
    !result.evidence || typeof result.evidence !== "object" ||
    backend !== "ROUTED" && result.evidence.backend !== backend ||
    !Number.isSafeInteger(result.evidence.durationMs) ||
    result.evidence.durationMs < 0 || result.evidence.durationMs > 60_000 ||
    !Number.isSafeInteger(result.evidence.rawCandidateCount) ||
    result.evidence.rawCandidateCount !== result.candidates.length ||
    result.evidence.requestedLimit !== request.finalLimit ||
    result.evidence.matchMode !== null &&
      !matchModes.has(result.evidence.matchMode) ||
    result.evidence.failureCode !== null &&
      !lexicalFailureCodes.has(result.evidence.failureCode) ||
    typeof result.evidence.fallbackUsed !== "boolean" ||
    typeof result.evidence.timedOut !== "boolean" ||
    result.evidence.projectionCaughtUp !== null &&
      typeof result.evidence.projectionCaughtUp !== "boolean" ||
    [result.evidence.projectionEventLag,
      result.evidence.projectionRevisionLag,
      result.evidence.projectionVisibleAgeMs].some((value) =>
      value !== null && (!Number.isSafeInteger(value) || value < 0)) ||
    result.evidence.opaqueId !== null &&
      !validOpaqueToken(result.evidence.opaqueId)) {
    throw new Error("memory_lexical_search_result_invalid");
  }
  const requestedVariants = new Map(request.variants.map((variant) => [
    variant.ordinal,
    variant
  ]));
  const perVariantCounts = new Map<number, number>();
  const identities = new Set<string>();
  for (const candidate of result.candidates) {
    const variant = requestedVariants.get(candidate.variantOrdinal);
    const identity = `${candidate.searchEntryId}\u0000${candidate.variantOrdinal}`;
    if (!candidate || typeof candidate !== "object" || !variant ||
      !validOpaqueToken(candidate.searchEntryId) ||
      typeof candidate.safeContentHash !== "string" ||
      !contentHashPattern.test(candidate.safeContentHash) ||
      !validBoundedInteger(candidate.rankWithinVariant,
        request.candidateLimitPerVariant) ||
      !validBoundedInteger(candidate.matchedTermCount,
        MEMORY_LEXICAL_PROVIDER_MAX_TERMS_PER_VARIANT) ||
      candidate.matchedTermCount > variant.logicalTerms.length ||
      !validBoundedInteger(candidate.maximumMatchedTermLength, 8_000) ||
      typeof candidate.backendScore !== "number" ||
      !Number.isFinite(candidate.backendScore) || candidate.backendScore < 0 ||
      !matchModes.has(candidate.matchMode) || identities.has(identity)) {
      throw new Error("memory_lexical_search_result_invalid");
    }
    identities.add(identity);
    const count = (perVariantCounts.get(candidate.variantOrdinal) ?? 0) + 1;
    if (count > request.candidateLimitPerVariant) {
      throw new Error("memory_lexical_search_result_invalid");
    }
    perVariantCounts.set(candidate.variantOrdinal, count);
  }
  if (result.evidence.matchMode !== null && result.candidates.some((candidate) =>
    candidate.matchMode !== result.evidence.matchMode)) {
    throw new Error("memory_lexical_search_result_invalid");
  }
}
