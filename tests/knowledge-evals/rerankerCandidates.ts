import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createLocalKnowledgeReranker,
  rankKnowledgeCandidates,
  type KnowledgeRetrievalCandidate
} from "../../lib/server/knowledge/retrievalRanking";
import {
  knowledgeRerankerCandidatePoolSchema,
  type KnowledgeRerankerCandidatePool,
  type KnowledgeRerankerCorpusManifest,
  type KnowledgeRerankerCorpusPassage,
  type KnowledgeRerankerEmbeddingIdentity
} from "./rerankerCorpusSchema";

export const KNOWLEDGE_RERANKER_CANDIDATE_SET_VERSION =
  "knowledge-reranker-candidates-v1" as const;

export const knowledgeRerankerUnavailableReasons = [
  "approved_embedding_not_configured",
  "cost_evidence_unavailable",
  "gpu_evidence_unavailable",
  "hybrid_component_unavailable",
  "local_model_not_configured",
  "model_artifact_missing",
  "provider_credential_missing",
  "system_model_structured_output_unavailable",
  "system_model_not_authorized"
] as const;

export type KnowledgeRerankerUnavailableReason =
  (typeof knowledgeRerankerUnavailableReasons)[number];

export type KnowledgeRerankerEmbeddingExecutor = Readonly<{
  embed(input: Readonly<{
    kind: "document" | "query";
    texts: readonly string[];
  }>): Promise<Readonly<{
    costMicros: number | null;
    inputTokens: number | null;
    vectors: readonly (readonly number[])[];
  }>>;
  identity: KnowledgeRerankerEmbeddingIdentity;
}>;

export type KnowledgeRerankerCandidatePoolBuildResult = Readonly<{
  evidence: Readonly<{
    cost: Readonly<{
      micros: number | null;
      status: "measured" | "unavailable";
    }>;
    durationMilliseconds: number;
    inputBytes: number;
    inputTokens: number | null;
    passageCount: number;
    queryCount: number;
  }>;
  pool: KnowledgeRerankerCandidatePool;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function finiteVector(vector: readonly number[], dimensions: number): boolean {
  return vector.length === dimensions && vector.every(Number.isFinite);
}

function normalized(vector: readonly number[]): readonly number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw new Error("knowledge_reranker_embedding_vector_invalid");
  }
  return Object.freeze(vector.map((value) => value / magnitude));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function frozenScore(value: number): number {
  return Number(Math.max(-1, Math.min(1, value)).toFixed(12));
}

export async function buildKnowledgeRerankerCandidatePool(input: Readonly<{
  candidateLimit: number;
  corpus: KnowledgeRerankerCorpusManifest;
  embedding: KnowledgeRerankerEmbeddingExecutor;
}>): Promise<KnowledgeRerankerCandidatePoolBuildResult> {
  const passages = input.corpus.documents.flatMap((document) => document.passages);
  if (!Number.isSafeInteger(input.candidateLimit) || input.candidateLimit < 1 ||
    input.candidateLimit > Math.min(50, passages.length)) {
    throw new Error("knowledge_reranker_candidate_limit_invalid");
  }
  if (new Set(passages.map((passage) => passage.id)).size !== passages.length) {
    throw new Error("knowledge_reranker_passage_identity_invalid");
  }
  const start = performance.now();
  const [passageResult, queryResult] = await Promise.all([
    input.embedding.embed({ kind: "document", texts: passages.map((passage) => passage.text) }),
    input.embedding.embed({ kind: "query", texts: input.corpus.queries.map((query) => query.text) })
  ]);
  const dimensions = input.embedding.identity.dimensions;
  if (passageResult.vectors.length !== passages.length ||
    queryResult.vectors.length !== input.corpus.queries.length ||
    [...passageResult.vectors, ...queryResult.vectors]
      .some((vector) => !finiteVector(vector, dimensions))) {
    throw new Error("knowledge_reranker_embedding_result_invalid");
  }
  const passageVectors = passageResult.vectors.map(normalized);
  const queryVectors = queryResult.vectors.map(normalized);
  const queries = input.corpus.queries.map((query, queryIndex) => ({
    candidates: passages.map((passage, passageIndex) => ({
      cosineSimilarity: frozenScore(cosine(queryVectors[queryIndex]!, passageVectors[passageIndex]!)),
      passageId: passage.id
    })).sort((left, right) =>
      right.cosineSimilarity - left.cosineSimilarity ||
      left.passageId.localeCompare(right.passageId))
      .slice(0, input.candidateLimit)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    queryId: query.id
  }));
  const poolBody = {
    candidateLimit: input.candidateLimit,
    corpusSha256: input.corpus.corpusSha256,
    embedding: input.embedding.identity,
    noRelevanceDerivedSignals: true as const,
    qualityGateEligible: input.embedding.identity.executionClass === "real_embedding" &&
      input.embedding.identity.approval === "approved_candidate" &&
      input.embedding.identity.authorization !== "test_double",
    queries,
    samePoolForEveryCandidate: true as const,
    version: "knowledge-reranker-candidate-pool-v1" as const
  };
  const pool = knowledgeRerankerCandidatePoolSchema.parse({
    ...poolBody,
    poolSha256: sha256(JSON.stringify(poolBody))
  });
  const costs = [passageResult.costMicros, queryResult.costMicros];
  const tokens = [passageResult.inputTokens, queryResult.inputTokens];
  return Object.freeze({
    evidence: Object.freeze({
      cost: Object.freeze(costs.every((value) => value !== null)
        ? { micros: costs.reduce((sum, value) => sum + value!, 0), status: "measured" as const }
        : { micros: null, status: "unavailable" as const }),
      durationMilliseconds: performance.now() - start,
      inputBytes: Buffer.byteLength([
        ...passages.map((passage) => passage.text),
        ...input.corpus.queries.map((query) => query.text)
      ].join(""), "utf8"),
      inputTokens: tokens.every((value) => value !== null)
        ? tokens.reduce((sum, value) => sum + value!, 0)
        : null,
      passageCount: passages.length,
      queryCount: input.corpus.queries.length
    }),
    pool
  });
}

export type KnowledgeSemanticRerankerIdentity = Readonly<{
  authorization: "evaluation_only" | "profile_authorized";
  backend: string;
  egress: "external" | "none";
  hardware: "cpu" | "gpu" | "provider_managed";
  modelId: string;
  provider: string;
  resources?: Readonly<{
    cpuLogicalCores: number | null;
    gpuDevice: string | null;
    scope: "isolated_runner" | "provider_managed" | "unavailable";
  }>;
  revision: string;
}>;

export type KnowledgeSemanticRerankerExecutor = Readonly<{
  identity: KnowledgeSemanticRerankerIdentity;
  rerank(input: Readonly<{
    passages: readonly Readonly<{ id: string; text: string }>[];
    query: string;
  }>): Promise<Readonly<{
    costMicros: number | null;
    inputTokens: number | null;
    resourceUsage?: Readonly<{
      peakGpuMemoryBytes: number | null;
      peakRssBytes: number;
    }> | null;
    scores: readonly Readonly<{ passageId: string; score: number }>[];
  }>>;
}>;

export type KnowledgeRerankerScoringInput = Readonly<{
  passages: readonly Readonly<{
    documentId: string;
    passage: KnowledgeRerankerCorpusPassage;
    retrievalRank: number;
    retrievalSimilarity: number;
  }>[];
  query: string;
}>;

export type KnowledgeRerankerScoringResult = Readonly<{
  costMicros: number | null;
  inputTokens: number | null;
  resourceUsage?: Readonly<{
    peakGpuMemoryBytes: number | null;
    peakRssBytes: number;
  }> | null;
  scores: readonly Readonly<{ passageId: string; score: number }>[];
}>;

type AvailableCandidate = Readonly<{
  availability: "available";
  egress: "external" | "none";
  fallbackCandidateId: "deterministic_heuristic_v1" | "weighted_rrf_v2";
  id: "deterministic_heuristic_v1" | "hybrid_local_v1" |
    "local_multilingual_cross_encoder" | "system_model_reranker";
  identity: Readonly<{
    authorization: "evaluation_only" | "local" | "profile_authorized";
    backend: string;
    hardware: "cpu" | "gpu" | "provider_managed";
    modelId: string;
    provider: string;
    resources: Readonly<{
      cpuLogicalCores: number | null;
      gpuDevice: string | null;
      scope: "isolated_runner" | "provider_managed" | "shared_process" | "unavailable";
    }>;
    revision: string;
  }>;
  kind: "deterministic" | "hybrid" | "local_cross_encoder" | "system_model";
  score(input: KnowledgeRerankerScoringInput): Promise<KnowledgeRerankerScoringResult>;
}>;

type UnavailableCandidate = Readonly<{
  availability: "unavailable";
  egress: "external" | "none";
  fallbackCandidateId: "deterministic_heuristic_v1";
  id: "hybrid_local_v1" | "local_multilingual_cross_encoder" | "system_model_reranker";
  kind: "hybrid" | "local_cross_encoder" | "system_model";
  reason: KnowledgeRerankerUnavailableReason;
}>;

export type KnowledgeRerankerCandidate = AvailableCandidate | UnavailableCandidate;

function passageLookup(input: KnowledgeRerankerScoringInput): Map<string, {
  documentId: string;
  passage: KnowledgeRerankerCorpusPassage;
  retrievalRank: number;
  retrievalSimilarity: number;
}> {
  return new Map(input.passages.map((entry) => [entry.passage.id, entry]));
}

function deterministicRetrievalCandidate(
  entry: KnowledgeRerankerScoringInput["passages"][number]
): KnowledgeRetrievalCandidate {
  const normalizedSimilarity = (entry.retrievalSimilarity + 1) / 2;
  return Object.freeze({
    baseName: entry.documentId,
    bindingOrdinal: 0,
    chunkId: entry.passage.id,
    chunkIndex: entry.passage.ordinal - 1,
    contentHash: entry.passage.contentSha256,
    documentId: entry.documentId,
    documentVersionId: `${entry.documentId}-version-1`,
    documentVersionNumber: 1,
    fileName: `${entry.documentId}.txt`,
    headingPath: Object.freeze([]),
    knowledgeBaseId: "knowledge-reranker-eval",
    layoutKind: "body",
    page: entry.passage.ordinal,
    sectionId: `${entry.documentId}-section-${entry.passage.ordinal}`,
    signals: Object.freeze([Object.freeze({
      exactKind: null,
      lane: "passage_semantic" as const,
      rank: entry.retrievalRank,
      rawScore: normalizedSimilarity,
      vectorDistance: 1 - normalizedSimilarity,
      vectorMode: "exact" as const
    })]),
    sourceArtifactId: `${entry.documentId}-artifact`,
    sourceName: entry.documentId,
    text: entry.passage.text
  });
}

async function deterministicScore(
  input: KnowledgeRerankerScoringInput
): Promise<KnowledgeRerankerScoringResult> {
  const result = await rankKnowledgeCandidates({
    candidates: input.passages.map(deterministicRetrievalCandidate),
    query: input.query,
    reranker: createLocalKnowledgeReranker(),
    resultLimit: input.passages.length,
    scoreThreshold: 0
  });
  return Object.freeze({
    costMicros: 0,
    inputTokens: null,
    scores: Object.freeze(result.ranked.map((entry) => Object.freeze({
      passageId: entry.chunkId,
      score: entry.rerankScore ?? entry.confidence
    })))
  });
}

function semanticScore(
  executor: KnowledgeSemanticRerankerExecutor,
  input: KnowledgeRerankerScoringInput
): Promise<KnowledgeRerankerScoringResult> {
  return executor.rerank({
    passages: input.passages.map((entry) => ({
      id: entry.passage.id,
      text: entry.passage.text
    })),
    query: input.query
  }).then((result) => {
    const expected = passageLookup(input);
    if (result.scores.length !== expected.size ||
      new Set(result.scores.map((entry) => entry.passageId)).size !== expected.size ||
      result.scores.some((entry) => !expected.has(entry.passageId) ||
        !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1)) {
      throw new Error("knowledge_reranker_candidate_result_invalid");
    }
    return Object.freeze({
      costMicros: result.costMicros,
      inputTokens: result.inputTokens,
      ...(result.resourceUsage === undefined
        ? {}
        : { resourceUsage: result.resourceUsage }),
      scores: Object.freeze(result.scores.map((entry) => Object.freeze({ ...entry })))
    });
  });
}

function availableSemanticCandidate(input: Readonly<{
  executor: KnowledgeSemanticRerankerExecutor;
  id: "local_multilingual_cross_encoder" | "system_model_reranker";
  kind: "local_cross_encoder" | "system_model";
}>): AvailableCandidate {
  return Object.freeze({
    availability: "available",
    egress: input.executor.identity.egress,
    fallbackCandidateId: "deterministic_heuristic_v1",
    id: input.id,
    identity: Object.freeze({
      authorization: input.executor.identity.authorization,
      backend: input.executor.identity.backend,
      hardware: input.executor.identity.hardware,
      modelId: input.executor.identity.modelId,
      provider: input.executor.identity.provider,
      resources: input.executor.identity.resources ?? Object.freeze({
        cpuLogicalCores: null,
        gpuDevice: null,
        scope: input.executor.identity.hardware === "provider_managed"
          ? "provider_managed" as const
          : "unavailable" as const
      }),
      revision: input.executor.identity.revision
    }),
    kind: input.kind,
    score: (scoringInput) => semanticScore(input.executor, scoringInput)
  });
}

export function createKnowledgeRerankerCandidates(input: Readonly<{
  localCrossEncoder?: KnowledgeSemanticRerankerExecutor;
  localUnavailableReason?: KnowledgeRerankerUnavailableReason;
  systemModel?: KnowledgeSemanticRerankerExecutor;
  systemUnavailableReason?: KnowledgeRerankerUnavailableReason;
}> = {}): readonly KnowledgeRerankerCandidate[] {
  const deterministic: AvailableCandidate = Object.freeze({
    availability: "available",
    egress: "none",
    fallbackCandidateId: "weighted_rrf_v2",
    id: "deterministic_heuristic_v1",
    identity: Object.freeze({
      authorization: "local",
      backend: "typescript",
      hardware: "cpu",
      modelId: "none",
      provider: "local",
      resources: Object.freeze({
        cpuLogicalCores: null,
        gpuDevice: null,
        scope: "shared_process" as const
      }),
      revision: "deterministic-token-vector-heuristic-v1"
    }),
    kind: "deterministic",
    score: deterministicScore
  });
  const local: KnowledgeRerankerCandidate = input.localCrossEncoder
    ? availableSemanticCandidate({
      executor: input.localCrossEncoder,
      id: "local_multilingual_cross_encoder",
      kind: "local_cross_encoder"
    })
    : Object.freeze({
      availability: "unavailable",
      egress: "none",
      fallbackCandidateId: "deterministic_heuristic_v1",
      id: "local_multilingual_cross_encoder",
      kind: "local_cross_encoder",
      reason: input.localUnavailableReason ?? "local_model_not_configured"
    });
  const system: KnowledgeRerankerCandidate = input.systemModel
    ? availableSemanticCandidate({
      executor: input.systemModel,
      id: "system_model_reranker",
      kind: "system_model"
    })
    : Object.freeze({
      availability: "unavailable",
      egress: "external",
      fallbackCandidateId: "deterministic_heuristic_v1",
      id: "system_model_reranker",
      kind: "system_model",
      reason: input.systemUnavailableReason ?? "system_model_not_authorized"
    });
  const hybrid: KnowledgeRerankerCandidate = input.localCrossEncoder
    ? Object.freeze({
      availability: "available",
      egress: input.localCrossEncoder.identity.egress,
      fallbackCandidateId: "deterministic_heuristic_v1",
      id: "hybrid_local_v1",
      identity: Object.freeze({
        authorization: input.localCrossEncoder.identity.authorization,
        backend: `hybrid:${input.localCrossEncoder.identity.backend}`,
        hardware: input.localCrossEncoder.identity.hardware,
        modelId: input.localCrossEncoder.identity.modelId,
        provider: input.localCrossEncoder.identity.provider,
        resources: input.localCrossEncoder.identity.resources ?? Object.freeze({
          cpuLogicalCores: null,
          gpuDevice: null,
          scope: "unavailable" as const
        }),
        revision: `0.35-deterministic+0.65-${input.localCrossEncoder.identity.revision}`
      }),
      kind: "hybrid",
      async score(scoringInput: KnowledgeRerankerScoringInput) {
        const [deterministicResult, semanticResult] = await Promise.all([
          deterministicScore(scoringInput),
          semanticScore(input.localCrossEncoder!, scoringInput)
        ]);
        const semanticById = new Map(semanticResult.scores.map((entry) =>
          [entry.passageId, entry.score]));
        return Object.freeze({
          costMicros: semanticResult.costMicros,
          inputTokens: semanticResult.inputTokens,
          ...(semanticResult.resourceUsage === undefined
            ? {}
            : { resourceUsage: semanticResult.resourceUsage }),
          scores: Object.freeze(deterministicResult.scores.map((entry) => Object.freeze({
            passageId: entry.passageId,
            score: 0.35 * entry.score + 0.65 * semanticById.get(entry.passageId)!
          })))
        });
      }
    } satisfies AvailableCandidate)
    : Object.freeze({
      availability: "unavailable",
      egress: "none",
      fallbackCandidateId: "deterministic_heuristic_v1",
      id: "hybrid_local_v1",
      kind: "hybrid",
      reason: "hybrid_component_unavailable"
    });
  return Object.freeze([deterministic, local, system, hybrid]);
}
