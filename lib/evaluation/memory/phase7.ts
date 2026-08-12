import { MEMORY_EVALUATION_SCORER_VERSION } from "./contracts";

export const MEMORY_PHASE7_EVALUATOR_VERSION = "memory-phase7-live-evaluator-v5";
export const MEMORY_PHASE7_EVIDENCE_VERSION = "memory-phase7-evidence-v1";
export const MEMORY_PHASE7_SUITE_VERSION = "memory-phase7-quality-v1";
export const MEMORY_PHASE7_CORPUS_VERSION = "memory-corpus-v2";
export const MEMORY_PHASE7_HOLDOUT_CORPUS_HASH =
  "85e8eab6184c0c5e7140cc27b907936d1687586e66a02144bbf09ec48ad0c4e3";
export const MEMORY_PHASE7_SCORER_VERSION = MEMORY_EVALUATION_SCORER_VERSION;
export const MEMORY_PHASE7_RANDOM_SEED = 73_471;
export const MEMORY_PHASE7_BOOTSTRAP_SAMPLES = 10_000;

export const MEMORY_PHASE7_ABLATION_STAGES = [
  "ACTIVE_BRANCH",
  "EXACT_CHUNK_FTS",
  "MULTILINGUAL_VECTOR_CHUNKS",
  "EPISODES",
  "SEMANTIC_FACTS",
  "HYBRID_RRF",
  "TEMPORAL_SCOPE_TEMPERATURE",
  "MULTILINGUAL_RERANKER",
  "BOUNDED_HISTORY_TOOL",
  "PROFILE_WORKING_SET"
] as const;
export type MemoryPhase7AblationStage =
  (typeof MEMORY_PHASE7_ABLATION_STAGES)[number];

export const MEMORY_PHASE7_MATERIAL_LIFT = Object.freeze({
  coreRecallAbsolute: 0.02,
  coreTemporalOrScopeAbsolute: 0.05,
  criticalCohortMaximumRegression: 0.02,
  hindsightFactPrecisionGap: 0.07,
  hindsightRussianRecallGap: 0.1,
  hindsightTemporalGap: 0.07,
  irrelevantInjectionPointMaximum: 0.03,
  irrelevantInjectionUpperMaximum: 0.05,
  optionalCostUsdPerEligibleQueryMaximum: 0.002,
  optionalLatencyP95MsMaximum: 1_500,
  optionalRecallAbsolute: 0.02,
  optionalTemporalAbsolute: 0.03,
  profileCostUsdPerProjectionMaximum: 0.02,
  profileEligibleYieldMinimum: 0.95,
  profileMedianCompressionRatioMaximum: 0.6,
  profileRefreshLatencyP95MsMaximum: 30_000,
  profileRussianLanguagePreservationMinimum: 0.98
});

export const MEMORY_PHASE7_HINDSIGHT_REFERENCE = Object.freeze({
  commit: "99525144b257e827ff07e98665eddd7000b8fc3c",
  embeddingDimensions: 1_536,
  embeddingModel: "qwen/qwen3-embedding-8b",
  imageDigest:
    "sha256:03cfd4d99ca4a067fbc250473b44611a1a69ea4f7457da9e2af700ff0b999825",
  llmModel: "gpt-5.6-terra",
  reranker: "rrf",
  tag: "0.7.0",
  textSearchLanguage: "simple",
  vectorExtension: "pgvector"
});

export type MemoryPhase7LanguageScore = Readonly<{
  criticalRecallAt5: Readonly<Record<string, number>>;
  hardInvariantFailures: number;
  irrelevantInjectionRate: number;
  irrelevantInjectionUpper95: number;
  recallAt5: number;
  scopeAccuracy: number;
  temporalAccuracy: number;
}>;

export type MemoryPhase7BilingualScore = Readonly<{
  EN: MemoryPhase7LanguageScore;
  RU: MemoryPhase7LanguageScore;
}>;

export type MemoryPhase7MaterialityDecision = Readonly<{
  material: boolean;
  reasons: readonly (
    | "HARD_CAPABILITY_UNLOCK"
    | "RECALL_LIFT"
    | "SCOPE_LIFT"
    | "TEMPORAL_LIFT"
  )[];
  safetyPassed: boolean;
}>;

function unit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validLanguageScore(score: MemoryPhase7LanguageScore): boolean {
  return [
    score.irrelevantInjectionRate,
    score.irrelevantInjectionUpper95,
    score.recallAt5,
    score.scopeAccuracy,
    score.temporalAccuracy,
    ...Object.values(score.criticalRecallAt5)
  ].every(unit) && Number.isSafeInteger(score.hardInvariantFailures) &&
    score.hardInvariantFailures >= 0;
}

function safetyPassed(score: MemoryPhase7BilingualScore): boolean {
  return (["EN", "RU"] as const).every((language) => {
    const current = score[language];
    return current.hardInvariantFailures === 0 &&
      current.irrelevantInjectionRate <=
        MEMORY_PHASE7_MATERIAL_LIFT.irrelevantInjectionPointMaximum &&
      current.irrelevantInjectionUpper95 <=
        MEMORY_PHASE7_MATERIAL_LIFT.irrelevantInjectionUpperMaximum;
  });
}

function criticalCohortsDoNotRegress(
  previous: MemoryPhase7BilingualScore,
  current: MemoryPhase7BilingualScore
): boolean {
  return (["EN", "RU"] as const).every((language) => {
    const before = previous[language].criticalRecallAt5;
    const after = current[language].criticalRecallAt5;
    return Object.entries(before).every(([cohort, score]) =>
      after[cohort] !== undefined &&
      after[cohort] >= score -
        MEMORY_PHASE7_MATERIAL_LIFT.criticalCohortMaximumRegression
    );
  });
}

function bilingualLift(
  previous: MemoryPhase7BilingualScore,
  current: MemoryPhase7BilingualScore,
  metric: "recallAt5" | "scopeAccuracy" | "temporalAccuracy",
  threshold: number
): boolean {
  return (["EN", "RU"] as const).every((language) =>
    current[language][metric] - previous[language][metric] >= threshold
  );
}

export function decideMemoryPhase7CoreMateriality(input: Readonly<{
  current: MemoryPhase7BilingualScore;
  hardCapabilityAfter: boolean;
  hardCapabilityBefore: boolean;
  previous: MemoryPhase7BilingualScore;
}>): MemoryPhase7MaterialityDecision {
  if (
    !validLanguageScore(input.previous.EN) ||
    !validLanguageScore(input.previous.RU) ||
    !validLanguageScore(input.current.EN) ||
    !validLanguageScore(input.current.RU)
  ) throw new Error("memory_phase7_materiality_input_invalid");
  const safe = safetyPassed(input.current) &&
    criticalCohortsDoNotRegress(input.previous, input.current);
  const reasons: MemoryPhase7MaterialityDecision["reasons"][number][] = [];
  if (input.hardCapabilityAfter && !input.hardCapabilityBefore) {
    reasons.push("HARD_CAPABILITY_UNLOCK");
  }
  if (bilingualLift(
    input.previous,
    input.current,
    "recallAt5",
    MEMORY_PHASE7_MATERIAL_LIFT.coreRecallAbsolute
  )) reasons.push("RECALL_LIFT");
  if (bilingualLift(
    input.previous,
    input.current,
    "scopeAccuracy",
    MEMORY_PHASE7_MATERIAL_LIFT.coreTemporalOrScopeAbsolute
  )) reasons.push("SCOPE_LIFT");
  if (bilingualLift(
    input.previous,
    input.current,
    "temporalAccuracy",
    MEMORY_PHASE7_MATERIAL_LIFT.coreTemporalOrScopeAbsolute
  )) reasons.push("TEMPORAL_LIFT");
  return Object.freeze({ material: safe && reasons.length > 0, reasons, safetyPassed: safe });
}

export type MemoryPhase7OptionalComponentDecision = Readonly<{
  enabled: boolean;
  latencyAndCostPassed: boolean;
  liftPassed: boolean;
  safetyPassed: boolean;
}>;

export function decideMemoryPhase7OptionalComponent(input: Readonly<{
  costUsdPerEligibleQuery: number;
  current: MemoryPhase7BilingualScore;
  latencyP95Ms: number;
  previous: MemoryPhase7BilingualScore;
}>): MemoryPhase7OptionalComponentDecision {
  if (
    !validLanguageScore(input.previous.EN) ||
    !validLanguageScore(input.previous.RU) ||
    !validLanguageScore(input.current.EN) ||
    !validLanguageScore(input.current.RU) ||
    !Number.isFinite(input.latencyP95Ms) || input.latencyP95Ms < 0 ||
    !Number.isFinite(input.costUsdPerEligibleQuery) ||
    input.costUsdPerEligibleQuery < 0
  ) throw new Error("memory_phase7_optional_input_invalid");
  const lift = bilingualLift(
    input.previous,
    input.current,
    "recallAt5",
    MEMORY_PHASE7_MATERIAL_LIFT.optionalRecallAbsolute
  ) || bilingualLift(
    input.previous,
    input.current,
    "temporalAccuracy",
    MEMORY_PHASE7_MATERIAL_LIFT.optionalTemporalAbsolute
  );
  const safe = safetyPassed(input.current) &&
    criticalCohortsDoNotRegress(input.previous, input.current);
  const operational = input.latencyP95Ms <=
      MEMORY_PHASE7_MATERIAL_LIFT.optionalLatencyP95MsMaximum &&
    input.costUsdPerEligibleQuery <=
      MEMORY_PHASE7_MATERIAL_LIFT.optionalCostUsdPerEligibleQueryMaximum;
  return Object.freeze({
    enabled: lift && safe && operational,
    latencyAndCostPassed: operational,
    liftPassed: lift,
    safetyPassed: safe
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0 || !values.every(unit)) {
    throw new Error("memory_phase7_profile_input_invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export type MemoryPhase7ProfileDecision = Readonly<{
  enabled: boolean;
  exactSupportPassed: boolean;
  medianCompressionRatio: number;
  operationalPassed: boolean;
  russianLanguagePreservation: number;
  yieldRate: number;
}>;

export function memoryPhase7RussianTextPreservesLanguage(
  detectedLanguage: "en" | "mixed" | "ru" | "und"
): boolean {
  return detectedLanguage === "ru" || detectedLanguage === "mixed";
}

export function decideMemoryPhase7Profile(input: Readonly<{
  compressionRatios: readonly number[];
  eligibleCases: number;
  estimatedCostUsdPerProjection: number | null;
  latencyP95Ms: number;
  producedCases: number;
  russianLanguagePreserved: number;
  russianSegments: number;
  supportedSegments: number;
  totalSegments: number;
}>): MemoryPhase7ProfileDecision {
  if (
    !Number.isSafeInteger(input.eligibleCases) || input.eligibleCases < 1 ||
    !Number.isSafeInteger(input.producedCases) || input.producedCases < 0 ||
    input.producedCases > input.eligibleCases ||
    !Number.isSafeInteger(input.supportedSegments) || input.supportedSegments < 0 ||
    !Number.isSafeInteger(input.totalSegments) || input.totalSegments < 1 ||
    input.supportedSegments > input.totalSegments ||
    !Number.isSafeInteger(input.russianSegments) || input.russianSegments < 1 ||
    !Number.isSafeInteger(input.russianLanguagePreserved) ||
    input.russianLanguagePreserved < 0 ||
    input.russianLanguagePreserved > input.russianSegments ||
    !Number.isFinite(input.latencyP95Ms) || input.latencyP95Ms < 0 ||
    input.estimatedCostUsdPerProjection !== null &&
      (!Number.isFinite(input.estimatedCostUsdPerProjection) ||
        input.estimatedCostUsdPerProjection < 0)
  ) throw new Error("memory_phase7_profile_input_invalid");
  const compression = median(input.compressionRatios);
  const yieldRate = input.producedCases / input.eligibleCases;
  const russianLanguagePreservation = input.russianLanguagePreserved /
    input.russianSegments;
  const exactSupportPassed = input.supportedSegments === input.totalSegments;
  const operationalPassed = input.estimatedCostUsdPerProjection !== null &&
    input.latencyP95Ms <=
      MEMORY_PHASE7_MATERIAL_LIFT.profileRefreshLatencyP95MsMaximum &&
    input.estimatedCostUsdPerProjection <=
      MEMORY_PHASE7_MATERIAL_LIFT.profileCostUsdPerProjectionMaximum;
  const enabled = exactSupportPassed &&
    yieldRate >= MEMORY_PHASE7_MATERIAL_LIFT.profileEligibleYieldMinimum &&
    russianLanguagePreservation >=
      MEMORY_PHASE7_MATERIAL_LIFT.profileRussianLanguagePreservationMinimum &&
    compression <=
      MEMORY_PHASE7_MATERIAL_LIFT.profileMedianCompressionRatioMaximum &&
    operationalPassed;
  return Object.freeze({
    enabled,
    exactSupportPassed,
    medianCompressionRatio: compression,
    operationalPassed,
    russianLanguagePreservation,
    yieldRate
  });
}

export type MemoryPhase7HindsightDecision = Readonly<{
  factPrecisionGap: number;
  requiresFocusedQualityWork: boolean;
  russianRecallGap: number;
  similarFactRecall: boolean;
  temporalGap: number;
}>;

export function decideMemoryPhase7HindsightGap(input: Readonly<{
  native: Readonly<{
    factPrecision: number;
    factRecall: number;
    russianRecallAt5: number;
    temporalAccuracy: number;
  }>;
  reference: Readonly<{
    factPrecision: number;
    factRecall: number;
    russianRecallAt5: number;
    temporalAccuracy: number;
  }>;
}>): MemoryPhase7HindsightDecision {
  const values = [
    input.native.factPrecision,
    input.native.factRecall,
    input.native.russianRecallAt5,
    input.native.temporalAccuracy,
    input.reference.factPrecision,
    input.reference.factRecall,
    input.reference.russianRecallAt5,
    input.reference.temporalAccuracy
  ];
  if (!values.every(unit)) throw new Error("memory_phase7_hindsight_input_invalid");
  const russianRecallGap = input.reference.russianRecallAt5 -
    input.native.russianRecallAt5;
  const temporalGap = input.reference.temporalAccuracy -
    input.native.temporalAccuracy;
  const factPrecisionGap = input.reference.factPrecision - input.native.factPrecision;
  const similarFactRecall = Math.abs(
    input.reference.factRecall - input.native.factRecall
  ) <= MEMORY_PHASE7_MATERIAL_LIFT.criticalCohortMaximumRegression;
  return Object.freeze({
    factPrecisionGap,
    requiresFocusedQualityWork:
      russianRecallGap > MEMORY_PHASE7_MATERIAL_LIFT.hindsightRussianRecallGap ||
      temporalGap > MEMORY_PHASE7_MATERIAL_LIFT.hindsightTemporalGap ||
      similarFactRecall &&
        factPrecisionGap > MEMORY_PHASE7_MATERIAL_LIFT.hindsightFactPrecisionGap,
    russianRecallGap,
    similarFactRecall,
    temporalGap
  });
}

export function memoryPhase7EvidenceIdentityIsCurrent(input: Readonly<{
  bootstrapSamples: unknown;
  corpusHash: unknown;
  corpusVersion: unknown;
  evaluatorVersion: unknown;
  evidenceVersion: unknown;
  randomSeed: unknown;
  scorerVersion: unknown;
  suiteVersion: unknown;
}>): boolean {
  return input.bootstrapSamples === MEMORY_PHASE7_BOOTSTRAP_SAMPLES &&
    input.corpusHash === MEMORY_PHASE7_HOLDOUT_CORPUS_HASH &&
    input.corpusVersion === MEMORY_PHASE7_CORPUS_VERSION &&
    input.evaluatorVersion === MEMORY_PHASE7_EVALUATOR_VERSION &&
    input.evidenceVersion === MEMORY_PHASE7_EVIDENCE_VERSION &&
    input.randomSeed === MEMORY_PHASE7_RANDOM_SEED &&
    input.scorerVersion === MEMORY_PHASE7_SCORER_VERSION &&
    input.suiteVersion === MEMORY_PHASE7_SUITE_VERSION;
}
