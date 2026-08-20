import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { groundKnowledgeAnswer } from "../../lib/server/knowledge/grounding";
import {
  knowledgeSemanticGroundingDecisions,
  segmentKnowledgeSemanticClaims,
  type KnowledgeSemanticGroundingDecision,
  type KnowledgeSemanticReasonFamily
} from "../../lib/server/knowledge/semanticGrounding";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage
} from "../../lib/server/knowledge/evidencePackage";
import {
  knowledgeSemanticGroundingMandatorySliceMinimums,
  knowledgeSemanticGroundingQualityGates,
  knowledgeSemanticGroundingReleaseSampleMinimums
} from "./semanticGrounding";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION,
  knowledgeSemanticGroundingReleaseMetricGates,
  knowledgeSemanticGroundingReleaseMetricSampleMinimums
} from "./semanticGroundingReleaseMetrics";
import {
  createKnowledgeSemanticArithmeticBinding,
  type KnowledgeSemanticArithmeticBinding
} from "./semanticGroundingArithmeticBinding";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
  knowledgeSemanticGroundingFixtures,
  type KnowledgeSemanticGroundingLanguage,
  type KnowledgeSemanticGroundingSlice,
  type KnowledgeSemanticGroundingSplit
} from "./semanticGroundingFixtures";

export const KNOWLEDGE_SEMANTIC_CANDIDATE_POOL_VERSION =
  "knowledge-semantic-candidate-pool-v1" as const;
export const KNOWLEDGE_SEMANTIC_CANDIDATE_SET_VERSION =
  "knowledge-semantic-candidates-v1" as const;
export const KNOWLEDGE_SEMANTIC_CANDIDATE_FREEZE_VERSION =
  "knowledge-semantic-candidate-freeze-v1" as const;
export const KNOWLEDGE_SEMANTIC_EVALUATION_CONTRACT_VERSION =
  "knowledge-semantic-evaluation-contract-v2" as const;
export const KNOWLEDGE_SEMANTIC_EXECUTOR_CONTRACT_VERSION =
  "knowledge-semantic-executor-contract-v1" as const;

/** The threshold schedule is part of the candidate contract, rather than a
 * mutable implementation detail of one benchmark invocation. */
export const KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION =
  "knowledge-semantic-threshold-v1" as const;
export const KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS = Object.freeze(
  [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
) as readonly number[];

/** Canonical, content-free descriptions of the candidate boundary. Source
 * digests below bind these declarations to the executable implementation. */
export const knowledgeSemanticCandidateInputContract = Object.freeze({
  citationHandles: "unique_strings_from_supplied_neighborhood",
  context: "ordered_claim_context_strings",
  evaluatorMetadataExcluded: Object.freeze([
    "arithmetic",
    "claimOrdinal",
    "claimSha256",
    "contentHash",
    "documentFamily",
    "evidencePackage",
    "fixtureId",
    "neighborhoodSha256",
    "ordinal",
    "split"
  ]),
  evidence: Object.freeze({
    fields: Object.freeze(["ambiguous", "handle", "locatorState", "state", "text"]),
    locatorStates: Object.freeze(["deleted", "invalid", "missing", "valid"]),
    states: Object.freeze(["available", "deleted"])
  }),
  fields: Object.freeze([
    "citationHandles",
    "context",
    "evidence",
    "language",
    "query",
    "scopeEvidence",
    "text",
    "type"
  ]),
  languages: Object.freeze(["en", "ru"]),
  scopeEvidence: Object.freeze({
    coverageFields: Object.freeze(["expectedPassageCount", "mode", "verified"]),
    readinessFields: Object.freeze([
      "failedSources", "pendingSources", "readySources", "totalSources"
    ])
  }),
  version: 1
});

export const knowledgeSemanticCandidateResultContract = Object.freeze({
  attributableHandles: "unique_subset_of_input_citation_handles",
  decisionScores: Object.freeze({
    decisions: knowledgeSemanticGroundingDecisions,
    maximum: 1,
    minimum: 0,
    sumTolerance: 0.001
  }),
  resourceUsage: Object.freeze({
    peakGpuMemoryBytes: "nullable_nonnegative_safe_integer",
    peakRssBytes: "positive_safe_integer"
  }),
  scalarAccounting: "nullable_nonnegative_safe_integer",
  usageStatuses: Object.freeze(["measured", "not_used", "partial", "unavailable"]),
  version: 1
});

const knowledgeSemanticScorerContract = Object.freeze({
  calibrationObjective: "maximum_grounded_accuracy_then_highest_threshold",
  confidenceThresholdFallback: "uncertain",
  decisionSelection: "maximum_probability_then_lexicographic_decision",
  finalSelectionEvidence: "held_out_only",
  scorePrecision: 6,
  version: 1
});

/** Exact PRD §28.3 metric arithmetic bound into the label-free candidate
 * freeze before any calibration, held-out, or blinded labels are revealed. */
export const knowledgeSemanticGroundingFrozenReleaseMetricContract = Object.freeze({
  gates: knowledgeSemanticGroundingReleaseMetricGates,
  sampleMinimums: knowledgeSemanticGroundingReleaseMetricSampleMinimums,
  version: KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION
});

// These are frozen after the manifest body below is assembled without gold labels.
export const KNOWLEDGE_SEMANTIC_FROZEN_CORPUS_SHA256 =
  "93e8f291feb4ad9212af2c6de2baa3bc405f86cbb1ffd93f543198d905b3a123";
export const KNOWLEDGE_SEMANTIC_FROZEN_POOL_SHA256 =
  "9b7a3fb3a4797e82c0126375fec15554e93802a634f7d778ec8b85e67bc279ed";

export const knowledgeSemanticCandidateUnavailableReasons = Object.freeze([
  "hybrid_component_unavailable",
  "local_model_not_configured",
  "system_model_not_authorized",
  "system_model_structured_output_unavailable"
] as const);

export type KnowledgeSemanticCandidateUnavailableReason =
  typeof knowledgeSemanticCandidateUnavailableReasons[number];

export type KnowledgeSemanticDecisionScores = Readonly<Record<
  KnowledgeSemanticGroundingDecision,
  number
>>;

export type KnowledgeSemanticCandidateInput = Readonly<{
  citationHandles: readonly string[];
  context: readonly string[];
  evidence: readonly Readonly<{
    ambiguous: boolean;
    handle: string;
    locatorState: "deleted" | "invalid" | "missing" | "valid";
    state: "available" | "deleted";
    text: string | null;
  }>[];
  language: KnowledgeSemanticGroundingLanguage;
  query: string;
  scopeEvidence: Readonly<{
    coverage: Pick<KnowledgeEvidencePackage["coverage"],
      "expectedPassageCount" | "mode" | "verified">;
    readiness: KnowledgeEvidencePackage["readiness"];
  }>;
  text: string;
  type: string;
}>;

export type KnowledgeSemanticCandidateResourceUsage = Readonly<{
  peakGpuMemoryBytes: number | null;
  peakRssBytes: number;
}>;

export type KnowledgeSemanticCandidateProviderUsage = Readonly<{
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  providerRequestCount: number | null;
  reasoningTokens: number | null;
  status: "measured" | "not_used" | "partial" | "unavailable";
  totalTokens: number | null;
}>;

export type KnowledgeSemanticCandidateResult = Readonly<{
  attributableHandles: readonly string[];
  costMicros: number | null;
  decisionScores: KnowledgeSemanticDecisionScores;
  inputTokens: number | null;
  reasonFamily: KnowledgeSemanticReasonFamily;
  resourceUsage?: KnowledgeSemanticCandidateResourceUsage | null;
  usage?: KnowledgeSemanticCandidateProviderUsage;
}>;

export type KnowledgeSemanticCandidateExecutorIdentity = Readonly<{
  authorization: "evaluation_only" | "local" | "profile_authorized";
  backend: string;
  egress: "external" | "none";
  executionClass: "real_model" | "structural_baseline" | "test_double";
  hardware: "cpu" | "gpu" | "provider_managed";
  modelId: string;
  profile: string;
  provider: string;
  resources: Readonly<{
    cpuLogicalCores: number | null;
    gpuDevice: string | null;
    scope: "isolated_runner" | "provider_managed" | "shared_process";
  }>;
  revision: string;
  version: number;
}>;

/** In-memory declaration used to derive content-free digests. Raw prompt and
 * schema material never enters the persisted freeze manifest. */
export type KnowledgeSemanticCandidateExecutorContract = Readonly<{
  inputProjection: unknown;
  prompt: unknown;
  protocol: unknown;
  responseSchema: unknown;
  supportingImplementation: readonly string[];
}>;

export type KnowledgeSemanticCandidateImplementationBinding = Readonly<{
  digest: string;
  executorImplementationSha256: string;
  inputProjectionSha256: string;
  promptSha256: string;
  protocolSha256: string;
  responseSchemaSha256: string;
  supportingImplementationSha256: string;
  version: typeof KNOWLEDGE_SEMANTIC_EXECUTOR_CONTRACT_VERSION;
}>;

export type KnowledgeSemanticCandidateExecutor = Readonly<{
  contract?: KnowledgeSemanticCandidateExecutorContract;
  identity: KnowledgeSemanticCandidateExecutorIdentity;
  validate(input: KnowledgeSemanticCandidateInput): Promise<KnowledgeSemanticCandidateResult>;
}>;

export type KnowledgeSemanticCandidatePoolEntry = Readonly<{
  /** Evaluator-only deterministic receipt. It is never passed to candidate executors. */
  arithmetic: KnowledgeSemanticArithmeticBinding | null;
  claimSha256: string;
  documentFamily: string;
  /** Evaluator-only source package. It is never passed to candidate executors. */
  evidencePackage: KnowledgeEvidencePackage;
  fixtureId: string;
  input: KnowledgeSemanticCandidateInput;
  language: KnowledgeSemanticGroundingLanguage;
  neighborhoodSha256: string;
  ordinal: number;
  slices: readonly KnowledgeSemanticGroundingSlice[];
  split: KnowledgeSemanticGroundingSplit;
}>;

export type KnowledgeSemanticCandidatePool = Readonly<{
  corpusSha256: string;
  corpusVersion: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION;
  entries: readonly KnowledgeSemanticCandidatePoolEntry[];
  labelsExcludedFromPool: true;
  poolSha256: string;
  samePoolForEveryCandidate: true;
  version: typeof KNOWLEDGE_SEMANTIC_CANDIDATE_POOL_VERSION;
}>;

export type KnowledgeSemanticCandidateSetBinding = Readonly<{
  corpusSha256: string;
  digest: string;
  evaluationContractSha256: string;
  poolSha256: string;
  thresholdContractVersion: typeof KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION;
  thresholdScheduleSha256: string;
  version: typeof KNOWLEDGE_SEMANTIC_CANDIDATE_SET_VERSION;
}>;

export type KnowledgeSemanticEvaluationContractBinding = Readonly<{
  candidateContractSha256: string;
  candidateImplementationSha256: string;
  digest: string;
  gateContractSha256: string;
  scorerContractSha256: string;
  scorerImplementationSha256: string;
  thresholdContractSha256: string;
  version: typeof KNOWLEDGE_SEMANTIC_EVALUATION_CONTRACT_VERSION;
}>;

export type KnowledgeSemanticCandidateId = "current_structural_fence_v4" | "hybrid_semantic_v1" |
  "local_multilingual_nli_v1" | "system_model_semantic_v1";

export type KnowledgeSemanticCandidateIdentityBinding =
  | Readonly<{
      availability: "available";
      executor: KnowledgeSemanticCandidateExecutorIdentity;
      fallbackCandidateId: "current_structural_fence_v4";
      id: KnowledgeSemanticCandidateId;
      implementation: KnowledgeSemanticCandidateImplementationBinding;
      kind: "hybrid" | "local_nli" | "structural" | "system_model";
    }>
  | Readonly<{
      availability: "unavailable";
      egress: "external" | "none";
      fallbackCandidateId: "current_structural_fence_v4";
      id: Exclude<KnowledgeSemanticCandidateId, "current_structural_fence_v4">;
      kind: "hybrid" | "local_nli" | "system_model";
      reason: KnowledgeSemanticCandidateUnavailableReason;
    }>;

export type KnowledgeSemanticCandidateFreezeManifest = Readonly<{
  aggregateOnly: true;
  artifactType: "knowledge_semantic_candidate_freeze";
  artifactVersion: typeof KNOWLEDGE_SEMANTIC_CANDIDATE_FREEZE_VERSION;
  candidateSet: KnowledgeSemanticCandidateSetBinding;
  candidates: readonly KnowledgeSemanticCandidateIdentityBinding[];
  corpusVersion: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION;
  evaluationContract: KnowledgeSemanticEvaluationContractBinding;
  labelsIncluded: false;
  manifestSha256: string;
  poolVersion: typeof KNOWLEDGE_SEMANTIC_CANDIDATE_POOL_VERSION;
  releaseMetrics: typeof knowledgeSemanticGroundingFrozenReleaseMetricContract;
  releaseMetricsSha256: string;
  thresholdSchedule: readonly number[];
}>;

export type KnowledgeSemanticCandidate =
  | Readonly<{
      availability: "available";
      executor: KnowledgeSemanticCandidateExecutor;
      fallbackCandidateId: "current_structural_fence_v4";
      id: KnowledgeSemanticCandidateId;
      kind: "hybrid" | "local_nli" | "structural" | "system_model";
    }>
  | Readonly<{
      availability: "unavailable";
      egress: "external" | "none";
      fallbackCandidateId: "current_structural_fence_v4";
      id: Exclude<KnowledgeSemanticCandidateId, "current_structural_fence_v4">;
      kind: "hybrid" | "local_nli" | "system_model";
      reason: KnowledgeSemanticCandidateUnavailableReason;
    }>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("knowledge_semantic_contract_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("knowledge_semantic_contract_value_invalid");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function normalizedImplementationSource(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    throw new Error("knowledge_semantic_implementation_source_invalid");
  }
  return normalized;
}

function callableSource(value: CallableFunction): string {
  return normalizedImplementationSource(Function.prototype.toString.call(value));
}

function implementationSources(...values: readonly CallableFunction[]): readonly string[] {
  return Object.freeze(values.map(callableSource));
}

function moduleSourceSha256(relativePath: string): string {
  let source: string;
  try {
    source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  } catch {
    throw new Error("knowledge_semantic_implementation_source_unavailable");
  }
  return sha256(normalizedImplementationSource(source));
}

/** Produces the exact current evaluator binding. The code digests deliberately
 * cover the full candidate and scoring modules so helper-function drift cannot
 * hide behind an unchanged manually assigned revision string. */
export function createKnowledgeSemanticEvaluationContractBinding():
KnowledgeSemanticEvaluationContractBinding {
  const thresholdContractSha256 = canonicalSha256({
    thresholds: KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS,
    version: KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION
  });
  const body = {
    candidateContractSha256: canonicalSha256({
      input: knowledgeSemanticCandidateInputContract,
      result: knowledgeSemanticCandidateResultContract
    }),
    candidateImplementationSha256:
      moduleSourceSha256("./semanticGroundingCandidates.ts"),
    gateContractSha256: canonicalSha256({
      mandatorySliceMinimums: knowledgeSemanticGroundingMandatorySliceMinimums,
      qualityGates: knowledgeSemanticGroundingQualityGates,
      releaseMetricGates: knowledgeSemanticGroundingReleaseMetricGates,
      releaseMetricSampleMinimums: knowledgeSemanticGroundingReleaseMetricSampleMinimums,
      releaseMetricsVersion: KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION,
      releaseSampleMinimums: knowledgeSemanticGroundingReleaseSampleMinimums
    }),
    scorerContractSha256: canonicalSha256(knowledgeSemanticScorerContract),
    scorerImplementationSha256: canonicalSha256({
      arithmeticBinding: moduleSourceSha256("./semanticGroundingArithmeticBinding.ts"),
      candidateBenchmark: moduleSourceSha256("./semanticGroundingBenchmark.ts"),
      deterministicScorer: moduleSourceSha256("./semanticGrounding.ts"),
      productionArithmetic: moduleSourceSha256(
        "../../lib/server/knowledge/semanticArithmetic.ts"
      ),
      releaseMetrics: moduleSourceSha256("./semanticGroundingReleaseMetrics.ts")
    }),
    thresholdContractSha256,
    version: KNOWLEDGE_SEMANTIC_EVALUATION_CONTRACT_VERSION
  };
  return Object.freeze({ ...body, digest: canonicalSha256(body) });
}

/** Hashes an executor's actual callable body plus every declared helper,
 * prompt, schema, protocol, and input projection. Test doubles without an
 * explicit declaration remain usable, but are still bound to their callable
 * source and the shared candidate boundary contract. */
export function knowledgeSemanticCandidateImplementationForDigest(
  executor: KnowledgeSemanticCandidateExecutor
): KnowledgeSemanticCandidateImplementationBinding {
  const contract = executor.contract ?? Object.freeze({
    inputProjection: knowledgeSemanticCandidateInputContract,
    prompt: Object.freeze({ status: "executor_defined" }),
    protocol: Object.freeze({ execution: "test_or_external_executor" }),
    responseSchema: knowledgeSemanticCandidateResultContract,
    supportingImplementation: Object.freeze([] as string[])
  });
  const body = {
    executorImplementationSha256: sha256(callableSource(executor.validate)),
    inputProjectionSha256: canonicalSha256(contract.inputProjection),
    promptSha256: canonicalSha256(contract.prompt),
    protocolSha256: canonicalSha256(contract.protocol),
    responseSchemaSha256: canonicalSha256(contract.responseSchema),
    supportingImplementationSha256: canonicalSha256(
      contract.supportingImplementation.map(normalizedImplementationSource)
    ),
    version: KNOWLEDGE_SEMANTIC_EXECUTOR_CONTRACT_VERSION
  };
  return Object.freeze({ ...body, digest: canonicalSha256(body) });
}

export function knowledgeSemanticCandidateIdentityForDigest(
  candidate: KnowledgeSemanticCandidate
): KnowledgeSemanticCandidateIdentityBinding {
  if (candidate.availability === "unavailable") {
    return Object.freeze({
      availability: candidate.availability,
      egress: candidate.egress,
      fallbackCandidateId: candidate.fallbackCandidateId,
      id: candidate.id,
      kind: candidate.kind,
      reason: candidate.reason
    });
  }
  return Object.freeze({
    availability: candidate.availability,
    executor: candidate.executor.identity,
    fallbackCandidateId: candidate.fallbackCandidateId,
    id: candidate.id,
    implementation: knowledgeSemanticCandidateImplementationForDigest(candidate.executor),
    kind: candidate.kind
  });
}

/**
 * Binds the frozen candidate-set version to the exact runner identities and
 * threshold schedule used by a run.  A live runner/model revision therefore
 * cannot masquerade as an already-frozen candidate merely by reusing the
 * corpus digest.
 */
export function createKnowledgeSemanticCandidateSetBinding(input: Readonly<{
  candidates: readonly KnowledgeSemanticCandidate[];
  corpusSha256: string;
  poolSha256: string;
}>): KnowledgeSemanticCandidateSetBinding {
  const evaluationContract = createKnowledgeSemanticEvaluationContractBinding();
  const thresholdScheduleSha256 = evaluationContract.thresholdContractSha256;
  const body = {
    candidates: input.candidates.map(knowledgeSemanticCandidateIdentityForDigest),
    corpusSha256: input.corpusSha256,
    evaluationContractSha256: evaluationContract.digest,
    poolSha256: input.poolSha256,
    thresholdContractVersion: KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION,
    thresholdScheduleSha256,
    version: KNOWLEDGE_SEMANTIC_CANDIDATE_SET_VERSION
  };
  return Object.freeze({
    corpusSha256: input.corpusSha256,
    digest: canonicalSha256(body),
    evaluationContractSha256: evaluationContract.digest,
    poolSha256: input.poolSha256,
    thresholdContractVersion: KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION,
    thresholdScheduleSha256,
    version: KNOWLEDGE_SEMANTIC_CANDIDATE_SET_VERSION
  });
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const candidateIdSchema = z.enum([
  "current_structural_fence_v4",
  "local_multilingual_nli_v1",
  "system_model_semantic_v1",
  "hybrid_semantic_v1"
]);
const candidateKindSchema = z.enum(["hybrid", "local_nli", "structural", "system_model"]);
const executorIdentitySchema = z.strictObject({
  authorization: z.enum(["evaluation_only", "local", "profile_authorized"]),
  backend: z.string().min(1).max(160),
  egress: z.enum(["external", "none"]),
  executionClass: z.enum(["real_model", "structural_baseline", "test_double"]),
  hardware: z.enum(["cpu", "gpu", "provider_managed"]),
  modelId: z.string().min(1).max(240),
  profile: z.string().min(1).max(160),
  provider: z.string().min(1).max(160),
  resources: z.strictObject({
    cpuLogicalCores: z.number().int().positive().nullable(),
    gpuDevice: z.string().min(1).max(160).nullable(),
    scope: z.enum(["isolated_runner", "provider_managed", "shared_process"])
  }),
  revision: z.string().min(1).max(240),
  version: z.number().int().positive()
});
const executorImplementationBindingSchema = z.strictObject({
  digest: sha256Schema,
  executorImplementationSha256: sha256Schema,
  inputProjectionSha256: sha256Schema,
  promptSha256: sha256Schema,
  protocolSha256: sha256Schema,
  responseSchemaSha256: sha256Schema,
  supportingImplementationSha256: sha256Schema,
  version: z.literal(KNOWLEDGE_SEMANTIC_EXECUTOR_CONTRACT_VERSION)
});
const availableCandidateIdentitySchema = z.strictObject({
  availability: z.literal("available"),
  executor: executorIdentitySchema,
  fallbackCandidateId: z.literal("current_structural_fence_v4"),
  id: candidateIdSchema,
  implementation: executorImplementationBindingSchema,
  kind: candidateKindSchema
});
const unavailableCandidateIdentitySchema = z.strictObject({
  availability: z.literal("unavailable"),
  egress: z.enum(["external", "none"]),
  fallbackCandidateId: z.literal("current_structural_fence_v4"),
  id: z.enum([
    "local_multilingual_nli_v1",
    "system_model_semantic_v1",
    "hybrid_semantic_v1"
  ]),
  kind: z.enum(["hybrid", "local_nli", "system_model"]),
  reason: z.enum(knowledgeSemanticCandidateUnavailableReasons)
});
const candidateSetBindingSchema = z.strictObject({
  corpusSha256: sha256Schema,
  digest: sha256Schema,
  evaluationContractSha256: sha256Schema,
  poolSha256: sha256Schema,
  thresholdContractVersion: z.literal(KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION),
  thresholdScheduleSha256: sha256Schema,
  version: z.literal(KNOWLEDGE_SEMANTIC_CANDIDATE_SET_VERSION)
});
const evaluationContractBindingSchema = z.strictObject({
  candidateContractSha256: sha256Schema,
  candidateImplementationSha256: sha256Schema,
  digest: sha256Schema,
  gateContractSha256: sha256Schema,
  scorerContractSha256: sha256Schema,
  scorerImplementationSha256: sha256Schema,
  thresholdContractSha256: sha256Schema,
  version: z.literal(KNOWLEDGE_SEMANTIC_EVALUATION_CONTRACT_VERSION)
});
const releaseMetricContractSchema = z.strictObject({
  gates: z.strictObject({
    citationHandleValidityMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.citationHandleValidityMinimum),
    citationPrecisionMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.citationPrecisionMinimum),
    contradictionPrecisionMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.contradictionPrecisionMinimum),
    contradictionRecallMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.contradictionRecallMinimum),
    correctNoAnswerMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.correctNoAnswerMinimum),
    criticalNumericDateAttributionMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.criticalNumericDateAttributionMinimum),
    numericDateAttributionMinimum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.numericDateAttributionMinimum),
    temporalVersionReferenceFalseBlockerMaximum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.temporalVersionReferenceFalseBlockerMaximum),
    unsupportedSourceDerivedRateMaximum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.unsupportedSourceDerivedRateMaximum),
    wilsonIntervalMaximumWidth: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.wilsonIntervalMaximumWidth),
    wholeAnswerDestructionMaximum: z.literal(
      knowledgeSemanticGroundingReleaseMetricGates.wholeAnswerDestructionMaximum)
  }),
  sampleMinimums: z.strictObject({
    citationHandleValidity: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.citationHandleValidity),
    citationPrecision: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.citationPrecision),
    claimScope: z.literal(knowledgeSemanticGroundingReleaseMetricSampleMinimums.claimScope),
    contradiction: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.contradiction),
    criticalNumericDate: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.criticalNumericDate),
    mandatoryRegression: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.mandatoryRegression),
    noAnswer: z.literal(knowledgeSemanticGroundingReleaseMetricSampleMinimums.noAnswer),
    numericDate: z.literal(knowledgeSemanticGroundingReleaseMetricSampleMinimums.numericDate),
    slice: z.literal(knowledgeSemanticGroundingReleaseMetricSampleMinimums.slice),
    sliceLanguage: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.sliceLanguage),
    sourceDerived: z.literal(
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.sourceDerived),
    wholeAnswer: z.literal(knowledgeSemanticGroundingReleaseMetricSampleMinimums.wholeAnswer)
  }),
  version: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION)
});
const candidateFreezeManifestSchema = z.strictObject({
  aggregateOnly: z.literal(true),
  artifactType: z.literal("knowledge_semantic_candidate_freeze"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_CANDIDATE_FREEZE_VERSION),
  candidateSet: candidateSetBindingSchema,
  candidates: z.array(z.discriminatedUnion("availability", [
    availableCandidateIdentitySchema,
    unavailableCandidateIdentitySchema
  ])).length(4),
  corpusVersion: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION),
  evaluationContract: evaluationContractBindingSchema,
  labelsIncluded: z.literal(false),
  manifestSha256: sha256Schema,
  poolVersion: z.literal(KNOWLEDGE_SEMANTIC_CANDIDATE_POOL_VERSION),
  releaseMetrics: releaseMetricContractSchema,
  releaseMetricsSha256: sha256Schema,
  thresholdSchedule: z.array(z.number().min(0).max(1)).min(1).max(32)
});

function freezeManifestBody(input: Readonly<{
  candidateSet: KnowledgeSemanticCandidateSetBinding;
  candidates: readonly KnowledgeSemanticCandidateIdentityBinding[];
  evaluationContract: KnowledgeSemanticEvaluationContractBinding;
}>): Omit<KnowledgeSemanticCandidateFreezeManifest, "manifestSha256"> {
  return {
    aggregateOnly: true,
    artifactType: "knowledge_semantic_candidate_freeze",
    artifactVersion: KNOWLEDGE_SEMANTIC_CANDIDATE_FREEZE_VERSION,
    candidateSet: input.candidateSet,
    candidates: input.candidates,
    corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
    evaluationContract: input.evaluationContract,
    labelsIncluded: false,
    poolVersion: KNOWLEDGE_SEMANTIC_CANDIDATE_POOL_VERSION,
    releaseMetrics: knowledgeSemanticGroundingFrozenReleaseMetricContract,
    releaseMetricsSha256: canonicalSha256(knowledgeSemanticGroundingFrozenReleaseMetricContract),
    thresholdSchedule: KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS
  };
}

/** Creates the durable, label-free identity artifact that must precede scoring. */
export function createKnowledgeSemanticCandidateFreezeManifest(input: Readonly<{
  candidates: readonly KnowledgeSemanticCandidate[];
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticCandidateFreezeManifest {
  const evaluationContract = createKnowledgeSemanticEvaluationContractBinding();
  const candidateSet = createKnowledgeSemanticCandidateSetBinding({
    candidates: input.candidates,
    corpusSha256: input.pool.corpusSha256,
    poolSha256: input.pool.poolSha256
  });
  const body = freezeManifestBody({
    candidateSet,
    candidates: Object.freeze(input.candidates.map(knowledgeSemanticCandidateIdentityForDigest)),
    evaluationContract
  });
  return Object.freeze({
    ...body,
    manifestSha256: canonicalSha256(body)
  });
}

/** Validates the persisted artifact without resolving any optional executor.
 * Optional runner identities are frozen authority at this boundary; their
 * transition into later artifacts is checked by the benchmark chain validator. */
export function assertKnowledgeSemanticCandidateFreezeArtifact(input: Readonly<{
  manifest: unknown;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticCandidateFreezeManifest {
  const parsed = candidateFreezeManifestSchema.safeParse(input.manifest);
  if (!parsed.success) throw new Error("knowledge_semantic_freeze_manifest_invalid");
  const { manifestSha256, ...body } = parsed.data;
  if (canonicalSha256(body) !== manifestSha256) {
    throw new Error("knowledge_semantic_freeze_manifest_digest_mismatch");
  }
  if (parsed.data.candidateSet.corpusSha256 !== input.pool.corpusSha256 ||
    parsed.data.candidateSet.poolSha256 !== input.pool.poolSha256 ||
    parsed.data.corpusVersion !== input.pool.corpusVersion ||
    parsed.data.poolVersion !== input.pool.version) {
    throw new Error("knowledge_semantic_freeze_manifest_pool_mismatch");
  }
  const expectedEvaluationContract = createKnowledgeSemanticEvaluationContractBinding();
  if (parsed.data.candidateSet.evaluationContractSha256 !==
      expectedEvaluationContract.digest ||
    canonicalJson(parsed.data.evaluationContract) !==
      canonicalJson(expectedEvaluationContract)) {
    throw new Error("knowledge_semantic_freeze_manifest_implementation_mismatch");
  }
  const expectedReleaseMetricsSha256 = canonicalSha256(
    knowledgeSemanticGroundingFrozenReleaseMetricContract
  );
  if (parsed.data.candidateSet.thresholdScheduleSha256 !==
      expectedEvaluationContract.thresholdContractSha256 ||
    canonicalJson(parsed.data.thresholdSchedule) !==
      canonicalJson(KNOWLEDGE_SEMANTIC_CALIBRATION_THRESHOLDS) ||
    parsed.data.releaseMetricsSha256 !== expectedReleaseMetricsSha256 ||
    canonicalJson(parsed.data.releaseMetrics) !==
      canonicalJson(knowledgeSemanticGroundingFrozenReleaseMetricContract)) {
    throw new Error("knowledge_semantic_freeze_manifest_threshold_mismatch");
  }

  const expectedCandidateOrder = [
    ["current_structural_fence_v4", "structural"],
    ["local_multilingual_nli_v1", "local_nli"],
    ["system_model_semantic_v1", "system_model"],
    ["hybrid_semantic_v1", "hybrid"]
  ] as const;
  const structuralCandidate = createKnowledgeSemanticGroundingCandidates()[0]!;
  const expectedStructuralIdentity = knowledgeSemanticCandidateIdentityForDigest(
    structuralCandidate
  );
  const availableImplementationsValid = parsed.data.candidates.every((candidate) => {
    if (candidate.availability === "unavailable") return true;
    const { digest, ...implementationBody } = candidate.implementation;
    return digest === canonicalSha256(implementationBody);
  });
  const localIdentity = parsed.data.candidates[1]!;
  const hybridIdentity = parsed.data.candidates[3]!;
  let hybridTransitionValid = localIdentity.availability === hybridIdentity.availability;
  if (localIdentity.availability === "unavailable" &&
    hybridIdentity.availability === "unavailable") {
    hybridTransitionValid = hybridTransitionValid &&
      hybridIdentity.egress === "none" &&
      hybridIdentity.reason === "hybrid_component_unavailable";
  } else if (localIdentity.availability === "available" &&
    hybridIdentity.availability === "available") {
    const expectedHybridExecutorIdentity = {
      ...localIdentity.executor,
      backend: `hybrid:${localIdentity.executor.backend}`,
      profile: `hybrid-${localIdentity.executor.profile}`.slice(0, 80),
      revision: `0.25-structural+0.75-${localIdentity.executor.revision}`,
      version: 1
    };
    const structuralExecutor = structuralCandidate.availability === "available"
      ? structuralCandidate.executor
      : null;
    const referenceHybridImplementation = structuralExecutor
      ? knowledgeSemanticCandidateImplementationForDigest(
          hybridExecutor(structuralExecutor, structuralExecutor)
        )
      : null;
    const expectedHybridProtocolSha256 = canonicalSha256({
      childImplementations: {
        semantic: localIdentity.implementation.digest,
        structural: expectedStructuralIdentity.availability === "available"
          ? expectedStructuralIdentity.implementation.digest
          : ""
      },
      execution: "parallel_in_process",
      semanticWeight: 0.75,
      structuralWeight: 0.25,
      version: 1
    });
    hybridTransitionValid = hybridTransitionValid &&
      canonicalJson(hybridIdentity.executor) === canonicalJson(expectedHybridExecutorIdentity) &&
      hybridIdentity.implementation.protocolSha256 === expectedHybridProtocolSha256 &&
      referenceHybridImplementation !== null &&
      ([
        "executorImplementationSha256",
        "inputProjectionSha256",
        "promptSha256",
        "responseSchemaSha256",
        "supportingImplementationSha256",
        "version"
      ] as const).every((key) =>
        hybridIdentity.implementation[key] === referenceHybridImplementation[key]);
  }
  const orderedIdentitiesValid = parsed.data.candidates.every((candidate, index) =>
    candidate.id === expectedCandidateOrder[index]?.[0] &&
    candidate.kind === expectedCandidateOrder[index]?.[1]);
  if (!orderedIdentitiesValid || !availableImplementationsValid ||
    canonicalJson(parsed.data.candidates[0]) !== canonicalJson(expectedStructuralIdentity) ||
    !hybridTransitionValid) {
    throw new Error("knowledge_semantic_freeze_manifest_candidate_mismatch");
  }

  const expectedCandidateSetDigest = canonicalSha256({
    candidates: parsed.data.candidates,
    corpusSha256: input.pool.corpusSha256,
    evaluationContractSha256: expectedEvaluationContract.digest,
    poolSha256: input.pool.poolSha256,
    thresholdContractVersion: KNOWLEDGE_SEMANTIC_THRESHOLD_CONTRACT_VERSION,
    thresholdScheduleSha256: expectedEvaluationContract.thresholdContractSha256,
    version: KNOWLEDGE_SEMANTIC_CANDIDATE_SET_VERSION
  });
  if (parsed.data.candidateSet.digest !== expectedCandidateSetDigest) {
    throw new Error("knowledge_semantic_freeze_manifest_candidate_mismatch");
  }
  return Object.freeze(parsed.data as KnowledgeSemanticCandidateFreezeManifest);
}

/** Validates both artifact integrity and its exact current runner/pool binding. */
export function assertKnowledgeSemanticCandidateFreezeManifest(input: Readonly<{
  candidates: readonly KnowledgeSemanticCandidate[];
  manifest: unknown;
  pool: KnowledgeSemanticCandidatePool;
}>): KnowledgeSemanticCandidateFreezeManifest {
  const parsed = assertKnowledgeSemanticCandidateFreezeArtifact(input);
  const expected = createKnowledgeSemanticCandidateFreezeManifest({
    candidates: input.candidates,
    pool: input.pool
  });
  if (canonicalJson(parsed.candidates) !== canonicalJson(expected.candidates) ||
    parsed.candidateSet.digest !== expected.candidateSet.digest) {
    throw new Error("knowledge_semantic_freeze_manifest_candidate_mismatch");
  }
  return parsed;
}

function ambiguous(item: KnowledgeSemanticCandidateInput["evidence"][number]): boolean {
  return item.ambiguous;
}

function evidenceAmbiguous(item: KnowledgeEvidencePackage["items"][number]): boolean {
  return item.contextBoundaries?.layoutKind === "table_ambiguous" ||
    item.contextBoundaries?.layoutKind === "field_ambiguous";
}

function corpusBody(): unknown {
  return {
    fixtures: knowledgeSemanticGroundingFixtures.map((fixture) => ({
      answer: fixture.answer,
      arithmeticPlans: fixture.arithmeticPlans,
      documentFamily: fixture.documentFamily,
      evidence: {
        coverage: fixture.evidence.coverage,
        items: fixture.evidence.items.map((item) => ({
          contentHash: item.contentHash,
          contextBoundaries: item.contextBoundaries,
          excerpt: item.excerpt,
          handle: item.handle,
          locator: item.locator,
          sourceVersionNumber: item.sourceVersionNumber,
          state: item.state,
          textTruncated: item.textTruncated
        })),
        readiness: fixture.evidence.readiness,
        strategy: fixture.evidence.strategy,
        version: fixture.evidence.version
      },
      id: fixture.id,
      language: fixture.language,
      query: fixture.evidence.originalIntent.query,
      split: fixture.split
    })),
    version: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION
  };
}

function narrowedEvidencePackage(
  fixture: typeof knowledgeSemanticGroundingFixtures[number],
  handles: readonly string[]
): KnowledgeEvidencePackage {
  const allowed = new Set(handles);
  return Object.freeze({
    ...fixture.evidence,
    items: Object.freeze(fixture.evidence.items.filter((item) => allowed.has(item.handle)))
  });
}

function neighborhoodItems(
  fixture: typeof knowledgeSemanticGroundingFixtures[number],
  claim: ReturnType<typeof segmentKnowledgeSemanticClaims>[number]
): readonly KnowledgeEvidencePackage["items"][number][] {
  return claim.citationHandles.length === 0 &&
    (claim.type === "source_summary" || claim.type === "coverage_claim")
    ? fixture.evidence.items
    : claim.evidenceItems;
}

function candidateLocatorState(
  item: KnowledgeEvidencePackage["items"][number]
): KnowledgeSemanticCandidateInput["evidence"][number]["locatorState"] {
  if (item.state === "deleted") return "deleted";
  if (item.locator === null) return "missing";
  if (!Number.isSafeInteger(item.locator.page) || item.locator.page < 1) return "invalid";
  return "valid";
}

function entryForClaim(
  fixture: typeof knowledgeSemanticGroundingFixtures[number],
  claim: ReturnType<typeof segmentKnowledgeSemanticClaims>[number]
): KnowledgeSemanticCandidatePoolEntry {
  const sliceMetadata = fixture.labels.find((label) => label.claimOrdinal === claim.ordinal)?.slices;
  if (!sliceMetadata) throw new Error("knowledge_semantic_candidate_slice_metadata_missing");
  const claimSha256 = sha256(JSON.stringify({
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    context: claim.context,
    ordinal: claim.ordinal,
    sourceShape: claim.sourceShape,
    text: claim.text,
    type: claim.type
  }));
  const locatorByHandle = new Map(claim.locatorStates.map((entry) =>
    [entry.handle, entry.state] as const));
  const items = neighborhoodItems(fixture, claim);
  const evaluatorEvidence = Object.freeze(items.map((item) => Object.freeze({
    ambiguous: evidenceAmbiguous(item),
    contentHash: item.contentHash,
    handle: item.handle,
    locatorState: locatorByHandle.get(item.handle) ?? candidateLocatorState(item),
    state: item.state,
    text: item.excerpt
  })));
  const neighborhoodSha256 = sha256(JSON.stringify({
    citationHandles: claim.citationHandles,
    evidence: evaluatorEvidence,
    neighborhoodRule: claim.neighborhoodRule,
    neighborhoodVersion: claim.neighborhoodVersion,
    unknownCitationHandles: claim.unknownCitationHandles
  }));
  const evidence = Object.freeze(evaluatorEvidence.map((item) => Object.freeze({
    ambiguous: item.ambiguous,
    handle: item.handle,
    locatorState: item.locatorState,
    state: item.state,
    text: item.text
  })));
  const evidencePackage = narrowedEvidencePackage(fixture, items.map((item) => item.handle));
  const arithmeticPlans = fixture.arithmeticPlans.filter((plan) =>
    plan.claimOrdinal === claim.ordinal);
  if ((claim.type === "derived_arithmetic" && arithmeticPlans.length !== 1) ||
    (claim.type !== "derived_arithmetic" && arithmeticPlans.length !== 0)) {
    throw new Error("knowledge_semantic_candidate_arithmetic_plan_mismatch");
  }
  const arithmetic = arithmeticPlans[0]
    ? createKnowledgeSemanticArithmeticBinding({
        claimSha256,
        evidencePackage,
        plan: arithmeticPlans[0]
      })
    : null;
  const input = Object.freeze({
    citationHandles: claim.citationHandles,
    context: claim.context,
    evidence,
    language: fixture.language,
    query: fixture.evidence.originalIntent.query,
    scopeEvidence: Object.freeze({
      coverage: Object.freeze({
        expectedPassageCount: fixture.evidence.coverage.expectedPassageCount,
        mode: fixture.evidence.coverage.mode,
        verified: fixture.evidence.coverage.verified
      }),
      readiness: Object.freeze({ ...fixture.evidence.readiness })
    }),
    text: claim.text,
    type: claim.type
  });
  return Object.freeze({
    arithmetic,
    claimSha256,
    documentFamily: fixture.documentFamily,
    evidencePackage,
    fixtureId: fixture.id,
    input,
    language: fixture.language,
    neighborhoodSha256,
    ordinal: claim.ordinal,
    slices: Object.freeze([...sliceMetadata]),
    split: fixture.split
  });
}

function assertPoolFamilies(entries: readonly KnowledgeSemanticCandidatePoolEntry[]): void {
  const familySplits = new Map<string, Set<KnowledgeSemanticGroundingSplit>>();
  for (const entry of entries) {
    const splits = familySplits.get(entry.documentFamily) ?? new Set();
    splits.add(entry.split);
    familySplits.set(entry.documentFamily, splits);
  }
  if ([...familySplits.values()].some((splits) => splits.size !== 1)) {
    throw new Error("knowledge_semantic_candidate_pool_family_leakage");
  }
}

function candidatePoolBody(input: Readonly<{
  corpusSha256: string;
  entries: readonly KnowledgeSemanticCandidatePoolEntry[];
}>) {
  return {
    corpusSha256: input.corpusSha256,
    corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
    entries: input.entries.map((entry) => ({
      arithmeticReceiptSha256: entry.arithmetic?.receipt.receiptSha256 ?? null,
      claimSha256: entry.claimSha256,
      documentFamily: entry.documentFamily,
      fixtureId: entry.fixtureId,
      language: entry.language,
      neighborhoodSha256: entry.neighborhoodSha256,
      ordinal: entry.ordinal,
      slices: entry.slices,
      split: entry.split
    })),
    labelsExcludedFromPool: true as const,
    samePoolForEveryCandidate: true as const,
    version: KNOWLEDGE_SEMANTIC_CANDIDATE_POOL_VERSION
  } as const;
}

/** Recomputes the content-free pool identity, including every evaluator-only
 * arithmetic receipt digest but excluding its private plan and evidence. */
export function knowledgeSemanticCandidatePoolSha256(input: Readonly<{
  corpusSha256: string;
  entries: readonly KnowledgeSemanticCandidatePoolEntry[];
}>): string {
  return sha256(JSON.stringify(candidatePoolBody(input)));
}

export function createKnowledgeSemanticGroundingCandidatePool():
KnowledgeSemanticCandidatePool {
  const corpusSha256 = sha256(JSON.stringify(corpusBody()));
  const entries = Object.freeze(knowledgeSemanticGroundingFixtures.flatMap((fixture) =>
    segmentKnowledgeSemanticClaims({ answer: fixture.answer, evidence: fixture.evidence })
      .map((claim) => entryForClaim(fixture, claim))));
  assertPoolFamilies(entries);
  const body = candidatePoolBody({ corpusSha256, entries });
  const poolSha256 = knowledgeSemanticCandidatePoolSha256({ corpusSha256, entries });
  if (corpusSha256 !== KNOWLEDGE_SEMANTIC_FROZEN_CORPUS_SHA256) {
    throw new Error(`knowledge_semantic_frozen_corpus_digest_mismatch:${corpusSha256}`);
  }
  if (poolSha256 !== KNOWLEDGE_SEMANTIC_FROZEN_POOL_SHA256) {
    throw new Error(`knowledge_semantic_frozen_pool_digest_mismatch:${poolSha256}`);
  }
  return Object.freeze({ ...body, entries, poolSha256 });
}

function oneHot(decision: KnowledgeSemanticGroundingDecision): KnowledgeSemanticDecisionScores {
  return Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((candidate) =>
    [candidate, Number(candidate === decision)])) as Record<
      KnowledgeSemanticGroundingDecision,
      number
    >);
}

/** Rebuilds only the structural fields needed by the local fence. Benchmark
 * fixture identities, content hashes, split names, and evaluator receipts are
 * deliberately absent from the executor boundary. */
function structuralEvidencePackage(
  input: KnowledgeSemanticCandidateInput
): KnowledgeEvidencePackage {
  return Object.freeze({
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: Object.freeze({
      ...input.scopeEvidence.coverage,
      namedTargets: Object.freeze([])
    }),
    degradedFlags: Object.freeze([]),
    items: Object.freeze(input.evidence.map((item, index) => {
      const opaqueOrdinal = index + 1;
      const opaqueIdentity = `semantic-candidate-${opaqueOrdinal}`;
      const available = item.state === "available";
      return Object.freeze({
        baseName: null,
        contentHash: null,
        contextBoundaries: item.ambiguous
          ? Object.freeze({
              expanded: false,
              excerptBytes: Buffer.byteLength(item.text ?? "", "utf8"),
              layoutKind: "table_ambiguous" as const,
              sourceTextBytes: Buffer.byteLength(item.text ?? "", "utf8")
            })
          : null,
        documentId: available ? `${opaqueIdentity}-document` : null,
        documentVersionId: available ? `${opaqueIdentity}-document-version` : null,
        excerpt: item.text,
        fileName: null,
        handle: item.handle,
        headingPath: Object.freeze([]),
        id: opaqueIdentity,
        knowledgeBaseId: available ? `${opaqueIdentity}-base` : null,
        locator: item.locatorState === "valid" ? Object.freeze({ page: 1 }) : null,
        ordinal: opaqueOrdinal,
        passageId: available ? `${opaqueIdentity}-passage` : null,
        provenance: Object.freeze([]),
        sectionId: available ? `${opaqueIdentity}-section` : null,
        sourceArtifactId: available ? `${opaqueIdentity}-artifact` : null,
        sourceId: available ? `${opaqueIdentity}-source` : null,
        sourceName: null,
        sourceVersionId: available ? `${opaqueIdentity}-source-version` : null,
        sourceVersionNumber: available ? 1 : null,
        state: item.state,
        textTruncated: available ? false : null
      });
    })),
    originalIntent: Object.freeze({ intent: "fact_lookup" as const, query: input.query }),
    readiness: input.scopeEvidence.readiness,
    runId: "semantic-candidate-run",
    scopeSnapshot: null,
    sessionId: "semantic-candidate-session",
    strategy: "focused" as const,
    version: 2 as const
  });
}

function structuralDecision(input: KnowledgeSemanticCandidateInput): Readonly<{
  attributableHandles: readonly string[];
  decision: KnowledgeSemanticGroundingDecision;
}> {
  const result = groundKnowledgeAnswer({
    answer: [...input.context, input.text].filter(Boolean).join(" — "),
    evidence: structuralEvidencePackage(input)
  });
  const issues = new Set(result.diagnostics.issueCodes);
  const decision: KnowledgeSemanticGroundingDecision = issues.has("numeric_or_date_mismatch")
    ? "contradicted"
    : result.outcome === "passed" || result.outcome === "repaired" &&
      result.diagnostics.unsupportedClaimCount === 0
      ? "supported"
      : issues.has("unsupported_claim") || issues.has("invalid_handle")
        ? "unsupported"
        : "uncertain";
  return Object.freeze({
    attributableHandles: Object.freeze(input.evidence
      .filter((item) => input.citationHandles.includes(item.handle) &&
        item.state === "available" && item.text !== null && !ambiguous(item))
      .map((item) => item.handle)),
    decision
  });
}

export function createStructuralSemanticGroundingExecutor():
KnowledgeSemanticCandidateExecutor {
  return Object.freeze({
    contract: Object.freeze({
      inputProjection: knowledgeSemanticCandidateInputContract,
      prompt: Object.freeze({ status: "not_applicable" }),
      protocol: Object.freeze({
        execution: "in_process",
        groundingContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
        structuralWeights: null,
        version: 1
      }),
      responseSchema: knowledgeSemanticCandidateResultContract,
      supportingImplementation: implementationSources(
        groundKnowledgeAnswer,
        structuralEvidencePackage,
        structuralDecision,
        assertKnowledgeSemanticCandidateResult
      )
    }),
    identity: Object.freeze({
      authorization: "local" as const,
      backend: "typescript",
      egress: "none" as const,
      executionClass: "structural_baseline" as const,
      hardware: "cpu" as const,
      modelId: "none",
      profile: "current-structural-fence-v4",
      provider: "local",
      resources: Object.freeze({
        cpuLogicalCores: null,
        gpuDevice: null,
        scope: "shared_process" as const
      }),
      revision: "ground-knowledge-answer-v4-claim-local",
      version: 4
    }),
    async validate(input) {
      const prediction = structuralDecision(input);
      return Object.freeze({
        attributableHandles: prediction.attributableHandles,
        costMicros: 0,
        decisionScores: oneHot(prediction.decision),
        inputTokens: null,
        reasonFamily: "structural_baseline" as const,
        usage: Object.freeze({
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          providerRequestCount: 0,
          reasoningTokens: 0,
          status: "not_used" as const,
          totalTokens: 0
        })
      });
    }
  });
}

function hybridExecutor(
  structural: KnowledgeSemanticCandidateExecutor,
  semantic: KnowledgeSemanticCandidateExecutor
): KnowledgeSemanticCandidateExecutor {
  return Object.freeze({
    contract: Object.freeze({
      inputProjection: knowledgeSemanticCandidateInputContract,
      prompt: Object.freeze({ status: "delegated_to_semantic_component" }),
      protocol: Object.freeze({
        childImplementations: Object.freeze({
          semantic: knowledgeSemanticCandidateImplementationForDigest(semantic).digest,
          structural: knowledgeSemanticCandidateImplementationForDigest(structural).digest
        }),
        execution: "parallel_in_process",
        semanticWeight: 0.75,
        structuralWeight: 0.25,
        version: 1
      }),
      responseSchema: knowledgeSemanticCandidateResultContract,
      supportingImplementation: implementationSources(hybridExecutor)
    }),
    identity: Object.freeze({
      ...semantic.identity,
      backend: `hybrid:${semantic.identity.backend}`,
      profile: `hybrid-${semantic.identity.profile}`.slice(0, 80),
      revision: `0.25-structural+0.75-${semantic.identity.revision}`,
      version: 1
    }),
    async validate(input) {
      const [structuralResult, semanticResult] = await Promise.all([
        structural.validate(input),
        semantic.validate(input)
      ]);
      return Object.freeze({
        attributableHandles: semanticResult.attributableHandles,
        costMicros: semanticResult.costMicros,
        decisionScores: Object.freeze(Object.fromEntries(
          knowledgeSemanticGroundingDecisions.map((decision) => [
            decision,
            0.25 * structuralResult.decisionScores[decision] +
              0.75 * semanticResult.decisionScores[decision]
          ])
        ) as Record<KnowledgeSemanticGroundingDecision, number>),
        inputTokens: semanticResult.inputTokens,
        reasonFamily: semanticResult.reasonFamily,
        ...(semanticResult.resourceUsage === undefined
          ? {}
          : { resourceUsage: semanticResult.resourceUsage }),
        usage: semanticResult.usage
      });
    }
  });
}

export function createKnowledgeSemanticGroundingCandidates(input: Readonly<{
  local?: KnowledgeSemanticCandidateExecutor;
  localUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
  systemModel?: KnowledgeSemanticCandidateExecutor;
  systemUnavailableReason?: KnowledgeSemanticCandidateUnavailableReason;
}> = {}): readonly KnowledgeSemanticCandidate[] {
  const structural = createStructuralSemanticGroundingExecutor();
  const hybridComponent = input.local;
  return Object.freeze([
    Object.freeze({
      availability: "available" as const,
      executor: structural,
      fallbackCandidateId: "current_structural_fence_v4" as const,
      id: "current_structural_fence_v4" as const,
      kind: "structural" as const
    }),
    input.local
      ? Object.freeze({
          availability: "available" as const,
          executor: input.local,
          fallbackCandidateId: "current_structural_fence_v4" as const,
          id: "local_multilingual_nli_v1" as const,
          kind: "local_nli" as const
        })
      : Object.freeze({
          availability: "unavailable" as const,
          egress: "none" as const,
          fallbackCandidateId: "current_structural_fence_v4" as const,
          id: "local_multilingual_nli_v1" as const,
          kind: "local_nli" as const,
          reason: input.localUnavailableReason ?? "local_model_not_configured"
        }),
    input.systemModel
      ? Object.freeze({
          availability: "available" as const,
          executor: input.systemModel,
          fallbackCandidateId: "current_structural_fence_v4" as const,
          id: "system_model_semantic_v1" as const,
          kind: "system_model" as const
        })
      : Object.freeze({
          availability: "unavailable" as const,
          egress: "external" as const,
          fallbackCandidateId: "current_structural_fence_v4" as const,
          id: "system_model_semantic_v1" as const,
          kind: "system_model" as const,
          reason: input.systemUnavailableReason ?? "system_model_not_authorized"
        }),
    hybridComponent
      ? Object.freeze({
          availability: "available" as const,
          executor: hybridExecutor(structural, hybridComponent),
          fallbackCandidateId: "current_structural_fence_v4" as const,
          id: "hybrid_semantic_v1" as const,
          kind: "hybrid" as const
        })
      : Object.freeze({
          availability: "unavailable" as const,
          egress: "none" as const,
          fallbackCandidateId: "current_structural_fence_v4" as const,
          id: "hybrid_semantic_v1" as const,
          kind: "hybrid" as const,
          reason: "hybrid_component_unavailable" as const
        })
  ]);
}

export function assertKnowledgeSemanticCandidateResult(
  input: KnowledgeSemanticCandidateInput,
  result: KnowledgeSemanticCandidateResult
): void {
  const usage = result.usage ?? {
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    inputTokens: null,
    outputTokens: null,
    providerRequestCount: null,
    reasoningTokens: null,
    status: "unavailable" as const,
    totalTokens: null
  };
  const scores = knowledgeSemanticGroundingDecisions.map((decision) =>
    result.decisionScores[decision]);
  const allowed = new Set(input.citationHandles);
  if (scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1) ||
    Math.abs(scores.reduce((sum, score) => sum + score, 0) - 1) > 0.001 ||
    result.attributableHandles.length !== new Set(result.attributableHandles).size ||
    result.attributableHandles.some((handle) => !allowed.has(handle)) ||
    result.costMicros !== null && (!Number.isSafeInteger(result.costMicros) ||
      result.costMicros < 0) ||
    result.inputTokens !== null && (!Number.isSafeInteger(result.inputTokens) ||
      result.inputTokens < 0) ||
    !["measured", "not_used", "partial", "unavailable"].includes(usage.status) ||
    ([
      usage.cachedInputTokens,
      usage.cacheWriteInputTokens,
      usage.inputTokens,
      usage.outputTokens,
      usage.providerRequestCount,
      usage.reasoningTokens,
      usage.totalTokens
    ].some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) ||
    usage.status === "measured" && [
      usage.cachedInputTokens,
      usage.cacheWriteInputTokens,
      usage.inputTokens,
      usage.outputTokens,
      usage.providerRequestCount,
      usage.reasoningTokens,
      usage.totalTokens
    ].some((value) => value === null) ||
    usage.status === "not_used" && [
      usage.cachedInputTokens,
      usage.cacheWriteInputTokens,
      usage.inputTokens,
      usage.outputTokens,
      usage.providerRequestCount,
      usage.reasoningTokens,
      usage.totalTokens
    ].some((value) => value !== 0) ||
    usage.inputTokens !== null && result.inputTokens !== null &&
      usage.inputTokens !== result.inputTokens ||
    result.resourceUsage !== undefined && result.resourceUsage !== null && (
      !Number.isSafeInteger(result.resourceUsage.peakRssBytes) ||
      result.resourceUsage.peakRssBytes < 1 ||
      result.resourceUsage.peakGpuMemoryBytes !== null && (
        !Number.isSafeInteger(result.resourceUsage.peakGpuMemoryBytes) ||
        result.resourceUsage.peakGpuMemoryBytes < 0))) {
    throw new Error("knowledge_semantic_candidate_result_invalid");
  }
}
