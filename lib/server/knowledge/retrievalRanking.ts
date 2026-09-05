import type { KnowledgeDocumentContextV1 } from "./documentContext";
import { formatKnowledgeRerankCandidate } from "./rerankCandidateFormatter";
import { knowledgeEvidenceOccurrenceKeyV1 } from "./evidenceOccurrence";

export const KNOWLEDGE_RETRIEVAL_FUSION = "weighted_rrf_v2" as const;
export const KNOWLEDGE_RRF_K = 60;
export const KNOWLEDGE_RANKING_CANDIDATE_MAX = 1_000;
/**
 * Maximum rank carried by one retrieval-lane provenance signal. Primary
 * lanes are much smaller, but the global neighbor window can exceed a single
 * lane's fetch size before deduplication. Keep SQL admission and every
 * durable decoder on this one explicit boundary.
 */
export const KNOWLEDGE_SIGNAL_RANK_MAX = KNOWLEDGE_RANKING_CANDIDATE_MAX;

/**
 * Versioned code-owned ranking profile. Version 2 widens the per-lane
 * candidate limit to 64 and introduces the hosted-rerank merged-pool caps.
 * Version 3 retained a bounded language-neutral token-coverage signal after
 * hosted reranking instead of allowing an uncalibrated provider score to
 * erase every first-stage lexical signal. Version 4 replaces only the
 * passage-level PostgreSQL lexical vote with the OpenSearch BM25 projection.
 * Version 5 changes only deduplication to immutable occurrence identity,
 * including bounded novelty history. Version 6 retains the bounded union of
 * BM25 query variants until the common pre-rerank pool is selected. Scoring,
 * per-query limits, rerank input limits and model bindings are unchanged.
 * Version 7 uses passage BM25/dense candidates with exact and metadata lanes;
 * section/document text contributes through bounded context expansion rather
 * than corpus-wide PostgreSQL full-text ranking and duplicate fusion votes.
 * Version 8 carries scoped exact-match specificity into fusion and reserves
 * pre-rerank slots only for discriminating exact evidence. Common literals
 * remain eligible without displacing stronger passage evidence by default.
 * These values are internal retrieval defaults, never user or Admin settings.
 */
export const KNOWLEDGE_RANKING_PROFILE_VERSION = 8 as const;
export const KNOWLEDGE_LANE_CANDIDATE_LIMIT = 64 as const;
export const KNOWLEDGE_BROAD_RERANK_INPUT_MAX = 96 as const;
export const KNOWLEDGE_SCOPED_RERANK_INPUT_MAX = 48 as const;
export const KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR = 0.1;
export const KNOWLEDGE_METADATA_RELEVANCE_FLOOR = 0.45;
export const KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR = 0.65;
export const KNOWLEDGE_SOFT_DIVERSITY_RELATIVE_BAND = 0.08;
export const KNOWLEDGE_RERANK_MODEL_RANK_WEIGHT = 0.7;
export const KNOWLEDGE_RERANK_TOKEN_COVERAGE_RANK_WEIGHT = 0.3;

const KNOWLEDGE_TOKEN_COVERAGE_QUERY_MAX = 128;
const KNOWLEDGE_TOKEN_COVERAGE_CANDIDATE_MAX = 4_096;
const GENERIC_WORD = /[\p{L}\p{M}\p{N}]+/gu;

export type KnowledgeRetrievalLane =
  | "document_lexical"
  | "exact"
  | "metadata"
  | "neighbor"
  | "passage_bm25"
  | "passage_semantic"
  | "section_lexical";

export type KnowledgeVectorSearchMode = "ann" | "exact";

export type KnowledgeCandidateSignal = Readonly<{
  exactKind: string | null;
  lane: KnowledgeRetrievalLane;
  rank: number;
  rawScore: number;
  vectorDistance: number | null;
  vectorMode: KnowledgeVectorSearchMode | null;
}>;

export type KnowledgeRetrievalCandidate = Readonly<{
  baseName: string;
  bindingOrdinal: number;
  chunkId: string;
  chunkIndex: number;
  contentHash: string;
  documentId: string;
  documentVersionId: string;
  documentVersionNumber: number;
  documentContext?: KnowledgeDocumentContextV1 | null;
  fileName: string;
  headingPath: readonly string[];
  knowledgeBaseId: string;
  layoutKind:
    | "body"
    | "field_ambiguous"
    | "field_pair"
    | "table_ambiguous"
    | "table_row"
    | "table_row_projection";
  page: number;
  sectionId: string | null;
  signals: readonly KnowledgeCandidateSignal[];
  sourceArtifactId: string | null;
  sourceName: string;
  text: string;
}>;

export type KnowledgeRankedCandidate = KnowledgeRetrievalCandidate & Readonly<{
  fusedScore: number;
}>;

export const KNOWLEDGE_RERANK_OMITTED_ADMISSION_VERSION = 1 as const;

/** Content-free admission facts for one accepted partial rerank response. */
export type KnowledgeRerankOmittedAdmissionEvidenceV1 = Readonly<{
  omittedCandidateCount: number;
  omittedRejectedCandidateCount: number;
  version: typeof KNOWLEDGE_RERANK_OMITTED_ADMISSION_VERSION;
}>;

/** Content-free final-ranking replay and admission evidence. */
export type KnowledgeRankingEvidence = Readonly<{
  candidateOrder: readonly string[];
  fusion: typeof KNOWLEDGE_RETRIEVAL_FUSION;
  rerankOmittedAdmission?: KnowledgeRerankOmittedAdmissionEvidenceV1;
}>;

/** Decode-only compatibility for accepted receipts written before the focused cutover. */
export type KnowledgeRerankerBindingEvidence =
  | Readonly<{
      egress: "none";
      kind: "deterministic_token_vector_heuristic";
      languages: readonly ["en", "ru"];
      profile: "deterministic-token-vector-heuristic-v1";
      status: "complete";
      version: 1;
    }>
  | Readonly<{
      egress: "none";
      failureCode: "knowledge_reranker_unavailable";
      kind: "deterministic_weighted_rrf_fallback";
      languages: readonly ["en", "ru"];
      profile: "weighted-rrf-v2";
      status: "degraded";
      version: 1;
    }>;

export const KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS: Readonly<
  Record<KnowledgeRetrievalLane, number>
> = Object.freeze({
  // Document and section matches are coarse routing evidence. Even together at
  // rank 1 they must not outrank a direct passage match retained at rank 40.
  document_lexical: 0.25,
  exact: 2.6,
  metadata: 1.2,
  neighbor: 0.25,
  passage_bm25: 1.3,
  passage_semantic: 1.15,
  section_lexical: 0.4
});

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sourceKey(candidate: KnowledgeRetrievalCandidate): string {
  // V2 retrieval projects the canonical Source id as documentId. Artifacts
  // remain part of immutable evidence attribution, but compatible profile
  // revisions of one Source must share one diversity slot and primary cap.
  return candidate.documentId;
}

function primaryCandidate(candidate: KnowledgeRetrievalCandidate): boolean {
  return candidate.signals.some((signal) => signal.lane !== "neighbor");
}

export function knowledgeCandidateSignalEligible(signal: KnowledgeCandidateSignal): boolean {
  switch (signal.lane) {
    case "exact":
      return true;
    case "document_lexical":
    case "section_lexical":
      return signal.rawScore >= KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR;
    case "passage_bm25":
      return signal.rawScore > 0;
    case "metadata":
      return signal.rawScore >= KNOWLEDGE_METADATA_RELEVANCE_FLOOR;
    case "passage_semantic":
      return signal.rawScore >= KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR &&
        signal.vectorDistance !== null &&
        1 - signal.vectorDistance >= KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR;
    case "neighbor":
      return false;
  }
}

export function relevanceEligibleKnowledgeCandidate(
  candidate: KnowledgeRetrievalCandidate
): KnowledgeRetrievalCandidate | null {
  const signals = candidate.signals.filter(knowledgeCandidateSignalEligible);
  return signals.length > 0
    ? Object.freeze({ ...candidate, signals: Object.freeze(signals) })
    : null;
}

/** Named lane relevance eligibility exactly as the deterministic path applies it. */
export function eligibleKnowledgeCandidates(
  candidates: readonly KnowledgeRetrievalCandidate[]
): KnowledgeRetrievalCandidate[] {
  return candidates.flatMap((candidate) => {
    const accepted = relevanceEligibleKnowledgeCandidate(candidate);
    return accepted ? [accepted] : [];
  });
}

export function fuseKnowledgeCandidates(
  candidates: readonly KnowledgeRetrievalCandidate[]
): KnowledgeRankedCandidate[] {
  const maximum = Object.values(KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS)
    .reduce((sum, weight) => sum + weight / (KNOWLEDGE_RRF_K + 1), 0);
  return candidates.map((candidate): KnowledgeRankedCandidate => {
    const bestByLane = new Map<KnowledgeRetrievalLane, KnowledgeCandidateSignal>();
    for (const signal of candidate.signals) {
      const existing = bestByLane.get(signal.lane);
      if (!existing || signal.rank < existing.rank ||
        signal.rank === existing.rank && signal.rawScore > existing.rawScore) {
        bestByLane.set(signal.lane, signal);
      }
    }
    const fusedScore = clamp([...bestByLane.values()].reduce((sum, signal) =>
      sum + KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS[signal.lane] *
        (signal.lane === "exact" ? clamp(signal.rawScore) : 1) /
        (KNOWLEDGE_RRF_K + signal.rank), 0) / maximum);
    return Object.freeze({
      ...candidate,
      fusedScore
    });
  }).sort((left, right) =>
    right.fusedScore - left.fusedScore || left.chunkId.localeCompare(right.chunkId));
}

export function boundKnowledgeCandidates(
  candidates: readonly KnowledgeRetrievalCandidate[],
  bindingScope: number | readonly number[],
  maximum = KNOWLEDGE_RANKING_CANDIDATE_MAX
): KnowledgeRetrievalCandidate[] {
  const bindingOrdinals = typeof bindingScope === "number"
    ? Number.isSafeInteger(bindingScope) && bindingScope >= 1 && bindingScope <= 128
      ? Array.from({ length: bindingScope }, (_, index) => index)
      : []
    : [...bindingScope];
  const allowedBindings = new Set(bindingOrdinals);
  const bindingCount = allowedBindings.size;
  if (bindingCount < 1 || bindingCount > 128 ||
    bindingOrdinals.some((ordinal) =>
      !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 128) ||
    bindingCount !== bindingOrdinals.length ||
    !Number.isSafeInteger(maximum) || maximum < bindingCount) {
    throw new Error("knowledge_candidate_bound_invalid");
  }
  if (candidates.some((candidate) =>
    !Number.isSafeInteger(candidate.bindingOrdinal) ||
    !allowedBindings.has(candidate.bindingOrdinal))) {
    throw new Error("knowledge_candidate_binding_invalid");
  }
  const perBinding = Math.floor(maximum / bindingCount);
  const retained = new Map<number, number>();
  const ranked = fuseKnowledgeCandidates(candidates);
  const selected: KnowledgeRetrievalCandidate[] = [];
  const selectedChunks = new Set<string>();
  for (const candidate of ranked) {
    const count = retained.get(candidate.bindingOrdinal) ?? 0;
    if (count >= perBinding) continue;
    selected.push(candidate);
    selectedChunks.add(candidate.chunkId);
    retained.set(candidate.bindingOrdinal, count + 1);
  }
  for (const candidate of ranked) {
    if (selected.length >= maximum) break;
    if (selectedChunks.has(candidate.chunkId)) continue;
    selected.push(candidate);
  }
  return selected;
}

export function knowledgeCandidateHasExactSignal(
  candidate: KnowledgeRetrievalCandidate
): boolean {
  return candidate.signals.some((signal) => signal.lane === "exact");
}

/** SQL sums inverse scoped passage frequencies for the matched literals.
 * One unique match (or equally discriminating combined matches) reaches one;
 * a ubiquitous literal must not reserve a slot merely because it is exact.
 * Eligibility and exact attribution remain independent of this preference. */
function hasDiscriminatingExactSignal(candidate: KnowledgeRetrievalCandidate): boolean {
  return candidate.signals.some(signal => signal.lane === "exact" && signal.rawScore >= 1);
}

/**
 * Builds the merged pre-rerank candidate pool: weighted RRF pre-order,
 * canonical occurrence deduplication, discriminating exact preservation, and
 * soft balancing across accepted bindings, capped at the versioned rerank
 * input maximum. Relevance floors are deliberately not applied here; the
 * hosted reranker judges the selected authority-scoped pool.
 */
export function selectKnowledgePreRerankPool(input: Readonly<{
  bindingOrdinals: readonly number[];
  candidates: readonly KnowledgeRetrievalCandidate[];
  maximum: number;
}>): KnowledgeRankedCandidate[] {
  const bindingCount = new Set(input.bindingOrdinals).size;
  if (!Number.isSafeInteger(input.maximum) || input.maximum < 1 || bindingCount < 1) {
    throw new Error("knowledge_prererank_pool_invalid");
  }
  const fused = fuseKnowledgeCandidates(input.candidates);
  const representativeByOccurrence = new Map<string, KnowledgeRankedCandidate>();
  for (const candidate of fused) {
    const key = knowledgeEvidenceOccurrenceKeyV1(candidate);
    const existing = representativeByOccurrence.get(key);
    if (!existing || knowledgeCandidateHasExactSignal(candidate) &&
      !knowledgeCandidateHasExactSignal(existing)) {
      // Repeated lane delivery cannot erase this occurrence's exact signal.
      // Equal text from a different occurrence retains its own slot.
      representativeByOccurrence.set(key, candidate);
    }
  }
  const deduped = [...representativeByOccurrence.values()].sort((left, right) =>
    right.fusedScore - left.fusedScore || left.chunkId.localeCompare(right.chunkId));
  if (deduped.length <= input.maximum) return deduped;
  const selected: KnowledgeRankedCandidate[] = [];
  const selectedChunks = new Set<string>();
  const perBinding = new Map<number, number>();
  const take = (candidate: KnowledgeRankedCandidate): void => {
    selected.push(candidate);
    selectedChunks.add(candidate.chunkId);
    perBinding.set(
      candidate.bindingOrdinal,
      (perBinding.get(candidate.bindingOrdinal) ?? 0) + 1
    );
  };
  // Preserve discriminating literals. Common exact matches compete through
  // specificity-weighted fusion instead of exhausting the pool reservation.
  for (const candidate of deduped) {
    if (selected.length >= input.maximum) break;
    if (hasDiscriminatingExactSignal(candidate)) take(candidate);
  }
  const quota = Math.max(1, Math.floor(input.maximum / bindingCount));
  for (const candidate of deduped) {
    if (selected.length >= input.maximum) break;
    if (selectedChunks.has(candidate.chunkId)) continue;
    if ((perBinding.get(candidate.bindingOrdinal) ?? 0) >= quota) continue;
    take(candidate);
  }
  for (const candidate of deduped) {
    if (selected.length >= input.maximum) break;
    if (selectedChunks.has(candidate.chunkId)) continue;
    take(candidate);
  }
  return selected.sort((left, right) =>
    right.fusedScore - left.fusedScore || left.chunkId.localeCompare(right.chunkId));
}

export type KnowledgeRerankedCandidate = KnowledgeRankedCandidate & Readonly<{
  rerankScore: number | null;
}>;

function genericWordTokens(value: string, maximum: number): string[] {
  const tokens: string[] = [];
  const normalized = value.normalize("NFKC").toLocaleLowerCase("und");
  for (const match of normalized.matchAll(GENERIC_WORD)) {
    const token = match[0];
    if (!token || [...token].length > 128) continue;
    tokens.push(token);
    if (tokens.length >= maximum) break;
  }
  return tokens;
}

function rankedByScore(
  entries: readonly Readonly<{ chunkId: string; score: number }>[]
): ReadonlyMap<string, number> {
  const ordered = [...entries].sort((left, right) =>
    right.score - left.score || left.chunkId.localeCompare(right.chunkId));
  const ranks = new Map<string, number>();
  let previousScore: number | undefined;
  let rank = 0;
  for (const [index, entry] of ordered.entries()) {
    if (previousScore === undefined || entry.score !== previousScore) rank = index + 1;
    ranks.set(entry.chunkId, rank);
    previousScore = entry.score;
  }
  return ranks;
}

/**
 * Computes a bounded, language-neutral approximation of the weighted query
 * coverage used alongside learned rerankers by mature RAG engines. Query
 * terms that occur in most of the current authority-scoped pool contribute
 * little; rare terms contribute more. This needs no language classifier,
 * stop-word dictionary, corpus mutation, or additional provider call.
 */
function tokenCoverageScores(
  candidates: readonly KnowledgeRerankedCandidate[],
  query: string
): ReadonlyMap<string, number> {
  const queryTokens = [...new Set(genericWordTokens(
    query,
    KNOWLEDGE_TOKEN_COVERAGE_QUERY_MAX
  ))];
  if (queryTokens.length === 0 || candidates.length === 0) return new Map();
  const candidateTokens = new Map<string, ReadonlySet<string>>();
  for (const candidate of candidates) {
    const formatted = formatKnowledgeRerankCandidate({
      headingPath: candidate.headingPath,
      sourceName: candidate.sourceName,
      text: candidate.text
    });
    candidateTokens.set(candidate.chunkId, new Set(genericWordTokens(
      formatted,
      KNOWLEDGE_TOKEN_COVERAGE_CANDIDATE_MAX
    )));
  }
  const weights = new Map<string, number>();
  for (const token of queryTokens) {
    let documentFrequency = 0;
    for (const tokens of candidateTokens.values()) {
      if (tokens.has(token)) documentFrequency += 1;
    }
    weights.set(
      token,
      Math.log((candidates.length + 1) / (documentFrequency + 0.5)) + 1
    );
  }
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return new Map(candidates.map((candidate) => {
    const tokens = candidateTokens.get(candidate.chunkId)!;
    const matchedWeight = queryTokens.reduce((sum, token) =>
      sum + (tokens.has(token) ? weights.get(token)! : 0), 0);
    return [candidate.chunkId, totalWeight > 0 ? matchedWeight / totalWeight : 0];
  }));
}

function hostedRerankFusionScores(
  candidates: readonly KnowledgeRerankedCandidate[],
  query: string
): ReadonlyMap<string, number> {
  const scored = candidates.filter((candidate) => candidate.rerankScore !== null);
  const rerankRanks = rankedByScore(scored.map((candidate) => ({
    chunkId: candidate.chunkId,
    score: candidate.rerankScore!
  })));
  const coverage = tokenCoverageScores(scored, query);
  const rankDenominator = Math.max(1, scored.length - 1);
  return new Map(scored.map((candidate) => [
    candidate.chunkId,
    KNOWLEDGE_RERANK_MODEL_RANK_WEIGHT * (scored.length === 1
      ? 1
      : 1 - (rerankRanks.get(candidate.chunkId)! - 1) / rankDenominator) +
    KNOWLEDGE_RERANK_TOKEN_COVERAGE_RANK_WEIGHT *
      (coverage.get(candidate.chunkId) ?? 0)
  ]));
}

/**
 * Final ranking after hosted reranking: descending rerank score, exact signal
 * as tie-breaker, fused RRF score next, deterministic chunk id last. Scored
 * candidates retain the accepted hosted-rerank semantics. Candidates omitted
 * by the provider rejoin only through the same signal eligibility as the
 * deterministic path, with their weighted RRF recomputed from eligible
 * signals; every admitted omitted candidate follows every scored candidate.
 */
export function orderRerankedKnowledgeCandidates(input: Readonly<{
  pool: readonly KnowledgeRankedCandidate[];
  query: string;
  rerankScores: ReadonlyMap<string, number>;
}>): KnowledgeRerankedCandidate[] {
  const scored = input.pool.filter((candidate) =>
    input.rerankScores.has(candidate.chunkId));
  const eligibleOmitted = fuseKnowledgeCandidates(eligibleKnowledgeCandidates(
    input.pool.filter((candidate) => !input.rerankScores.has(candidate.chunkId))
  ));
  const withScores = [...scored, ...eligibleOmitted]
    .map((candidate): KnowledgeRerankedCandidate =>
    Object.freeze({
      ...candidate,
      rerankScore: input.rerankScores.get(candidate.chunkId) ?? null
    }));
  const fusionScores = hostedRerankFusionScores(withScores, input.query);
  return withScores.sort((left, right) => {
    if ((left.rerankScore === null) !== (right.rerankScore === null)) {
      return left.rerankScore === null ? 1 : -1;
    }
    if (left.rerankScore !== null && right.rerankScore !== null) {
      const fusionDifference = fusionScores.get(right.chunkId)! -
        fusionScores.get(left.chunkId)!;
      if (fusionDifference !== 0) return fusionDifference;
      if (left.rerankScore !== right.rerankScore) {
        return right.rerankScore - left.rerankScore;
      }
    }
    const leftExact = knowledgeCandidateHasExactSignal(left) ? 1 : 0;
    const rightExact = knowledgeCandidateHasExactSignal(right) ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;
    if (left.fusedScore !== right.fusedScore) return right.fusedScore - left.fusedScore;
    return left.chunkId.localeCompare(right.chunkId);
  });
}

/**
 * Post-rerank final selection: canonical occurrence deduplication, then soft
 * Source diversity applied only inside the narrow relative score band, then
 * the final broad/scoped result limit. Diversity never promotes an unscored
 * candidate above a scored one and never lifts a candidate outside the band.
 */
export function selectRerankedKnowledgeCandidates(input: Readonly<{
  candidates: readonly KnowledgeRerankedCandidate[];
  resultLimit: number;
}>): KnowledgeRerankedCandidate[] {
  const selectedOccurrences = new Set<string>();
  const remaining = input.candidates.filter(primaryCandidate).filter((candidate) => {
    const key = knowledgeEvidenceOccurrenceKeyV1(candidate);
    if (selectedOccurrences.has(key)) return false;
    selectedOccurrences.add(key);
    return true;
  });
  const bandScore = (candidate: KnowledgeRerankedCandidate): number =>
    candidate.rerankScore ?? candidate.fusedScore;
  const selected: KnowledgeRerankedCandidate[] = [];
  const counts = new Map<string, number>();
  while (selected.length < input.resultLimit && remaining.length > 0) {
    const strongest = remaining[0]!;
    const strongestSourceCount = counts.get(sourceKey(strongest)) ?? 0;
    const bandFloor = bandScore(strongest) * (1 - KNOWLEDGE_SOFT_DIVERSITY_RELATIVE_BAND);
    const alternative = remaining
      .filter((candidate) =>
        (candidate.rerankScore === null) === (strongest.rerankScore === null) &&
        bandScore(candidate) >= bandFloor &&
        (counts.get(sourceKey(candidate)) ?? 0) < strongestSourceCount)
      .sort((left, right) =>
        (counts.get(sourceKey(left)) ?? 0) - (counts.get(sourceKey(right)) ?? 0) ||
        bandScore(right) - bandScore(left) ||
        left.chunkId.localeCompare(right.chunkId))[0];
    const chosen = alternative ?? strongest;
    remaining.splice(remaining.indexOf(chosen), 1);
    selected.push(chosen);
    const source = sourceKey(chosen);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return selected;
}

export function selectSourceDiverseKnowledgeCandidates(input: Readonly<{
  candidates: readonly KnowledgeRankedCandidate[];
  resultLimit: number;
}>): KnowledgeRankedCandidate[] {
  const selectedOccurrences = new Set<string>();
  const remaining = input.candidates.filter(primaryCandidate).filter((candidate) => {
    const key = knowledgeEvidenceOccurrenceKeyV1(candidate);
    if (selectedOccurrences.has(key)) return false;
    selectedOccurrences.add(key);
    return true;
  });
  const selected: KnowledgeRankedCandidate[] = [];
  const counts = new Map<string, number>();
  while (selected.length < input.resultLimit && remaining.length > 0) {
    const strongest = remaining[0]!;
    const strongestSourceCount = counts.get(sourceKey(strongest)) ?? 0;
    const bandFloor = strongest.fusedScore * (1 - KNOWLEDGE_SOFT_DIVERSITY_RELATIVE_BAND);
    const alternative = remaining
      .filter((candidate) =>
        candidate.fusedScore >= bandFloor &&
        (counts.get(sourceKey(candidate)) ?? 0) < strongestSourceCount)
      .sort((left, right) =>
        (counts.get(sourceKey(left)) ?? 0) - (counts.get(sourceKey(right)) ?? 0) ||
        right.fusedScore - left.fusedScore ||
        left.chunkId.localeCompare(right.chunkId))[0];
    const chosen = alternative ?? strongest;
    remaining.splice(remaining.indexOf(chosen), 1);
    selected.push(chosen);
    const source = sourceKey(chosen);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return selected;
}

export function rankKnowledgeCandidates(input: Readonly<{
  candidates: readonly KnowledgeRetrievalCandidate[];
  resultLimit: number;
}>): Promise<Readonly<{
  evidence: KnowledgeRankingEvidence;
  ranked: readonly KnowledgeRankedCandidate[];
  selected: readonly KnowledgeRankedCandidate[];
}>> {
  const eligible = input.candidates.flatMap((candidate) => {
    const accepted = relevanceEligibleKnowledgeCandidate(candidate);
    return accepted ? [accepted] : [];
  });
  const ranked = Object.freeze(fuseKnowledgeCandidates(eligible));
  const order = Object.freeze(ranked.map((candidate) => candidate.chunkId));
  const selected = Object.freeze(selectSourceDiverseKnowledgeCandidates({
    candidates: ranked,
    resultLimit: input.resultLimit
  }));
  return Promise.resolve(Object.freeze({
    evidence: Object.freeze({
      candidateOrder: order,
      fusion: KNOWLEDGE_RETRIEVAL_FUSION
    }),
    ranked,
    selected
  }));
}
