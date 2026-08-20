import type { KnowledgeDocumentContextV1 } from "./documentContext";

export const KNOWLEDGE_RETRIEVAL_FUSION = "weighted_rrf_v2" as const;
export const KNOWLEDGE_RERANKER_PROFILE =
  "deterministic-token-vector-heuristic-v1" as const;
export const KNOWLEDGE_RERANKER_FALLBACK_PROFILE = "weighted-rrf-v2" as const;
export const KNOWLEDGE_RERANKER_VERSION = 1;
export const KNOWLEDGE_RRF_K = 60;
export const KNOWLEDGE_MIN_CONFIDENCE = 0.22;
export const KNOWLEDGE_RANKING_CANDIDATE_MAX = 1_000;

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
  confidence: number;
  fusedScore: number;
  rerankScore: number | null;
}>;

export type KnowledgeRerankerBindingEvidence =
  | Readonly<{
      egress: "none";
      kind: "deterministic_token_vector_heuristic";
      languages: readonly ["en", "ru"];
      profile: typeof KNOWLEDGE_RERANKER_PROFILE;
      status: "complete";
      version: typeof KNOWLEDGE_RERANKER_VERSION;
    }>
  | Readonly<{
      egress: "none";
      failureCode: "knowledge_reranker_unavailable";
      kind: "deterministic_weighted_rrf_fallback";
      languages: readonly ["en", "ru"];
      profile: typeof KNOWLEDGE_RERANKER_FALLBACK_PROFILE;
      status: "degraded";
      version: typeof KNOWLEDGE_RERANKER_VERSION;
    }>;

export type KnowledgeRankingEvidence = Readonly<{
  fusion: typeof KNOWLEDGE_RETRIEVAL_FUSION;
  postRerankOrder: readonly string[];
  preRerankOrder: readonly string[];
  rerankerBinding: KnowledgeRerankerBindingEvidence;
}>;

export type KnowledgeCandidateReranker = Readonly<{
  rerank(input: Readonly<{
    candidates: readonly KnowledgeRankedCandidate[];
    query: string;
  }>): Promise<readonly Readonly<{ chunkId: string; score: number }>[] >;
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

const stopWords = new Set([
  "a", "about", "after", "all", "an", "and", "are", "as", "at", "be", "by",
  "can", "does", "every", "find", "for", "from", "get", "how", "in", "is", "it",
  "of", "on", "open", "or", "the", "to", "under", "what", "when", "where", "which",
  "who", "with", "а", "в", "все", "где", "для", "и", "из", "или", "как", "какой",
  "когда", "кто", "на", "над", "о", "об", "от", "по", "под", "при", "про", "сколько",
  "что", "это"
]);

const comparisonPattern = /\b(?:compare|comparison|difference|differences|versus|vs)\b|сравн|разниц/iu;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/ё/gu, "е");
}

function stem(token: string): string {
  if (token.length <= 4) return token;
  if (/^[a-z]+$/u.test(token)) {
    return token.replace(/(?:ation|ments?|ingly|edly|ing|ers?|ed|es|s)$/u, "") || token;
  }
  if (/^[а-я]+$/u.test(token)) {
    return token.replace(
      /(?:иями|ями|ами|ого|ему|ому|ими|ий|ый|ая|яя|ое|ее|ые|ие|ых|их|ую|юю|ов|ев|ам|ям|ах|ях|ом|ем|ой|ей|ы|и|а|я|у|ю|е|о)$/u,
      ""
    ) || token;
  }
  return token;
}

function tokens(value: string): string[] {
  return [...normalized(value).matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)]
    .map((match) => match[0]!)
    .filter((token) => !stopWords.has(token))
    .map(stem)
    .filter((token) => token.length >= 2);
}

function tokenCoverage(query: string, candidate: KnowledgeRetrievalCandidate): number {
  const queryTokens = [...new Set(tokens(query))];
  if (queryTokens.length === 0) return 0;
  const candidateTokens = new Set(tokens([
    candidate.sourceName,
    candidate.fileName,
    ...candidate.headingPath,
    candidate.text
  ].join(" ")));
  return queryTokens.filter((token) => candidateTokens.has(token)).length / queryTokens.length;
}

function semanticScore(candidate: KnowledgeRetrievalCandidate): number {
  const distances = candidate.signals.flatMap((signal) =>
    signal.vectorDistance === null ? [] : [signal.vectorDistance]);
  if (distances.length === 0) return 0;
  return clamp(1 - Math.min(...distances));
}

function hasLane(candidate: KnowledgeRetrievalCandidate, lane: KnowledgeRetrievalLane): boolean {
  return candidate.signals.some((signal) => signal.lane === lane);
}

function calibratedScore(
  query: string,
  candidate: KnowledgeRankedCandidate,
  includeCrossSignals: boolean
): number {
  const semantic = semanticScore(candidate);
  const coverage = tokenCoverage(query, candidate);
  const exact = hasLane(candidate, "exact") ? 1 : 0;
  const metadata = hasLane(candidate, "metadata") ? 1 : 0;
  const lexical = candidate.signals.some((signal) => signal.lane.endsWith("_lexical")) ? 1 : 0;
  const distinctLanes = new Set(candidate.signals.map((signal) => signal.lane)).size;
  const consensus = clamp((distinctLanes - 1) / 3);
  const crossSignals = includeCrossSignals
    ? 0.3 * coverage + 0.07 * consensus
    : 0.18 * coverage + 0.04 * consensus;
  return clamp(
    0.42 * semantic +
    crossSignals +
    0.12 * exact +
    0.07 * metadata +
    0.06 * (lexical ? 1 : 0) +
    0.04 * candidate.fusedScore
  );
}

function candidateOrder(
  left: Pick<KnowledgeRankedCandidate, "chunkId" | "confidence" | "fusedScore">,
  right: Pick<KnowledgeRankedCandidate, "chunkId" | "confidence" | "fusedScore">
): number {
  return right.confidence - left.confidence ||
    right.fusedScore - left.fusedScore ||
    left.chunkId.localeCompare(right.chunkId);
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
      confidence: 0,
      fusedScore,
      rerankScore: null
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

export function createLocalKnowledgeReranker(): KnowledgeCandidateReranker {
  return Object.freeze({
    async rerank(input) {
      return Object.freeze(input.candidates.map((candidate) => Object.freeze({
        chunkId: candidate.chunkId,
        score: calibratedScore(input.query, candidate, true)
      })).sort((left, right) =>
        right.score - left.score || left.chunkId.localeCompare(right.chunkId)));
    }
  });
}

function distinctiveNames(candidate: KnowledgeRetrievalCandidate): string[] {
  return [...new Set(tokens(`${candidate.sourceName} ${candidate.fileName}`))]
    .filter((token) => token.length >= 4 && !/^\d+$/u.test(token));
}

function namedTargetKey(query: string, candidate: KnowledgeRetrievalCandidate): string | null {
  const queryTokens = new Set(tokens(query));
  const matched = distinctiveNames(candidate).find((token) => queryTokens.has(token));
  return matched ?? null;
}

function selectCandidates(input: Readonly<{
  candidates: readonly KnowledgeRankedCandidate[];
  query: string;
  resultLimit: number;
  scoreThreshold: number;
}>): KnowledgeRankedCandidate[] {
  const minimum = Math.max(KNOWLEDGE_MIN_CONFIDENCE, input.scoreThreshold);
  const eligible = input.candidates.filter((candidate) => candidate.confidence >= minimum);
  if (eligible.length === 0) return [];

  const selected: KnowledgeRankedCandidate[] = [];
  const selectedChunks = new Set<string>();
  const selectedContent = new Set<string>();
  const selectedDocuments = new Map<string, number>();
  const targetKeys = new Set(eligible.flatMap((candidate) => {
    const key = namedTargetKey(input.query, candidate);
    return key ? [key] : [];
  }));
  const coverageRequired = comparisonPattern.test(input.query) || targetKeys.size >= 2;

  const add = (candidate: KnowledgeRankedCandidate, allowRepeatedContent = false): boolean => {
    if (selected.length >= input.resultLimit || selectedChunks.has(candidate.chunkId)) return false;
    if (!allowRepeatedContent && selectedContent.has(candidate.contentHash)) return false;
    selected.push(candidate);
    selectedChunks.add(candidate.chunkId);
    selectedContent.add(candidate.contentHash);
    selectedDocuments.set(candidate.documentId, (selectedDocuments.get(candidate.documentId) ?? 0) + 1);
    return true;
  };

  if (coverageRequired) {
    for (const target of targetKeys) {
      const candidate = eligible.find((entry) => namedTargetKey(input.query, entry) === target);
      if (candidate) add(candidate, true);
    }
  }

  for (const candidate of eligible) {
    if (selected.length >= input.resultLimit) break;
    if ((selectedDocuments.get(candidate.documentId) ?? 0) === 0) add(candidate);
  }
  for (const candidate of eligible) {
    if (selected.length >= input.resultLimit) break;
    if ((selectedDocuments.get(candidate.documentId) ?? 0) < 2) add(candidate);
  }
  for (const candidate of eligible) {
    if (selected.length >= input.resultLimit) break;
    add(candidate);
  }
  return selected;
}

export async function rankKnowledgeCandidates(input: Readonly<{
  candidates: readonly KnowledgeRetrievalCandidate[];
  query: string;
  reranker?: KnowledgeCandidateReranker;
  resultLimit: number;
  scoreThreshold: number;
}>): Promise<Readonly<{
  evidence: KnowledgeRankingEvidence;
  ranked: readonly KnowledgeRankedCandidate[];
  selected: readonly KnowledgeRankedCandidate[];
}>> {
  const fused = fuseKnowledgeCandidates(input.candidates);
  const preRerankOrder = Object.freeze(fused.map((candidate) => candidate.chunkId));
  let ranked: KnowledgeRankedCandidate[];
  let binding: KnowledgeRerankerBindingEvidence;
  try {
    const scores = await (input.reranker ?? createLocalKnowledgeReranker()).rerank({
      candidates: fused,
      query: input.query
    });
    const byChunk = new Map(scores.map((entry) => [entry.chunkId, entry.score]));
    if (
      byChunk.size !== fused.length ||
      fused.some((candidate) => {
        const score = byChunk.get(candidate.chunkId);
        return score === undefined || !Number.isFinite(score) || score < 0 || score > 1;
      })
    ) throw new Error("knowledge_reranker_result_invalid");
    ranked = fused.map((candidate): KnowledgeRankedCandidate => {
      const score = byChunk.get(candidate.chunkId)!;
      return Object.freeze({ ...candidate, confidence: score, rerankScore: score });
    }).sort(candidateOrder);
    binding = Object.freeze({
      egress: "none",
      kind: "deterministic_token_vector_heuristic",
      languages: Object.freeze(["en", "ru"] as const),
      profile: KNOWLEDGE_RERANKER_PROFILE,
      status: "complete",
      version: KNOWLEDGE_RERANKER_VERSION
    });
  } catch {
    ranked = fused.map((candidate): KnowledgeRankedCandidate => Object.freeze({
      ...candidate,
      confidence: calibratedScore(input.query, candidate, false),
      rerankScore: null
    })).sort((left, right) =>
      right.fusedScore - left.fusedScore || candidateOrder(left, right));
    binding = Object.freeze({
      egress: "none",
      failureCode: "knowledge_reranker_unavailable",
      kind: "deterministic_weighted_rrf_fallback",
      languages: Object.freeze(["en", "ru"] as const),
      profile: KNOWLEDGE_RERANKER_FALLBACK_PROFILE,
      status: "degraded",
      version: KNOWLEDGE_RERANKER_VERSION
    });
  }
  const selected = Object.freeze(selectCandidates({
    candidates: ranked,
    query: input.query,
    resultLimit: input.resultLimit,
    scoreThreshold: input.scoreThreshold
  }));
  return Object.freeze({
    evidence: Object.freeze({
      fusion: KNOWLEDGE_RETRIEVAL_FUSION,
      postRerankOrder: Object.freeze(ranked.map((candidate) => candidate.chunkId)),
      preRerankOrder,
      rerankerBinding: binding
    }),
    ranked: Object.freeze(ranked),
    selected
  });
}
