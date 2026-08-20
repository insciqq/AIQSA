import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION,
  decodeKnowledgeSemanticGroundingPrediction,
  knowledgeSemanticClaimValidationText,
  knowledgeSemanticGroundingDecisions,
  segmentKnowledgeSemanticClaims,
  type KnowledgeSemanticGroundingClaim,
  type KnowledgeSemanticGroundingDecision,
  type KnowledgeSemanticGroundingPrediction
} from "../../lib/server/knowledge/semanticGrounding";
import { groundKnowledgeAnswer } from "../../lib/server/knowledge/grounding";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
  knowledgeSemanticGroundingFixtures,
  knowledgeSemanticGroundingSlices,
  type KnowledgeSemanticGroundingFixture,
  type KnowledgeSemanticGroundingLanguage,
  type KnowledgeSemanticGroundingSlice,
  type KnowledgeSemanticGroundingSplit
} from "./semanticGroundingFixtures";

export const KNOWLEDGE_SEMANTIC_GROUNDING_BENCHMARK_VERSION = 1 as const;

const knowledgeSemanticGroundingSplits = Object.freeze([
  "development", "calibration", "held_out", "blinded_review"
] as const satisfies readonly KnowledgeSemanticGroundingSplit[]);
const knowledgeSemanticGroundingLanguages = Object.freeze([
  "en", "ru"
] as const satisfies readonly KnowledgeSemanticGroundingLanguage[]);

/** Every declared semantic slice must have observed held-out evidence before
 * an aggregate can be considered a measured quality gate.  A zero-count slice
 * is unavailable evidence, never a perfect score. */
export const knowledgeSemanticGroundingMandatorySliceMinimums = Object.freeze(
  Object.fromEntries(knowledgeSemanticGroundingSlices.map((slice) => [slice, 1]))
) as Readonly<Record<KnowledgeSemanticGroundingSlice, number>>;

const knowledgeSemanticGroundingCalibrationDecisionMinimums = Object.freeze(
  Object.fromEntries(knowledgeSemanticGroundingDecisions.map((decision) => [decision, 15]))
) as Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;
const knowledgeSemanticGroundingFinalDecisionMinimums = Object.freeze(
  Object.fromEntries(knowledgeSemanticGroundingDecisions.map((decision) => [decision, 30]))
) as Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;

/**
 * Release evidence needs materially more than representation. These minima
 * are deliberately separate from the one-example structural coverage floor
 * above: repeated claims from one generated template cannot make a release
 * sample sufficient. They are frozen into the candidate manifest alongside
 * the metric thresholds.
 */
export const knowledgeSemanticGroundingReleaseSampleMinimums = Object.freeze({
  calibration: Object.freeze({
    claimCount: 80,
    decisionClaims: knowledgeSemanticGroundingCalibrationDecisionMinimums,
    languageClaimCount: 40,
    normalizedTemplateFamilyCount: 40
  }),
  finalEvaluation: Object.freeze({
    claimCount: 240,
    decisionClaims: knowledgeSemanticGroundingFinalDecisionMinimums,
    languageClaimCount: 120,
    normalizedTemplateFamilyCount: 120,
    sliceClaimCount: 30,
    sliceLanguageClaimCount: 15,
    sliceNormalizedTemplateFamilyCount: 12,
    sliceLanguageNormalizedTemplateFamilyCount: 8
  })
});

export const knowledgeSemanticGroundingQualityGates = Object.freeze({
  attributionAccuracyMinimum: 0.95,
  contradictionPrecisionMinimum: 0.95,
  contradictionRecallMinimum: 0.9,
  dateConsistencyAccuracyMinimum: 0.98,
  decisionAccuracyMinimum: 0.95,
  genericEntailmentAccuracyMinimum: 0.95,
  heldOutClaimMinimum: 100,
  languageAccuracyMinimum: 0.95,
  languageClaimMinimum: 30,
  locatorAccuracyMinimum: 1,
  contradictionClaimMinimum: 20,
  noAnswerAccuracyMinimum: 0.9,
  numericConsistencyAccuracyMinimum: 0.98,
  releaseSampleMinimums: knowledgeSemanticGroundingReleaseSampleMinimums,
  sliceClaimMinimums: knowledgeSemanticGroundingMandatorySliceMinimums,
  sliceLanguageClaimMinimum: 1,
  temporalFalseBlockerMaximum: 0,
  versionAttributionAccuracyMinimum: 0.95
});

export type KnowledgeSemanticGroundingPredictionSet = Readonly<{
  fixtureId: string;
  predictions: readonly unknown[];
}>;

export type KnowledgeSemanticGroundingCandidate = Readonly<{
  blockingEligible: boolean;
  independentLabelReviewComplete: boolean;
  profile: string;
  semanticProof: boolean;
  version: number;
}>;

export const KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_CORPUS_AUDIT_VERSION = 1 as const;

export type KnowledgeSemanticGroundingReleaseCorpusAuditReason =
  | "exact_document_family_split_leakage"
  | "normalized_template_family_split_leakage"
  | "calibration_claim_count_below_release_minimum"
  | "calibration_decision_coverage_below_release_minimum"
  | "calibration_language_coverage_below_release_minimum"
  | "calibration_template_family_count_below_release_minimum"
  | "held_out_claim_count_below_release_minimum"
  | "held_out_decision_coverage_below_release_minimum"
  | "held_out_language_coverage_below_release_minimum"
  | "held_out_slice_coverage_below_release_minimum"
  | "held_out_slice_language_coverage_below_release_minimum"
  | "held_out_slice_template_family_coverage_below_release_minimum"
  | "held_out_slice_language_template_family_coverage_below_release_minimum"
  | "held_out_template_family_count_below_release_minimum"
  | "blinded_review_claim_count_below_release_minimum"
  | "blinded_review_decision_coverage_below_release_minimum"
  | "blinded_review_language_coverage_below_release_minimum"
  | "blinded_review_slice_coverage_below_release_minimum"
  | "blinded_review_slice_language_coverage_below_release_minimum"
  | "blinded_review_slice_template_family_coverage_below_release_minimum"
  | "blinded_review_slice_language_template_family_coverage_below_release_minimum"
  | "blinded_review_template_family_count_below_release_minimum";

export type KnowledgeSemanticGroundingReleaseCorpusAuditFixture = Readonly<{
  documentFamily: string;
  id: string;
  labels: readonly Readonly<{
    decision: KnowledgeSemanticGroundingDecision;
    slices: readonly KnowledgeSemanticGroundingSlice[];
  }>[];
  language: KnowledgeSemanticGroundingLanguage;
  split: KnowledgeSemanticGroundingSplit;
}>;

type ReleaseCorpusSliceSample = Readonly<{
  claimCount: number;
  languageClaims: Readonly<Record<KnowledgeSemanticGroundingLanguage, number>>;
  languageNormalizedTemplateFamilies: Readonly<
    Record<KnowledgeSemanticGroundingLanguage, number>
  >;
  normalizedTemplateFamilyCount: number;
}>;

type ReleaseCorpusSplitSample = Readonly<{
  claimCount: number;
  decisionClaims: Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;
  documentFamilyCount: number;
  languageClaims: Readonly<Record<KnowledgeSemanticGroundingLanguage, number>>;
  normalizedTemplateFamilyCount: number;
  slices: Readonly<Record<KnowledgeSemanticGroundingSlice, ReleaseCorpusSliceSample>>;
}>;

export type KnowledgeSemanticGroundingReleaseCorpusAudit = Readonly<{
  automatedGateEligible: boolean;
  independentReviewGateEligible: boolean;
  reasonCodes: readonly KnowledgeSemanticGroundingReleaseCorpusAuditReason[];
  releaseGateEligible: boolean;
  samples: Readonly<{
    blindedReview: ReleaseCorpusSplitSample;
    calibration: ReleaseCorpusSplitSample;
    heldOut: ReleaseCorpusSplitSample;
  }>;
  splitIntegrity: Readonly<{
    exactDocumentFamilyCollisionCount: number;
    exactDocumentFamilySplitDisjoint: boolean;
    normalizedTemplateFamilyCollisionCount: number;
    normalizedTemplateFamilySplitDisjoint: boolean;
  }>;
  version: typeof KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_CORPUS_AUDIT_VERSION;
}>;

type Accuracy = Readonly<{
  accuracy: number;
  count: number;
}>;

type LanguageAccuracy = Accuracy & Readonly<{
  attributionAccuracy: number;
  contradictionPrecision: number;
  contradictionRecall: number;
  genericEntailmentAccuracy: number;
  noAnswerAccuracy: number;
}>;

type SliceAccuracy = Accuracy & Readonly<{
  attributionAccuracy: number;
}>;

type ConfusionMatrix = Readonly<Record<
  KnowledgeSemanticGroundingDecision,
  Readonly<Record<KnowledgeSemanticGroundingDecision, number>>
>>;

export type KnowledgeSemanticGroundingBenchmarkReport = Readonly<{
  blockingEligible: boolean;
  candidate: KnowledgeSemanticGroundingCandidate;
  claimCount: number;
  confusionMatrix: ConfusionMatrix;
  contractValid: true;
  contractVersion: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION;
  corpus: Readonly<{
    fixtureCount: number;
    labelProvenance: "generated_single_annotator";
    languages: Readonly<Record<KnowledgeSemanticGroundingLanguage, number>>;
    releaseEvidence: KnowledgeSemanticGroundingReleaseCorpusAudit;
    splitClaims: Readonly<Record<KnowledgeSemanticGroundingSplit, number>>;
    splitFixtures: Readonly<Record<KnowledgeSemanticGroundingSplit, number>>;
    version: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION;
  }>;
  gates: typeof knowledgeSemanticGroundingQualityGates;
  limitations: readonly (
    | "normalized_text_fixtures_only"
    | "held_out_sample_below_release_minimum"
    | "no_independent_blinded_review"
    | "no_model_latency_cost_egress_measurement"
    | "normalized_template_family_split_leakage"
    | "prose_clause_segmentation_not_complete"
    | "release_sample_sufficiency_not_met"
    | "structural_baseline_not_semantic"
    | "synthetic_single_annotator_labels"
    | "table_row_inheritance_single_handle_only"
  )[];
  metrics: Readonly<{
    attributionAccuracy: number;
    contradictionPrecision: number;
    contradictionRecall: number;
    dateConsistencyAccuracy: number;
    decisionAccuracy: number;
    factualCorrectness: number;
    genericEntailmentAccuracy: number;
    groundedCorrectness: number;
    languages: Readonly<Record<KnowledgeSemanticGroundingLanguage, LanguageAccuracy>>;
    locatorAccuracy: number;
    noAnswerAccuracy: number;
    numericConsistencyAccuracy: number;
    scope: "held_out";
    slices: Readonly<Record<KnowledgeSemanticGroundingSlice, SliceAccuracy>>;
    splits: Readonly<Record<KnowledgeSemanticGroundingSplit, Accuracy>>;
    temporalFalseBlockers: number;
    versionAttributionAccuracy: number;
  }>;
  predictionDistribution: Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;
  releaseGatePassed: false;
  semanticProof: false;
  semanticQualityGatePassed: boolean;
  version: typeof KNOWLEDGE_SEMANTIC_GROUNDING_BENCHMARK_VERSION;
}>;

type ScoredClaim = Readonly<{
  attributionCorrect: boolean;
  decisionCorrect: boolean;
  expected: KnowledgeSemanticGroundingDecision;
  fixture: KnowledgeSemanticGroundingFixture;
  predicted: KnowledgeSemanticGroundingDecision;
  slices: readonly KnowledgeSemanticGroundingSlice[];
  type: KnowledgeSemanticGroundingClaim["type"];
}>;

function round(value: number): number {
  return Number(value.toFixed(6));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function accuracy(claims: readonly ScoredClaim[]): Accuracy {
  return Object.freeze({
    // Missing evidence is unavailable, not a vacuous pass.
    accuracy: claims.length === 0
      ? 0
      : round(claims.filter((claim) => claim.decisionCorrect).length / claims.length),
    count: claims.length
  });
}

function sliceAccuracy(claims: readonly ScoredClaim[]): SliceAccuracy {
  return Object.freeze({
    ...accuracy(claims),
    attributionAccuracy: claims.length === 0
      ? 0
      : round(claims.filter((claim) => claim.attributionCorrect).length / claims.length)
  });
}

function predictionCount(
  claims: readonly ScoredClaim[],
  decision: KnowledgeSemanticGroundingDecision
): number {
  return claims.filter((claim) => claim.predicted === decision).length;
}

function ratio(numerator: number, denominator: number): number {
  // A zero denominator means the metric was not measured.  Returning one
  // would let an absent contradiction/slice satisfy a release gate.
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function confusionMatrix(claims: readonly ScoredClaim[]): ConfusionMatrix {
  return Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((expected) => [
    expected,
    Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((predicted) => [
      predicted,
      claims.filter((claim) => claim.expected === expected && claim.predicted === predicted).length
    ])))
  ])) as Record<
    KnowledgeSemanticGroundingDecision,
    Readonly<Record<KnowledgeSemanticGroundingDecision, number>>
  >);
}

function languageAccuracy(claims: readonly ScoredClaim[]): LanguageAccuracy {
  const predictedContradictions = claims.filter((claim) => claim.predicted === "contradicted");
  const expectedContradictions = claims.filter((claim) => claim.expected === "contradicted");
  const correctContradictions = expectedContradictions.filter((claim) =>
    claim.predicted === "contradicted").length;
  return Object.freeze({
    ...accuracy(claims),
    attributionAccuracy: ratio(
      claims.filter((claim) => claim.attributionCorrect).length,
      claims.length
    ),
    contradictionPrecision: ratio(correctContradictions, predictedContradictions.length),
    contradictionRecall: ratio(correctContradictions, expectedContradictions.length),
    genericEntailmentAccuracy: accuracy(claims.filter((claim) =>
      claim.slices.includes("generic_entailment"))).accuracy,
    noAnswerAccuracy: accuracy(claims.filter((claim) => claim.slices.includes("no_answer"))).accuracy
  });
}

const splitPrefixTokens = new Set([
  "blind", "blinded", "cal", "calibration", "dev", "development", "held", "heldout"
]);
const languageTokens = new Set(["en", "english", "ru", "russian"]);

function stripSplitPrefix(tokens: readonly string[]): string[] {
  const remaining = [...tokens];
  if ((remaining[0] === "blinded" && remaining[1] === "review") ||
    (remaining[0] === "held" && remaining[1] === "out")) {
    remaining.splice(0, 2);
  } else if (remaining[0] && splitPrefixTokens.has(remaining[0])) {
    remaining.shift();
  }
  return remaining;
}

function normalizedTemplateTokens(value: string): string[] {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .split("-")
    .filter(Boolean)
    .map((token) => /^\p{N}+$/u.test(token) ? "n" : token);
}

function normalizedTemplateFamilySignature(
  fixture: KnowledgeSemanticGroundingReleaseCorpusAuditFixture
): string {
  const familyTokens = normalizedTemplateTokens(fixture.documentFamily);
  const fixtureIdTokens = normalizedTemplateTokens(fixture.id);
  const matrixGenerated = familyTokens[0] === "matrix";
  if (matrixGenerated) familyTokens.shift();
  let normalizedFamily = stripSplitPrefix(familyTokens);

  if (matrixGenerated) {
    // The checked-in matrix shape is <split>-<row>-<language>-<scenario>.
    // Row names, ordinals and split aliases are data variants, not independent
    // template families. The fixture id is checked as a second shape source so
    // merely renaming documentFamily cannot conceal a dev/blind collision.
    const normalizedId = stripSplitPrefix(fixtureIdTokens);
    if (normalizedFamily.length >= 3 && languageTokens.has(normalizedFamily[1]!)) {
      normalizedFamily = normalizedFamily.slice(2);
    }
    const normalizedIdScenario = normalizedId.length >= 3 && languageTokens.has(normalizedId[1]!)
      ? normalizedId.slice(2)
      : normalizedId;
    const familyScenario = normalizedFamily.join("-");
    const idScenario = normalizedIdScenario.join("-");
    return `matrix:${familyScenario === idScenario
      ? familyScenario
      : [familyScenario, idScenario].sort().join("|")}`;
  }

  normalizedFamily = normalizedFamily.length > 0
    ? normalizedFamily
    : stripSplitPrefix(fixtureIdTokens);
  return `family:${normalizedFamily.join("-")}`;
}

function collisionCount(
  fixtures: readonly KnowledgeSemanticGroundingReleaseCorpusAuditFixture[],
  identity: (fixture: KnowledgeSemanticGroundingReleaseCorpusAuditFixture) => string
): number {
  const splitsByIdentity = new Map<string, Set<KnowledgeSemanticGroundingSplit>>();
  for (const fixture of fixtures) {
    const fixtureIdentity = identity(fixture);
    const splits = splitsByIdentity.get(fixtureIdentity) ??
      new Set<KnowledgeSemanticGroundingSplit>();
    splits.add(fixture.split);
    splitsByIdentity.set(fixtureIdentity, splits);
  }
  return [...splitsByIdentity.values()].filter((splits) => splits.size > 1).length;
}

function releaseCorpusSplitSample(
  fixtures: readonly KnowledgeSemanticGroundingReleaseCorpusAuditFixture[],
  split: KnowledgeSemanticGroundingSplit
): ReleaseCorpusSplitSample {
  const splitFixtures = fixtures.filter((fixture) => fixture.split === split);
  const claimEntries = splitFixtures.flatMap((fixture) => fixture.labels.map((label) =>
    Object.freeze({ fixture, label })));
  const languageClaims = Object.freeze(Object.fromEntries(
    knowledgeSemanticGroundingLanguages.map((language) => [
      language,
      claimEntries.filter((entry) => entry.fixture.language === language).length
    ])
  )) as Readonly<Record<KnowledgeSemanticGroundingLanguage, number>>;
  const decisionClaims = Object.freeze(Object.fromEntries(
    knowledgeSemanticGroundingDecisions.map((decision) => [
      decision,
      claimEntries.filter((entry) => entry.label.decision === decision).length
    ])
  )) as Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;
  const slices = Object.freeze(Object.fromEntries(knowledgeSemanticGroundingSlices.map((slice) => {
    const sliceEntries = claimEntries.filter((entry) => entry.label.slices.includes(slice));
    const sliceFixtures = new Set(sliceEntries.map((entry) => entry.fixture));
    const languageSliceFixtures = (language: KnowledgeSemanticGroundingLanguage) =>
      new Set(sliceEntries.filter((entry) => entry.fixture.language === language)
        .map((entry) => entry.fixture));
    return [slice, Object.freeze({
      claimCount: sliceEntries.length,
      languageClaims: Object.freeze(Object.fromEntries(
        knowledgeSemanticGroundingLanguages.map((language) => [
          language,
          sliceEntries.filter((entry) => entry.fixture.language === language).length
        ])
      )) as Readonly<Record<KnowledgeSemanticGroundingLanguage, number>>,
      languageNormalizedTemplateFamilies: Object.freeze(Object.fromEntries(
        knowledgeSemanticGroundingLanguages.map((language) => [
          language,
          new Set([...languageSliceFixtures(language)].map((fixture) =>
            normalizedTemplateFamilySignature(fixture))).size
        ])
      )) as Readonly<Record<KnowledgeSemanticGroundingLanguage, number>>,
      normalizedTemplateFamilyCount: new Set([...sliceFixtures].map((fixture) =>
        normalizedTemplateFamilySignature(fixture))).size
    })];
  }))) as Readonly<Record<KnowledgeSemanticGroundingSlice, ReleaseCorpusSliceSample>>;

  return Object.freeze({
    claimCount: claimEntries.length,
    decisionClaims,
    documentFamilyCount: new Set(splitFixtures.map((fixture) => fixture.documentFamily)).size,
    languageClaims,
    normalizedTemplateFamilyCount: new Set(splitFixtures.map((fixture) =>
      normalizedTemplateFamilySignature(fixture))).size,
    slices
  });
}

function calibrationSampleReasons(
  sample: ReleaseCorpusSplitSample
): readonly KnowledgeSemanticGroundingReleaseCorpusAuditReason[] {
  const minimums = knowledgeSemanticGroundingReleaseSampleMinimums.calibration;
  const reasons: KnowledgeSemanticGroundingReleaseCorpusAuditReason[] = [];
  if (sample.claimCount < minimums.claimCount) {
    reasons.push("calibration_claim_count_below_release_minimum");
  }
  if (knowledgeSemanticGroundingDecisions.some((decision) =>
    sample.decisionClaims[decision] < minimums.decisionClaims[decision])) {
    reasons.push("calibration_decision_coverage_below_release_minimum");
  }
  if (knowledgeSemanticGroundingLanguages.some((language) =>
    sample.languageClaims[language] < minimums.languageClaimCount)) {
    reasons.push("calibration_language_coverage_below_release_minimum");
  }
  if (sample.normalizedTemplateFamilyCount < minimums.normalizedTemplateFamilyCount) {
    reasons.push("calibration_template_family_count_below_release_minimum");
  }
  return Object.freeze(reasons);
}

function finalEvaluationSampleReasons(
  sample: ReleaseCorpusSplitSample,
  split: "held_out" | "blinded_review"
): readonly KnowledgeSemanticGroundingReleaseCorpusAuditReason[] {
  const minimums = knowledgeSemanticGroundingReleaseSampleMinimums.finalEvaluation;
  const prefix = split === "held_out" ? "held_out" : "blinded_review";
  const reasons: KnowledgeSemanticGroundingReleaseCorpusAuditReason[] = [];
  if (sample.claimCount < minimums.claimCount) {
    reasons.push(`${prefix}_claim_count_below_release_minimum`);
  }
  if (knowledgeSemanticGroundingDecisions.some((decision) =>
    sample.decisionClaims[decision] < minimums.decisionClaims[decision])) {
    reasons.push(`${prefix}_decision_coverage_below_release_minimum`);
  }
  if (knowledgeSemanticGroundingLanguages.some((language) =>
    sample.languageClaims[language] < minimums.languageClaimCount)) {
    reasons.push(`${prefix}_language_coverage_below_release_minimum`);
  }
  if (sample.normalizedTemplateFamilyCount < minimums.normalizedTemplateFamilyCount) {
    reasons.push(`${prefix}_template_family_count_below_release_minimum`);
  }
  if (knowledgeSemanticGroundingSlices.some((slice) =>
    sample.slices[slice].claimCount < minimums.sliceClaimCount)) {
    reasons.push(`${prefix}_slice_coverage_below_release_minimum`);
  }
  if (knowledgeSemanticGroundingSlices.some((slice) =>
    knowledgeSemanticGroundingLanguages.some((language) =>
      sample.slices[slice].languageClaims[language] < minimums.sliceLanguageClaimCount))) {
    reasons.push(`${prefix}_slice_language_coverage_below_release_minimum`);
  }
  if (knowledgeSemanticGroundingSlices.some((slice) =>
    sample.slices[slice].normalizedTemplateFamilyCount <
      minimums.sliceNormalizedTemplateFamilyCount)) {
    reasons.push(`${prefix}_slice_template_family_coverage_below_release_minimum`);
  }
  if (knowledgeSemanticGroundingSlices.some((slice) =>
    knowledgeSemanticGroundingLanguages.some((language) =>
      sample.slices[slice].languageNormalizedTemplateFamilies[language] <
        minimums.sliceLanguageNormalizedTemplateFamilyCount))) {
    reasons.push(`${prefix}_slice_language_template_family_coverage_below_release_minimum`);
  }
  return Object.freeze(reasons);
}

export function auditKnowledgeSemanticGroundingReleaseCorpus(
  fixtures: readonly KnowledgeSemanticGroundingReleaseCorpusAuditFixture[] =
  knowledgeSemanticGroundingFixtures
): KnowledgeSemanticGroundingReleaseCorpusAudit {
  const exactDocumentFamilyCollisionCount = collisionCount(
    fixtures,
    (fixture) => fixture.documentFamily
  );
  const normalizedTemplateFamilyCollisionCount = collisionCount(
    fixtures,
    normalizedTemplateFamilySignature
  );
  const splitIntegrityReasons: KnowledgeSemanticGroundingReleaseCorpusAuditReason[] = [];
  if (exactDocumentFamilyCollisionCount > 0) {
    splitIntegrityReasons.push("exact_document_family_split_leakage");
  }
  if (normalizedTemplateFamilyCollisionCount > 0) {
    splitIntegrityReasons.push("normalized_template_family_split_leakage");
  }
  const calibration = releaseCorpusSplitSample(fixtures, "calibration");
  const heldOut = releaseCorpusSplitSample(fixtures, "held_out");
  const blindedReview = releaseCorpusSplitSample(fixtures, "blinded_review");
  const calibrationReasons = calibrationSampleReasons(calibration);
  const heldOutReasons = finalEvaluationSampleReasons(heldOut, "held_out");
  const blindedReviewReasons = finalEvaluationSampleReasons(blindedReview, "blinded_review");
  const automatedGateEligible = splitIntegrityReasons.length === 0 &&
    calibrationReasons.length === 0 && heldOutReasons.length === 0;
  const independentReviewGateEligible = splitIntegrityReasons.length === 0 &&
    blindedReviewReasons.length === 0;

  return Object.freeze({
    automatedGateEligible,
    independentReviewGateEligible,
    reasonCodes: Object.freeze([
      ...splitIntegrityReasons,
      ...calibrationReasons,
      ...heldOutReasons,
      ...blindedReviewReasons
    ]),
    releaseGateEligible: automatedGateEligible && independentReviewGateEligible,
    samples: Object.freeze({ blindedReview, calibration, heldOut }),
    splitIntegrity: Object.freeze({
      exactDocumentFamilyCollisionCount,
      exactDocumentFamilySplitDisjoint: exactDocumentFamilyCollisionCount === 0,
      normalizedTemplateFamilyCollisionCount,
      normalizedTemplateFamilySplitDisjoint: normalizedTemplateFamilyCollisionCount === 0
    }),
    version: KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_CORPUS_AUDIT_VERSION
  });
}

export function assertKnowledgeSemanticGroundingReleaseCorpusEligible(
  audit: KnowledgeSemanticGroundingReleaseCorpusAudit
): void {
  if (!audit.releaseGateEligible) {
    throw new Error(`knowledge_semantic_release_corpus_ineligible:${audit.reasonCodes.join(",")}`);
  }
}

function validateCorpus(): ReadonlyMap<string, readonly KnowledgeSemanticGroundingClaim[]> {
  const ids = new Set<string>();
  const familiesBySplit = Object.fromEntries(knowledgeSemanticGroundingSplits.map((split) => [
    split,
    new Set<string>()
  ])) as Record<KnowledgeSemanticGroundingSplit, Set<string>>;
  const languagesBySplit = Object.fromEntries(knowledgeSemanticGroundingSplits.map((split) => [
    split,
    new Set<KnowledgeSemanticGroundingLanguage>()
  ])) as Record<KnowledgeSemanticGroundingSplit,
    Set<KnowledgeSemanticGroundingLanguage>>;
  const heldOutSlices = new Set<KnowledgeSemanticGroundingSlice>();
  const claimsByFixture = new Map<string, readonly KnowledgeSemanticGroundingClaim[]>();

  for (const fixture of knowledgeSemanticGroundingFixtures) {
    if (ids.has(fixture.id)) throw new Error("knowledge_semantic_fixture_id_duplicate");
    ids.add(fixture.id);
    familiesBySplit[fixture.split].add(fixture.documentFamily);
    languagesBySplit[fixture.split].add(fixture.language);
    if (fixture.split === "held_out") {
      fixture.labels.forEach((label) => label.slices.forEach((slice) => heldOutSlices.add(slice)));
    }
    const claims = segmentKnowledgeSemanticClaims({
      answer: fixture.answer,
      evidence: fixture.evidence
    });
    if (claims.length !== fixture.labels.length) {
      throw new Error(`knowledge_semantic_claim_count_mismatch:${fixture.id}`);
    }
    for (const [index, label] of fixture.labels.entries()) {
      const claim = claims[index];
      if (!claim || label.claimOrdinal !== index + 1 || claim.ordinal !== label.claimOrdinal ||
        claim.type !== label.type || !sameSet(claim.citationHandles, label.attributableHandles)) {
        throw new Error(`knowledge_semantic_claim_contract_mismatch:${fixture.id}:${index + 1}`);
      }
    }
    claimsByFixture.set(fixture.id, claims);
  }

  for (const leftSplit of knowledgeSemanticGroundingSplits) {
    for (const rightSplit of knowledgeSemanticGroundingSplits) {
      if (leftSplit >= rightSplit) continue;
      if ([...familiesBySplit[leftSplit]].some((family) =>
        familiesBySplit[rightSplit].has(family))) {
        throw new Error("knowledge_semantic_document_family_split_leakage");
      }
    }
  }
  for (const split of knowledgeSemanticGroundingSplits) {
    // Empty development/blinded pools are represented explicitly and fail
    // the measured gate later; populated pools must contain both languages.
    if (languagesBySplit[split].size > 0 &&
      (!languagesBySplit[split].has("en") || !languagesBySplit[split].has("ru"))) {
      throw new Error(`knowledge_semantic_language_split_incomplete:${split}`);
    }
  }
  for (const slice of knowledgeSemanticGroundingSlices) {
    if (!heldOutSlices.has(slice)) throw new Error(`knowledge_semantic_held_out_slice_missing:${slice}`);
  }
  return claimsByFixture;
}

function validatePredictions(
  predictionSets: readonly KnowledgeSemanticGroundingPredictionSet[],
  claimsByFixture: ReadonlyMap<string, readonly KnowledgeSemanticGroundingClaim[]>
): ReadonlyMap<string, readonly KnowledgeSemanticGroundingPrediction[]> {
  const sets = new Map<string, readonly KnowledgeSemanticGroundingPrediction[]>();
  for (const set of predictionSets) {
    if (sets.has(set.fixtureId)) throw new Error("knowledge_semantic_prediction_set_duplicate");
    const claims = claimsByFixture.get(set.fixtureId);
    if (!claims) throw new Error("knowledge_semantic_prediction_fixture_unknown");
    if (claims.length !== set.predictions.length) {
      throw new Error(`knowledge_semantic_prediction_count_mismatch:${set.fixtureId}`);
    }
    const decoded = set.predictions.map((prediction, index) => {
      const result = decodeKnowledgeSemanticGroundingPrediction(claims[index]!, prediction);
      if (!result) {
        throw new Error(`knowledge_semantic_prediction_invalid:${set.fixtureId}:${index + 1}`);
      }
      return result;
    });
    sets.set(set.fixtureId, Object.freeze(decoded));
  }
  if (sets.size !== knowledgeSemanticGroundingFixtures.length) {
    throw new Error("knowledge_semantic_prediction_fixture_coverage_incomplete");
  }
  return sets;
}

function assertCandidate(candidate: KnowledgeSemanticGroundingCandidate): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/u.test(candidate.profile) ||
    !Number.isSafeInteger(candidate.version) || candidate.version < 1 ||
    typeof candidate.semanticProof !== "boolean" ||
    typeof candidate.blockingEligible !== "boolean" ||
    typeof candidate.independentLabelReviewComplete !== "boolean" ||
    candidate.semanticProof || candidate.blockingEligible ||
    candidate.independentLabelReviewComplete) {
    throw new Error("knowledge_semantic_candidate_invalid");
  }
}

export function scoreKnowledgeSemanticGroundingPredictions(input: Readonly<{
  candidate: KnowledgeSemanticGroundingCandidate;
  predictions: readonly KnowledgeSemanticGroundingPredictionSet[];
}>): KnowledgeSemanticGroundingBenchmarkReport {
  assertCandidate(input.candidate);
  const claimsByFixture = validateCorpus();
  const releaseEvidence = auditKnowledgeSemanticGroundingReleaseCorpus();
  const releaseSampleSufficiencyNotMet = releaseEvidence.reasonCodes.some((reason) =>
    reason !== "exact_document_family_split_leakage" &&
    reason !== "normalized_template_family_split_leakage");
  const predictions = validatePredictions(input.predictions, claimsByFixture);
  const scored: ScoredClaim[] = [];
  for (const fixture of knowledgeSemanticGroundingFixtures) {
    const fixturePredictions = predictions.get(fixture.id)!;
    for (const [index, label] of fixture.labels.entries()) {
      const prediction = fixturePredictions[index]!;
      scored.push(Object.freeze({
        attributionCorrect: sameSet(prediction.attributableHandles, label.attributableHandles),
        decisionCorrect: prediction.decision === label.decision,
        expected: label.decision,
        fixture,
        predicted: prediction.decision,
        slices: label.slices,
        type: label.type
      }));
    }
  }

  const heldOutScored = scored.filter((claim) => claim.fixture.split === "held_out");
  const bySlice = Object.freeze(Object.fromEntries(knowledgeSemanticGroundingSlices.map((slice) => [
    slice,
    sliceAccuracy(heldOutScored.filter((claim) => claim.slices.includes(slice)))
  ])) as Record<KnowledgeSemanticGroundingSlice, SliceAccuracy>);
  const byLanguage = Object.freeze(Object.fromEntries((["en", "ru"] as const).map((language) => [
    language,
    languageAccuracy(heldOutScored.filter((claim) => claim.fixture.language === language))
  ])) as Record<KnowledgeSemanticGroundingLanguage, LanguageAccuracy>);
  const bySplit = Object.freeze(Object.fromEntries(([
    "development", "calibration", "held_out", "blinded_review"
  ] as const)
    .map((split) => [
      split,
      accuracy(scored.filter((claim) => claim.fixture.split === split))
    ])) as Record<KnowledgeSemanticGroundingSplit, Accuracy>);
  const predictedContradictions = heldOutScored.filter((claim) =>
    claim.predicted === "contradicted");
  const expectedContradictions = heldOutScored.filter((claim) =>
    claim.expected === "contradicted");
  const correctContradictions = expectedContradictions.filter((claim) =>
    claim.predicted === "contradicted").length;
  const temporalFalseBlockers = heldOutScored.filter((claim) =>
    claim.slices.includes("temporal_non_contradiction") && claim.expected === "supported" &&
    claim.predicted !== "supported").length;
  const attributionAccuracy = ratio(
    heldOutScored.filter((claim) => claim.attributionCorrect).length,
    heldOutScored.length
  );
  const decisionAccuracy = accuracy(heldOutScored).accuracy;
  const groundedCorrectness = ratio(
    heldOutScored.filter((claim) => claim.decisionCorrect && claim.attributionCorrect).length,
    heldOutScored.length
  );
  const metrics = Object.freeze({
    attributionAccuracy,
    contradictionPrecision: ratio(correctContradictions, predictedContradictions.length),
    contradictionRecall: ratio(correctContradictions, expectedContradictions.length),
    dateConsistencyAccuracy: bySlice.date_consistency.accuracy,
    decisionAccuracy,
    factualCorrectness: accuracy(heldOutScored.filter((claim) =>
      claim.type !== "source_summary")).accuracy,
    genericEntailmentAccuracy: bySlice.generic_entailment.accuracy,
    groundedCorrectness,
    languages: byLanguage,
    locatorAccuracy: bySlice.locator_correctness.accuracy,
    noAnswerAccuracy: bySlice.no_answer.accuracy,
    numericConsistencyAccuracy: bySlice.numeric_consistency.accuracy,
    scope: "held_out" as const,
    slices: bySlice,
    splits: bySplit,
    temporalFalseBlockers,
    versionAttributionAccuracy: bySlice.version_attribution.accuracy
  });
  const metricThresholdsPassed =
    metrics.attributionAccuracy >= knowledgeSemanticGroundingQualityGates.attributionAccuracyMinimum &&
    metrics.contradictionPrecision >=
      knowledgeSemanticGroundingQualityGates.contradictionPrecisionMinimum &&
    metrics.contradictionRecall >= knowledgeSemanticGroundingQualityGates.contradictionRecallMinimum &&
    metrics.dateConsistencyAccuracy >=
      knowledgeSemanticGroundingQualityGates.dateConsistencyAccuracyMinimum &&
    metrics.decisionAccuracy >= knowledgeSemanticGroundingQualityGates.decisionAccuracyMinimum &&
    metrics.genericEntailmentAccuracy >=
      knowledgeSemanticGroundingQualityGates.genericEntailmentAccuracyMinimum &&
    metrics.locatorAccuracy >= knowledgeSemanticGroundingQualityGates.locatorAccuracyMinimum &&
    metrics.noAnswerAccuracy >= knowledgeSemanticGroundingQualityGates.noAnswerAccuracyMinimum &&
    metrics.numericConsistencyAccuracy >=
      knowledgeSemanticGroundingQualityGates.numericConsistencyAccuracyMinimum &&
    metrics.temporalFalseBlockers <=
      knowledgeSemanticGroundingQualityGates.temporalFalseBlockerMaximum &&
    metrics.versionAttributionAccuracy >=
      knowledgeSemanticGroundingQualityGates.versionAttributionAccuracyMinimum &&
    knowledgeSemanticGroundingSlices.every((slice) =>
      metrics.slices[slice].count >=
        knowledgeSemanticGroundingQualityGates.sliceClaimMinimums[slice] &&
      (["en", "ru"] as const).every((language) => {
        const claims = heldOutScored.filter((claim) =>
          claim.fixture.language === language && claim.slices.includes(slice));
        return claims.length >= knowledgeSemanticGroundingQualityGates.sliceLanguageClaimMinimum;
      })) &&
    heldOutScored.length >= knowledgeSemanticGroundingQualityGates.heldOutClaimMinimum &&
    expectedContradictions.length >=
      knowledgeSemanticGroundingQualityGates.contradictionClaimMinimum &&
    Object.values(metrics.languages).every((slice) =>
      slice.accuracy >= knowledgeSemanticGroundingQualityGates.languageAccuracyMinimum &&
      slice.count >= knowledgeSemanticGroundingQualityGates.languageClaimMinimum);
  const semanticQualityGatePassed = metricThresholdsPassed &&
    releaseEvidence.automatedGateEligible &&
    input.candidate.independentLabelReviewComplete;
  const fixtureCount = knowledgeSemanticGroundingFixtures.length;
  const languageFixtureCount = (language: KnowledgeSemanticGroundingLanguage): number =>
    knowledgeSemanticGroundingFixtures.filter((fixture) => fixture.language === language).length;
  const splitFixtureCount = (split: KnowledgeSemanticGroundingSplit): number =>
    knowledgeSemanticGroundingFixtures.filter((fixture) => fixture.split === split).length;
  const splitClaimCount = (split: KnowledgeSemanticGroundingSplit): number =>
    scored.filter((claim) => claim.fixture.split === split).length;

  return Object.freeze({
    blockingEligible: false,
    candidate: Object.freeze({ ...input.candidate }),
    claimCount: scored.length,
    confusionMatrix: confusionMatrix(heldOutScored),
    contractValid: true,
    contractVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION,
    corpus: Object.freeze({
      fixtureCount,
      labelProvenance: "generated_single_annotator" as const,
      languages: Object.freeze({ en: languageFixtureCount("en"), ru: languageFixtureCount("ru") }),
      releaseEvidence,
      splitClaims: Object.freeze({
        development: splitClaimCount("development"),
        calibration: splitClaimCount("calibration"),
        held_out: splitClaimCount("held_out"),
        blinded_review: splitClaimCount("blinded_review")
      }),
      splitFixtures: Object.freeze({
        development: splitFixtureCount("development"),
        calibration: splitFixtureCount("calibration"),
        held_out: splitFixtureCount("held_out"),
        blinded_review: splitFixtureCount("blinded_review")
      }),
      version: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION
    }),
    gates: knowledgeSemanticGroundingQualityGates,
    limitations: Object.freeze([
      "normalized_text_fixtures_only" as const,
      "no_independent_blinded_review" as const,
      "no_model_latency_cost_egress_measurement" as const,
      ...(!releaseEvidence.splitIntegrity.normalizedTemplateFamilySplitDisjoint
        ? ["normalized_template_family_split_leakage" as const]
        : []),
      "prose_clause_segmentation_not_complete" as const,
      ...(releaseSampleSufficiencyNotMet
        ? ["release_sample_sufficiency_not_met" as const]
        : []),
      "structural_baseline_not_semantic" as const,
      "synthetic_single_annotator_labels" as const,
      "table_row_inheritance_single_handle_only" as const
    ]),
    metrics,
    predictionDistribution: Object.freeze(Object.fromEntries(
      knowledgeSemanticGroundingDecisions.map((decision) => [
        decision,
        predictionCount(heldOutScored, decision)
      ])
    ) as Record<KnowledgeSemanticGroundingDecision, number>),
    releaseGatePassed: false,
    semanticProof: false,
    semanticQualityGatePassed,
    version: KNOWLEDGE_SEMANTIC_GROUNDING_BENCHMARK_VERSION
  });
}

function structuralBaselinePrediction(
  fixture: KnowledgeSemanticGroundingFixture,
  claim: KnowledgeSemanticGroundingClaim
): KnowledgeSemanticGroundingPrediction {
  const result = groundKnowledgeAnswer({
    answer: knowledgeSemanticClaimValidationText(claim),
    evidence: fixture.evidence
  });
  const issues = new Set(result.diagnostics.issueCodes);
  const hasAvailableEvidence = fixture.evidence.items.some((item) =>
    item.state === "available" && item.excerpt !== null);
  const decision: KnowledgeSemanticGroundingDecision = claim.type === "source_summary" &&
    claim.citationHandles.length === 0 && !hasAvailableEvidence
    ? "supported"
    : issues.has("numeric_or_date_mismatch")
    ? "contradicted"
    : result.outcome === "passed" || result.outcome === "repaired" &&
      result.diagnostics.unsupportedClaimCount === 0
      ? "supported"
      : issues.has("unsupported_claim") || issues.has("invalid_handle")
        ? "unsupported"
        : "uncertain";
  const attributableHandles = claim.evidenceItems
    .filter((item) => item.state === "available" && item.excerpt !== null)
    .map((item) => item.handle);
  return Object.freeze({
    attributableHandles: Object.freeze(attributableHandles),
    claimOrdinal: claim.ordinal,
    confidence: 1,
    decision,
    reasonFamily: "structural_baseline",
    validatorProfile: "current-structural-fence-v4",
    validatorVersion: 4,
    version: KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION
  });
}

export function runCurrentFenceSemanticGroundingBenchmark():
KnowledgeSemanticGroundingBenchmarkReport {
  const claimsByFixture = validateCorpus();
  const predictions = knowledgeSemanticGroundingFixtures.map((fixture) => Object.freeze({
    fixtureId: fixture.id,
    predictions: Object.freeze(claimsByFixture.get(fixture.id)!.map((claim) =>
      structuralBaselinePrediction(fixture, claim)))
  }));
  return scoreKnowledgeSemanticGroundingPredictions({
    candidate: Object.freeze({
      blockingEligible: false,
      independentLabelReviewComplete: false,
      profile: "current-structural-fence-v4",
      semanticProof: false,
      version: 4
    }),
    predictions
  });
}

export function assertKnowledgeSemanticGroundingBenchmarkContract(
  report: KnowledgeSemanticGroundingBenchmarkReport
): void {
  if (!report.contractValid || report.semanticProof || report.blockingEligible ||
    report.releaseGatePassed || report.candidate.semanticProof ||
    report.candidate.blockingEligible || report.candidate.independentLabelReviewComplete) {
    throw new Error("knowledge_semantic_grounding_benchmark_contract_failed");
  }
}
