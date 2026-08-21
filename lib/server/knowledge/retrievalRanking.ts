import type { KnowledgeDocumentContextV1 } from "./documentContext";

export const KNOWLEDGE_RETRIEVAL_FUSION = "weighted_rrf_v2" as const;
export const KNOWLEDGE_RRF_K = 60;
export const KNOWLEDGE_RANKING_CANDIDATE_MAX = 1_000;
export const KNOWLEDGE_DIVERSE_SOURCE_LIMIT = 4;
export const KNOWLEDGE_MULTI_SOURCE_PRIMARY_LIMIT = 3;

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

const laneWeights: Readonly<Record<KnowledgeRetrievalLane, number>> = Object.freeze({
  document_lexical: 0.7,
  exact: 2.6,
  metadata: 1.2,
  neighbor: 0.25,
  passage_lexical: 1.3,
  passage_semantic: 1.15,
  section_lexical: 0.9
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

export function fuseKnowledgeCandidates(
  candidates: readonly KnowledgeRetrievalCandidate[]
): KnowledgeRankedCandidate[] {
  const maximum = Object.values(laneWeights)
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
      sum + laneWeights[signal.lane] / (KNOWLEDGE_RRF_K + signal.rank), 0) / maximum);
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

export function selectSourceDiverseKnowledgeCandidates(input: Readonly<{
  candidates: readonly KnowledgeRankedCandidate[];
  resultLimit: number;
}>): KnowledgeRankedCandidate[] {
  const ranked = input.candidates.filter(primaryCandidate);
  const sourceCount = new Set(ranked.map(sourceKey)).size;
  const perSourceLimit = sourceCount >= 2
    ? KNOWLEDGE_MULTI_SOURCE_PRIMARY_LIMIT
    : input.resultLimit;
  const selected: KnowledgeRankedCandidate[] = [];
  const selectedChunks = new Set<string>();
  const selectedContent = new Set<string>();
  const selectedSources = new Set<string>();
  const counts = new Map<string, number>();
  const add = (candidate: KnowledgeRankedCandidate): boolean => {
    const source = sourceKey(candidate);
    if (selected.length >= input.resultLimit || selectedChunks.has(candidate.chunkId) ||
      selectedContent.has(candidate.contentHash) ||
      (counts.get(source) ?? 0) >= perSourceLimit) return false;
    selected.push(candidate);
    selectedChunks.add(candidate.chunkId);
    selectedContent.add(candidate.contentHash);
    selectedSources.add(source);
    counts.set(source, (counts.get(source) ?? 0) + 1);
    return true;
  };

  for (const candidate of ranked) {
    if (selectedSources.size >= KNOWLEDGE_DIVERSE_SOURCE_LIMIT) break;
    if (!selectedSources.has(sourceKey(candidate))) add(candidate);
  }
  for (const candidate of ranked) add(candidate);
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
  const ranked = Object.freeze(fuseKnowledgeCandidates(input.candidates));
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
