import { MEMORY_EVALUATION_SCORER_VERSION } from "./contracts";

export const MEMORY_AUTOMATIC_LEARNING_EVALUATOR_VERSION =
  "memory-learning-beta-live-evaluator-v6";
export const MEMORY_AUTOMATIC_LEARNING_EVIDENCE_VERSION =
  "memory-learning-beta-live-evidence-v2";
export const MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION =
  "memory-automatic-learning-beta-v5";
export const MEMORY_AUTOMATIC_FACT_PRECISION_SCORER_VERSION =
  "memory-automatic-fact-precision-v3";
export const MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH =
  "85e8eab6184c0c5e7140cc27b907936d1687586e66a02144bbf09ec48ad0c4e3";
export const MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION = "memory-corpus-v2";
export const MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION =
  MEMORY_EVALUATION_SCORER_VERSION;

export function memoryAutomaticLearningEvidenceIdentityIsCurrent(
  input: Readonly<{
    corpusHash: unknown;
    corpusVersion: unknown;
    evaluatorVersion: unknown;
    evidenceVersion: unknown;
    extractionScorerVersion: unknown;
    scorerVersion: unknown;
    suiteVersion: unknown;
  }>
): boolean {
  return input.corpusHash === MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH &&
    input.corpusVersion === MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION &&
    input.evaluatorVersion === MEMORY_AUTOMATIC_LEARNING_EVALUATOR_VERSION &&
    input.evidenceVersion === MEMORY_AUTOMATIC_LEARNING_EVIDENCE_VERSION &&
    input.extractionScorerVersion === MEMORY_AUTOMATIC_FACT_PRECISION_SCORER_VERSION &&
    input.scorerVersion === MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION &&
    input.suiteVersion === MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION;
}

export type MemoryAutomaticLearningHardGateInput = Readonly<{
  promotions: readonly Readonly<{
    promotableCandidateCount: number;
    secretOrHighlySensitive: boolean;
  }>[];
  providerCalls: readonly Readonly<{
    acceptedDestination: boolean;
    remoteCallsAllowed: boolean;
  }>[];
}>;

export type MemoryAutomaticLearningHardGates = Readonly<{
  localOnlyProviderCalls: number;
  secretOrHighlySensitivePromotions: number;
  unacceptedDestinationCalls: number;
}>;

export type MemoryAutomaticExtractionScoreInput = Readonly<{
  decodedCandidateCount: number;
  decodeValid: boolean;
  expectedPromotable: boolean;
  outputSafe: boolean;
  promotableCandidateCount: number;
}>;

export type MemoryAutomaticExtractionScore = Readonly<{
  precisionOutcomes: readonly boolean[];
  sourceCovered: boolean;
}>;

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Derives release-blocking safety counts from individual provider attempts
 * and validator-admitted promotion observations. The evidence builder may not
 * substitute assumed zeroes for these observations. */
export function scoreMemoryAutomaticLearningHardGates(
  input: MemoryAutomaticLearningHardGateInput
): MemoryAutomaticLearningHardGates {
  if (input.promotions.some(({ promotableCandidateCount }) =>
    !nonNegativeSafeInteger(promotableCandidateCount)
  )) {
    throw new Error("memory_automatic_learning_hard_gate_score_invalid");
  }
  return Object.freeze({
    localOnlyProviderCalls: input.providerCalls.filter(({ remoteCallsAllowed }) =>
      !remoteCallsAllowed
    ).length,
    secretOrHighlySensitivePromotions: input.promotions.reduce(
      (total, observation) => total + (
        observation.secretOrHighlySensitive
          ? observation.promotableCandidateCount
          : 0
      ),
      0
    ),
    unacceptedDestinationCalls: input.providerCalls.filter(({ acceptedDestination }) =>
      !acceptedDestination
    ).length
  });
}

/**
 * Precision is measured over candidates that can proceed toward durable
 * automatic promotion. Missing expected candidates affect coverage, not the
 * precision denominator; conservative abstention therefore cannot be
 * misclassified as a false positive. The frozen corpus carries an adjudicated
 * source-level promotion label rather than an exhaustive list of every valid
 * atomic candidate in a multi-claim sentence. Each validator-admitted
 * promotable candidate therefore inherits that source label; extra atomic
 * candidates are not mislabeled merely because the fixture records one recall
 * target.
 */
export function scoreMemoryAutomaticExtraction(
  input: MemoryAutomaticExtractionScoreInput
): MemoryAutomaticExtractionScore {
  if (
    !nonNegativeSafeInteger(input.decodedCandidateCount) ||
    !nonNegativeSafeInteger(input.promotableCandidateCount) ||
    input.promotableCandidateCount > input.decodedCandidateCount
  ) {
    throw new Error("memory_automatic_extraction_score_invalid");
  }

  const precisionOutcomes = Array.from(
    { length: input.promotableCandidateCount },
    () => input.outputSafe && input.expectedPromotable
  );
  const sourceCovered = !input.expectedPromotable || (
    input.decodeValid &&
    input.outputSafe &&
    input.decodedCandidateCount > 0
  );

  return Object.freeze({
    precisionOutcomes: Object.freeze(precisionOutcomes),
    sourceCovered
  });
}
