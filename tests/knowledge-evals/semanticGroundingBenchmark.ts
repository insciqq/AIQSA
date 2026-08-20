import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  knowledgeSemanticGroundingDecisions,
  knowledgeSemanticReasonFamilies,
  type KnowledgeSemanticGroundingDecision
} from "../../lib/server/knowledge/semanticGrounding";
import {
  auditKnowledgeSemanticGroundingReleaseCorpus,
  knowledgeSemanticGroundingQualityGates,
  type KnowledgeSemanticGroundingReleaseCorpusAudit
} from "./semanticGrounding";
import {
  assertKnowledgeSemanticCandidateResult,
  assertKnowledgeSemanticCandidateFreezeArtifact,
  assertKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticCandidateSetBinding,
  createKnowledgeSemanticGroundingCandidatePool,
  createKnowledgeSemanticGroundingCandidates,
  knowledgeSemanticCandidateIdentityForDigest,
  KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS,
  type KnowledgeSemanticCandidate,
  type KnowledgeSemanticCandidateFreezeManifest,
  type KnowledgeSemanticCandidateId,
  type KnowledgeSemanticCandidateIdentityBinding,
  type KnowledgeSemanticCandidateProviderUsage,
  type KnowledgeSemanticCandidateSetBinding,
  type KnowledgeSemanticCandidateExecutor,
  type KnowledgeSemanticCandidatePool,
  type KnowledgeSemanticCandidatePoolEntry,
  type KnowledgeSemanticCandidateResourceUsage,
  type KnowledgeSemanticCandidateResult,
  type KnowledgeSemanticCandidateUnavailableReason
} from "./semanticGroundingCandidates";
import type {
  KnowledgeSemanticGroundingImportedReviewEvidence
} from "./semanticGroundingReview";
import {
  auditKnowledgeSemanticArithmeticBindings,
  verifyKnowledgeSemanticArithmeticBinding,
  type KnowledgeSemanticArithmeticBindingAudit
} from "./semanticGroundingArithmeticBinding";
import {
  verifyKnowledgeSemanticHumanTrust,
  type KnowledgeSemanticHumanTrustVerificationReport
} from "./semanticGroundingTrust";
import {
  knowledgeSemanticGroundingReleaseMetricSlices,
  measureKnowledgeSemanticGroundingReleaseMetrics,
  type KnowledgeSemanticGroundingReleaseMetrics,
  type KnowledgeSemanticGroundingReleaseMetricObservation,
  type KnowledgeSemanticGroundingReleaseMetricSlice
} from "./semanticGroundingReleaseMetrics";
import {
  knowledgeSemanticGroundingSlices,
  type KnowledgeSemanticGroundingLanguage,
  type KnowledgeSemanticGroundingSlice
} from "./semanticGroundingFixtures";

export const KNOWLEDGE_SEMANTIC_CANDIDATE_BENCHMARK_VERSION =
  "knowledge-semantic-candidate-benchmark-v1" as const;
export const KNOWLEDGE_SEMANTIC_CALIBRATION_VERSION =
  "knowledge-semantic-confidence-calibration-v1" as const;
export const KNOWLEDGE_SEMANTIC_CALIBRATION_FREEZE_VERSION =
  "knowledge-semantic-calibration-freeze-v1" as const;
export const KNOWLEDGE_SEMANTIC_FINAL_PREDICTION_FREEZE_VERSION =
  "knowledge-semantic-final-prediction-freeze-v1" as const;

type Unavailable = Readonly<{ reason: string; status: "unavailable" }>;
type ConfusionMatrix = Readonly<Record<
  KnowledgeSemanticGroundingDecision,
  Readonly<Record<KnowledgeSemanticGroundingDecision, number>>
>>;

type EvaluationSlice = Readonly<{
  accuracy: number;
  attributableAccuracy: number;
  confusionMatrix: ConfusionMatrix;
  count: number;
  falseNegativeCount: number;
  falsePositiveCount: number;
}>;

type SplitQualitySummary = Readonly<{
  byLanguage: Readonly<Record<KnowledgeSemanticGroundingLanguage, EvaluationSlice>>;
  bySlice: Readonly<Record<KnowledgeSemanticGroundingSlice, EvaluationSlice>>;
  groundedAccuracy: number;
  overall: EvaluationSlice;
}>;

export type KnowledgeSemanticMeasuredQuality = Readonly<{
  calibration: Readonly<{
    brierScore: number;
    evaluatedClaims: number;
    expectedCalibrationError: number;
    groundedAccuracy: number;
    objective: "grounded_accuracy";
    selectedConfidenceMinimum: number;
    split: "calibration";
    status: "measured_from_imported_human_labels";
    thresholdFrozenBeforeHeldOut: boolean;
    version: typeof KNOWLEDGE_SEMANTIC_CALIBRATION_VERSION;
  }>;
  blindedReviewAcceptancePassed: boolean;
  blindedReviewQualityGatesPassed: boolean;
  blindedReviewReleaseMetrics: KnowledgeSemanticGroundingReleaseMetrics;
  gatesPassed: boolean;
  heldOutGatesPassed: boolean;
  /** Development remains diagnostic; it never ranks final candidates. */
  development: SplitQualitySummary;
  /** Final proof evidence must come from an untouched blinded-review split. */
  blindedReview: SplitQualitySummary;
  heldOut: Readonly<{
    attributableAccuracy: number;
    byLanguage: Readonly<Record<KnowledgeSemanticGroundingLanguage, EvaluationSlice>>;
    bySlice: Readonly<Record<KnowledgeSemanticGroundingSlice, EvaluationSlice>>;
    contradictionPrecision: number;
    contradictionRecall: number;
    decisionAccuracy: number;
    groundedAccuracy: number;
    overall: EvaluationSlice;
    supportedPrecision: number;
    supportedRecall: number;
    temporalFalseBlockers: number;
    versionFalseBlockers: number;
  }>;
  heldOutReleaseMetrics: KnowledgeSemanticGroundingReleaseMetrics;
  labelProvenance: "two_external_humans_adjudicated";
  provenanceVerification: "self_attested_unverified" | "verified_external_humans";
  selection: Readonly<{
    groundedAccuracy: number;
    split: "held_out";
  }>;
  scope: "blinded_review_only_after_calibration_threshold_freeze";
  status: "measured_from_imported_human_labels";
}>;

type KnowledgeSemanticCalibrationMetrics =
  KnowledgeSemanticMeasuredQuality["calibration"];

export type KnowledgeSemanticCalibrationFrozenOutput = Readonly<{
  attributableHandles: readonly string[];
  claimSha256: string;
  decisionScores: KnowledgeSemanticCandidateResult["decisionScores"];
  neighborhoodSha256: string;
  reasonFamily: KnowledgeSemanticCandidateResult["reasonFamily"];
}>;

export type KnowledgeSemanticCalibrationFreezeCandidate =
  | Readonly<{
      calibration: KnowledgeSemanticCalibrationMetrics;
      calibrationOutputSha256: string;
      candidateId: KnowledgeSemanticCandidateId;
      executionStatus: "complete";
      outputs: readonly KnowledgeSemanticCalibrationFrozenOutput[];
    }>
  | Readonly<{
      calibration: null;
      calibrationOutputSha256: null;
      candidateId: KnowledgeSemanticCandidateId;
      executionStatus: "failed" | "unavailable";
      outputs: readonly [];
      reason: string;
    }>;

export type KnowledgeSemanticCalibrationFreezeManifest = Readonly<{
  aggregateOnly: true;
  artifactType: "knowledge_semantic_calibration_freeze";
  artifactVersion: typeof KNOWLEDGE_SEMANTIC_CALIBRATION_FREEZE_VERSION;
  calibrationLabelSha256: string;
  candidateFreezeManifestSha256: string;
  candidateSetDigest: string;
  candidates: readonly KnowledgeSemanticCalibrationFreezeCandidate[];
  corpusSha256: string;
  labelsStored: false;
  manifestSha256: string;
  poolSha256: string;
  thresholdScheduleSha256: string;
}>;

export type KnowledgeSemanticFinalPredictionFrozenOutput = Readonly<{
  attributableHandles: readonly string[];
  claimSha256: string;
  decisionScores: KnowledgeSemanticCandidateResult["decisionScores"];
  latencyMicroseconds: number;
  neighborhoodSha256: string;
  reasonFamily: KnowledgeSemanticCandidateResult["reasonFamily"];
  resourceUsage: KnowledgeSemanticCandidateResourceUsage | null;
  split: MeasuredSplit;
  usage: KnowledgeSemanticCandidateProviderUsage & Readonly<{
    costMicros: number | null;
  }>;
}>;

export type KnowledgeSemanticFinalPredictionFreezeCandidate =
  | Readonly<{
      candidateId: KnowledgeSemanticCandidateId;
      candidateIdentity: KnowledgeSemanticCandidateIdentityBinding;
      executionStatus: "complete";
      outputSha256: string;
      outputs: readonly KnowledgeSemanticFinalPredictionFrozenOutput[];
    }>
  | Readonly<{
      candidateId: KnowledgeSemanticCandidateId;
      candidateIdentity: KnowledgeSemanticCandidateIdentityBinding;
      executionStatus: "failed";
      failureClaimSha256: string | null;
      failureNeighborhoodSha256: string | null;
      outputSha256: string;
      outputs: readonly KnowledgeSemanticFinalPredictionFrozenOutput[];
      reason: "candidate_calibration_unavailable" | "candidate_execution_failed";
    }>
  | Readonly<{
      candidateId: KnowledgeSemanticCandidateId;
      candidateIdentity: KnowledgeSemanticCandidateIdentityBinding;
      executionStatus: "unavailable";
      outputSha256: null;
      outputs: readonly [];
      reason: KnowledgeSemanticCandidateUnavailableReason;
    }>;

export type KnowledgeSemanticFinalPredictionFreezeManifest = Readonly<{
  artifactType: "knowledge_semantic_final_prediction_freeze";
  artifactVersion: typeof KNOWLEDGE_SEMANTIC_FINAL_PREDICTION_FREEZE_VERSION;
  calibrationFreezeManifestSha256: string;
  candidateFreezeManifestSha256: string;
  candidateSetDigest: string;
  candidates: readonly KnowledgeSemanticFinalPredictionFreezeCandidate[];
  contentFree: true;
  corpusSha256: string;
  fallbackReplayVerified: boolean;
  labelAccessByPredictionProcess: false;
  labelsIncluded: false;
  manifestSha256: string;
  poolSha256: string;
  splitsExecuted: readonly ["development", "held_out", "blinded_review"];
}>;

type ResourceEvidence = Unavailable | Readonly<{
  measurement: "hardware_not_used";
  peakBytes: 0;
  status: "not_used";
}> | Readonly<{
  measurement: "provider_managed";
  peakBytes: null;
  status: "provider_managed";
}> | Readonly<{
  measurement: "runner_reported_peak";
  peakBytes: number;
  status: "measured";
}>;

type CandidateIdentity = Readonly<{
  authorization: "evaluation_only" | "local" | "profile_authorized";
  backend: string;
  executionClass: "real_model" | "structural_baseline" | "test_double";
  hardware: "cpu" | "gpu" | "provider_managed";
  id: string;
  kind: "hybrid" | "local_nli" | "structural" | "system_model";
  modelId: string;
  profile: string;
  provider: string;
  resources: Readonly<{
    cpuLogicalCores: number | null;
    gpuDevice: string | null;
    scope: "isolated_runner" | "provider_managed" | "shared_process";
  }>;
  revision: string;
  validatorVersion: number;
}>;

type CandidatePerformance = Readonly<{
  coldFirstClaimMilliseconds: number;
  concurrency: 1;
  measuredClaims: number;
  p50Milliseconds: number;
  p95Milliseconds: number;
  status: "measured";
  throughputClaimsPerSecond: number;
}>;

type CandidateCost = Readonly<{
  microsPerClaim: number | null;
  reason: string | null;
  status: "measured" | "unavailable";
  totalMicros: number | null;
}>;

type CandidateOperationalEvidence = Readonly<{
  cost: CandidateCost;
  egress: Readonly<{
    disclosedInputBytes: number;
    inputTokens: number | null;
    mode: "external" | "none";
    privateDataHandling: "synthetic_corpus_only";
    processedInputBytes: number;
    retention: "none" | "provider_policy";
  }>;
  gpu: ResourceEvidence;
  outage: Readonly<{
    fallbackCandidateId: "current_structural_fence_v4";
    fallbackReplay: "not_applicable" | "unavailable" | "verified";
    semanticDecisionOnOutage: "not_evaluated";
    structuralFenceRemainsActive: true;
    technicalLeakageObserved: false;
  }>;
  recovery: Readonly<{
    benchmarkEvidence: "contract_only" | "pure_replay_verified";
    complexity: "checkpoint_required" | "pure_recompute";
    externalDispatchMayRepeatAutomatically: false;
  }>;
  rss: ResourceEvidence;
}>;

type CompleteCandidateReport = CandidateOperationalEvidence & Readonly<{
  executionStatus: "complete";
  identity: CandidateIdentity;
  performance: CandidatePerformance;
  quality: KnowledgeSemanticMeasuredQuality | Unavailable;
}>;

type FailedCandidateReport = CandidateOperationalEvidence & Readonly<{
  executionStatus: "failed";
  failureCode: "candidate_execution_failed";
  identity: CandidateIdentity;
  performance: Unavailable;
  quality: Unavailable;
}>;

type UnavailableCandidateReport = Readonly<{
  cost: Unavailable;
  egress: Readonly<{
    disclosedInputBytes: 0;
    inputTokens: null;
    mode: "external" | "none";
    privateDataHandling: "synthetic_corpus_only";
    processedInputBytes: 0;
    retention: "none" | "provider_policy";
  }>;
  executionStatus: "unavailable";
  gpu: Unavailable;
  identity: Readonly<{
    id: string;
    kind: "hybrid" | "local_nli" | "system_model";
  }>;
  outage: Readonly<{
    fallbackCandidateId: "current_structural_fence_v4";
    fallbackReplay: "unavailable";
    semanticDecisionOnOutage: "not_evaluated";
    structuralFenceRemainsActive: true;
    technicalLeakageObserved: false;
  }>;
  performance: Unavailable;
  quality: Unavailable;
  reason: KnowledgeSemanticCandidateUnavailableReason;
  recovery: Readonly<{
    benchmarkEvidence: "contract_only";
    complexity: "checkpoint_required" | "pure_recompute";
    externalDispatchMayRepeatAutomatically: false;
  }>;
  rss: Unavailable;
}>;

export type KnowledgeSemanticCandidateBenchmarkCandidateReport =
  CompleteCandidateReport | FailedCandidateReport | UnavailableCandidateReport;

type KnowledgeSemanticCandidateSelectionReport =
  | Readonly<{
      cost: Pick<CandidateCost, "status">;
      executionStatus: "complete";
      identity: Pick<CandidateIdentity,
        "authorization" | "executionClass" | "id" | "kind">;
      outage: Pick<CandidateOperationalEvidence["outage"], "fallbackReplay">;
      performance: Pick<CandidatePerformance, "p95Milliseconds">;
      quality: KnowledgeSemanticMeasuredQuality | Unavailable;
    }>
  | Readonly<{
      executionStatus: "failed" | "unavailable";
      identity: Readonly<{
        id: string;
        kind: "hybrid" | "local_nli" | "structural" | "system_model";
      }>;
    }>;

export type KnowledgeSemanticFrozenSelectionEvidence = Readonly<{
  blindedExecution: KnowledgeSemanticCandidateBenchmarkReport["blindedExecution"];
  blindedReleaseEvidenceEligible: boolean;
  candidateSet: KnowledgeSemanticCandidateBenchmarkReport["candidateSet"];
  candidates: readonly KnowledgeSemanticCandidateSelectionReport[];
  contractValid: boolean;
  corpus: KnowledgeSemanticCandidateBenchmarkReport["corpus"];
  humanReview: KnowledgeSemanticCandidateBenchmarkReport["humanReview"];
  selection: KnowledgeSemanticCandidateBenchmarkReport["selection"];
  semanticProof: boolean;
}>;

export type KnowledgeSemanticCandidateBenchmarkReport = Readonly<{
  aggregateOnly: true;
  blindedExecution: Readonly<{
    finalPredictionsFrozenBeforeBlindLabels: boolean;
    reason: "final_predictions_executed_after_review_import" |
      "final_predictions_frozen_without_labels" |
      "final_prediction_freeze_missing";
    releaseEvidenceEligible: boolean;
  }>;
  blockingEligible: false;
  candidateSet: KnowledgeSemanticCandidateSetBinding & Readonly<{
    frozen: boolean;
    thresholdContractFrozen: boolean;
  }>;
  candidates: readonly KnowledgeSemanticCandidateBenchmarkCandidateReport[];
  contractValid: boolean;
  corpus: Readonly<{
    arithmetic: KnowledgeSemanticArithmeticBindingAudit;
    blindedReviewClaims: number;
    blindedReviewSplitAvailable: boolean;
    calibrationClaims: number;
    corpusSha256: string;
    developmentClaims: number;
    familyLeakage: boolean;
    fixtureCount: number;
    heldOutClaims: number;
    labelsExcludedFromCandidateInput: true;
    languages: readonly ["en", "ru"];
    poolSha256: string;
    releaseEvidence: KnowledgeSemanticGroundingReleaseCorpusAudit;
    samePoolForEveryCandidate: true;
    version: string;
  }>;
  humanReview: Readonly<{
    adjudicationComplete: boolean;
    disagreement: KnowledgeSemanticGroundingImportedReviewEvidence["disagreement"] | Unavailable;
    independentAnnotatorCount: number;
    labelsStatus: "imported" | "not_imported";
    provenanceVerification: "operator_anchored_ed25519_verified" | "unverifiable" |
      "not_imported";
    reasonCodes: readonly string[];
    trust: KnowledgeSemanticHumanTrustVerificationReport;
    unresolvedMaterialDisagreements: number | null;
  }>;
  releaseGatePassed: false;
  selection: Readonly<{
    reasonCodes: readonly string[];
    selectedCandidateId: string | null;
    selectionEligible: boolean;
  }>;
  semanticProof: boolean;
  version: typeof KNOWLEDGE_SEMANTIC_CANDIDATE_BENCHMARK_VERSION;
}>;

type BoundLabel = KnowledgeSemanticGroundingImportedReviewEvidence["labels"][number];
type RawPrediction = Readonly<{
  entry: KnowledgeSemanticCandidatePoolEntry;
  milliseconds: number;
  result: KnowledgeSemanticCandidateResult;
}>;
type ScoredClaim = Readonly<{
  attributableCorrect: boolean;
  confidence: number;
  decisionCorrect: boolean;
  entry: KnowledgeSemanticCandidatePoolEntry;
  expected: KnowledgeSemanticGroundingDecision;
  expectedAttributableHandles: readonly string[];
  predicted: KnowledgeSemanticGroundingDecision;
  predictedAttributableHandles: readonly string[];
}>;

type MeasuredSplit = "development" | "held_out" | "blinded_review";

function unavailable(reason: string): Unavailable {
  return Object.freeze({ reason, status: "unavailable" });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const candidateIdSchema = z.enum([
  "current_structural_fence_v4",
  "local_multilingual_nli_v1",
  "system_model_semantic_v1",
  "hybrid_semantic_v1"
]);
const calibrationMetricsSchema = z.strictObject({
  brierScore: z.number().finite().min(0),
  evaluatedClaims: z.number().int().positive(),
  expectedCalibrationError: z.number().finite().min(0),
  groundedAccuracy: z.number().finite().min(0).max(1),
  objective: z.literal("grounded_accuracy"),
  selectedConfidenceMinimum: z.number().finite().min(0).max(1),
  split: z.literal("calibration"),
  status: z.literal("measured_from_imported_human_labels"),
  thresholdFrozenBeforeHeldOut: z.literal(true),
  version: z.literal(KNOWLEDGE_SEMANTIC_CALIBRATION_VERSION)
});
const calibrationFreezeCandidateSchema = z.discriminatedUnion("executionStatus", [
  z.strictObject({
    calibration: calibrationMetricsSchema,
    calibrationOutputSha256: sha256Schema,
    candidateId: candidateIdSchema,
    executionStatus: z.literal("complete"),
    outputs: z.array(z.strictObject({
      attributableHandles: z.array(z.string().regex(/^K[1-9]\d{0,3}(?:\.[1-9]\d?)?$/u)),
      claimSha256: sha256Schema,
      decisionScores: z.strictObject({
        contradicted: z.number().finite().min(0).max(1),
        supported: z.number().finite().min(0).max(1),
        uncertain: z.number().finite().min(0).max(1),
        unsupported: z.number().finite().min(0).max(1)
      }),
      neighborhoodSha256: sha256Schema,
      reasonFamily: z.enum(knowledgeSemanticReasonFamilies)
    })).min(1)
  }),
  z.strictObject({
    calibration: z.null(),
    calibrationOutputSha256: z.null(),
    candidateId: candidateIdSchema,
    executionStatus: z.enum(["failed", "unavailable"]),
    outputs: z.tuple([]),
    reason: z.string().regex(/^[a-z][a-z0-9_]{1,120}$/u)
  })
]);
const calibrationFreezeManifestSchema = z.strictObject({
  aggregateOnly: z.literal(true),
  artifactType: z.literal("knowledge_semantic_calibration_freeze"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_CALIBRATION_FREEZE_VERSION),
  calibrationLabelSha256: sha256Schema,
  candidateFreezeManifestSha256: sha256Schema,
  candidateSetDigest: sha256Schema,
  candidates: z.array(calibrationFreezeCandidateSchema).length(4),
  corpusSha256: sha256Schema,
  labelsStored: z.literal(false),
  manifestSha256: sha256Schema,
  poolSha256: sha256Schema,
  thresholdScheduleSha256: sha256Schema
});
const predictionUsageSchema = z.strictObject({
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheWriteInputTokens: z.number().int().nonnegative().nullable(),
  costMicros: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  providerRequestCount: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  status: z.enum(["measured", "not_used", "partial", "unavailable"]),
  totalTokens: z.number().int().nonnegative().nullable()
});
const finalPredictionOutputSchema = z.strictObject({
  attributableHandles: z.array(z.string().regex(/^K[1-9]\d{0,3}(?:\.[1-9]\d?)?$/u)),
  claimSha256: sha256Schema,
  decisionScores: z.strictObject({
    contradicted: z.number().finite().min(0).max(1),
    supported: z.number().finite().min(0).max(1),
    uncertain: z.number().finite().min(0).max(1),
    unsupported: z.number().finite().min(0).max(1)
  }),
  latencyMicroseconds: z.number().int().nonnegative(),
  neighborhoodSha256: sha256Schema,
  reasonFamily: z.enum(knowledgeSemanticReasonFamilies),
  resourceUsage: z.strictObject({
    peakGpuMemoryBytes: z.number().int().nonnegative().nullable(),
    peakRssBytes: z.number().int().positive()
  }).nullable(),
  split: z.enum(["development", "held_out", "blinded_review"]),
  usage: predictionUsageSchema
});
const finalPredictionCandidateSchema = z.discriminatedUnion("executionStatus", [
  z.strictObject({
    candidateId: candidateIdSchema,
    candidateIdentity: z.unknown(),
    executionStatus: z.literal("complete"),
    outputSha256: sha256Schema,
    outputs: z.array(finalPredictionOutputSchema).min(1)
  }),
  z.strictObject({
    candidateId: candidateIdSchema,
    candidateIdentity: z.unknown(),
    executionStatus: z.literal("failed"),
    failureClaimSha256: sha256Schema.nullable(),
    failureNeighborhoodSha256: sha256Schema.nullable(),
    outputSha256: sha256Schema,
    outputs: z.array(finalPredictionOutputSchema),
    reason: z.enum(["candidate_calibration_unavailable", "candidate_execution_failed"])
  }),
  z.strictObject({
    candidateId: candidateIdSchema,
    candidateIdentity: z.unknown(),
    executionStatus: z.literal("unavailable"),
    outputSha256: z.null(),
    outputs: z.tuple([]),
    reason: z.enum([
      "hybrid_component_unavailable",
      "local_model_not_configured",
      "system_model_not_authorized",
      "system_model_structured_output_unavailable"
    ])
  })
]);
const finalPredictionFreezeManifestSchema = z.strictObject({
  artifactType: z.literal("knowledge_semantic_final_prediction_freeze"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_FINAL_PREDICTION_FREEZE_VERSION),
  calibrationFreezeManifestSha256: sha256Schema,
  candidateFreezeManifestSha256: sha256Schema,
  candidateSetDigest: sha256Schema,
  candidates: z.array(finalPredictionCandidateSchema).length(4),
  contentFree: z.literal(true),
  corpusSha256: sha256Schema,
  fallbackReplayVerified: z.boolean(),
  labelAccessByPredictionProcess: z.literal(false),
  labelsIncluded: z.literal(false),
  manifestSha256: sha256Schema,
  poolSha256: sha256Schema,
  splitsExecuted: z.tuple([
    z.literal("development"),
    z.literal("held_out"),
    z.literal("blinded_review")
  ])
});

function round(value: number): number {
  return Number(value.toFixed(6));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function prediction(result: KnowledgeSemanticCandidateResult): Readonly<{
  confidence: number;
  decision: KnowledgeSemanticGroundingDecision;
}> {
  return knowledgeSemanticGroundingDecisions.map((decision) => ({
    confidence: result.decisionScores[decision],
    decision
  })).sort((left, right) => right.confidence - left.confidence ||
    left.decision.localeCompare(right.decision))[0]!;
}

function arithmeticAudit(
  pool: KnowledgeSemanticCandidatePool
): KnowledgeSemanticArithmeticBindingAudit {
  const derived = pool.entries.filter((entry) => entry.input.type === "derived_arithmetic");
  const bound = pool.entries.filter((entry) => entry.arithmetic !== null);
  if (derived.length !== bound.length || derived.some((entry) => entry.arithmetic === null) ||
    bound.some((entry) => entry.input.type !== "derived_arithmetic")) {
    throw new Error("knowledge_semantic_arithmetic_pool_binding_invalid");
  }
  return auditKnowledgeSemanticArithmeticBindings(bound.map((entry) => ({
    binding: entry.arithmetic!,
    claimSha256: entry.claimSha256,
    evidencePackage: entry.evidencePackage
  })));
}

/** Candidate resource/cost evidence remains measured, while arithmetic truth is
 * always derived from the exact evaluator-only receipt bound to this pool row. */
function deterministicArithmeticResult(
  entry: KnowledgeSemanticCandidatePoolEntry,
  result: KnowledgeSemanticCandidateResult
): KnowledgeSemanticCandidateResult {
  if (entry.input.type !== "derived_arithmetic") {
    if (entry.arithmetic !== null) {
      throw new Error("knowledge_semantic_arithmetic_pool_binding_invalid");
    }
    return result;
  }
  if (entry.arithmetic === null) {
    throw new Error("knowledge_semantic_arithmetic_receipt_missing");
  }
  const verification = verifyKnowledgeSemanticArithmeticBinding({
    binding: entry.arithmetic,
    claimSha256: entry.claimSha256,
    evidencePackage: entry.evidencePackage
  });
  const decision = verification.code === "verified"
    ? "supported" as const
    : verification.code === "output_outside_tolerance"
      ? "contradicted" as const
      : null;
  if (!decision) {
    throw new Error(`knowledge_semantic_arithmetic_receipt_${verification.code}`);
  }
  const deterministic = Object.freeze({
    ...result,
    attributableHandles: Object.freeze([entry.arithmetic.plan.citationHandle]),
    decisionScores: Object.freeze(Object.fromEntries(
      knowledgeSemanticGroundingDecisions.map((candidate) =>
        [candidate, Number(candidate === decision)])
    ) as Record<KnowledgeSemanticGroundingDecision, number>),
    reasonFamily: "deterministic_receipt" as const
  });
  assertKnowledgeSemanticCandidateResult(entry.input, deterministic);
  return deterministic;
}

function thresholded(
  result: KnowledgeSemanticCandidateResult,
  threshold: number
): Readonly<{ confidence: number; decision: KnowledgeSemanticGroundingDecision }> {
  const selected = prediction(result);
  return Object.freeze({
    confidence: selected.confidence,
    decision: selected.confidence < threshold ? "uncertain" : selected.decision
  });
}

function bindLabels(
  pool: KnowledgeSemanticCandidatePool,
  review: KnowledgeSemanticGroundingImportedReviewEvidence,
  expectedReviewScope: KnowledgeSemanticGroundingImportedReviewEvidence["reviewScope"]
): ReadonlyMap<string, BoundLabel> {
  const expectedSplits = new Set<KnowledgeSemanticCandidatePoolEntry["split"]>(
    expectedReviewScope === "calibration"
      ? ["calibration"]
      : ["development", "held_out", "blinded_review"]
  );
  const expectedEntries = pool.entries.filter((entry) => expectedSplits.has(entry.split));
  if (review.corpusSha256 !== pool.corpusSha256 || review.poolSha256 !== pool.poolSha256 ||
    review.reviewScope !== expectedReviewScope ||
    !review.adjudicationComplete ||
    review.independentAnnotatorCount !== 2 || review.unresolvedMaterialDisagreements !== 0 ||
    review.labelProvenance !== "two_external_humans_adjudicated" ||
    review.labels.length !== expectedEntries.length) {
    throw new Error("knowledge_semantic_review_pool_mismatch");
  }
  const labels = new Map<string, BoundLabel>();
  const entryByKey = new Map<string, KnowledgeSemanticCandidatePoolEntry>(pool.entries.map((entry) =>
    [`${entry.fixtureId}:${entry.ordinal}`, entry] as const));
  for (const label of review.labels) {
    const key = `${label.fixtureId}:${label.claimOrdinal}`;
    const entry = entryByKey.get(key);
    if (!entry || labels.has(key) || label.claimSha256 !== entry.claimSha256 ||
      label.neighborhoodSha256 !== entry.neighborhoodSha256 ||
      label.language !== entry.language || label.split !== entry.split ||
      !knowledgeSemanticGroundingDecisions.includes(label.decision) ||
      label.attributableHandles.length !== new Set(label.attributableHandles).size ||
      label.attributableHandles.some((handle) => !entry.input.citationHandles.includes(handle))) {
      throw new Error("knowledge_semantic_review_pool_mismatch");
    }
    labels.set(key, label);
  }
  if (labels.size !== expectedEntries.length || expectedEntries.some((entry) =>
    !labels.has(`${entry.fixtureId}:${entry.ordinal}`))) {
    throw new Error("knowledge_semantic_review_pool_mismatch");
  }
  return labels;
}

function labelFor(
  labels: ReadonlyMap<string, BoundLabel>,
  entry: KnowledgeSemanticCandidatePoolEntry
): BoundLabel {
  const label = labels.get(`${entry.fixtureId}:${entry.ordinal}`);
  if (!label) throw new Error("knowledge_semantic_review_label_missing");
  return label;
}

function calibrationLabelSha256(
  pool: KnowledgeSemanticCandidatePool,
  labels: ReadonlyMap<string, BoundLabel>
): string {
  return canonicalSha256(pool.entries.filter((entry) => entry.split === "calibration")
    .map((entry) => {
      const label = labelFor(labels, entry);
      return {
        attributableHandles: [...label.attributableHandles].sort(),
        claimSha256: entry.claimSha256,
        decision: label.decision,
        fixtureId: entry.fixtureId,
        neighborhoodSha256: entry.neighborhoodSha256,
        ordinal: entry.ordinal
      };
    }));
}

function frozenCalibrationOutputs(
  predictions: readonly RawPrediction[]
): readonly KnowledgeSemanticCalibrationFrozenOutput[] {
  return Object.freeze(predictions.map((raw) => Object.freeze({
    attributableHandles: [...raw.result.attributableHandles].sort(),
    claimSha256: raw.entry.claimSha256,
    decisionScores: raw.result.decisionScores,
    neighborhoodSha256: raw.entry.neighborhoodSha256,
    reasonFamily: raw.result.reasonFamily
  })));
}

function calibrationError(
  predictions: readonly RawPrediction[],
  labels: ReadonlyMap<string, BoundLabel>
): Readonly<{ brierScore: number; expectedCalibrationError: number }> {
  const buckets = Array.from({ length: 10 }, () => [] as RawPrediction[]);
  let brier = 0;
  for (const raw of predictions) {
    const label = labelFor(labels, raw.entry);
    const selected = prediction(raw.result);
    buckets[Math.min(9, Math.floor(selected.confidence * 10))]!.push(raw);
    brier += knowledgeSemanticGroundingDecisions.reduce((sum, decision) =>
      sum + (raw.result.decisionScores[decision] - Number(label.decision === decision)) ** 2, 0) /
      knowledgeSemanticGroundingDecisions.length;
  }
  const expectedCalibrationError = buckets.reduce((sum, bucket) => {
    if (bucket.length === 0) return sum;
    const confidence = bucket.reduce((total, raw) =>
      total + prediction(raw.result).confidence, 0) / bucket.length;
    const accuracy = bucket.filter((raw) =>
      prediction(raw.result).decision === labelFor(labels, raw.entry).decision).length /
      bucket.length;
    return sum + Math.abs(confidence - accuracy) * bucket.length / predictions.length;
  }, 0);
  return Object.freeze({
    brierScore: predictions.length === 0 ? 0 : round(brier / predictions.length),
    expectedCalibrationError: predictions.length === 0 ? 0 : round(expectedCalibrationError)
  });
}

function calibrate(
  predictions: readonly RawPrediction[],
  labels: ReadonlyMap<string, BoundLabel>
): KnowledgeSemanticMeasuredQuality["calibration"] {
  const calibration = predictions.filter((raw) => raw.entry.split === "calibration");
  const candidates = KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS.map((threshold) => ({
    groundedAccuracy: ratio(calibration.filter((raw) => {
      const label = labelFor(labels, raw.entry);
      return thresholded(raw.result, threshold).decision === label.decision &&
        sameSet(raw.result.attributableHandles, label.attributableHandles);
    }).length, calibration.length),
    threshold
  })).sort((left, right) => right.groundedAccuracy - left.groundedAccuracy ||
    right.threshold - left.threshold);
  const selected = candidates[0]!;
  const calibrationMetrics = calibrationError(calibration, labels);
  return Object.freeze({
    ...calibrationMetrics,
    evaluatedClaims: calibration.length,
    groundedAccuracy: selected.groundedAccuracy,
    objective: "grounded_accuracy" as const,
    selectedConfidenceMinimum: selected.threshold,
    split: "calibration" as const,
    status: "measured_from_imported_human_labels" as const,
    thresholdFrozenBeforeHeldOut: true as const,
    version: KNOWLEDGE_SEMANTIC_CALIBRATION_VERSION
  });
}

async function calibrationCandidateResult(input: Readonly<{
  candidate: KnowledgeSemanticCandidate;
  labels: ReadonlyMap<string, BoundLabel>;
  pool: KnowledgeSemanticCandidatePool;
}>): Promise<KnowledgeSemanticCalibrationFreezeCandidate> {
  if (input.candidate.availability === "unavailable") {
    return Object.freeze({
      calibration: null,
      calibrationOutputSha256: null,
      candidateId: input.candidate.id,
      executionStatus: "unavailable" as const,
      outputs: Object.freeze([] as const),
      reason: input.candidate.reason
    });
  }
  const predictions: RawPrediction[] = [];
  try {
    for (const entry of input.pool.entries.filter((candidate) =>
      candidate.split === "calibration")) {
      const started = performance.now();
      const rawResult = await input.candidate.executor.validate(entry.input);
      assertKnowledgeSemanticCandidateResult(entry.input, rawResult);
      const result = deterministicArithmeticResult(entry, rawResult);
      predictions.push(Object.freeze({
        entry,
        milliseconds: performance.now() - started,
        result
      }));
    }
  } catch {
    return Object.freeze({
      calibration: null,
      calibrationOutputSha256: null,
      candidateId: input.candidate.id,
      executionStatus: "failed" as const,
      outputs: Object.freeze([] as const),
      reason: "candidate_calibration_execution_failed"
    });
  }
  if (predictions.length === 0) {
    throw new Error("knowledge_semantic_calibration_split_empty");
  }
  const outputs = frozenCalibrationOutputs(predictions);
  return Object.freeze({
    calibration: calibrate(predictions, input.labels),
    calibrationOutputSha256: canonicalSha256(outputs),
    candidateId: input.candidate.id,
    executionStatus: "complete" as const,
    outputs
  });
}

function calibrationFreezeBody(input: Readonly<{
  calibrationLabelSha256: string;
  candidateFreezeManifestSha256: string;
  candidateSet: KnowledgeSemanticCandidateSetBinding;
  candidates: readonly KnowledgeSemanticCalibrationFreezeCandidate[];
}>): Omit<KnowledgeSemanticCalibrationFreezeManifest, "manifestSha256"> {
  return {
    aggregateOnly: true,
    artifactType: "knowledge_semantic_calibration_freeze",
    artifactVersion: KNOWLEDGE_SEMANTIC_CALIBRATION_FREEZE_VERSION,
    calibrationLabelSha256: input.calibrationLabelSha256,
    candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
    candidateSetDigest: input.candidateSet.digest,
    candidates: input.candidates,
    corpusSha256: input.candidateSet.corpusSha256,
    labelsStored: false,
    poolSha256: input.candidateSet.poolSha256,
    thresholdScheduleSha256: input.candidateSet.thresholdScheduleSha256
  };
}

export async function runKnowledgeSemanticCalibrationFreeze(input: Readonly<{
  candidateFreezeManifestSha256: string;
  frozenCandidateSetDigest: string;
  frozenThresholdScheduleSha256: string;
  labels: KnowledgeSemanticGroundingImportedReviewEvidence;
  local?: KnowledgeSemanticCandidateExecutor;
  localUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
  systemModel?: KnowledgeSemanticCandidateExecutor;
  systemUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
}>): Promise<KnowledgeSemanticCalibrationFreezeManifest> {
  if (!/^[a-f0-9]{64}$/u.test(input.candidateFreezeManifestSha256)) {
    throw new Error("knowledge_semantic_candidate_freeze_binding_invalid");
  }
  if (input.labels.reviewScope !== "calibration" ||
    input.labels.evaluationBindings.candidateFreezeManifestSha256 !==
      input.candidateFreezeManifestSha256 ||
    input.labels.evaluationBindings.calibrationFreezeManifestSha256 !== null ||
    input.labels.evaluationBindings.finalPredictionFreezeManifestSha256 !== null) {
    throw new Error("knowledge_semantic_calibration_review_binding_invalid");
  }
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const labels = bindLabels(pool, input.labels, "calibration");
  const candidates = createKnowledgeSemanticGroundingCandidates({
    ...(input.local ? { local: input.local } : {}),
    ...(input.localUnavailableReason ? { localUnavailableReason: input.localUnavailableReason } : {}),
    ...(input.systemModel ? { systemModel: input.systemModel } : {}),
    ...(input.systemUnavailableReason
      ? { systemUnavailableReason: input.systemUnavailableReason }
      : {})
  });
  const candidateSet = createKnowledgeSemanticCandidateSetBinding({
    candidates,
    corpusSha256: pool.corpusSha256,
    poolSha256: pool.poolSha256
  });
  if (input.frozenCandidateSetDigest !== candidateSet.digest ||
    input.frozenThresholdScheduleSha256 !== candidateSet.thresholdScheduleSha256) {
    throw new Error("knowledge_semantic_candidate_freeze_binding_mismatch");
  }
  const frozenCandidates: KnowledgeSemanticCalibrationFreezeCandidate[] = [];
  for (const candidate of candidates) {
    frozenCandidates.push(await calibrationCandidateResult({ candidate, labels, pool }));
  }
  const body = calibrationFreezeBody({
    calibrationLabelSha256: calibrationLabelSha256(pool, labels),
    candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
    candidateSet,
    candidates: Object.freeze(frozenCandidates)
  });
  return Object.freeze({ ...body, manifestSha256: canonicalSha256(body) });
}

export function assertKnowledgeSemanticCalibrationFreezeArtifact(input: Readonly<{
  candidateFreezeManifestSha256: string;
  candidates: readonly KnowledgeSemanticCandidate[];
  manifest: unknown;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticCalibrationFreezeManifest {
  const parsed = calibrationFreezeManifestSchema.safeParse(input.manifest);
  if (!parsed.success) throw new Error("knowledge_semantic_calibration_freeze_invalid");
  const { manifestSha256, ...body } = parsed.data;
  if (canonicalSha256(body) !== manifestSha256) {
    throw new Error("knowledge_semantic_calibration_freeze_digest_mismatch");
  }
  const candidateSet = createKnowledgeSemanticCandidateSetBinding({
    candidates: input.candidates,
    corpusSha256: input.pool.corpusSha256,
    poolSha256: input.pool.poolSha256
  });
  if (parsed.data.candidateFreezeManifestSha256 !== input.candidateFreezeManifestSha256 ||
    parsed.data.candidateSetDigest !== candidateSet.digest ||
    parsed.data.corpusSha256 !== candidateSet.corpusSha256 ||
    parsed.data.poolSha256 !== candidateSet.poolSha256 ||
    parsed.data.thresholdScheduleSha256 !== candidateSet.thresholdScheduleSha256) {
    throw new Error("knowledge_semantic_calibration_freeze_binding_mismatch");
  }
  const calibrationEntries = input.pool.entries.filter((entry) =>
    entry.split === "calibration");
  if (parsed.data.candidates.length !== input.candidates.length ||
    parsed.data.candidates.some((candidate, index) =>
      candidate.candidateId !== input.candidates[index]?.id ||
      candidate.executionStatus === "complete" &&
        (!KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS.includes(
          candidate.calibration.selectedConfidenceMinimum) ||
        canonicalSha256(candidate.outputs) !== candidate.calibrationOutputSha256 ||
        candidate.outputs.length !== calibrationEntries.length ||
        candidate.outputs.some((output, outputIndex) => {
          const entry = calibrationEntries[outputIndex];
          const scoreTotal = knowledgeSemanticGroundingDecisions.reduce((total, decision) =>
            total + output.decisionScores[decision], 0);
          return !entry || output.claimSha256 !== entry.claimSha256 ||
            output.neighborhoodSha256 !== entry.neighborhoodSha256 ||
            Math.abs(scoreTotal - 1) > 0.001 ||
            output.attributableHandles.length !== new Set(output.attributableHandles).size ||
            output.attributableHandles.some((handle) =>
              !entry.input.citationHandles.includes(handle));
        })))) {
    throw new Error("knowledge_semantic_calibration_freeze_candidate_mismatch");
  }
  return Object.freeze(parsed.data as KnowledgeSemanticCalibrationFreezeManifest);
}

export function assertKnowledgeSemanticCalibrationFreeze(input: Readonly<{
  candidateFreezeManifestSha256: string;
  candidates: readonly KnowledgeSemanticCandidate[];
  labels: ReadonlyMap<string, BoundLabel>;
  manifest: unknown;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticCalibrationFreezeManifest {
  const parsed = assertKnowledgeSemanticCalibrationFreezeArtifact(input);
  if (parsed.calibrationLabelSha256 !== calibrationLabelSha256(input.pool, input.labels)) {
    throw new Error("knowledge_semantic_calibration_freeze_binding_mismatch");
  }
  const calibrationEntries = input.pool.entries.filter((entry) =>
    entry.split === "calibration");
  for (const candidate of parsed.candidates) {
    if (candidate.executionStatus !== "complete") continue;
    const predictions = candidate.outputs.map((output, index): RawPrediction => Object.freeze({
      entry: calibrationEntries[index]!,
      milliseconds: 0,
      result: Object.freeze({
        attributableHandles: Object.freeze([...output.attributableHandles]),
        costMicros: 0,
        decisionScores: Object.freeze({ ...output.decisionScores }),
        inputTokens: null,
        reasonFamily: output.reasonFamily as KnowledgeSemanticCandidateResult["reasonFamily"],
        usage: Object.freeze({
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          inputTokens: null,
          outputTokens: null,
          providerRequestCount: null,
          reasoningTokens: null,
          status: "unavailable" as const,
          totalTokens: null
        })
      })
    }));
    const expectedCalibration = calibrate(predictions, input.labels);
    if (canonicalJson(expectedCalibration) !== canonicalJson(candidate.calibration)) {
      throw new Error("knowledge_semantic_calibration_freeze_threshold_mismatch");
    }
  }
  return parsed;
}

function predictionUsage(
  result: KnowledgeSemanticCandidateResult
): KnowledgeSemanticFinalPredictionFrozenOutput["usage"] {
  const usage = result.usage ?? {
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    inputTokens: result.inputTokens,
    outputTokens: null,
    providerRequestCount: null,
    reasoningTokens: null,
    status: "unavailable" as const,
    totalTokens: null
  };
  return Object.freeze({ ...usage, costMicros: result.costMicros });
}

function finalPredictionBody(input: Readonly<{
  calibrationFreezeManifestSha256: string;
  candidateFreezeManifestSha256: string;
  candidateSetDigest: string;
  candidates: readonly KnowledgeSemanticFinalPredictionFreezeCandidate[];
  corpusSha256: string;
  fallbackReplayVerified: boolean;
  poolSha256: string;
}>): Omit<KnowledgeSemanticFinalPredictionFreezeManifest, "manifestSha256"> {
  return {
    artifactType: "knowledge_semantic_final_prediction_freeze",
    artifactVersion: KNOWLEDGE_SEMANTIC_FINAL_PREDICTION_FREEZE_VERSION,
    calibrationFreezeManifestSha256: input.calibrationFreezeManifestSha256,
    candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
    candidateSetDigest: input.candidateSetDigest,
    candidates: input.candidates,
    contentFree: true,
    corpusSha256: input.corpusSha256,
    fallbackReplayVerified: input.fallbackReplayVerified,
    labelAccessByPredictionProcess: false,
    labelsIncluded: false,
    poolSha256: input.poolSha256,
    splitsExecuted: ["development", "held_out", "blinded_review"]
  };
}

/**
 * Executes every frozen candidate on development/held-out/blinded claims
 * without accepting labels.  The resulting private artifact is the only
 * prediction source permitted once review labels are imported.
 */
export async function runKnowledgeSemanticFinalPredictionFreeze(input: Readonly<{
  calibrationFreeze: unknown;
  candidateFreezeManifest: unknown;
  candidateFreezeManifestSha256: string;
  local?: KnowledgeSemanticCandidateExecutor;
  localUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
  systemModel?: KnowledgeSemanticCandidateExecutor;
  systemUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
}>): Promise<KnowledgeSemanticFinalPredictionFreezeManifest> {
  if (!/^[a-f0-9]{64}$/u.test(input.candidateFreezeManifestSha256)) {
    throw new Error("knowledge_semantic_candidate_freeze_binding_invalid");
  }
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const candidates = createKnowledgeSemanticGroundingCandidates({
    ...(input.local ? { local: input.local } : {}),
    ...(input.localUnavailableReason ? { localUnavailableReason: input.localUnavailableReason } : {}),
    ...(input.systemModel ? { systemModel: input.systemModel } : {}),
    ...(input.systemUnavailableReason
      ? { systemUnavailableReason: input.systemUnavailableReason }
      : {})
  });
  const candidateFreeze = assertKnowledgeSemanticCandidateFreezeManifest({
    candidates,
    manifest: input.candidateFreezeManifest,
    pool
  });
  if (candidateFreeze.manifestSha256 !== input.candidateFreezeManifestSha256) {
    throw new Error("knowledge_semantic_candidate_freeze_binding_mismatch");
  }
  const calibrationFreeze = assertKnowledgeSemanticCalibrationFreezeArtifact({
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    candidates,
    manifest: input.calibrationFreeze,
    pool
  });
  if (calibrationFreeze.candidateFreezeManifestSha256 !== candidateFreeze.manifestSha256 ||
    calibrationFreeze.candidateSetDigest !== candidateFreeze.candidateSet.digest) {
    throw new Error("knowledge_semantic_calibration_freeze_binding_mismatch");
  }
  const fallbackReplayVerified = await fallbackReplay(pool);
  const calibrationById = new Map(calibrationFreeze.candidates.map((candidate) => [
    candidate.candidateId,
    candidate
  ] as const));
  const entries = pool.entries.filter((entry) => entry.split !== "calibration");
  const frozenCandidates: KnowledgeSemanticFinalPredictionFreezeCandidate[] = [];
  for (const candidate of candidates) {
    const candidateIdentity = knowledgeSemanticCandidateIdentityForDigest(candidate);
    if (candidate.availability === "unavailable") {
      frozenCandidates.push(Object.freeze({
        candidateId: candidate.id,
        candidateIdentity,
        executionStatus: "unavailable" as const,
        outputSha256: null,
        outputs: Object.freeze([] as const),
        reason: candidate.reason
      }));
      continue;
    }
    const calibration = calibrationById.get(candidate.id);
    if (!calibration || calibration.executionStatus !== "complete") {
      frozenCandidates.push(Object.freeze({
        candidateId: candidate.id,
        candidateIdentity,
        executionStatus: "failed" as const,
        failureClaimSha256: null,
        failureNeighborhoodSha256: null,
        outputSha256: canonicalSha256([]),
        outputs: Object.freeze([]),
        reason: "candidate_calibration_unavailable" as const
      }));
      continue;
    }
    const outputs: KnowledgeSemanticFinalPredictionFrozenOutput[] = [];
    let failureClaimSha256: string | null = null;
    let failureNeighborhoodSha256: string | null = null;
    let failure = false;
    for (const entry of entries) {
      const started = performance.now();
      try {
        const rawResult = await candidate.executor.validate(entry.input);
        assertKnowledgeSemanticCandidateResult(entry.input, rawResult);
        const result = deterministicArithmeticResult(entry, rawResult);
        outputs.push(Object.freeze({
          attributableHandles: Object.freeze([...result.attributableHandles].sort()),
          claimSha256: entry.claimSha256,
          decisionScores: Object.freeze({ ...result.decisionScores }),
          latencyMicroseconds: Math.max(0, Math.round((performance.now() - started) * 1_000)),
          neighborhoodSha256: entry.neighborhoodSha256,
          reasonFamily: result.reasonFamily,
          resourceUsage: result.resourceUsage ?? null,
          split: entry.split as MeasuredSplit,
          usage: predictionUsage(result)
        }));
      } catch {
        failure = true;
        failureClaimSha256 = entry.claimSha256;
        failureNeighborhoodSha256 = entry.neighborhoodSha256;
        break;
      }
    }
    const outputSha256 = canonicalSha256(outputs);
    frozenCandidates.push(Object.freeze(failure
      ? {
          candidateId: candidate.id,
          candidateIdentity,
          executionStatus: "failed" as const,
          failureClaimSha256,
          failureNeighborhoodSha256,
          outputSha256,
          outputs: Object.freeze(outputs),
          reason: "candidate_execution_failed" as const
        }
      : {
          candidateId: candidate.id,
          candidateIdentity,
          executionStatus: "complete" as const,
          outputSha256,
          outputs: Object.freeze(outputs)
        }));
  }
  const body = finalPredictionBody({
    calibrationFreezeManifestSha256: calibrationFreeze.manifestSha256,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    candidateSetDigest: candidateFreeze.candidateSet.digest,
    candidates: Object.freeze(frozenCandidates),
    corpusSha256: pool.corpusSha256,
    fallbackReplayVerified,
    poolSha256: pool.poolSha256
  });
  return Object.freeze({ ...body, manifestSha256: canonicalSha256(body) });
}

export function assertKnowledgeSemanticFinalPredictionFreeze(input: Readonly<{
  calibrationFreeze: unknown;
  candidateFreezeManifest: unknown;
  candidateFreezeManifestSha256: string;
  manifest: unknown;
  pool: KnowledgeSemanticCandidatePool;
  candidates: readonly KnowledgeSemanticCandidate[];
}>): KnowledgeSemanticFinalPredictionFreezeManifest {
  const parsed = finalPredictionFreezeManifestSchema.safeParse(input.manifest);
  if (!parsed.success) throw new Error("knowledge_semantic_final_prediction_freeze_invalid");
  const { manifestSha256, ...body } = parsed.data;
  if (canonicalSha256(body) !== manifestSha256) {
    throw new Error("knowledge_semantic_final_prediction_freeze_digest_mismatch");
  }
  const candidateFreeze = assertKnowledgeSemanticCandidateFreezeManifest({
    candidates: input.candidates,
    manifest: input.candidateFreezeManifest,
    pool: input.pool
  });
  const calibrationFreeze = assertKnowledgeSemanticCalibrationFreezeArtifact({
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    candidates: input.candidates,
    manifest: input.calibrationFreeze,
    pool: input.pool
  });
  if (candidateFreeze.manifestSha256 !== input.candidateFreezeManifestSha256 ||
    parsed.data.candidateFreezeManifestSha256 !== candidateFreeze.manifestSha256 ||
    parsed.data.calibrationFreezeManifestSha256 !== calibrationFreeze.manifestSha256 ||
    parsed.data.candidateSetDigest !== candidateFreeze.candidateSet.digest ||
    parsed.data.corpusSha256 !== input.pool.corpusSha256 ||
    parsed.data.poolSha256 !== input.pool.poolSha256 ||
    !parsed.data.fallbackReplayVerified) {
    throw new Error("knowledge_semantic_final_prediction_freeze_binding_mismatch");
  }
  const expectedIdentities = new Map(input.candidates.map((candidate) => [
    candidate.id,
    knowledgeSemanticCandidateIdentityForDigest(candidate)
  ] as const));
  const liveCandidates = new Map(input.candidates.map((candidate) => [
    candidate.id,
    candidate
  ] as const));
  const calibrationCandidates = new Map(calibrationFreeze.candidates.map((candidate) => [
    candidate.candidateId,
    candidate
  ] as const));
  const entries = input.pool.entries.filter((entry) => entry.split !== "calibration");
  if (parsed.data.candidates.length !== expectedIdentities.size ||
    new Set(parsed.data.candidates.map((candidate) => candidate.candidateId)).size !==
      parsed.data.candidates.length) {
    throw new Error("knowledge_semantic_final_prediction_freeze_candidate_mismatch");
  }
  if (parsed.data.candidates.some((candidate) => {
    const expectedIdentity = expectedIdentities.get(candidate.candidateId);
    const liveCandidate = liveCandidates.get(candidate.candidateId);
    const calibrationCandidate = calibrationCandidates.get(candidate.candidateId);
    if (!expectedIdentity || canonicalJson(expectedIdentity) !== canonicalJson(candidate.candidateIdentity)) {
      return true;
    }
    if (!liveCandidate || !calibrationCandidate ||
      (liveCandidate.availability === "available" && candidate.executionStatus === "unavailable") ||
      (liveCandidate.availability === "unavailable" &&
        (candidate.executionStatus !== "unavailable" || candidate.reason !== liveCandidate.reason)) ||
      (calibrationCandidate.executionStatus !== "complete" &&
        candidate.executionStatus === "complete")) {
      return true;
    }
    if (candidate.executionStatus === "unavailable") return candidate.outputs.length !== 0;
    if (candidate.executionStatus === "complete" && candidate.outputs.length !== entries.length) {
      return true;
    }
    if (canonicalSha256(candidate.outputs) !== candidate.outputSha256) return true;
    return candidate.outputs.some((output, index) => {
      const entry = entries[index];
      return !artifactOutputMatchesPoolEntry(output, entry) || output.split !== entry?.split ||
        !artifactPredictionUsageValid(output.usage);
    });
  })) {
    throw new Error("knowledge_semantic_final_prediction_freeze_output_mismatch");
  }
  return Object.freeze(parsed.data as KnowledgeSemanticFinalPredictionFreezeManifest);
}

export type KnowledgeSemanticFinalArtifactFreezeChain = Readonly<{
  calibrationFreeze: KnowledgeSemanticCalibrationFreezeManifest;
  candidateFreeze: KnowledgeSemanticCandidateFreezeManifest;
  finalPredictionFreeze: KnowledgeSemanticFinalPredictionFreezeManifest;
}>;

function artifactOutputMatchesPoolEntry(
  output: Readonly<{
    attributableHandles: readonly string[];
    claimSha256: string;
    decisionScores: KnowledgeSemanticCandidateResult["decisionScores"];
    neighborhoodSha256: string;
    reasonFamily: KnowledgeSemanticCandidateResult["reasonFamily"];
  }>,
  entry: KnowledgeSemanticCandidatePoolEntry | undefined
): boolean {
  if (!entry) return false;
  const total = knowledgeSemanticGroundingDecisions.reduce((sum, decision) =>
    sum + output.decisionScores[decision], 0);
  const sortedHandles = [...output.attributableHandles].sort();
  const arithmeticMatches = (() => {
    if (entry.input.type !== "derived_arithmetic") return entry.arithmetic === null;
    if (entry.arithmetic === null) return false;
    const verification = verifyKnowledgeSemanticArithmeticBinding({
      binding: entry.arithmetic,
      claimSha256: entry.claimSha256,
      evidencePackage: entry.evidencePackage
    });
    const expectedDecision = verification.code === "verified"
      ? "supported" as const
      : verification.code === "output_outside_tolerance"
        ? "contradicted" as const
        : null;
    return expectedDecision !== null && output.reasonFamily === "deterministic_receipt" &&
      canonicalJson(output.attributableHandles) ===
        canonicalJson([entry.arithmetic.plan.citationHandle]) &&
      knowledgeSemanticGroundingDecisions.every((decision) =>
        output.decisionScores[decision] === Number(decision === expectedDecision));
  })();
  return arithmeticMatches && output.claimSha256 === entry.claimSha256 &&
    output.neighborhoodSha256 === entry.neighborhoodSha256 &&
    Math.abs(total - 1) <= 0.001 &&
    output.attributableHandles.length === new Set(output.attributableHandles).size &&
    canonicalJson(output.attributableHandles) === canonicalJson(sortedHandles) &&
    output.attributableHandles.every((handle) =>
      entry.input.citationHandles.includes(handle));
}

function artifactPredictionUsageValid(
  usage: KnowledgeSemanticFinalPredictionFrozenOutput["usage"]
): boolean {
  const counters = [
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.inputTokens,
    usage.outputTokens,
    usage.providerRequestCount,
    usage.reasoningTokens,
    usage.totalTokens
  ];
  return (usage.status !== "measured" || counters.every((value) => value !== null)) &&
    (usage.status !== "not_used" || counters.every((value) => value === 0));
}

/** Validates the complete persisted candidate -> calibration -> final chain
 * without constructing optional executors or executing candidate code. */
export function assertKnowledgeSemanticFinalArtifactFreezeChain(input: Readonly<{
  calibrationFreeze: unknown;
  candidateFreeze: unknown;
  finalPredictionFreeze: unknown;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticFinalArtifactFreezeChain {
  const candidateFreeze = assertKnowledgeSemanticCandidateFreezeArtifact({
    manifest: input.candidateFreeze,
    pool: input.pool
  });
  const parsedCalibration = calibrationFreezeManifestSchema.safeParse(input.calibrationFreeze);
  if (!parsedCalibration.success) {
    throw new Error("knowledge_semantic_calibration_freeze_invalid");
  }
  const { manifestSha256: calibrationManifestSha256, ...calibrationBody } =
    parsedCalibration.data;
  if (canonicalSha256(calibrationBody) !== calibrationManifestSha256) {
    throw new Error("knowledge_semantic_calibration_freeze_digest_mismatch");
  }
  if (parsedCalibration.data.candidateFreezeManifestSha256 !==
      candidateFreeze.manifestSha256 ||
    parsedCalibration.data.candidateSetDigest !== candidateFreeze.candidateSet.digest ||
    parsedCalibration.data.corpusSha256 !== input.pool.corpusSha256 ||
    parsedCalibration.data.poolSha256 !== input.pool.poolSha256 ||
    parsedCalibration.data.thresholdScheduleSha256 !==
      candidateFreeze.candidateSet.thresholdScheduleSha256) {
    throw new Error("knowledge_semantic_calibration_freeze_binding_mismatch");
  }
  const calibrationEntries = input.pool.entries.filter((entry) =>
    entry.split === "calibration");
  const calibrationCandidateInvalid = parsedCalibration.data.candidates.some(
    (candidate, index) => {
      const frozenIdentity = candidateFreeze.candidates[index];
      if (!frozenIdentity || candidate.candidateId !== frozenIdentity.id) return true;
      if (frozenIdentity.availability === "unavailable") {
        return candidate.executionStatus !== "unavailable" ||
          candidate.reason !== frozenIdentity.reason;
      }
      if (candidate.executionStatus === "unavailable") return true;
      if (candidate.executionStatus === "failed") {
        return candidate.reason !== "candidate_calibration_execution_failed";
      }
      const calibration = candidate.calibration;
      if (!calibration) return true;
      return calibration.evaluatedClaims !== calibrationEntries.length ||
        !KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS.includes(
          calibration.selectedConfidenceMinimum
        ) ||
        canonicalSha256(candidate.outputs) !== candidate.calibrationOutputSha256 ||
        candidate.outputs.length !== calibrationEntries.length ||
        candidate.outputs.some((output, outputIndex) =>
          !artifactOutputMatchesPoolEntry(output, calibrationEntries[outputIndex]));
    }
  );
  if (calibrationCandidateInvalid) {
    throw new Error("knowledge_semantic_calibration_freeze_candidate_mismatch");
  }

  const parsedFinal = finalPredictionFreezeManifestSchema.safeParse(
    input.finalPredictionFreeze
  );
  if (!parsedFinal.success) {
    throw new Error("knowledge_semantic_final_prediction_freeze_invalid");
  }
  const { manifestSha256: finalManifestSha256, ...finalBody } = parsedFinal.data;
  if (canonicalSha256(finalBody) !== finalManifestSha256) {
    throw new Error("knowledge_semantic_final_prediction_freeze_digest_mismatch");
  }
  if (parsedFinal.data.candidateFreezeManifestSha256 !== candidateFreeze.manifestSha256 ||
    parsedFinal.data.calibrationFreezeManifestSha256 !==
      parsedCalibration.data.manifestSha256 ||
    parsedFinal.data.candidateSetDigest !== candidateFreeze.candidateSet.digest ||
    parsedFinal.data.corpusSha256 !== input.pool.corpusSha256 ||
    parsedFinal.data.poolSha256 !== input.pool.poolSha256 ||
    !parsedFinal.data.fallbackReplayVerified) {
    throw new Error("knowledge_semantic_final_prediction_freeze_binding_mismatch");
  }
  const finalEntries = input.pool.entries.filter((entry) =>
    entry.split !== "calibration");
  const finalCandidateInvalid = parsedFinal.data.candidates.some((candidate, index) => {
    const frozenIdentity = candidateFreeze.candidates[index];
    const calibrationCandidate = parsedCalibration.data.candidates[index];
    if (!frozenIdentity || !calibrationCandidate ||
      candidate.candidateId !== frozenIdentity.id ||
      calibrationCandidate.candidateId !== frozenIdentity.id ||
      canonicalJson(candidate.candidateIdentity) !== canonicalJson(frozenIdentity)) {
      return true;
    }
    if (frozenIdentity.availability === "unavailable") {
      return candidate.executionStatus !== "unavailable" ||
        candidate.reason !== frozenIdentity.reason ||
        calibrationCandidate.executionStatus !== "unavailable";
    }
    if (candidate.executionStatus === "unavailable") return true;
    if (candidate.executionStatus === "complete") {
      if (calibrationCandidate.executionStatus !== "complete" ||
        candidate.outputs.length !== finalEntries.length) {
        return true;
      }
    } else if (candidate.reason === "candidate_calibration_unavailable") {
      if (calibrationCandidate.executionStatus === "complete" ||
        candidate.outputs.length !== 0 || candidate.failureClaimSha256 !== null ||
        candidate.failureNeighborhoodSha256 !== null) {
        return true;
      }
    } else {
      const failureEntry = finalEntries[candidate.outputs.length];
      if (calibrationCandidate.executionStatus !== "complete" || !failureEntry ||
        candidate.failureClaimSha256 !== failureEntry.claimSha256 ||
        candidate.failureNeighborhoodSha256 !== failureEntry.neighborhoodSha256) {
        return true;
      }
    }
    if (canonicalSha256(candidate.outputs) !== candidate.outputSha256) return true;
    return candidate.outputs.some((output, outputIndex) =>
      output.split !== finalEntries[outputIndex]?.split ||
      !artifactPredictionUsageValid(output.usage) ||
      !artifactOutputMatchesPoolEntry(output, finalEntries[outputIndex]));
  });
  if (finalCandidateInvalid) {
    throw new Error("knowledge_semantic_final_prediction_freeze_output_mismatch");
  }
  return Object.freeze({
    calibrationFreeze: Object.freeze(
      parsedCalibration.data as KnowledgeSemanticCalibrationFreezeManifest
    ),
    candidateFreeze,
    finalPredictionFreeze: Object.freeze(
      parsedFinal.data as KnowledgeSemanticFinalPredictionFreezeManifest
    )
  });
}

function confusionMatrix(claims: readonly ScoredClaim[]): ConfusionMatrix {
  return Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((expected) => [
    expected,
    Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((predicted) => [
      predicted,
      claims.filter((claim) => claim.expected === expected && claim.predicted === predicted).length
    ])))
  ])) as Record<KnowledgeSemanticGroundingDecision,
    Readonly<Record<KnowledgeSemanticGroundingDecision, number>>>);
}

function evaluationSlice(claims: readonly ScoredClaim[]): EvaluationSlice {
  return Object.freeze({
    accuracy: ratio(claims.filter((claim) => claim.decisionCorrect).length, claims.length),
    attributableAccuracy: ratio(
      claims.filter((claim) => claim.attributableCorrect).length,
      claims.length
    ),
    confusionMatrix: confusionMatrix(claims),
    count: claims.length,
    falseNegativeCount: claims.filter((claim) =>
      (claim.expected === "contradicted" || claim.expected === "unsupported") &&
      claim.predicted === "supported").length,
    falsePositiveCount: claims.filter((claim) => claim.expected === "supported" &&
      (claim.predicted === "contradicted" || claim.predicted === "unsupported")).length
  });
}

function precisionRecall(
  claims: readonly ScoredClaim[],
  decision: KnowledgeSemanticGroundingDecision
): Readonly<{ precision: number; recall: number }> {
  const predicted = claims.filter((claim) => claim.predicted === decision);
  const expected = claims.filter((claim) => claim.expected === decision);
  const correct = predicted.filter((claim) => claim.expected === decision).length;
  return Object.freeze({
    precision: ratio(correct, predicted.length),
    recall: ratio(correct, expected.length)
  });
}

function scoredSplit(
  predictions: readonly RawPrediction[],
  labels: ReadonlyMap<string, BoundLabel>,
  split: MeasuredSplit,
  threshold: number
): readonly ScoredClaim[] {
  return predictions.filter((raw) => raw.entry.split === split).map((raw): ScoredClaim => {
    const label = labelFor(labels, raw.entry);
    const selected = thresholded(raw.result, threshold);
    return Object.freeze({
      attributableCorrect: sameSet(raw.result.attributableHandles, label.attributableHandles),
      confidence: selected.confidence,
      decisionCorrect: selected.decision === label.decision,
      entry: raw.entry,
      expected: label.decision,
      expectedAttributableHandles: Object.freeze([...label.attributableHandles]),
      predicted: selected.decision,
      predictedAttributableHandles: Object.freeze([...raw.result.attributableHandles])
    });
  });
}

function splitSummary(claims: readonly ScoredClaim[]): SplitQualitySummary {
  const byLanguage = Object.freeze(Object.fromEntries((["en", "ru"] as const).map((language) => [
    language,
    evaluationSlice(claims.filter((claim) => claim.entry.language === language))
  ])) as Record<KnowledgeSemanticGroundingLanguage, EvaluationSlice>);
  const bySlice = Object.freeze(Object.fromEntries(knowledgeSemanticGroundingSlices.map((slice) => [
    slice,
    evaluationSlice(claims.filter((claim) => claim.entry.slices.includes(slice)))
  ])) as Record<KnowledgeSemanticGroundingSlice, EvaluationSlice>);
  const overall = evaluationSlice(claims);
  return Object.freeze({
    byLanguage,
    bySlice,
    groundedAccuracy: ratio(claims.filter((claim) =>
      claim.decisionCorrect && claim.attributableCorrect).length, claims.length),
    overall
  });
}

const releaseMetricSliceSet = new Set<string>(knowledgeSemanticGroundingReleaseMetricSlices);

function releaseMetricRegressionClass(
  claim: ScoredClaim
): KnowledgeSemanticGroundingReleaseMetricObservation["mandatoryRegression"] {
  if (claim.entry.slices.includes("reference_context")) return "reference";
  if (claim.entry.slices.includes("version_attribution")) return "version";
  if (claim.entry.slices.includes("temporal_non_contradiction")) return "temporal";
  return null;
}

function releaseMetricSlices(
  claim: ScoredClaim
): readonly KnowledgeSemanticGroundingReleaseMetricSlice[] {
  const slices = claim.entry.slices.filter((slice): slice is KnowledgeSemanticGroundingReleaseMetricSlice =>
    releaseMetricSliceSet.has(slice));
  if (slices.length === 0) {
    throw new Error("knowledge_semantic_release_metric_slice_missing");
  }
  return Object.freeze(slices);
}

/** Projects a scored, independently adjudicated claim into the content-free
 * §28.3 calculator. The semantic candidate is shadow-only at H6, so it cannot
 * destroy or rewrite the answer; repair preservation remains a separate H7/H8
 * gate over real generated outputs. */
function releaseMetricObservations(
  claims: readonly ScoredClaim[]
): readonly KnowledgeSemanticGroundingReleaseMetricObservation[] {
  const claimsByFixture = new Map<string, readonly ScoredClaim[]>();
  for (const claim of claims) {
    const grouped = claimsByFixture.get(claim.entry.fixtureId) ?? [];
    claimsByFixture.set(claim.entry.fixtureId, Object.freeze([...grouped, claim]));
  }
  return Object.freeze(claims.map((claim) => {
    const noAnswer = claim.entry.slices.includes("no_answer");
    const numericDate = claim.entry.slices.some((slice) =>
      slice === "date_consistency" || slice === "derived_arithmetic" ||
      slice === "numeric_consistency" || slice === "reference_context" ||
      slice === "temporal_non_contradiction" || slice === "version_attribution");
    const mandatoryRegression = releaseMetricRegressionClass(claim);
    const fixtureClaims = claimsByFixture.get(claim.entry.fixtureId) ?? [];
    const independentUncertainClaim = claim.expected === "uncertain" &&
      fixtureClaims.some((candidate) => candidate.expected === "supported");
    const availableCitationHandles = claim.entry.input.evidence
      .filter((evidence) => evidence.state === "available" && evidence.locatorState === "valid")
      .map((evidence) => evidence.handle);
    const sourceDerived = !noAnswer && claim.entry.input.type !== "general_knowledge" &&
      claim.entry.input.type !== "non_factual";
    return Object.freeze({
      availableCitationHandles: [...new Set(availableCitationHandles)],
      claimSha256: claim.entry.claimSha256,
      criticalNumericDate: numericDate && mandatoryRegression !== null,
      expectedCitationHandles: [...claim.expectedAttributableHandles],
      expectedDecision: claim.expected,
      independentUncertainClaim,
      language: claim.entry.language,
      mandatoryRegression,
      noAnswerExpected: noAnswer && claim.expected === "supported",
      noAnswerPredicted: noAnswer && claim.predicted === "supported",
      numericDate,
      numericDateAttributionCorrect: !numericDate ||
        claim.decisionCorrect && claim.attributableCorrect,
      predictedCitationHandles: [...claim.predictedAttributableHandles],
      predictedDecision: claim.predicted,
      slices: [...releaseMetricSlices(claim)],
      sourceDerived,
      supportedClaimsPreserved: independentUncertainClaim,
      wholeAnswerDestroyed: false
    });
  }));
}

function qualityGatesForSplit(
  claims: readonly ScoredClaim[],
  summary: SplitQualitySummary
): boolean {
  const contradiction = precisionRecall(claims, "contradicted");
  const temporalFalseBlockers = claims.filter((claim) =>
    claim.entry.slices.includes("temporal_non_contradiction") &&
    claim.expected === "supported" && claim.predicted !== "supported").length;
  const versionFalseBlockers = claims.filter((claim) =>
    claim.entry.slices.includes("version_attribution") &&
    claim.expected === "supported" && claim.predicted !== "supported").length;
  const mandatorySlicesMeasured = knowledgeSemanticGroundingSlices.every((slice) =>
    summary.bySlice[slice].count >=
      knowledgeSemanticGroundingQualityGates.sliceClaimMinimums[slice] &&
    (["en", "ru"] as const).every((language) =>
      claims.filter((claim) => claim.entry.language === language &&
        claim.entry.slices.includes(slice)).length >=
        knowledgeSemanticGroundingQualityGates.sliceLanguageClaimMinimum));
  const languagesMeasured = (["en", "ru"] as const).every((language) => {
    const metrics = summary.byLanguage[language];
    return metrics.accuracy >= knowledgeSemanticGroundingQualityGates.languageAccuracyMinimum &&
      metrics.count >= knowledgeSemanticGroundingQualityGates.languageClaimMinimum;
  });
  return summary.overall.attributableAccuracy >=
      knowledgeSemanticGroundingQualityGates.attributionAccuracyMinimum &&
    summary.overall.accuracy >= knowledgeSemanticGroundingQualityGates.decisionAccuracyMinimum &&
    contradiction.precision >= knowledgeSemanticGroundingQualityGates.contradictionPrecisionMinimum &&
    contradiction.recall >= knowledgeSemanticGroundingQualityGates.contradictionRecallMinimum &&
    summary.bySlice.date_consistency.accuracy >=
      knowledgeSemanticGroundingQualityGates.dateConsistencyAccuracyMinimum &&
    summary.bySlice.generic_entailment.accuracy >=
      knowledgeSemanticGroundingQualityGates.genericEntailmentAccuracyMinimum &&
    summary.bySlice.locator_correctness.accuracy >=
      knowledgeSemanticGroundingQualityGates.locatorAccuracyMinimum &&
    summary.bySlice.no_answer.accuracy >= knowledgeSemanticGroundingQualityGates.noAnswerAccuracyMinimum &&
    summary.bySlice.numeric_consistency.accuracy >=
      knowledgeSemanticGroundingQualityGates.numericConsistencyAccuracyMinimum &&
    summary.bySlice.version_attribution.accuracy >=
      knowledgeSemanticGroundingQualityGates.versionAttributionAccuracyMinimum &&
    mandatorySlicesMeasured &&
    temporalFalseBlockers <= knowledgeSemanticGroundingQualityGates.temporalFalseBlockerMaximum &&
    versionFalseBlockers === 0 &&
    claims.length >= knowledgeSemanticGroundingQualityGates.heldOutClaimMinimum &&
    claims.filter((claim) => claim.expected === "contradicted").length >=
      knowledgeSemanticGroundingQualityGates.contradictionClaimMinimum &&
    languagesMeasured;
}

function measuredQuality(input: Readonly<{
  calibration: KnowledgeSemanticCalibrationMetrics;
  humanProvenanceGatePassed: boolean;
  labels: ReadonlyMap<string, BoundLabel>;
  predictions: readonly RawPrediction[];
}>): KnowledgeSemanticMeasuredQuality {
  const calibration = input.calibration;
  const development = scoredSplit(
    input.predictions, input.labels, "development", calibration.selectedConfidenceMinimum
  );
  const heldOut = scoredSplit(
    input.predictions, input.labels, "held_out", calibration.selectedConfidenceMinimum
  );
  const blindedReview = scoredSplit(
    input.predictions, input.labels, "blinded_review", calibration.selectedConfidenceMinimum
  );
  const developmentSummary = splitSummary(development);
  const heldOutSummary = splitSummary(heldOut);
  const blindedSummary = splitSummary(blindedReview);
  const heldOutReleaseMetrics = measureKnowledgeSemanticGroundingReleaseMetrics({
    observations: releaseMetricObservations(heldOut)
  });
  const blindedReviewReleaseMetrics = measureKnowledgeSemanticGroundingReleaseMetrics({
    observations: releaseMetricObservations(blindedReview)
  });
  const heldOutGatesPassed = calibration.thresholdFrozenBeforeHeldOut &&
    qualityGatesForSplit(heldOut, heldOutSummary);
  const blindedReviewQualityGatesPassed = calibration.thresholdFrozenBeforeHeldOut &&
    qualityGatesForSplit(blindedReview, blindedSummary);
  const blindedReviewAcceptancePassed = input.humanProvenanceGatePassed &&
    blindedReviewQualityGatesPassed;
  const gatesPassed = heldOutGatesPassed && blindedReviewAcceptancePassed;
  return Object.freeze({
    calibration: Object.freeze({
      ...calibration,
      thresholdFrozenBeforeHeldOut: true as const
    }),
    blindedReviewAcceptancePassed,
    blindedReviewQualityGatesPassed,
    blindedReviewReleaseMetrics,
    development: developmentSummary,
    blindedReview: blindedSummary,
    gatesPassed,
    heldOutGatesPassed,
    heldOut: Object.freeze({
      attributableAccuracy: heldOutSummary.overall.attributableAccuracy,
      byLanguage: heldOutSummary.byLanguage,
      bySlice: heldOutSummary.bySlice,
      contradictionPrecision: precisionRecall(heldOut, "contradicted").precision,
      contradictionRecall: precisionRecall(heldOut, "contradicted").recall,
      decisionAccuracy: heldOutSummary.overall.accuracy,
      groundedAccuracy: heldOutSummary.groundedAccuracy,
      overall: heldOutSummary.overall,
      supportedPrecision: precisionRecall(heldOut, "supported").precision,
      supportedRecall: precisionRecall(heldOut, "supported").recall,
      temporalFalseBlockers: heldOut.filter((claim) =>
        claim.entry.slices.includes("temporal_non_contradiction") &&
        claim.expected === "supported" && claim.predicted !== "supported").length,
      versionFalseBlockers: heldOut.filter((claim) =>
        claim.entry.slices.includes("version_attribution") &&
          claim.expected === "supported" && claim.predicted !== "supported").length
    }),
    heldOutReleaseMetrics,
    labelProvenance: "two_external_humans_adjudicated" as const,
    provenanceVerification: input.humanProvenanceGatePassed
      ? "verified_external_humans" as const
      : "self_attested_unverified" as const,
    selection: Object.freeze({
      groundedAccuracy: heldOutSummary.groundedAccuracy,
      split: "held_out" as const
    }),
    scope: "blinded_review_only_after_calibration_threshold_freeze" as const,
    status: "measured_from_imported_human_labels" as const
  });
}

function identity(
  candidate: Extract<KnowledgeSemanticCandidate, { availability: "available" }>
): CandidateIdentity {
  return Object.freeze({
    ...candidate.executor.identity,
    id: candidate.id,
    kind: candidate.kind,
    validatorVersion: candidate.executor.identity.version
  });
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function inputBytes(entry: KnowledgeSemanticCandidatePoolEntry): number {
  return Buffer.byteLength(JSON.stringify({
    claim: {
      context: entry.input.context,
      text: entry.input.text,
      type: entry.input.type
    },
    evidence: entry.input.evidence.map((item) => ({
      ambiguous: item.ambiguous,
      locatorState: item.locatorState,
      state: item.state,
      text: item.text
    })),
    query: entry.input.query,
    scopeEvidence: entry.input.scopeEvidence
  }), "utf8");
}

function resources(
  executor: KnowledgeSemanticCandidateExecutor,
  results: readonly KnowledgeSemanticCandidateResult[]
): Readonly<{ gpu: ResourceEvidence; rss: ResourceEvidence }> {
  if (executor.identity.hardware === "provider_managed") {
    const managed = Object.freeze({
      measurement: "provider_managed" as const,
      peakBytes: null,
      status: "provider_managed" as const
    });
    return Object.freeze({ gpu: managed, rss: managed });
  }
  const usage = results.map((result) => result.resourceUsage);
  const complete = usage.length > 0 && usage.every((entry) => entry !== undefined && entry !== null);
  const rss: ResourceEvidence = complete
    ? Object.freeze({
        measurement: "runner_reported_peak" as const,
        peakBytes: Math.max(...usage.map((entry) => entry!.peakRssBytes)),
        status: "measured" as const
      })
    : unavailable("peak_rss_not_isolated_from_candidate_runtime");
  const gpu: ResourceEvidence = executor.identity.hardware === "cpu"
    ? Object.freeze({
        measurement: "hardware_not_used" as const,
        peakBytes: 0,
        status: "not_used" as const
      })
    : complete && usage.every((entry) => entry!.peakGpuMemoryBytes !== null)
      ? Object.freeze({
          measurement: "runner_reported_peak" as const,
          peakBytes: Math.max(...usage.map((entry) => entry!.peakGpuMemoryBytes!)),
          status: "measured" as const
        })
      : unavailable("gpu_peak_memory_not_isolated_from_candidate_runtime");
  return Object.freeze({ gpu, rss });
}

async function fallbackReplay(pool: KnowledgeSemanticCandidatePool): Promise<boolean> {
  const first = pool.entries[0];
  if (!first) return false;
  const fallback = createKnowledgeSemanticGroundingCandidates()[0];
  if (!fallback || fallback.availability !== "available") return false;
  const [left, right] = await Promise.all([
    fallback.executor.validate(first.input),
    fallback.executor.validate(first.input)
  ]);
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationalEvidence(input: Readonly<{
  candidate: Extract<KnowledgeSemanticCandidate, { availability: "available" }>;
  entries: readonly KnowledgeSemanticCandidatePoolEntry[];
  fallbackVerified: boolean;
  results: readonly KnowledgeSemanticCandidateResult[];
}>): CandidateOperationalEvidence {
  const costs = input.results.map((result) => result.costMicros);
  const tokens = input.results.map((result) => result.inputTokens);
  const costMeasured = costs.every((value) => value !== null);
  const totalMicros = costMeasured
    ? costs.reduce((sum, value) => sum + value!, 0)
    : null;
  const processedInputBytes = input.entries.reduce((sum, entry) =>
    sum + inputBytes(entry), 0);
  const executionResources = resources(input.candidate.executor, input.results);
  const external = input.candidate.executor.identity.egress === "external";
  return Object.freeze({
    cost: Object.freeze({
      microsPerClaim: totalMicros === null ? null : totalMicros / input.results.length,
      reason: costMeasured ? null : "candidate_cost_evidence_unavailable",
      status: costMeasured ? "measured" as const : "unavailable" as const,
      totalMicros
    }),
    egress: Object.freeze({
      disclosedInputBytes: external ? processedInputBytes : 0,
      inputTokens: tokens.every((value) => value !== null)
        ? tokens.reduce((sum, value) => sum + value!, 0)
        : null,
      mode: input.candidate.executor.identity.egress,
      privateDataHandling: "synthetic_corpus_only" as const,
      processedInputBytes,
      retention: external ? "provider_policy" as const : "none" as const
    }),
    gpu: executionResources.gpu,
    outage: Object.freeze({
      fallbackCandidateId: "current_structural_fence_v4" as const,
      fallbackReplay: input.candidate.kind === "structural"
        ? "not_applicable" as const
        : input.fallbackVerified ? "verified" as const : "unavailable" as const,
      semanticDecisionOnOutage: "not_evaluated" as const,
      structuralFenceRemainsActive: true as const,
      technicalLeakageObserved: false as const
    }),
    recovery: Object.freeze({
      benchmarkEvidence: external ? "contract_only" as const : "pure_replay_verified" as const,
      complexity: external ? "checkpoint_required" as const : "pure_recompute" as const,
      externalDispatchMayRepeatAutomatically: false as const
    }),
    rss: executionResources.rss
  });
}

function failedOperationalEvidence(
  candidate: Extract<KnowledgeSemanticCandidate, { availability: "available" }>,
  processedInputBytes: number,
  fallbackVerified: boolean
): CandidateOperationalEvidence {
  const external = candidate.executor.identity.egress === "external";
  return Object.freeze({
    cost: Object.freeze({
      microsPerClaim: null,
      reason: "candidate_execution_failed",
      status: "unavailable" as const,
      totalMicros: null
    }),
    egress: Object.freeze({
      disclosedInputBytes: external ? processedInputBytes : 0,
      inputTokens: null,
      mode: candidate.executor.identity.egress,
      privateDataHandling: "synthetic_corpus_only" as const,
      processedInputBytes,
      retention: external ? "provider_policy" as const : "none" as const
    }),
    gpu: unavailable("candidate_execution_failed"),
    outage: Object.freeze({
      fallbackCandidateId: "current_structural_fence_v4" as const,
      fallbackReplay: candidate.kind === "structural"
        ? "not_applicable" as const
        : fallbackVerified ? "verified" as const : "unavailable" as const,
      semanticDecisionOnOutage: "not_evaluated" as const,
      structuralFenceRemainsActive: true as const,
      technicalLeakageObserved: false as const
    }),
    recovery: Object.freeze({
      benchmarkEvidence: external ? "contract_only" as const : "pure_replay_verified" as const,
      complexity: external ? "checkpoint_required" as const : "pure_recompute" as const,
      externalDispatchMayRepeatAutomatically: false as const
    }),
    rss: unavailable("candidate_execution_failed")
  });
}

function rawPredictionsFromFrozen(
  pool: KnowledgeSemanticCandidatePool,
  frozenPrediction: Extract<KnowledgeSemanticFinalPredictionFreezeCandidate, {
    executionStatus: "complete";
  }>
): readonly RawPrediction[] {
  const entries = pool.entries.filter((entry) => entry.split !== "calibration");
  if (frozenPrediction.outputs.length !== entries.length) {
    throw new Error("knowledge_semantic_final_prediction_freeze_output_mismatch");
  }
  return Object.freeze(frozenPrediction.outputs.map((output, index) => {
    const entry = entries[index];
    if (!entry) throw new Error("knowledge_semantic_final_prediction_freeze_output_mismatch");
    return Object.freeze({
      entry,
      milliseconds: output.latencyMicroseconds / 1_000,
      result: Object.freeze({
        attributableHandles: Object.freeze([...output.attributableHandles]),
        costMicros: output.usage.costMicros,
        decisionScores: Object.freeze({ ...output.decisionScores }),
        inputTokens: output.usage.inputTokens,
        reasonFamily: output.reasonFamily,
        resourceUsage: output.resourceUsage,
        usage: Object.freeze({ ...output.usage })
      })
    });
  }));
}

async function executeCandidate(input: Readonly<{
  calibration?: KnowledgeSemanticCalibrationMetrics;
  candidate: Extract<KnowledgeSemanticCandidate, { availability: "available" }>;
  fallbackVerified: boolean;
  frozenPrediction?: Extract<KnowledgeSemanticFinalPredictionFreezeCandidate, {
    executionStatus: "complete";
  }>;
  humanProvenanceGatePassed: boolean;
  labels?: ReadonlyMap<string, BoundLabel>;
  pool: KnowledgeSemanticCandidatePool;
}>): Promise<CompleteCandidateReport | FailedCandidateReport> {
  const predictions: RawPrediction[] = input.frozenPrediction
    ? [...rawPredictionsFromFrozen(input.pool, input.frozenPrediction)]
    : [];
  let processedInputBytes = 0;
  try {
    if (input.frozenPrediction) {
      for (const prediction of predictions) processedInputBytes += inputBytes(prediction.entry);
    } else {
    for (const entry of input.pool.entries.filter((candidate) =>
      !input.labels || candidate.split !== "calibration")) {
      processedInputBytes += inputBytes(entry);
      const started = performance.now();
      const rawResult = await input.candidate.executor.validate(entry.input);
      const milliseconds = performance.now() - started;
      assertKnowledgeSemanticCandidateResult(entry.input, rawResult);
      const result = deterministicArithmeticResult(entry, rawResult);
      predictions.push(Object.freeze({ entry, milliseconds, result }));
    }
    }
  } catch {
    return Object.freeze({
      ...failedOperationalEvidence(input.candidate, processedInputBytes, input.fallbackVerified),
      executionStatus: "failed" as const,
      failureCode: "candidate_execution_failed" as const,
      identity: identity(input.candidate),
      performance: unavailable("candidate_execution_failed"),
      quality: unavailable("candidate_execution_failed")
    });
  }
  const milliseconds = predictions.map((entry) => entry.milliseconds);
  const elapsed = milliseconds.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    ...operationalEvidence({
      candidate: input.candidate,
      entries: predictions.map((prediction) => prediction.entry),
      fallbackVerified: input.fallbackVerified,
      results: predictions.map((entry) => entry.result)
    }),
    executionStatus: "complete" as const,
    identity: identity(input.candidate),
    performance: Object.freeze({
      coldFirstClaimMilliseconds: milliseconds[0] ?? 0,
      concurrency: 1 as const,
      measuredClaims: predictions.length,
      p50Milliseconds: percentile(milliseconds, 0.5),
      p95Milliseconds: percentile(milliseconds, 0.95),
      status: "measured" as const,
      throughputClaimsPerSecond: elapsed > 0 ? predictions.length / (elapsed / 1_000) : 0
    }),
    quality: input.labels && input.calibration
      ? measuredQuality({
          calibration: input.calibration,
          humanProvenanceGatePassed: input.humanProvenanceGatePassed,
          labels: input.labels,
          predictions
        })
      : unavailable(input.labels
          ? "calibration_freeze_not_supplied"
          : "independent_semantic_labels_not_imported")
  });
}

function unavailableCandidateReport(
  candidate: Extract<KnowledgeSemanticCandidate, { availability: "unavailable" }>
): UnavailableCandidateReport {
  const external = candidate.egress === "external";
  return Object.freeze({
    cost: unavailable(candidate.reason),
    egress: Object.freeze({
      disclosedInputBytes: 0 as const,
      inputTokens: null,
      mode: candidate.egress,
      privateDataHandling: "synthetic_corpus_only" as const,
      processedInputBytes: 0 as const,
      retention: external ? "provider_policy" as const : "none" as const
    }),
    executionStatus: "unavailable" as const,
    gpu: unavailable("candidate_not_executed"),
    identity: Object.freeze({ id: candidate.id, kind: candidate.kind }),
    outage: Object.freeze({
      fallbackCandidateId: "current_structural_fence_v4" as const,
      fallbackReplay: "unavailable" as const,
      semanticDecisionOnOutage: "not_evaluated" as const,
      structuralFenceRemainsActive: true as const,
      technicalLeakageObserved: false as const
    }),
    performance: unavailable(candidate.reason),
    quality: unavailable("independent_semantic_labels_not_imported"),
    reason: candidate.reason,
    recovery: Object.freeze({
      benchmarkEvidence: "contract_only" as const,
      complexity: external ? "checkpoint_required" as const : "pure_recompute" as const,
      externalDispatchMayRepeatAutomatically: false as const
    }),
    rss: unavailable("candidate_not_executed")
  });
}

function selection(input: Readonly<{
  arithmeticAuditPassed: boolean;
  releaseCorpusGateEligible: boolean;
  blindedReviewSplitAvailable: boolean;
  candidateSetFrozen: boolean;
  developmentSplitAvailable: boolean;
  humanTrust: KnowledgeSemanticHumanTrustVerificationReport;
  labels?: KnowledgeSemanticGroundingImportedReviewEvidence;
  reports: readonly KnowledgeSemanticCandidateSelectionReport[];
  thresholdContractFrozen: boolean;
}>): KnowledgeSemanticCandidateBenchmarkReport["selection"] {
  const reasons: string[] = [];
  if (!input.labels) {
    reasons.push("independent_semantic_labels_not_collected", "adjudication_not_completed");
  } else if (!input.humanTrust.humanProvenanceGatePassed) {
    reasons.push("human_provenance_not_verified");
  }
  if (!input.developmentSplitAvailable) reasons.push("development_split_unavailable");
  if (!input.blindedReviewSplitAvailable) reasons.push("independent_blinded_split_unavailable");
  if (!input.candidateSetFrozen) reasons.push("candidate_set_not_frozen");
  if (!input.thresholdContractFrozen) reasons.push("threshold_contract_not_frozen");
  if (!input.releaseCorpusGateEligible) {
    reasons.push("release_sample_sufficiency_not_met");
  }
  if (!input.arithmeticAuditPassed) {
    reasons.push("deterministic_arithmetic_receipt_gate_failed");
  }
  const ranked = input.reports.filter((report): report is Extract<
    KnowledgeSemanticCandidateSelectionReport,
    Readonly<{ executionStatus: "complete" }>
  > =>
    report.executionStatus === "complete" && report.identity.kind !== "structural" &&
    report.identity.executionClass === "real_model" &&
    report.quality.status === "measured_from_imported_human_labels" &&
    report.quality.heldOutGatesPassed && report.cost.status === "measured" &&
    report.outage.fallbackReplay === "verified");
  if (input.labels && ranked.length === 0) {
    reasons.push("no_candidate_passed_held_out_quality_gates");
  }
  const selected = [...ranked].sort((left, right) => {
    const qualityDelta = right.quality.status === "measured_from_imported_human_labels" &&
      left.quality.status === "measured_from_imported_human_labels"
      ? right.quality.selection.groundedAccuracy - left.quality.selection.groundedAccuracy
      : 0;
    return qualityDelta || left.performance.p95Milliseconds - right.performance.p95Milliseconds ||
      left.identity.id.localeCompare(right.identity.id);
  })[0];
  if (selected?.quality.status === "measured_from_imported_human_labels") {
    if (!selected.quality.blindedReviewQualityGatesPassed) {
      reasons.push("selected_candidate_blinded_review_quality_gate_failed");
    }
    if (!selected.quality.blindedReviewAcceptancePassed || !selected.quality.gatesPassed) {
      reasons.push("selected_candidate_blinded_review_not_accepted");
    }
    if (selected.identity.authorization !== "profile_authorized") {
      reasons.push("selected_candidate_not_runtime_authorized");
    }
  }
  return Object.freeze({
    reasonCodes: Object.freeze([...new Set(reasons)]),
    selectedCandidateId: selected?.identity.id ?? null,
    selectionEligible: Boolean(selected) && reasons.length === 0
  });
}

export type KnowledgeSemanticCandidateHumanTrustInput = Readonly<{
  anchorSet?: unknown;
  evaluatedAt?: unknown;
  evidence?: unknown;
  pinnedAnchorSetSha256?: unknown;
}>;

type KnowledgeSemanticHumanTrustReviewBindings = Pick<
  KnowledgeSemanticGroundingImportedReviewEvidence,
  "adjudicationSha256" | "corpusSha256" | "mappingSha256" | "packetSha256" |
  "poolSha256" | "reviewerSubmissionSha256s"
>;

export function verifyKnowledgeSemanticCandidateHumanTrust(input: Readonly<{
  calibrationFreezeManifestSha256?: string;
  candidateFreezeManifestSha256?: string;
  humanTrust?: KnowledgeSemanticCandidateHumanTrustInput;
  labels?: KnowledgeSemanticHumanTrustReviewBindings;
  predictionArtifactSha256?: string;
}>): KnowledgeSemanticHumanTrustVerificationReport {
  const expectedArtifacts = input.labels && input.calibrationFreezeManifestSha256 &&
      input.candidateFreezeManifestSha256 && input.predictionArtifactSha256
    ? {
        adjudicationSha256: input.labels.adjudicationSha256,
        calibrationFreezeManifestSha256: input.calibrationFreezeManifestSha256,
        candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
        corpusSha256: input.labels.corpusSha256,
        packetSha256: input.labels.packetSha256,
        poolSha256: input.labels.poolSha256,
        predictionArtifactSha256: input.predictionArtifactSha256,
        reviewMappingSha256: input.labels.mappingSha256,
        reviewerSubmissionSha256s: input.labels.reviewerSubmissionSha256s
      }
    : undefined;
  return verifyKnowledgeSemanticHumanTrust({
    ...(input.humanTrust ? {
      anchorSet: input.humanTrust.anchorSet,
      evaluatedAt: input.humanTrust.evaluatedAt,
      evidence: input.humanTrust.evidence,
      pinnedAnchorSetSha256: input.humanTrust.pinnedAnchorSetSha256
    } : {}),
    ...(expectedArtifacts ? { expectedArtifacts } : {})
  });
}

function frozenSelectionIdentity(
  binding: KnowledgeSemanticCandidateIdentityBinding
): CandidateIdentity {
  if (binding.availability !== "available") {
    throw new Error("knowledge_semantic_frozen_selection_identity_unavailable");
  }
  return Object.freeze({
    ...binding.executor,
    id: binding.id,
    kind: binding.kind,
    validatorVersion: binding.executor.version
  });
}

function selectionCandidateFromFrozen(input: Readonly<{
  calibration: KnowledgeSemanticCalibrationFreezeCandidate;
  candidate: KnowledgeSemanticFinalPredictionFreezeCandidate;
  fallbackReplayVerified: boolean;
  humanTrust: KnowledgeSemanticHumanTrustVerificationReport;
  labels: ReadonlyMap<string, BoundLabel>;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticCandidateSelectionReport {
  const { candidate } = input;
  if (candidate.executionStatus !== "complete") {
    return Object.freeze({
      executionStatus: candidate.executionStatus,
      identity: Object.freeze({
        id: candidate.candidateId,
        kind: candidate.candidateIdentity.kind
      })
    });
  }
  if (input.calibration.executionStatus !== "complete" ||
    candidate.candidateIdentity.availability !== "available") {
    throw new Error("knowledge_semantic_frozen_selection_calibration_missing");
  }
  const identity = frozenSelectionIdentity(candidate.candidateIdentity);
  const predictions = rawPredictionsFromFrozen(input.pool, candidate);
  return Object.freeze({
    cost: Object.freeze({
      status: candidate.outputs.every((output) => output.usage.costMicros !== null)
        ? "measured" as const
        : "unavailable" as const
    }),
    executionStatus: "complete" as const,
    identity: Object.freeze({
      authorization: identity.authorization,
      executionClass: identity.executionClass,
      id: identity.id,
      kind: identity.kind
    }),
    outage: Object.freeze({
      fallbackReplay: identity.kind === "structural"
        ? "not_applicable" as const
        : input.fallbackReplayVerified
          ? "verified" as const
          : "unavailable" as const
    }),
    performance: Object.freeze({
      p95Milliseconds: percentile(
        predictions.map(({ milliseconds }) => milliseconds),
        0.95
      )
    }),
    quality: measuredQuality({
      calibration: input.calibration.calibration,
      humanProvenanceGatePassed: input.humanTrust.humanProvenanceGatePassed,
      labels: input.labels,
      predictions
    })
  });
}

function benchmarkCorpusEvidence(input: Readonly<{
  arithmetic: KnowledgeSemanticArithmeticBindingAudit;
  pool: KnowledgeSemanticCandidatePool;
  releaseEvidence: KnowledgeSemanticGroundingReleaseCorpusAudit;
}>): KnowledgeSemanticCandidateBenchmarkReport["corpus"] {
  const fixtureIds = new Set(input.pool.entries.map((entry) => entry.fixtureId));
  return Object.freeze({
    arithmetic: input.arithmetic,
    blindedReviewClaims: input.pool.entries.filter((entry) =>
      entry.split === "blinded_review").length,
    blindedReviewSplitAvailable: input.pool.entries.some((entry) =>
      entry.split === "blinded_review"),
    calibrationClaims: input.pool.entries.filter((entry) =>
      entry.split === "calibration").length,
    corpusSha256: input.pool.corpusSha256,
    developmentClaims: input.pool.entries.filter((entry) =>
      entry.split === "development").length,
    familyLeakage: !input.releaseEvidence.splitIntegrity.exactDocumentFamilySplitDisjoint ||
      !input.releaseEvidence.splitIntegrity.normalizedTemplateFamilySplitDisjoint,
    fixtureCount: fixtureIds.size,
    heldOutClaims: input.pool.entries.filter((entry) => entry.split === "held_out").length,
    labelsExcludedFromCandidateInput: true as const,
    languages: Object.freeze(["en", "ru"] as const),
    poolSha256: input.pool.poolSha256,
    releaseEvidence: input.releaseEvidence,
    samePoolForEveryCandidate: true as const,
    version: input.pool.corpusVersion
  });
}

function frozenSelectionContractValid(input: Readonly<{
  arithmetic: KnowledgeSemanticArithmeticBindingAudit;
  candidates: readonly KnowledgeSemanticCandidateSelectionReport[];
  finalPredictionFreeze: KnowledgeSemanticFinalPredictionFreezeManifest;
  pool: KnowledgeSemanticCandidatePool;
}>): boolean {
  const familySplits = new Map<string, Set<string>>();
  for (const entry of input.pool.entries) {
    const splits = familySplits.get(entry.documentFamily) ?? new Set<string>();
    splits.add(entry.split);
    familySplits.set(entry.documentFamily, splits);
  }
  return input.pool.labelsExcludedFromPool && input.pool.samePoolForEveryCandidate &&
    input.arithmetic.passed && input.candidates.length === 4 &&
    input.finalPredictionFreeze.fallbackReplayVerified &&
    ![...familySplits.values()].some((splits) => splits.size !== 1) &&
    input.candidates.some((candidate) => candidate.executionStatus === "complete" &&
      candidate.identity.id === "current_structural_fence_v4");
}

/** Recomputes every field that can influence candidate selection from the
 * frozen prediction chain and adjudicated labels. No executor is accepted or
 * invoked by this path. */
export function deriveKnowledgeSemanticFrozenSelectionEvidence(input: Readonly<{
  calibrationFreeze: unknown;
  candidateFreeze: unknown;
  finalPredictionFreeze: unknown;
  humanTrust: KnowledgeSemanticHumanTrustVerificationReport;
  labels: KnowledgeSemanticGroundingImportedReviewEvidence;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticFrozenSelectionEvidence {
  const chain = assertKnowledgeSemanticFinalArtifactFreezeChain({
    calibrationFreeze: input.calibrationFreeze,
    candidateFreeze: input.candidateFreeze,
    finalPredictionFreeze: input.finalPredictionFreeze,
    pool: input.pool
  });
  if (input.labels.reviewScope !== "final" ||
    input.labels.evaluationBindings.candidateFreezeManifestSha256 !==
      chain.candidateFreeze.manifestSha256 ||
    input.labels.evaluationBindings.calibrationFreezeManifestSha256 !==
      chain.calibrationFreeze.manifestSha256 ||
    input.labels.evaluationBindings.finalPredictionFreezeManifestSha256 !==
      chain.finalPredictionFreeze.manifestSha256) {
    throw new Error("knowledge_semantic_final_review_binding_invalid");
  }
  const labels = bindLabels(input.pool, input.labels, "final");
  const arithmetic = arithmeticAudit(input.pool);
  const releaseEvidence = auditKnowledgeSemanticGroundingReleaseCorpus();
  const candidates = Object.freeze(chain.finalPredictionFreeze.candidates.map(
    (candidate, index) => {
      const calibration = chain.calibrationFreeze.candidates[index];
      if (!calibration) {
        throw new Error("knowledge_semantic_frozen_selection_calibration_missing");
      }
      return selectionCandidateFromFrozen({
        calibration,
        candidate,
        fallbackReplayVerified: chain.finalPredictionFreeze.fallbackReplayVerified,
        humanTrust: input.humanTrust,
        labels,
        pool: input.pool
      });
    }
  ));
  const selectionResult = selection({
    arithmeticAuditPassed: arithmetic.passed,
    blindedReviewSplitAvailable: input.pool.entries.some((entry) =>
      entry.split === "blinded_review"),
    candidateSetFrozen: true,
    developmentSplitAvailable: input.pool.entries.some((entry) =>
      entry.split === "development"),
    humanTrust: input.humanTrust,
    labels: input.labels,
    releaseCorpusGateEligible: releaseEvidence.releaseGateEligible,
    reports: candidates,
    thresholdContractFrozen: true
  });
  const selected = candidates.find((candidate) => candidate.executionStatus === "complete" &&
    candidate.identity.id === selectionResult.selectedCandidateId);
  const blindedReleaseEvidenceEligible = Boolean(
    input.humanTrust.humanProvenanceGatePassed && releaseEvidence.releaseGateEligible &&
    selected?.executionStatus === "complete" &&
    selected.quality.status === "measured_from_imported_human_labels" &&
    selected.quality.blindedReviewAcceptancePassed
  );
  const contractValid = frozenSelectionContractValid({
    arithmetic,
    candidates,
    finalPredictionFreeze: chain.finalPredictionFreeze,
    pool: input.pool
  });
  return Object.freeze({
    blindedExecution: Object.freeze({
      finalPredictionsFrozenBeforeBlindLabels: true,
      reason: "final_predictions_frozen_without_labels" as const,
      releaseEvidenceEligible: blindedReleaseEvidenceEligible
    }),
    blindedReleaseEvidenceEligible,
    candidateSet: Object.freeze({
      ...chain.candidateFreeze.candidateSet,
      frozen: true,
      thresholdContractFrozen: true
    }),
    candidates,
    contractValid,
    corpus: benchmarkCorpusEvidence({ arithmetic, pool: input.pool, releaseEvidence }),
    humanReview: Object.freeze({
      adjudicationComplete: input.labels.adjudicationComplete,
      disagreement: input.labels.disagreement,
      independentAnnotatorCount: input.labels.independentAnnotatorCount,
      labelsStatus: "imported" as const,
      provenanceVerification: input.humanTrust.provenanceVerification,
      reasonCodes: input.humanTrust.reasonCodes,
      trust: input.humanTrust,
      unresolvedMaterialDisagreements: input.labels.unresolvedMaterialDisagreements
    }),
    selection: selectionResult,
    semanticProof: selectionResult.selectionEligible
  });
}

function selectionCandidateFromReport(
  report: KnowledgeSemanticCandidateBenchmarkCandidateReport
): KnowledgeSemanticCandidateSelectionReport {
  if (report.executionStatus !== "complete") {
    return Object.freeze({
      executionStatus: report.executionStatus,
      identity: Object.freeze({ id: report.identity.id, kind: report.identity.kind })
    });
  }
  return Object.freeze({
    cost: Object.freeze({ status: report.cost.status }),
    executionStatus: "complete" as const,
    identity: Object.freeze({
      authorization: report.identity.authorization,
      executionClass: report.identity.executionClass,
      id: report.identity.id,
      kind: report.identity.kind
    }),
    outage: Object.freeze({ fallbackReplay: report.outage.fallbackReplay }),
    performance: Object.freeze({ p95Milliseconds: report.performance.p95Milliseconds }),
    quality: report.quality
  });
}

/** Rejects a digest-valid report whose green fields were authored rather than
 * derived from its exact frozen outputs and labels. */
export function assertKnowledgeSemanticCandidateBenchmarkSelectionEvidence(
  input: Readonly<{
    calibrationFreeze: unknown;
    candidateFreeze: unknown;
    finalPredictionFreeze: unknown;
    humanTrust: KnowledgeSemanticHumanTrustVerificationReport;
    labels: KnowledgeSemanticGroundingImportedReviewEvidence;
    pool: KnowledgeSemanticCandidatePool;
    report: KnowledgeSemanticCandidateBenchmarkReport;
  }>
): KnowledgeSemanticFrozenSelectionEvidence {
  const derived = deriveKnowledgeSemanticFrozenSelectionEvidence(input);
  const reportCandidates = input.report.candidates.map(selectionCandidateFromReport);
  if (input.report.aggregateOnly !== true || input.report.blockingEligible !== false ||
    input.report.releaseGatePassed !== false ||
    input.report.version !== KNOWLEDGE_SEMANTIC_CANDIDATE_BENCHMARK_VERSION ||
    !sameCanonical(input.report.blindedExecution, derived.blindedExecution) ||
    !sameCanonical(input.report.candidateSet, derived.candidateSet) ||
    !sameCanonical(reportCandidates, derived.candidates) ||
    input.report.contractValid !== derived.contractValid ||
    !sameCanonical(input.report.corpus, derived.corpus) ||
    !sameCanonical(input.report.humanReview, derived.humanReview) ||
    !sameCanonical(input.report.selection, derived.selection) ||
    input.report.semanticProof !== derived.semanticProof) {
    throw new Error("knowledge_semantic_candidate_benchmark_selection_evidence_mismatch");
  }
  return derived;
}

export async function runKnowledgeSemanticCandidateBenchmark(input: Readonly<{
  calibrationFreeze?: unknown;
  candidateFreezeManifest?: unknown;
  candidateFreezeManifestSha256?: string;
  finalPredictionFreeze?: unknown;
  frozenCandidateSetDigest?: string;
  frozenThresholdScheduleSha256?: string;
  humanTrust?: KnowledgeSemanticCandidateHumanTrustInput;
  labels?: KnowledgeSemanticGroundingImportedReviewEvidence;
  local?: KnowledgeSemanticCandidateExecutor;
  localUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
  systemModel?: KnowledgeSemanticCandidateExecutor;
  systemUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
}> = {}): Promise<KnowledgeSemanticCandidateBenchmarkReport> {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const arithmetic = arithmeticAudit(pool);
  const boundLabels = input.labels ? bindLabels(pool, input.labels, "final") : undefined;
  const candidates = createKnowledgeSemanticGroundingCandidates({
    ...(input.local ? { local: input.local } : {}),
    ...(input.localUnavailableReason ? { localUnavailableReason: input.localUnavailableReason } : {}),
    ...(input.systemModel ? { systemModel: input.systemModel } : {}),
    ...(input.systemUnavailableReason
      ? { systemUnavailableReason: input.systemUnavailableReason }
      : {})
  });
  const candidateSet = createKnowledgeSemanticCandidateSetBinding({
    candidates,
    corpusSha256: pool.corpusSha256,
    poolSha256: pool.poolSha256
  });
  const candidateSetFrozen = input.frozenCandidateSetDigest === candidateSet.digest;
  const thresholdScheduleFrozen =
    input.frozenThresholdScheduleSha256 === candidateSet.thresholdScheduleSha256;
  const calibrationFreezeArtifact = input.calibrationFreeze && input.candidateFreezeManifestSha256
    ? assertKnowledgeSemanticCalibrationFreezeArtifact({
        candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
        candidates,
        manifest: input.calibrationFreeze,
        pool
      })
    : undefined;
  const calibrationFreeze = calibrationFreezeArtifact;
  const finalPredictionFreeze = input.finalPredictionFreeze && input.candidateFreezeManifest &&
      input.candidateFreezeManifestSha256 && input.calibrationFreeze
    ? assertKnowledgeSemanticFinalPredictionFreeze({
        calibrationFreeze: input.calibrationFreeze,
        candidateFreezeManifest: input.candidateFreezeManifest,
        candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
        candidates,
        manifest: input.finalPredictionFreeze,
        pool
      })
    : undefined;
  if (input.labels && (!finalPredictionFreeze || !calibrationFreezeArtifact ||
    !input.candidateFreezeManifestSha256 || input.labels.reviewScope !== "final" ||
    input.labels.evaluationBindings.candidateFreezeManifestSha256 !==
      input.candidateFreezeManifestSha256 ||
    input.labels.evaluationBindings.calibrationFreezeManifestSha256 !==
      calibrationFreezeArtifact.manifestSha256 ||
    input.labels.evaluationBindings.finalPredictionFreezeManifestSha256 !==
      finalPredictionFreeze.manifestSha256)) {
    throw new Error("knowledge_semantic_final_review_binding_invalid");
  }
  if (boundLabels && calibrationFreeze && !finalPredictionFreeze) {
    throw new Error("knowledge_semantic_final_prediction_freeze_required");
  }
  const thresholdContractFrozen = thresholdScheduleFrozen && calibrationFreezeArtifact !== undefined;
  const calibrationByCandidate = new Map(calibrationFreeze?.candidates
    .filter((candidate): candidate is Extract<KnowledgeSemanticCalibrationFreezeCandidate, {
      executionStatus: "complete";
    }> => candidate.executionStatus === "complete")
    .map((candidate) => [candidate.candidateId, candidate.calibration] as const) ?? []);
  const developmentSplitAvailable = pool.entries.some((entry) => entry.split === "development");
  const blindedReviewSplitAvailable = pool.entries.some((entry) =>
    entry.split === "blinded_review");
  const releaseEvidence = auditKnowledgeSemanticGroundingReleaseCorpus();
  // A label-bearing scoring process must be read-only with respect to every
  // candidate executor, including the structural fallback.  The label-free
  // prediction artifact already seals the deterministic replay result.
  const fallbackVerified = finalPredictionFreeze?.fallbackReplayVerified ??
    await fallbackReplay(pool);
  const humanTrust = verifyKnowledgeSemanticCandidateHumanTrust({
    ...(finalPredictionFreeze ? {
      calibrationFreezeManifestSha256:
        finalPredictionFreeze.calibrationFreezeManifestSha256,
      candidateFreezeManifestSha256: finalPredictionFreeze.candidateFreezeManifestSha256,
      predictionArtifactSha256: finalPredictionFreeze.manifestSha256
    } : {}),
    ...(input.humanTrust ? { humanTrust: input.humanTrust } : {}),
    ...(input.labels ? { labels: input.labels } : {})
  });
  const reports: KnowledgeSemanticCandidateBenchmarkCandidateReport[] = [];
  for (const candidate of candidates) {
    const frozenCandidate = finalPredictionFreeze?.candidates.find((entry) =>
      entry.candidateId === candidate.id);
    reports.push(candidate.availability === "available"
      ? frozenCandidate?.executionStatus === "failed"
        ? Object.freeze({
            ...failedOperationalEvidence(candidate, 0, fallbackVerified),
            executionStatus: "failed" as const,
            failureCode: "candidate_execution_failed" as const,
            identity: identity(candidate),
            performance: unavailable(frozenCandidate.reason),
            quality: unavailable(frozenCandidate.reason)
          })
        : await executeCandidate({
          ...(calibrationByCandidate.has(candidate.id)
            ? { calibration: calibrationByCandidate.get(candidate.id)! }
            : {}),
          candidate,
          fallbackVerified,
          humanProvenanceGatePassed: humanTrust.humanProvenanceGatePassed,
          ...(frozenCandidate?.executionStatus === "complete"
            ? { frozenPrediction: frozenCandidate }
            : {}),
          ...(boundLabels ? { labels: boundLabels } : {}),
          pool
        })
      : unavailableCandidateReport(candidate));
  }
  const selectionResult = selection({
    arithmeticAuditPassed: arithmetic.passed,
    releaseCorpusGateEligible: releaseEvidence.releaseGateEligible,
    blindedReviewSplitAvailable,
    candidateSetFrozen,
    developmentSplitAvailable,
    humanTrust,
    ...(input.labels ? { labels: input.labels } : {}),
    reports,
    thresholdContractFrozen
  });
  const fixtureIds = new Set(pool.entries.map((entry) => entry.fixtureId));
  const familySplits = new Map<string, Set<string>>();
  for (const entry of pool.entries) {
    const splits = familySplits.get(entry.documentFamily) ?? new Set();
    splits.add(entry.split);
    familySplits.set(entry.documentFamily, splits);
  }
  const contractValid = pool.labelsExcludedFromPool && pool.samePoolForEveryCandidate &&
    arithmetic.passed && candidates.length === 4 && reports.length === 4 && fallbackVerified &&
    ![...familySplits.values()].some((splits) => splits.size !== 1) &&
    reports.some((report) => report.executionStatus === "complete" &&
      report.identity.id === "current_structural_fence_v4");
  const selectedReport = reports.find((report) =>
    report.executionStatus === "complete" &&
    report.identity.id === selectionResult.selectedCandidateId);
  const blindedReleaseEvidenceEligible = Boolean(finalPredictionFreeze && input.labels &&
    humanTrust.humanProvenanceGatePassed && releaseEvidence.releaseGateEligible &&
    selectedReport?.quality.status === "measured_from_imported_human_labels" &&
    selectedReport.quality.blindedReviewAcceptancePassed);
  return Object.freeze({
    aggregateOnly: true as const,
    blindedExecution: Object.freeze({
      finalPredictionsFrozenBeforeBlindLabels: finalPredictionFreeze !== undefined,
      reason: finalPredictionFreeze
        ? "final_predictions_frozen_without_labels" as const
        : input.labels
          ? "final_predictions_executed_after_review_import" as const
          : "final_prediction_freeze_missing" as const,
      releaseEvidenceEligible: blindedReleaseEvidenceEligible
    }),
    blockingEligible: false as const,
    candidateSet: Object.freeze({
      ...candidateSet,
      frozen: candidateSetFrozen,
      thresholdContractFrozen
    }),
    candidates: Object.freeze(reports),
    contractValid,
    corpus: Object.freeze({
      arithmetic,
      blindedReviewClaims: pool.entries.filter((entry) => entry.split === "blinded_review").length,
      blindedReviewSplitAvailable,
      calibrationClaims: pool.entries.filter((entry) => entry.split === "calibration").length,
      corpusSha256: pool.corpusSha256,
      developmentClaims: pool.entries.filter((entry) => entry.split === "development").length,
      familyLeakage: !releaseEvidence.splitIntegrity.exactDocumentFamilySplitDisjoint ||
        !releaseEvidence.splitIntegrity.normalizedTemplateFamilySplitDisjoint,
      fixtureCount: fixtureIds.size,
      heldOutClaims: pool.entries.filter((entry) => entry.split === "held_out").length,
      labelsExcludedFromCandidateInput: true as const,
      languages: Object.freeze(["en", "ru"] as const),
      poolSha256: pool.poolSha256,
      releaseEvidence,
      samePoolForEveryCandidate: true as const,
      version: pool.corpusVersion
    }),
    humanReview: Object.freeze({
      adjudicationComplete: input.labels?.adjudicationComplete ?? false,
      disagreement: input.labels?.disagreement ??
        unavailable("independent_semantic_labels_not_imported"),
      independentAnnotatorCount: input.labels?.independentAnnotatorCount ?? 0,
      labelsStatus: input.labels ? "imported" as const : "not_imported" as const,
      provenanceVerification: input.labels
        ? humanTrust.provenanceVerification
        : "not_imported" as const,
      reasonCodes: input.labels
        ? humanTrust.reasonCodes
        : Object.freeze([
            "independent_semantic_labels_not_collected",
            "adjudication_not_completed",
            "human_provenance_not_imported"
          ]),
      trust: humanTrust,
      unresolvedMaterialDisagreements: input.labels?.unresolvedMaterialDisagreements ?? null
    }),
    releaseGatePassed: false as const,
    selection: selectionResult,
    semanticProof: selectionResult.selectionEligible,
    version: KNOWLEDGE_SEMANTIC_CANDIDATE_BENCHMARK_VERSION
  });
}

export async function assertKnowledgeSemanticCandidateBenchmarkContract():
Promise<KnowledgeSemanticCandidateBenchmarkReport> {
  const report = await runKnowledgeSemanticCandidateBenchmark();
  if (!report.contractValid || report.semanticProof || report.blockingEligible ||
    report.releaseGatePassed || report.selection.selectionEligible) {
    throw new Error("knowledge_semantic_candidate_benchmark_contract_failed");
  }
  return report;
}
