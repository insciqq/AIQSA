import { createHash } from "node:crypto";

export const KNOWLEDGE_RERANKER_SELECTION_POLICY_VERSION =
  "knowledge-reranker-selection-policy-v1" as const;

export const KNOWLEDGE_RERANKER_NO_ANSWER_THRESHOLDS = Object.freeze(
  Array.from({ length: 21 }, (_, index) => Number((index * 0.05).toFixed(2)))
);

export const KNOWLEDGE_RERANKER_SELECTION_POLICY = Object.freeze({
  calibration: Object.freeze({
    objective: "answerability_accuracy" as const,
    split: "calibration" as const,
    thresholdGrid: KNOWLEDGE_RERANKER_NO_ANSWER_THRESHOLDS,
    tieBreak: "lowest_threshold" as const
  }),
  candidateSet: Object.freeze([
    "deterministic_heuristic_v1",
    "local_multilingual_cross_encoder",
    "system_model_reranker",
    "hybrid_local_v1"
  ] as const),
  evidence: Object.freeze({
    candidatePool: "approved_real_embedding_same_pool" as const,
    labels: "two_independent_humans_with_complete_adjudication" as const,
    metricSplit: "held_out" as const,
    outage: "deterministic_fallback_verified" as const,
    resources: "isolated_local_or_provider_managed" as const
  }),
  limits: Object.freeze({
    maxCostMicrosPerQuery: 10_000,
    maxGpuMemoryBytes: 24 * 1024 ** 3,
    maxP95Milliseconds: Object.freeze({
      hybrid: 1_500,
      local_cross_encoder: 1_500,
      system_model: 5_000
    }),
    maxRssBytes: 8 * 1024 ** 3,
    minThroughputQueriesPerSecond: 0.2
  }),
  quality: Object.freeze({
    maxPerLanguageNdcgRegression: 0.01,
    maxRecallRegression: 0.01,
    minMeanReciprocalRankGain: 0,
    minNdcgGain: 0.02,
    minNoAnswerAccuracyGain: 0
  }),
  tieBreak: Object.freeze([
    "ndcg_at_10_desc",
    "mean_reciprocal_rank_at_10_desc",
    "p95_latency_asc",
    "cost_asc",
    "candidate_id_asc"
  ] as const),
  version: KNOWLEDGE_RERANKER_SELECTION_POLICY_VERSION
});

export const KNOWLEDGE_RERANKER_SELECTION_POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(KNOWLEDGE_RERANKER_SELECTION_POLICY), "utf8")
  .digest("hex");

type MetricSlice = Readonly<{
  meanReciprocalRankAt10: number | null;
  ndcgAt10: number | null;
  noAnswerAccuracy: number | null;
  recallAt10: number | null;
}>;

export type KnowledgeRerankerPolicyCandidateEvidence = Readonly<{
  authorization: "evaluation_only" | "local" | "profile_authorized" | null;
  costMicrosPerQuery: number | null;
  costStatus: "measured" | "unavailable";
  egress: "external" | "none";
  executionStatus: "complete" | "failed" | "unavailable";
  gpu: Readonly<{
    peakBytes: number | null;
    status: "measured" | "not_used" | "provider_managed" | "unavailable";
  }>;
  id: string;
  kind: "deterministic" | "hybrid" | "local_cross_encoder" | "system_model";
  outageStatus: "not_applicable" | "verified_in_benchmark" | "unavailable";
  performance: Readonly<{
    p95Milliseconds: number;
    status: "measured";
    throughputQueriesPerSecond: number;
  }> | Readonly<{ status: "unavailable" }>;
  quality: Readonly<{
    byLanguage: Readonly<Record<"en" | "ru", MetricSlice>>;
    overall: MetricSlice;
    status: "measured_from_imported_human_labels";
  }> | Readonly<{ status: "unavailable" }>;
  resourceScope: "isolated_runner" | "provider_managed" | "shared_process" | "unavailable";
  rss: Readonly<{
    peakBytes: number | null;
    status: "measured" | "not_used" | "provider_managed" | "unavailable";
  }>;
}>;

export type KnowledgeRerankerSelectionPolicyResult = Readonly<{
  decision: "not_selected" | "selected";
  eligibleCandidateIds: readonly string[];
  policySha256: typeof KNOWLEDGE_RERANKER_SELECTION_POLICY_SHA256;
  policyVersion: typeof KNOWLEDGE_RERANKER_SELECTION_POLICY_VERSION;
  reasonCodes: readonly string[];
  selectedCandidateId: string | null;
  selectedCandidateRequiresProfileAuthorization: boolean;
  selectionEligible: boolean;
}>;

function metricAtLeast(
  candidate: number | null,
  baseline: number | null,
  requiredGain: number
): boolean {
  return baseline === null
    ? candidate === null
    : candidate !== null && candidate >= baseline + requiredGain;
}

function resourceEligible(
  candidate: KnowledgeRerankerPolicyCandidateEvidence
): boolean {
  if (candidate.kind === "system_model") {
    return candidate.resourceScope === "provider_managed" &&
      candidate.rss.status === "provider_managed" &&
      candidate.gpu.status === "provider_managed";
  }
  return candidate.resourceScope === "isolated_runner" &&
    candidate.rss.status === "measured" && candidate.rss.peakBytes !== null &&
    candidate.rss.peakBytes <= KNOWLEDGE_RERANKER_SELECTION_POLICY.limits.maxRssBytes &&
    (candidate.gpu.status === "not_used" || candidate.gpu.status === "measured" &&
      candidate.gpu.peakBytes !== null &&
      candidate.gpu.peakBytes <= KNOWLEDGE_RERANKER_SELECTION_POLICY.limits.maxGpuMemoryBytes);
}

function qualityEligible(
  candidate: KnowledgeRerankerPolicyCandidateEvidence,
  baseline: KnowledgeRerankerPolicyCandidateEvidence
): boolean {
  if (candidate.quality.status !== "measured_from_imported_human_labels" ||
    baseline.quality.status !== "measured_from_imported_human_labels") return false;
  const policy = KNOWLEDGE_RERANKER_SELECTION_POLICY.quality;
  return metricAtLeast(candidate.quality.overall.ndcgAt10, baseline.quality.overall.ndcgAt10,
    policy.minNdcgGain) &&
    metricAtLeast(candidate.quality.overall.meanReciprocalRankAt10,
      baseline.quality.overall.meanReciprocalRankAt10,
      policy.minMeanReciprocalRankGain) &&
    metricAtLeast(candidate.quality.overall.recallAt10, baseline.quality.overall.recallAt10,
      -policy.maxRecallRegression) &&
    metricAtLeast(candidate.quality.overall.noAnswerAccuracy,
      baseline.quality.overall.noAnswerAccuracy,
      policy.minNoAnswerAccuracyGain) &&
    (["en", "ru"] as const).every((language) => metricAtLeast(
      candidate.quality.status === "measured_from_imported_human_labels"
        ? candidate.quality.byLanguage[language].ndcgAt10
        : null,
      baseline.quality.status === "measured_from_imported_human_labels"
        ? baseline.quality.byLanguage[language].ndcgAt10
        : null,
      -policy.maxPerLanguageNdcgRegression
    ));
}

function performanceEligible(candidate: KnowledgeRerankerPolicyCandidateEvidence): boolean {
  if (candidate.performance.status !== "measured" || candidate.kind === "deterministic") {
    return false;
  }
  const maximum = KNOWLEDGE_RERANKER_SELECTION_POLICY.limits.maxP95Milliseconds[candidate.kind];
  return candidate.performance.p95Milliseconds <= maximum &&
    candidate.performance.throughputQueriesPerSecond >=
      KNOWLEDGE_RERANKER_SELECTION_POLICY.limits.minThroughputQueriesPerSecond;
}

function candidateEligible(
  candidate: KnowledgeRerankerPolicyCandidateEvidence,
  baseline: KnowledgeRerankerPolicyCandidateEvidence
): boolean {
  return candidate.kind !== "deterministic" && candidate.executionStatus === "complete" &&
    candidate.outageStatus === "verified_in_benchmark" &&
    candidate.costStatus === "measured" && candidate.costMicrosPerQuery !== null &&
    candidate.costMicrosPerQuery <=
      KNOWLEDGE_RERANKER_SELECTION_POLICY.limits.maxCostMicrosPerQuery &&
    resourceEligible(candidate) && performanceEligible(candidate) &&
    qualityEligible(candidate, baseline);
}

function qualityNumber(
  candidate: KnowledgeRerankerPolicyCandidateEvidence,
  field: "meanReciprocalRankAt10" | "ndcgAt10"
): number {
  return candidate.quality.status === "measured_from_imported_human_labels"
    ? candidate.quality.overall[field] ?? -1
    : -1;
}

function candidateOrder(
  left: KnowledgeRerankerPolicyCandidateEvidence,
  right: KnowledgeRerankerPolicyCandidateEvidence
): number {
  const ndcg = qualityNumber(right, "ndcgAt10") - qualityNumber(left, "ndcgAt10");
  if (ndcg !== 0) return ndcg;
  const reciprocal = qualityNumber(right, "meanReciprocalRankAt10") -
    qualityNumber(left, "meanReciprocalRankAt10");
  if (reciprocal !== 0) return reciprocal;
  const latency = (left.performance.status === "measured" ? left.performance.p95Milliseconds : Infinity) -
    (right.performance.status === "measured" ? right.performance.p95Milliseconds : Infinity);
  if (latency !== 0) return latency;
  const cost = (left.costMicrosPerQuery ?? Infinity) - (right.costMicrosPerQuery ?? Infinity);
  return cost !== 0 ? cost : left.id.localeCompare(right.id);
}

export function evaluateKnowledgeRerankerSelectionPolicy(input: Readonly<{
  candidates: readonly KnowledgeRerankerPolicyCandidateEvidence[];
  prerequisiteReasonCodes?: readonly string[];
}>): KnowledgeRerankerSelectionPolicyResult {
  const reasons = [...input.prerequisiteReasonCodes ?? []];
  const expected = KNOWLEDGE_RERANKER_SELECTION_POLICY.candidateSet;
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  if (expected.some((id) => !byId.has(id)) || input.candidates.length !== expected.length ||
    input.candidates.some((candidate) => candidate.executionStatus !== "complete")) {
    reasons.push("required_candidate_execution_incomplete");
  }
  const baseline = byId.get("deterministic_heuristic_v1");
  const semantic = expected.slice(1).map((id) => byId.get(id)).filter(
    (candidate): candidate is KnowledgeRerankerPolicyCandidateEvidence => Boolean(candidate)
  );
  if (semantic.some((candidate) => candidate.outageStatus !== "verified_in_benchmark")) {
    reasons.push("outage_evidence_incomplete");
  }
  if (semantic.some((candidate) => candidate.costStatus !== "measured" ||
    !resourceEligible(candidate))) {
    reasons.push("resource_or_cost_evidence_incomplete");
  }
  const eligible = baseline
    ? semantic.filter((candidate) => candidateEligible(candidate, baseline)).sort(candidateOrder)
    : [];
  if (reasons.length === 0 && eligible.length === 0) {
    reasons.push("no_candidate_met_frozen_policy");
  }
  const reasonCodes = Object.freeze([...new Set(reasons)]);
  const selected = reasonCodes.length === 0 ? eligible[0] ?? null : null;
  return Object.freeze({
    decision: selected ? "selected" : "not_selected",
    eligibleCandidateIds: Object.freeze(eligible.map((candidate) => candidate.id)),
    policySha256: KNOWLEDGE_RERANKER_SELECTION_POLICY_SHA256,
    policyVersion: KNOWLEDGE_RERANKER_SELECTION_POLICY_VERSION,
    reasonCodes,
    selectedCandidateId: selected?.id ?? null,
    selectedCandidateRequiresProfileAuthorization: Boolean(selected &&
      selected.egress === "external" && selected.authorization !== "profile_authorized"),
    selectionEligible: selected !== null
  });
}
