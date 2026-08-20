import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  buildKnowledgeRerankerCandidatePool,
  createKnowledgeRerankerCandidates,
  type KnowledgeRerankerCandidate,
  type KnowledgeRerankerEmbeddingExecutor,
  type KnowledgeRerankerScoringInput,
  type KnowledgeRerankerScoringResult,
  type KnowledgeRerankerUnavailableReason,
  type KnowledgeSemanticRerankerExecutor
} from "./rerankerCandidates";
import {
  assessKnowledgeRerankerCorpus,
  createKnowledgeRerankerCorpusManifest,
  KNOWLEDGE_RERANKER_CORPUS_VERSION
} from "./rerankerCorpus";
import type {
  KnowledgeRerankerCandidatePool,
  KnowledgeRerankerCorpusManifest,
  KnowledgeRerankerLanguage
} from "./rerankerCorpusSchema";
import type { KnowledgeRerankerImportedReviewEvidence } from "./rerankerReview";
import {
  evaluateKnowledgeRerankerSelectionPolicy,
  KNOWLEDGE_RERANKER_NO_ANSWER_THRESHOLDS,
  type KnowledgeRerankerPolicyCandidateEvidence,
  type KnowledgeRerankerSelectionPolicyResult
} from "./rerankerSelectionPolicy";

export const KNOWLEDGE_PROFILE_BENCHMARK_VERSION = "knowledge-profile-benchmark-v3" as const;

type Unavailable = Readonly<{
  reason: string;
  status: "unavailable";
}>;

type ResourceEvidence = Unavailable | Readonly<{
  measurement: "runner_reported_peak";
  peakBytes: number;
  status: "measured";
}> | Readonly<{
  measurement: "hardware_not_used";
  peakBytes: 0;
  status: "not_used";
}> | Readonly<{
  measurement: "provider_managed";
  peakBytes: null;
  status: "provider_managed";
}>;

type QualitySlice = Readonly<{
  evaluatedAnswerableQueries: number;
  evaluatedNoAnswerQueries: number;
  meanReciprocalRankAt10: number | null;
  ndcgAt10: number | null;
  noAnswerAccuracy: number | null;
  recallAt10: number | null;
}>;

type MeasuredQuality = Readonly<{
  calibration: Readonly<{
    answerabilityAccuracy: number;
    evaluatedQueries: number;
    noAnswerThreshold: number;
    objective: "answerability_accuracy";
    split: "calibration";
    status: "measured_from_imported_human_labels";
  }>;
  byLanguage: Readonly<Record<KnowledgeRerankerLanguage, QualitySlice>>;
  evaluatedSplit: "held_out";
  overall: QualitySlice;
  scope: "held_out_within_frozen_candidate_pool";
  status: "measured_from_imported_human_labels";
}>;

type CandidateIdentity = Readonly<{
  authorization: "evaluation_only" | "local" | "profile_authorized";
  backend: string;
  hardware: "cpu" | "gpu" | "provider_managed";
  id: string;
  kind: "deterministic" | "hybrid" | "local_cross_encoder" | "system_model";
  modelId: string;
  provider: string;
  resources: Readonly<{
    cpuLogicalCores: number | null;
    gpuDevice: string | null;
    scope: "isolated_runner" | "provider_managed" | "shared_process" | "unavailable";
  }>;
  revision: string;
}>;

type CandidatePerformance = Readonly<{
  coldFirstQueryMilliseconds: number;
  concurrency: 1;
  measuredQueries: number;
  p50Milliseconds: number;
  p95Milliseconds: number;
  status: "measured";
  throughputQueriesPerSecond: number;
}>;

type CandidateCost = Readonly<{
  microsPerQuery: number | null;
  reason: string | null;
  status: "measured" | "unavailable";
  totalMicros: number | null;
}>;

type CandidateExecutionReport = Readonly<{
  cost: CandidateCost;
  egress: Readonly<{
    inputBytes: number;
    inputTokens: number | null;
    mode: "external" | "none";
    retention: "none" | "provider_policy";
  }>;
  executionStatus: "complete";
  gpu: ResourceEvidence;
  identity: CandidateIdentity;
  rss: ResourceEvidence;
  outage: Readonly<{
    evidence: "deterministic_fallback_replay" | "not_applicable" | "unavailable";
    fallbackCandidateId: "deterministic_heuristic_v1" | "weighted_rrf_v2";
    productionOutageEvidence: false;
    status: "not_applicable" | "unavailable" | "verified_in_benchmark";
    technicalLeakageObserved: false;
  }>;
  performance: CandidatePerformance;
  quality: MeasuredQuality | Unavailable;
}>;

type CandidateUnavailableReport = Readonly<{
  cost: Unavailable;
  egress: Readonly<{
    inputBytes: 0;
    inputTokens: null;
    mode: "external" | "none";
    retention: "none" | "provider_policy";
  }>;
  executionStatus: "unavailable";
  gpu: Unavailable;
  identity: Readonly<{
    id: string;
    kind: "hybrid" | "local_cross_encoder" | "system_model";
  }>;
  rss: Unavailable;
  outage: Readonly<{
    evidence: "unavailable";
    fallbackCandidateId: "deterministic_heuristic_v1";
    productionOutageEvidence: false;
    status: "unavailable";
    technicalLeakageObserved: false;
  }>;
  performance: Unavailable;
  quality: Unavailable;
  reason: string;
}>;

type CandidateFailedReport = Readonly<{
  cost: Unavailable;
  egress: Readonly<{
    inputBytes: number;
    inputTokens: null;
    mode: "external" | "none";
    retention: "none" | "provider_policy";
  }>;
  executionStatus: "failed";
  failureCode: "candidate_execution_failed";
  gpu: Unavailable;
  identity: CandidateIdentity;
  rss: Unavailable;
  outage: Readonly<{
    evidence: "deterministic_fallback_replay" | "not_applicable" | "unavailable";
    fallbackCandidateId: "deterministic_heuristic_v1" | "weighted_rrf_v2";
    productionOutageEvidence: false;
    status: "not_applicable" | "verified_in_benchmark" | "unavailable";
    technicalLeakageObserved: false;
  }>;
  performance: Unavailable;
  quality: Unavailable;
}>;

export type KnowledgeProfileBenchmarkCandidateReport =
  | CandidateExecutionReport
  | CandidateFailedReport
  | CandidateUnavailableReport;

export type KnowledgeProfileBenchmarkReport = Readonly<{
  aggregateOnly: true;
  candidates: readonly KnowledgeProfileBenchmarkCandidateReport[];
  contractValid: boolean;
  corpus: Readonly<{
    corpusSha256: string;
    documentCount: number;
    familyLeakage: false;
    queryCount: number;
    version: typeof KNOWLEDGE_RERANKER_CORPUS_VERSION;
  }>;
  embedding: Readonly<{
    approval: "approved_candidate" | "test_double_only";
    authorization: "evaluation_only" | "profile_authorized" | "test_double";
    cost: Readonly<{
      micros: number | null;
      status: "measured" | "unavailable";
    }>;
    egress: "external" | "none";
    execution: Readonly<{
      durationMilliseconds: number;
      inputBytes: number;
      inputTokens: number | null;
      passageCount: number;
      queryCount: number;
    }>;
    executionClass: "real_embedding" | "test_double";
    modelId: string;
    poolSha256: string;
    provider: string;
    qualityGateEligible: boolean;
    revision: string;
  }>;
  humanReview: Readonly<{
    adjudicationComplete: boolean;
    disagreement: Unavailable | Readonly<{
      adjudicatedItemCount: number;
      answerabilityDisagreementCount: number;
      pairLabelDisagreementCount: number;
      rawPairAgreement: number;
      status: "measured";
    }>;
    independentAnnotatorCount: number;
    labelsStatus: "imported" | "not_imported";
    reasonCodes: readonly string[];
    unresolvedMaterialDisagreements: number | null;
  }>;
  qualityGatePassed: boolean;
  selection: KnowledgeRerankerSelectionPolicyResult;
  version: typeof KNOWLEDGE_PROFILE_BENCHMARK_VERSION;
}>;

function hermeticEmbeddingExecutor(): KnowledgeRerankerEmbeddingExecutor {
  return Object.freeze({
    async embed(input) {
      return Object.freeze({
        costMicros: 0,
        inputTokens: null,
        vectors: Object.freeze(input.texts.map((text) => {
          const digest = createHash("sha256").update(text, "utf8").digest();
          return Object.freeze(Array.from({ length: 16 }, (_, index) =>
            (digest[index]! - 127.5) / 127.5));
        }))
      });
    },
    identity: Object.freeze({
      approval: "test_double_only",
      authorization: "test_double",
      dimensions: 16,
      egress: "none",
      executionClass: "test_double",
      modelId: "content-hash-vector-v1",
      provider: "hermetic-test-double",
      revision: "1",
      vectorSpaceId: "knowledge-reranker-hermetic-v1"
    })
  });
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dcg(relevances: readonly number[]): number {
  return relevances.reduce((sum, relevance, index) =>
    sum + (2 ** relevance - 1) / Math.log2(index + 2), 0);
}

function qualitySlice(input: readonly Readonly<{
  answerability: "answerable" | "no_answer" | "uncertain";
  ranked: readonly Readonly<{ passageId: string; score: number }>[];
  relevance: ReadonlyMap<string, number>;
}>[], noAnswerThreshold: number): QualitySlice {
  const answerable = input.filter((query) => query.answerability === "answerable");
  const noAnswer = input.filter((query) => query.answerability === "no_answer");
  const ndcgValues: number[] = [];
  const reciprocalRanks: number[] = [];
  const recallValues: number[] = [];
  for (const query of answerable) {
    const rankedRelevance = query.ranked.slice(0, 10)
      .map((entry) => query.relevance.get(entry.passageId) ?? 0);
    const ideal = [...query.relevance.values()].sort((left, right) => right - left).slice(0, 10);
    const idealDcg = dcg(ideal);
    ndcgValues.push(idealDcg === 0 ? 0 : dcg(rankedRelevance) / idealDcg);
    const firstRelevant = rankedRelevance.findIndex((relevance) => relevance >= 2);
    reciprocalRanks.push(firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1));
    const relevant = [...query.relevance.values()].filter((relevance) => relevance >= 2).length;
    const retained = rankedRelevance.filter((relevance) => relevance >= 2).length;
    recallValues.push(relevant === 0 ? 0 : retained / relevant);
  }
  return Object.freeze({
    evaluatedAnswerableQueries: answerable.length,
    evaluatedNoAnswerQueries: noAnswer.length,
    meanReciprocalRankAt10: mean(reciprocalRanks),
    ndcgAt10: mean(ndcgValues),
    noAnswerAccuracy: mean(noAnswer.map((query) => Number(
      (query.ranked[0]?.score ?? 0) < noAnswerThreshold
    ))),
    recallAt10: mean(recallValues)
  });
}

function calibrateNoAnswerThreshold(input: readonly Readonly<{
  answerability: "answerable" | "no_answer" | "uncertain";
  ranked: readonly Readonly<{ passageId: string; score: number }>[];
}>[]): MeasuredQuality["calibration"] {
  const eligible = input.filter((query) => query.answerability !== "uncertain");
  const evaluated = KNOWLEDGE_RERANKER_NO_ANSWER_THRESHOLDS.map((threshold) => ({
    accuracy: mean(eligible.map((query) => Number(
      ((query.ranked[0]?.score ?? 0) < threshold) ===
        (query.answerability === "no_answer")
    ))) ?? 0,
    threshold
  })).sort((left, right) => right.accuracy - left.accuracy ||
    left.threshold - right.threshold);
  const selected = evaluated[0]!;
  return Object.freeze({
    answerabilityAccuracy: selected.accuracy,
    evaluatedQueries: eligible.length,
    noAnswerThreshold: selected.threshold,
    objective: "answerability_accuracy",
    split: "calibration",
    status: "measured_from_imported_human_labels"
  });
}

function measuredQuality(input: Readonly<{
  labels: KnowledgeRerankerImportedReviewEvidence;
  rankings: ReadonlyMap<string, readonly Readonly<{ passageId: string; score: number }>[] >;
}>): MeasuredQuality {
  const queries = input.labels.labels.map((label) => ({
    answerability: label.answerability,
    language: label.language,
    ranked: input.rankings.get(label.queryId) ?? [],
    relevance: new Map(label.relevance.map((entry) => [entry.passageId, entry.relevance])),
    split: label.split
  }));
  const calibration = calibrateNoAnswerThreshold(queries.filter((query) =>
    query.split === "calibration"));
  const heldOut = queries.filter((query) => query.split === "held_out");
  return Object.freeze({
    calibration,
    byLanguage: Object.freeze({
      en: qualitySlice(heldOut.filter((query) => query.language === "en"),
        calibration.noAnswerThreshold),
      ru: qualitySlice(heldOut.filter((query) => query.language === "ru"),
        calibration.noAnswerThreshold)
    }),
    evaluatedSplit: "held_out",
    overall: qualitySlice(heldOut, calibration.noAnswerThreshold),
    scope: "held_out_within_frozen_candidate_pool",
    status: "measured_from_imported_human_labels"
  });
}

function scoringInput(
  corpus: KnowledgeRerankerCorpusManifest,
  pool: KnowledgeRerankerCandidatePool,
  queryId: string
): KnowledgeRerankerScoringInput {
  const query = corpus.queries.find((entry) => entry.id === queryId);
  const candidates = pool.queries.find((entry) => entry.queryId === queryId)?.candidates;
  if (!query || !candidates) throw new Error("knowledge_profile_benchmark_query_missing");
  const passages = new Map(corpus.documents.flatMap((document) => document.passages
    .map((passage) => [passage.id, { documentId: document.id, passage }] as const)));
  return Object.freeze({
    passages: Object.freeze(candidates.map((candidate) => {
      const entry = passages.get(candidate.passageId);
      if (!entry) throw new Error("knowledge_profile_benchmark_passage_missing");
      return Object.freeze({
        ...entry,
        retrievalRank: candidate.rank,
        retrievalSimilarity: candidate.cosineSimilarity
      });
    })),
    query: query.text
  });
}

function unavailable(reason: string): Unavailable {
  return Object.freeze({ reason, status: "unavailable" });
}

function unavailableCandidateReport(
  candidate: Extract<KnowledgeRerankerCandidate, { availability: "unavailable" }>
): CandidateUnavailableReport {
  return Object.freeze({
    cost: unavailable(candidate.reason),
    egress: Object.freeze({
      inputBytes: 0,
      inputTokens: null,
      mode: candidate.egress,
      retention: candidate.egress === "external" ? "provider_policy" : "none"
    }),
    executionStatus: "unavailable",
    gpu: unavailable("candidate_not_executed"),
    identity: Object.freeze({ id: candidate.id, kind: candidate.kind }),
    outage: Object.freeze({
      evidence: "unavailable",
      fallbackCandidateId: candidate.fallbackCandidateId,
      productionOutageEvidence: false,
      status: "unavailable",
      technicalLeakageObserved: false
    }),
    performance: unavailable(candidate.reason),
    quality: unavailable("independent_relevance_labels_not_imported"),
    reason: candidate.reason,
    rss: unavailable("candidate_not_executed")
  });
}

function identity(candidate: Extract<KnowledgeRerankerCandidate, { availability: "available" }>): CandidateIdentity {
  return Object.freeze({
    ...candidate.identity,
    id: candidate.id,
    kind: candidate.kind
  });
}

function inputBytes(input: KnowledgeRerankerScoringInput): number {
  return Buffer.byteLength(input.query, "utf8") + input.passages.reduce((sum, entry) =>
    sum + Buffer.byteLength(entry.passage.text, "utf8"), 0);
}

function notUsedResource(): ResourceEvidence {
  return Object.freeze({
    measurement: "hardware_not_used",
    peakBytes: 0,
    status: "not_used"
  });
}

function providerManagedResource(): ResourceEvidence {
  return Object.freeze({
    measurement: "provider_managed",
    peakBytes: null,
    status: "provider_managed"
  });
}

async function outageEvidence(input: Readonly<{
  candidate: Extract<KnowledgeRerankerCandidate, { availability: "available" }>;
  corpus: KnowledgeRerankerCorpusManifest;
  pool: KnowledgeRerankerCandidatePool;
}>): Promise<CandidateExecutionReport["outage"] | CandidateFailedReport["outage"]> {
  if (input.candidate.kind === "deterministic") {
    return Object.freeze({
      evidence: "not_applicable",
      fallbackCandidateId: input.candidate.fallbackCandidateId,
      productionOutageEvidence: false,
      status: "not_applicable",
      technicalLeakageObserved: false
    });
  }
  const first = input.pool.queries[0];
  if (!first) {
    return Object.freeze({
      evidence: "unavailable",
      fallbackCandidateId: input.candidate.fallbackCandidateId,
      productionOutageEvidence: false,
      status: "unavailable",
      technicalLeakageObserved: false
    });
  }
  try {
    const candidateInput = scoringInput(input.corpus, input.pool, first.queryId);
    const fallback = createKnowledgeRerankerCandidates()[0];
    if (!fallback || fallback.availability !== "available" || fallback.kind !== "deterministic") {
      throw new Error("knowledge_profile_benchmark_fallback_unavailable");
    }
    const [left, right] = await Promise.all([
      fallback.score(candidateInput),
      fallback.score(candidateInput)
    ]);
    const stable = JSON.stringify(left.scores) === JSON.stringify(right.scores) &&
      left.scores.length === candidateInput.passages.length;
    return Object.freeze({
      evidence: stable ? "deterministic_fallback_replay" : "unavailable",
      fallbackCandidateId: input.candidate.fallbackCandidateId,
      productionOutageEvidence: false,
      status: stable ? "verified_in_benchmark" : "unavailable",
      technicalLeakageObserved: false
    });
  } catch {
    return Object.freeze({
      evidence: "unavailable",
      fallbackCandidateId: input.candidate.fallbackCandidateId,
      productionOutageEvidence: false,
      status: "unavailable",
      technicalLeakageObserved: false
    });
  }
}

function executionResources(input: Readonly<{
  candidate: Extract<KnowledgeRerankerCandidate, { availability: "available" }>;
  results: readonly KnowledgeRerankerScoringResult[];
}>): Readonly<{ gpu: ResourceEvidence; rss: ResourceEvidence }> {
  if (input.candidate.identity.hardware === "provider_managed") {
    return Object.freeze({
      gpu: providerManagedResource(),
      rss: providerManagedResource()
    });
  }
  const usages = input.results.map((result) => result.resourceUsage);
  const complete = usages.length > 0 && usages.every((usage) => usage !== undefined && usage !== null);
  const rss: ResourceEvidence = complete
      ? Object.freeze({
        measurement: "runner_reported_peak" as const,
        peakBytes: Math.max(...usages.map((usage) => usage!.peakRssBytes)),
        status: "measured" as const
      })
    : unavailable("peak_rss_not_isolated_from_candidate_runtime");
  const gpu: ResourceEvidence = input.candidate.identity.hardware === "cpu"
    ? notUsedResource()
    : complete && usages.every((usage) => usage!.peakGpuMemoryBytes !== null)
      ? Object.freeze({
          measurement: "runner_reported_peak" as const,
          peakBytes: Math.max(...usages.map((usage) => usage!.peakGpuMemoryBytes!)),
          status: "measured" as const
        })
      : unavailable("gpu_peak_memory_not_isolated_from_candidate_runtime");
  return Object.freeze({ gpu, rss });
}

async function executeCandidate(input: Readonly<{
  candidate: Extract<KnowledgeRerankerCandidate, { availability: "available" }>;
  corpus: KnowledgeRerankerCorpusManifest;
  labels?: KnowledgeRerankerImportedReviewEvidence;
  pool: KnowledgeRerankerCandidatePool;
}>): Promise<CandidateExecutionReport | CandidateFailedReport> {
  const outage = await outageEvidence(input);
  const measurements: number[] = [];
  const results: KnowledgeRerankerScoringResult[] = [];
  const rankings = new Map<string, readonly Readonly<{ passageId: string; score: number }>[] >();
  let sentBytes = 0;
  try {
    for (const poolQuery of input.pool.queries) {
      const candidateInput = scoringInput(input.corpus, input.pool, poolQuery.queryId);
      sentBytes += inputBytes(candidateInput);
      const start = performance.now();
      const result = await input.candidate.score(candidateInput);
      measurements.push(performance.now() - start);
      if (result.scores.length !== candidateInput.passages.length ||
        result.scores.some((entry) => !Number.isFinite(entry.score) ||
          entry.score < 0 || entry.score > 1)) {
        throw new Error("knowledge_profile_benchmark_candidate_result_invalid");
      }
      results.push(result);
      rankings.set(poolQuery.queryId, Object.freeze([...result.scores]
        .sort((left, right) => right.score - left.score ||
          left.passageId.localeCompare(right.passageId))));
    }
  } catch {
    return Object.freeze({
      cost: unavailable("candidate_execution_failed"),
      egress: Object.freeze({
        inputBytes: input.candidate.egress === "external" ? sentBytes : 0,
        inputTokens: null,
        mode: input.candidate.egress,
        retention: input.candidate.egress === "external" ? "provider_policy" : "none"
      }),
      executionStatus: "failed",
      failureCode: "candidate_execution_failed",
      gpu: unavailable("candidate_execution_failed"),
      identity: identity(input.candidate),
      outage,
      performance: unavailable("candidate_execution_failed"),
      quality: unavailable("candidate_execution_failed"),
      rss: unavailable("candidate_execution_failed")
    });
  }
  const elapsed = measurements.reduce((sum, value) => sum + value, 0);
  const costs = results.map((result) => result.costMicros);
  const tokens = results.map((result) => result.inputTokens);
  const costMeasured = costs.every((value) => value !== null);
  const totalMicros = costMeasured
    ? costs.reduce((sum, value) => sum + value!, 0)
    : null;
  const quality = input.labels
    ? measuredQuality({ labels: input.labels, rankings })
    : unavailable("independent_relevance_labels_not_imported");
  const resources = executionResources({ candidate: input.candidate, results });
  return Object.freeze({
    cost: Object.freeze({
      microsPerQuery: totalMicros === null ? null : totalMicros / measurements.length,
      reason: costMeasured ? null : "candidate_cost_evidence_unavailable",
      status: costMeasured ? "measured" : "unavailable",
      totalMicros
    }),
    egress: Object.freeze({
      inputBytes: input.candidate.egress === "external" ? sentBytes : 0,
      inputTokens: tokens.every((value) => value !== null)
        ? tokens.reduce((sum, value) => sum + value!, 0)
        : null,
      mode: input.candidate.egress,
      retention: input.candidate.egress === "external" ? "provider_policy" : "none"
    }),
    executionStatus: "complete",
    gpu: resources.gpu,
    identity: identity(input.candidate),
    outage,
    performance: Object.freeze({
      coldFirstQueryMilliseconds: measurements[0] ?? 0,
      concurrency: 1,
      measuredQueries: measurements.length,
      p50Milliseconds: percentile(measurements, 0.5),
      p95Milliseconds: percentile(measurements, 0.95),
      status: "measured",
      throughputQueriesPerSecond: elapsed > 0 ? measurements.length / (elapsed / 1_000) : 0
    }),
    quality,
    rss: resources.rss
  });
}

function selectionPrerequisiteReasons(input: Readonly<{
  embeddingCostStatus: "measured" | "unavailable";
  labels?: KnowledgeRerankerImportedReviewEvidence;
  pool: KnowledgeRerankerCandidatePool;
}>): string[] {
  const reasons: string[] = [];
  if (!input.pool.qualityGateEligible) reasons.push("approved_real_embedding_not_executed");
  if (input.pool.qualityGateEligible && input.embeddingCostStatus !== "measured") {
    reasons.push("embedding_cost_evidence_unavailable");
  }
  if (!input.labels) {
    reasons.push("independent_relevance_labels_not_collected", "adjudication_not_completed");
  } else {
    if (input.labels.independentAnnotatorCount < 2) {
      reasons.push("two_independent_annotators_not_verified");
    }
    if (!input.labels.adjudicationComplete) reasons.push("adjudication_not_completed");
    if (!input.labels.candidatePoolQualityGateEligible) {
      reasons.push("reviewed_candidate_pool_not_real_embedding_eligible");
    }
    if (input.labels.candidatePoolSha256 !== input.pool.poolSha256) {
      reasons.push("reviewed_candidate_pool_mismatch");
    }
  }
  return [...new Set(reasons)];
}

function policyResource(
  resource: ResourceEvidence
): KnowledgeRerankerPolicyCandidateEvidence["rss"] {
  return resource.status === "unavailable"
    ? Object.freeze({ peakBytes: null, status: "unavailable" })
    : Object.freeze({ peakBytes: resource.peakBytes, status: resource.status });
}

function policyCandidate(
  candidate: KnowledgeProfileBenchmarkCandidateReport
): KnowledgeRerankerPolicyCandidateEvidence {
  const detailedIdentity = candidate.executionStatus === "unavailable"
    ? null
    : candidate.identity;
  const performance = candidate.performance.status === "measured"
    ? Object.freeze({
        p95Milliseconds: candidate.performance.p95Milliseconds,
        status: "measured" as const,
        throughputQueriesPerSecond: candidate.performance.throughputQueriesPerSecond
      })
    : Object.freeze({ status: "unavailable" as const });
  const quality = candidate.quality.status === "measured_from_imported_human_labels"
    ? candidate.quality
    : Object.freeze({ status: "unavailable" as const });
  return Object.freeze({
    authorization: detailedIdentity?.authorization ?? null,
    costMicrosPerQuery: candidate.cost.status === "measured"
      ? candidate.cost.microsPerQuery
      : null,
    costStatus: candidate.cost.status,
    egress: candidate.egress.mode,
    executionStatus: candidate.executionStatus,
    gpu: policyResource(candidate.gpu),
    id: candidate.identity.id,
    kind: candidate.identity.kind,
    outageStatus: candidate.outage.status,
    performance,
    quality,
    resourceScope: detailedIdentity?.resources.scope ?? "unavailable",
    rss: policyResource(candidate.rss)
  });
}

export async function runKnowledgeProfileBenchmark(input: Readonly<{
  embedding?: KnowledgeRerankerEmbeddingExecutor;
  labels?: KnowledgeRerankerImportedReviewEvidence;
  localCrossEncoder?: KnowledgeSemanticRerankerExecutor;
  localUnavailableReason?: KnowledgeRerankerUnavailableReason;
  systemModel?: KnowledgeSemanticRerankerExecutor;
  systemUnavailableReason?: KnowledgeRerankerUnavailableReason;
}> = {}): Promise<KnowledgeProfileBenchmarkReport> {
  const corpus = createKnowledgeRerankerCorpusManifest();
  const corpusAssessment = assessKnowledgeRerankerCorpus(corpus);
  const embedding = input.embedding ?? hermeticEmbeddingExecutor();
  const poolResult = await buildKnowledgeRerankerCandidatePool({
    candidateLimit: 12,
    corpus,
    embedding
  });
  const candidates = createKnowledgeRerankerCandidates({
    ...(input.localCrossEncoder ? { localCrossEncoder: input.localCrossEncoder } : {}),
    ...(input.localUnavailableReason ? { localUnavailableReason: input.localUnavailableReason } : {}),
    ...(input.systemModel ? { systemModel: input.systemModel } : {}),
    ...(input.systemUnavailableReason ? { systemUnavailableReason: input.systemUnavailableReason } : {})
  });
  const labelsBoundToPool = input.labels?.candidatePoolSha256 === poolResult.pool.poolSha256
    ? input.labels
    : undefined;
  const candidateReports = Object.freeze(await Promise.all(candidates.map((candidate) =>
    candidate.availability === "unavailable"
      ? unavailableCandidateReport(candidate)
      : executeCandidate({
        candidate,
        corpus,
        ...(labelsBoundToPool ? { labels: labelsBoundToPool } : {}),
        pool: poolResult.pool
      }))));
  const selection = evaluateKnowledgeRerankerSelectionPolicy({
    candidates: candidateReports.map(policyCandidate),
    prerequisiteReasonCodes: selectionPrerequisiteReasons({
      embeddingCostStatus: poolResult.evidence.cost.status,
      ...(input.labels ? { labels: input.labels } : {}),
      pool: poolResult.pool
    })
  });
  const contractValid = corpusAssessment.documentCount === 50 &&
    corpusAssessment.familyLeakage === false &&
    poolResult.pool.samePoolForEveryCandidate &&
    poolResult.pool.noRelevanceDerivedSignals &&
    candidates.length === 4 &&
    candidateReports.some((candidate) => candidate.executionStatus === "complete" &&
      candidate.identity.id === "deterministic_heuristic_v1");
  return Object.freeze({
    aggregateOnly: true,
    candidates: candidateReports,
    contractValid,
    corpus: Object.freeze({
      corpusSha256: corpus.corpusSha256,
      documentCount: corpusAssessment.documentCount,
      familyLeakage: corpusAssessment.familyLeakage,
      queryCount: corpusAssessment.queryCount,
      version: corpus.version
    }),
    embedding: Object.freeze({
      approval: poolResult.pool.embedding.approval,
      authorization: poolResult.pool.embedding.authorization,
      cost: poolResult.evidence.cost,
      egress: poolResult.pool.embedding.egress,
      execution: Object.freeze({
        durationMilliseconds: poolResult.evidence.durationMilliseconds,
        inputBytes: poolResult.evidence.inputBytes,
        inputTokens: poolResult.evidence.inputTokens,
        passageCount: poolResult.evidence.passageCount,
        queryCount: poolResult.evidence.queryCount
      }),
      executionClass: poolResult.pool.embedding.executionClass,
      modelId: poolResult.pool.embedding.modelId,
      poolSha256: poolResult.pool.poolSha256,
      provider: poolResult.pool.embedding.provider,
      qualityGateEligible: poolResult.pool.qualityGateEligible,
      revision: poolResult.pool.embedding.revision
    }),
    humanReview: Object.freeze({
      adjudicationComplete: input.labels?.adjudicationComplete ?? false,
      disagreement: input.labels
        ? Object.freeze({
            ...input.labels.disagreement,
            status: "measured" as const
          })
        : unavailable("independent_relevance_labels_not_imported"),
      independentAnnotatorCount: input.labels?.independentAnnotatorCount ?? 0,
      labelsStatus: input.labels ? "imported" : "not_imported",
      reasonCodes: input.labels
        ? Object.freeze([])
        : Object.freeze([
          "independent_relevance_labels_not_collected",
          "adjudication_not_completed"
        ]),
      unresolvedMaterialDisagreements:
        input.labels?.unresolvedMaterialDisagreements ?? null
    }),
    qualityGatePassed: selection.selectionEligible,
    selection,
    version: KNOWLEDGE_PROFILE_BENCHMARK_VERSION
  });
}

export async function assertKnowledgeProfileBenchmarkGates(): Promise<KnowledgeProfileBenchmarkReport> {
  const report = await runKnowledgeProfileBenchmark();
  if (!report.contractValid || report.selection.selectionEligible ||
    report.qualityGatePassed) {
    throw new Error("knowledge_profile_benchmark_contract_gate_failed");
  }
  return report;
}
