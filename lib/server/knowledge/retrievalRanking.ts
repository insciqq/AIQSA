import type { KnowledgeDocumentContextV1 } from "./documentContext";

export const KNOWLEDGE_RETRIEVAL_FUSION = "weighted_rrf_v2" as const;
export const KNOWLEDGE_RRF_K = 60;
export const KNOWLEDGE_RANKING_CANDIDATE_MAX = 1_000;
/**
 * Versioned code-owned ranking profile. Version 2 widens the per-lane
 * candidate limit to 64 and introduces the hosted-rerank merged-pool caps.
 * These values are internal retrieval defaults, never user or Admin settings.
 */
export const KNOWLEDGE_RANKING_PROFILE_VERSION = 2 as const;
export const KNOWLEDGE_LANE_CANDIDATE_LIMIT = 64 as const;
export const KNOWLEDGE_BROAD_RERANK_INPUT_MAX = 96 as const;
export const KNOWLEDGE_SCOPED_RERANK_INPUT_MAX = 48 as const;
export const KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR = 0.1;
export const KNOWLEDGE_METADATA_RELEVANCE_FLOOR = 0.45;
export const KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR = 0.65;
export const KNOWLEDGE_SOFT_DIVERSITY_RELATIVE_BAND = 0.08;

export type KnowledgeRetrievalLane =
  | "document_lexical"
  | "exact"
  | "metadata"
  | "neighbor"
  | "passage_lexical"
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

/** Content-free deterministic RRF replay evidence. */
export type KnowledgeRankingEvidence = Readonly<{
  candidateOrder: readonly string[];
  fusion: typeof KNOWLEDGE_RETRIEVAL_FUSION;
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
  passage_lexical: 1.3,
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
    case "passage_lexical":
    case "section_lexical":
      return signal.rawScore >= KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR;
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

function relevanceEligibleCandidate(
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
    const accepted = relevanceEligibleCandidate(candidate);
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
      sum + KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS[signal.lane] /
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

/**
 * Builds the merged pre-rerank candidate pool: weighted RRF pre-order,
 * canonical content deduplication, guaranteed exact-candidate survival, and
 * soft balancing across accepted bindings, capped at the versioned rerank
 * input maximum. Relevance floors are deliberately not applied here — the
 * hosted reranker sees every authority-scoped candidate.
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
  const representativeByContent = new Map<string, KnowledgeRankedCandidate>();
  const seenChunks = new Set<string>();
  for (const candidate of fused) {
    if (seenChunks.has(candidate.chunkId)) continue;
    seenChunks.add(candidate.chunkId);
    const existing = representativeByContent.get(candidate.contentHash);
    if (!existing || knowledgeCandidateHasExactSignal(candidate) &&
      !knowledgeCandidateHasExactSignal(existing)) {
      // Canonical content dedup must not erase the exact signal merely
      // because another Source's duplicate happened to have stronger dense
      // evidence. Keep the exact-bearing representative; ties retain the
      // deterministic fused pre-order.
      representativeByContent.set(candidate.contentHash, candidate);
    }
  }
  const deduped = [...representativeByContent.values()].sort((left, right) =>
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
  // Exact candidates survive pre-rerank bounding regardless of dense or
  // lexical strength and regardless of binding quotas.
  for (const candidate of deduped) {
    if (selected.length >= input.maximum) break;
    if (knowledgeCandidateHasExactSignal(candidate)) take(candidate);
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

/**
 * Final ranking after hosted reranking: descending rerank score, exact signal
 * as tie-breaker, fused RRF score next, deterministic chunk id last. Scored
 * candidates always precede candidates the provider omitted; omitted
 * candidates keep their deterministic weighted RRF order.
 */
export function orderRerankedKnowledgeCandidates(input: Readonly<{
  pool: readonly KnowledgeRankedCandidate[];
  rerankScores: ReadonlyMap<string, number>;
}>): KnowledgeRerankedCandidate[] {
  const withScores = input.pool.map((candidate): KnowledgeRerankedCandidate =>
    Object.freeze({
      ...candidate,
      rerankScore: input.rerankScores.get(candidate.chunkId) ?? null
    }));
  return withScores.sort((left, right) => {
    if ((left.rerankScore === null) !== (right.rerankScore === null)) {
      return left.rerankScore === null ? 1 : -1;
    }
    if (left.rerankScore !== null && right.rerankScore !== null &&
      left.rerankScore !== right.rerankScore) {
      return right.rerankScore - left.rerankScore;
    }
    const leftExact = knowledgeCandidateHasExactSignal(left) ? 1 : 0;
    const rightExact = knowledgeCandidateHasExactSignal(right) ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;
    if (left.fusedScore !== right.fusedScore) return right.fusedScore - left.fusedScore;
    return left.chunkId.localeCompare(right.chunkId);
  });
}

/**
 * Post-rerank final selection: canonical content deduplication, then soft
 * Source diversity applied only inside the narrow relative score band, then
 * the final broad/scoped result limit. Diversity never promotes an unscored
 * candidate above a scored one and never lifts a candidate outside the band.
 */
export function selectRerankedKnowledgeCandidates(input: Readonly<{
  candidates: readonly KnowledgeRerankedCandidate[];
  resultLimit: number;
}>): KnowledgeRerankedCandidate[] {
  const selectedChunks = new Set<string>();
  const selectedContent = new Set<string>();
  const remaining = input.candidates.filter(primaryCandidate).filter((candidate) => {
    if (selectedChunks.has(candidate.chunkId) || selectedContent.has(candidate.contentHash)) {
      return false;
    }
    selectedChunks.add(candidate.chunkId);
    selectedContent.add(candidate.contentHash);
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
  const selectedChunks = new Set<string>();
  const selectedContent = new Set<string>();
  const remaining = input.candidates.filter(primaryCandidate).filter((candidate) => {
    if (selectedChunks.has(candidate.chunkId) || selectedContent.has(candidate.contentHash)) {
      return false;
    }
    selectedChunks.add(candidate.chunkId);
    selectedContent.add(candidate.contentHash);
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
    const accepted = relevanceEligibleCandidate(candidate);
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
