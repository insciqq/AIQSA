import { z } from "zod";

/**
 * Content-free release metrics for the semantic grounding benchmark.
 *
 * This module deliberately accepts observations rather than fixtures, answer
 * text, evidence text, or review artifacts.  A caller is responsible for
 * proving the provenance of the observations before handing them to this
 * calculator.  The calculator only performs deterministic arithmetic and
 * fails closed for an empty or statistically insufficient denominator.
 */

export const KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION =
  "knowledge-semantic-grounding-release-metrics-v1" as const;

export const knowledgeSemanticGroundingReleaseMetricDecisions = Object.freeze([
  "contradicted",
  "supported",
  "uncertain",
  "unsupported"
] as const);

export type KnowledgeSemanticGroundingReleaseMetricDecision =
  typeof knowledgeSemanticGroundingReleaseMetricDecisions[number];

export const knowledgeSemanticGroundingReleaseMetricLanguages = Object.freeze([
  "en",
  "ru"
] as const);
export type KnowledgeSemanticGroundingReleaseMetricLanguage =
  typeof knowledgeSemanticGroundingReleaseMetricLanguages[number];

/**
 * These names intentionally mirror the frozen semantic corpus slices.  The
 * additional `reference_context` slice represents the PRD's reference-range
 * regression set, which is a metric concern even when a corpus uses a more
 * specific structural slice name.
 */
export const knowledgeSemanticGroundingReleaseMetricSlices = Object.freeze([
  "citation_neighborhood",
  "contradiction",
  "coverage_claim",
  "date_consistency",
  "derived_arithmetic",
  "direct_entailment",
  "generic_entailment",
  "general_knowledge",
  "list_segmentation",
  "locator_correctness",
  "markdown_table_segmentation",
  "no_answer",
  "numeric_consistency",
  "reference_context",
  "temporal_non_contradiction",
  "uncertainty",
  "version_attribution"
] as const);
export type KnowledgeSemanticGroundingReleaseMetricSlice =
  typeof knowledgeSemanticGroundingReleaseMetricSlices[number];

/** Slices that must have measured observations before a release can pass. */
export const knowledgeSemanticGroundingReleaseRequiredSlices = Object.freeze([
  "citation_neighborhood",
  "contradiction",
  "date_consistency",
  "no_answer",
  "numeric_consistency",
  "reference_context",
  "temporal_non_contradiction",
  "version_attribution"
] as const satisfies readonly KnowledgeSemanticGroundingReleaseMetricSlice[]);

export const knowledgeSemanticGroundingReleaseRegressionClasses = Object.freeze([
  "reference",
  "temporal",
  "version"
] as const);
export type KnowledgeSemanticGroundingReleaseRegressionClass =
  typeof knowledgeSemanticGroundingReleaseRegressionClasses[number];

/**
 * Thresholds are versioned here rather than copied from a report.  A future
 * benchmark integration can bind this object into its candidate/freeze
 * manifest and hash it before the held-out run.
 */
export const knowledgeSemanticGroundingReleaseMetricGates = Object.freeze({
  citationHandleValidityMinimum: 1,
  citationPrecisionMinimum: 0.95,
  contradictionPrecisionMinimum: 0.95,
  contradictionRecallMinimum: 0.9,
  correctNoAnswerMinimum: 0.9,
  criticalNumericDateAttributionMinimum: 1,
  numericDateAttributionMinimum: 0.98,
  temporalVersionReferenceFalseBlockerMaximum: 0,
  unsupportedSourceDerivedRateMaximum: 0.02,
  wilsonIntervalMaximumWidth: 0.35,
  wholeAnswerDestructionMaximum: 0
} as const);

/**
 * These floors are intentionally explicit.  A Wilson interval on one item is
 * informative for diagnostics but cannot be used as release evidence.  The
 * critical regression set has a minimum of one because its gate is an exact
 * zero-false-blocker / one-attribution check; broader semantic slices require
 * materially larger samples.
 */
export const knowledgeSemanticGroundingReleaseMetricSampleMinimums = Object.freeze({
  claimScope: 30,
  citationHandleValidity: 15,
  citationPrecision: 15,
  contradiction: 15,
  criticalNumericDate: 1,
  noAnswer: 15,
  numericDate: 15,
  sourceDerived: 15,
  wholeAnswer: 1,
  mandatoryRegression: 1,
  slice: 30,
  sliceLanguage: 15
} as const);

const decisionSchema = z.enum(knowledgeSemanticGroundingReleaseMetricDecisions);
const languageSchema = z.enum(knowledgeSemanticGroundingReleaseMetricLanguages);
const sliceSchema = z.enum(knowledgeSemanticGroundingReleaseMetricSlices);
const regressionClassSchema = z.enum(knowledgeSemanticGroundingReleaseRegressionClasses);
const citationHandleSchema = z.string().regex(/^K[1-9][0-9]{0,3}(?:\.[1-9][0-9]?)?$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const handleListSchema = z.array(citationHandleSchema).max(4_096).superRefine(
  (handles, context) => {
    if (new Set(handles).size !== handles.length) {
      context.addIssue({ code: "custom", message: "citation handles must be unique" });
    }
  }
);

/**
 * One row is enough to reproduce every metric in this module.  There is no
 * answer text, fixture id, ordinal, source name, or expected-label payload.
 * `claimSha256` is an opaque duplicate key. It is never copied into the
 * output, but requiring it prevents repeated claims from inflating a sample.
 */
export const knowledgeSemanticGroundingReleaseMetricObservationSchema = z
  .strictObject({
    claimSha256: sha256Schema,
    criticalNumericDate: z.boolean(),
    expectedCitationHandles: handleListSchema,
    expectedDecision: decisionSchema,
    independentUncertainClaim: z.boolean(),
    language: languageSchema,
    mandatoryRegression: regressionClassSchema.nullable(),
    noAnswerExpected: z.boolean(),
    noAnswerPredicted: z.boolean(),
    numericDate: z.boolean(),
    numericDateAttributionCorrect: z.boolean(),
    predictedCitationHandles: handleListSchema,
    predictedDecision: decisionSchema,
    slices: z.array(sliceSchema).min(1).max(knowledgeSemanticGroundingReleaseMetricSlices.length)
      .superRefine((slices, context) => {
        if (new Set(slices).size !== slices.length) {
          context.addIssue({ code: "custom", message: "metric slices must be unique" });
        }
      }),
    sourceDerived: z.boolean(),
    supportedClaimsPreserved: z.boolean(),
    wholeAnswerDestroyed: z.boolean(),
    availableCitationHandles: handleListSchema
  })
  .superRefine((observation, context) => {
    if (observation.criticalNumericDate && !observation.numericDate) {
      context.addIssue({
        code: "custom",
        message: "critical numeric/date observation must be numeric/date"
      });
    }
    if (observation.wholeAnswerDestroyed &&
      (!observation.independentUncertainClaim || observation.supportedClaimsPreserved)) {
      context.addIssue({
        code: "custom",
        message: "whole-answer destruction must be tied to an independent uncertain claim"
      });
    }
  });

export type KnowledgeSemanticGroundingReleaseMetricObservation = Readonly<
  z.infer<typeof knowledgeSemanticGroundingReleaseMetricObservationSchema>
>;

const confidenceLevel = 0.95 as const;
const zForConfidence = 1.959963984540054;

const finiteRate = z.number().finite().min(0).max(1);
const countSchema = z.number().int().nonnegative();

export const knowledgeSemanticGroundingReleaseMetricWilsonIntervalSchema = z.strictObject({
  confidenceLevel: z.literal(confidenceLevel),
  lower: finiteRate,
  upper: finiteRate
}).superRefine((interval, context) => {
  if (interval.lower > interval.upper) {
    context.addIssue({ code: "custom", message: "Wilson interval bounds are reversed" });
  }
});

export type KnowledgeSemanticGroundingReleaseMetricWilsonInterval = Readonly<
  z.infer<typeof knowledgeSemanticGroundingReleaseMetricWilsonIntervalSchema>
>;

const unavailableWilsonIntervalSchema = z.null();

export const knowledgeSemanticGroundingReleaseMetricRateSchema = z.strictObject({
  denominator: countSchema,
  interval: knowledgeSemanticGroundingReleaseMetricWilsonIntervalSchema
    .or(unavailableWilsonIntervalSchema),
  numerator: countSchema,
  sampleMinimum: z.number().int().positive(),
  sampleSufficient: z.boolean(),
  status: z.enum(["measured", "unavailable"]),
  value: finiteRate.nullable()
}).superRefine((metric, context) => {
  if (metric.numerator > metric.denominator) {
    context.addIssue({ code: "custom", message: "metric numerator exceeds denominator" });
    return;
  }
  const measured = metric.denominator > 0;
  const expectedInterval = wilsonIntervalForCount(metric.numerator, metric.denominator);
  const expectedValue = measured ? round(metric.numerator / metric.denominator) : null;
  if (metric.status !== (measured ? "measured" : "unavailable") ||
    metric.sampleSufficient !== (metric.denominator >= metric.sampleMinimum) ||
    metric.value !== expectedValue ||
    JSON.stringify(metric.interval) !== JSON.stringify(expectedInterval)) {
    context.addIssue({ code: "custom", message: "metric aggregate is internally inconsistent" });
  }
});

export type KnowledgeSemanticGroundingReleaseMetricRate = Readonly<
  z.infer<typeof knowledgeSemanticGroundingReleaseMetricRateSchema>
>;

export const knowledgeSemanticGroundingReleaseMetricCountSchema = z.strictObject({
  count: countSchema,
  sampleCount: countSchema,
  sampleMinimum: z.number().int().positive(),
  sampleSufficient: z.boolean(),
  status: z.enum(["measured", "unavailable"])
}).superRefine((metric, context) => {
  const measured = metric.sampleCount > 0;
  if (metric.count > metric.sampleCount ||
    metric.status !== (measured ? "measured" : "unavailable") ||
    metric.sampleSufficient !== (metric.sampleCount >= metric.sampleMinimum)) {
    context.addIssue({ code: "custom", message: "count aggregate is internally inconsistent" });
  }
});

export type KnowledgeSemanticGroundingReleaseMetricCount = Readonly<
  z.infer<typeof knowledgeSemanticGroundingReleaseMetricCountSchema>
>;

export const knowledgeSemanticGroundingReleaseMetricScopeSchema = z.strictObject({
  claimCount: countSchema,
  citationHandleValidity: knowledgeSemanticGroundingReleaseMetricRateSchema,
  citationPrecision: knowledgeSemanticGroundingReleaseMetricRateSchema,
  contradictionPrecision: knowledgeSemanticGroundingReleaseMetricRateSchema,
  contradictionRecall: knowledgeSemanticGroundingReleaseMetricRateSchema,
  correctNoAnswer: knowledgeSemanticGroundingReleaseMetricRateSchema,
  criticalNumericDateAttribution: knowledgeSemanticGroundingReleaseMetricRateSchema,
  gatesPassed: z.boolean(),
  mandatoryRegressionFalseBlockers: z.strictObject({
    byClass: z.record(regressionClassSchema, countSchema),
    requiredClasses: z.array(regressionClassSchema).max(
      knowledgeSemanticGroundingReleaseRegressionClasses.length
    ).readonly(),
    requiredClassesMeasured: z.boolean(),
    requiredTotal: countSchema,
    sampleByClass: z.record(regressionClassSchema, countSchema),
    total: countSchema,
    evidence: knowledgeSemanticGroundingReleaseMetricCountSchema
  }),
  numericDateAttribution: knowledgeSemanticGroundingReleaseMetricRateSchema,
  reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,127}$/u)),
  sourceDerivedClaimCount: countSchema,
  unsupportedSourceDerivedRate: knowledgeSemanticGroundingReleaseMetricRateSchema,
  wholeAnswerDestruction: z.strictObject({
    destroyedCount: countSchema,
    evidence: knowledgeSemanticGroundingReleaseMetricCountSchema,
    preservedCount: countSchema
  })
});

export type KnowledgeSemanticGroundingReleaseMetricScope = Readonly<
  z.infer<typeof knowledgeSemanticGroundingReleaseMetricScopeSchema>
>;

const metricScopesBySliceSchema = z.strictObject({
  citation_neighborhood: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  contradiction: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  coverage_claim: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  date_consistency: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  derived_arithmetic: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  direct_entailment: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  generic_entailment: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  general_knowledge: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  list_segmentation: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  locator_correctness: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  markdown_table_segmentation: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  no_answer: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  numeric_consistency: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  reference_context: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  temporal_non_contradiction: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  uncertainty: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  version_attribution: knowledgeSemanticGroundingReleaseMetricScopeSchema
});

export const knowledgeSemanticGroundingReleaseMetricsSchema = z.strictObject({
  aggregateOnly: z.literal(true),
  byLanguage: z.strictObject({
    en: knowledgeSemanticGroundingReleaseMetricScopeSchema,
    ru: knowledgeSemanticGroundingReleaseMetricScopeSchema
  }),
  byLanguageAndSlice: z.strictObject({
    en: metricScopesBySliceSchema,
    ru: metricScopesBySliceSchema
  }),
  bySlice: metricScopesBySliceSchema,
  gates: z.strictObject({
    allLanguagesPassed: z.boolean(),
    allLanguagesSampleSufficient: z.boolean(),
    allRequiredLanguageSlicesPassed: z.boolean(),
    allRequiredLanguageSlicesSampleSufficient: z.boolean(),
    allRequiredSlicesPassed: z.boolean(),
    allRequiredSlicesSampleSufficient: z.boolean(),
    citationHandleValidity: z.boolean(),
    citationPrecision: z.boolean(),
    contradictionPrecision: z.boolean(),
    contradictionRecall: z.boolean(),
    correctNoAnswer: z.boolean(),
    criticalNumericDateAttribution: z.boolean(),
    confidenceIntervalsStable: z.boolean(),
    numericDateAttribution: z.boolean(),
    temporalVersionReferenceFalseBlockers: z.boolean(),
    unsupportedSourceDerivedRate: z.boolean(),
    wholeAnswerPreservation: z.boolean()
  }),
  overall: knowledgeSemanticGroundingReleaseMetricScopeSchema,
  reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,127}$/u)),
  releaseGatePassed: z.literal(false),
  version: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION)
});

export type KnowledgeSemanticGroundingReleaseMetrics = Readonly<
  z.infer<typeof knowledgeSemanticGroundingReleaseMetricsSchema>
>;

type MutableObservation = KnowledgeSemanticGroundingReleaseMetricObservation;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`);
}

function wilsonIntervalForCount(
  numerator: number,
  denominator: number
): KnowledgeSemanticGroundingReleaseMetricWilsonInterval | null {
  if (denominator <= 0) return null;
  const n = denominator;
  const p = numerator / n;
  const zSquared = zForConfidence ** 2;
  const denominatorTerm = 1 + zSquared / n;
  const centre = p + zSquared / (2 * n);
  const margin = zForConfidence * Math.sqrt((p * (1 - p) + zSquared / (4 * n)) / n);
  return Object.freeze({
    confidenceLevel,
    lower: round(Math.max(0, (centre - margin) / denominatorTerm)),
    upper: round(Math.min(1, (centre + margin) / denominatorTerm))
  });
}

/**
 * Return a two-sided Wilson score interval.  Zero observations are explicitly
 * unavailable (`null`) rather than `[0, 1]`, preventing an absent slice from
 * satisfying a gate.  Inputs are validated and bounded to safe integers.
 */
export function wilsonConfidenceInterval(input: Readonly<{
  confidenceLevel?: typeof confidenceLevel;
  numerator: number;
  denominator: number;
}>): KnowledgeSemanticGroundingReleaseMetricWilsonInterval | null {
  if (input.confidenceLevel !== undefined && input.confidenceLevel !== confidenceLevel) {
    throw new Error("knowledge_semantic_release_metrics_confidence_level_unsupported");
  }
  if (!Number.isSafeInteger(input.numerator) || !Number.isSafeInteger(input.denominator) ||
    input.numerator < 0 || input.denominator < 0 || input.numerator > input.denominator) {
    throw new Error("knowledge_semantic_release_metrics_interval_input_invalid");
  }
  return wilsonIntervalForCount(input.numerator, input.denominator);
}

function rate(
  numerator: number,
  denominator: number,
  sampleMinimum: number
): KnowledgeSemanticGroundingReleaseMetricRate {
  const interval = wilsonIntervalForCount(numerator, denominator);
  const measured = denominator > 0;
  return Object.freeze({
    denominator,
    interval,
    numerator,
    sampleMinimum,
    sampleSufficient: denominator >= sampleMinimum,
    status: measured ? "measured" as const : "unavailable" as const,
    value: measured ? round(numerator / denominator) : null
  });
}

function countMetric(
  count: number,
  sampleCount: number,
  sampleMinimum: number
): KnowledgeSemanticGroundingReleaseMetricCount {
  return Object.freeze({
    count,
    sampleCount,
    sampleMinimum,
    sampleSufficient: sampleCount >= sampleMinimum,
    status: sampleCount > 0 ? "measured" as const : "unavailable" as const
  });
}

function duplicateObservations(observations: readonly MutableObservation[]): boolean {
  const hashes = observations
    .map((observation) => observation.claimSha256)
    .filter((hash): hash is string => hash !== undefined);
  return new Set(hashes).size !== hashes.length;
}

type ScopeInput = Readonly<{
  observations: readonly MutableObservation[];
  claimMinimum: number;
  requiredGates: readonly ScopeGate[];
  requiredRegressionClasses: readonly KnowledgeSemanticGroundingReleaseRegressionClass[];
}>;

type ScopeGate =
  | "citation_handle_validity"
  | "citation_precision"
  | "contradiction_precision"
  | "contradiction_recall"
  | "correct_no_answer"
  | "critical_numeric_date_attribution"
  | "mandatory_regression_false_blockers"
  | "numeric_date_attribution"
  | "unsupported_source_derived_rate"
  | "whole_answer_preservation";

const allScopeGates = Object.freeze([
  "citation_handle_validity",
  "citation_precision",
  "contradiction_precision",
  "contradiction_recall",
  "correct_no_answer",
  "critical_numeric_date_attribution",
  "mandatory_regression_false_blockers",
  "numeric_date_attribution",
  "unsupported_source_derived_rate",
  "whole_answer_preservation"
] as const satisfies readonly ScopeGate[]);

type SliceGatePolicy = Readonly<{
  gates: readonly ScopeGate[];
  regressionClasses: readonly KnowledgeSemanticGroundingReleaseRegressionClass[];
}>;

const sourceDerivedSliceGates = Object.freeze([
  "citation_handle_validity",
  "citation_precision",
  "unsupported_source_derived_rate"
] as const satisfies readonly ScopeGate[]);

const numericDateSliceGates = Object.freeze([
  "citation_handle_validity",
  "citation_precision",
  "critical_numeric_date_attribution",
  "numeric_date_attribution"
] as const satisfies readonly ScopeGate[]);

const sliceGatePolicies: Readonly<Record<
  KnowledgeSemanticGroundingReleaseMetricSlice,
  SliceGatePolicy
>> = Object.freeze({
  citation_neighborhood: Object.freeze({
    gates: Object.freeze(["citation_handle_validity", "citation_precision"] as const),
    regressionClasses: Object.freeze([])
  }),
  contradiction: Object.freeze({
    gates: Object.freeze(["contradiction_precision", "contradiction_recall"] as const),
    regressionClasses: Object.freeze([])
  }),
  coverage_claim: Object.freeze({ gates: sourceDerivedSliceGates, regressionClasses: Object.freeze([]) }),
  date_consistency: Object.freeze({ gates: numericDateSliceGates, regressionClasses: Object.freeze([]) }),
  derived_arithmetic: Object.freeze({ gates: numericDateSliceGates, regressionClasses: Object.freeze([]) }),
  direct_entailment: Object.freeze({ gates: sourceDerivedSliceGates, regressionClasses: Object.freeze([]) }),
  generic_entailment: Object.freeze({ gates: sourceDerivedSliceGates, regressionClasses: Object.freeze([]) }),
  general_knowledge: Object.freeze({
    gates: Object.freeze(["unsupported_source_derived_rate"] as const),
    regressionClasses: Object.freeze([])
  }),
  list_segmentation: Object.freeze({ gates: sourceDerivedSliceGates, regressionClasses: Object.freeze([]) }),
  locator_correctness: Object.freeze({ gates: sourceDerivedSliceGates, regressionClasses: Object.freeze([]) }),
  markdown_table_segmentation: Object.freeze({ gates: sourceDerivedSliceGates, regressionClasses: Object.freeze([]) }),
  no_answer: Object.freeze({
    gates: Object.freeze(["correct_no_answer"] as const),
    regressionClasses: Object.freeze([])
  }),
  numeric_consistency: Object.freeze({ gates: numericDateSliceGates, regressionClasses: Object.freeze([]) }),
  reference_context: Object.freeze({
    gates: Object.freeze(["mandatory_regression_false_blockers"] as const),
    regressionClasses: Object.freeze(["reference"] as const)
  }),
  temporal_non_contradiction: Object.freeze({
    gates: Object.freeze(["mandatory_regression_false_blockers"] as const),
    regressionClasses: Object.freeze(["temporal"] as const)
  }),
  uncertainty: Object.freeze({
    gates: Object.freeze(["whole_answer_preservation"] as const),
    regressionClasses: Object.freeze([])
  }),
  version_attribution: Object.freeze({
    gates: Object.freeze([
      "citation_handle_validity",
      "citation_precision",
      "mandatory_regression_false_blockers"
    ] as const),
    regressionClasses: Object.freeze(["version"] as const)
  })
});

function scopeReason(
  metricName: string,
  metric: KnowledgeSemanticGroundingReleaseMetricRate,
  predicate: "minimum" | "maximum",
  threshold: number
): string | null {
  if (metric.status === "unavailable") return `${metricName}_unavailable`;
  if (!metric.sampleSufficient) return `${metricName}_sample_insufficient`;
  if (metric.value === null) return `${metricName}_unavailable`;
  return predicate === "minimum"
    ? metric.value < threshold ? `${metricName}_below_minimum` : null
    : metric.value > threshold ? `${metricName}_above_maximum` : null;
}

function scopeMetrics(input: ScopeInput): KnowledgeSemanticGroundingReleaseMetricScope {
  const observations = input.observations;
  const sourceDerived = observations.filter((observation) => observation.sourceDerived);
  const citationPredictions = observations.flatMap((observation) =>
    observation.predictedCitationHandles.map((handle) => ({ handle, observation })));
  const validCitations = citationPredictions.filter(({ handle, observation }) =>
    observation.availableCitationHandles.includes(handle));
  const preciseCitations = citationPredictions.filter(({ handle, observation }) =>
    observation.expectedCitationHandles.includes(handle));
  const contradictionPredictions = observations.filter((observation) =>
    observation.predictedDecision === "contradicted");
  const contradictionLabels = observations.filter((observation) =>
    observation.expectedDecision === "contradicted");
  const correctContradictions = contradictionPredictions.filter((observation) =>
    observation.expectedDecision === "contradicted").length;
  const numericDate = observations.filter((observation) => observation.numericDate);
  const criticalNumericDate = numericDate.filter((observation) =>
    observation.criticalNumericDate);
  const noAnswer = observations.filter((observation) => observation.noAnswerExpected);
  const independentUncertain = observations.filter((observation) =>
    observation.independentUncertainClaim);
  const regressionClasses = Object.fromEntries(
    knowledgeSemanticGroundingReleaseRegressionClasses.map((regressionClass) => [
      regressionClass,
      observations.filter((observation) =>
        observation.mandatoryRegression === regressionClass &&
        observation.expectedDecision === "supported" &&
        observation.predictedDecision !== "supported").length
    ])
  ) as Record<KnowledgeSemanticGroundingReleaseRegressionClass, number>;
  const regressionSamples = Object.fromEntries(
    knowledgeSemanticGroundingReleaseRegressionClasses.map((regressionClass) => [
      regressionClass,
      observations.filter((observation) =>
        observation.mandatoryRegression === regressionClass).length
    ])
  ) as Record<KnowledgeSemanticGroundingReleaseRegressionClass, number>;
  const regressionEvidenceCount = Object.values(regressionSamples)
    .reduce((sum, value) => sum + value, 0);
  const requiredRegressionClassesMeasured = input.requiredRegressionClasses
    .every((regressionClass) => regressionSamples[regressionClass] >=
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.mandatoryRegression);
  const regressionTotal = Object.values(regressionClasses).reduce((sum, value) => sum + value, 0);
  const requiredRegressionTotal = input.requiredRegressionClasses.reduce(
    (sum, regressionClass) => sum + regressionClasses[regressionClass],
    0
  );
  const regressionEvidence = countMetric(
    regressionTotal,
    regressionEvidenceCount,
    knowledgeSemanticGroundingReleaseMetricSampleMinimums.mandatoryRegression
  );
  const wholeAnswerDestroyed = independentUncertain.filter((observation) =>
    observation.wholeAnswerDestroyed).length;
  const wholeAnswerPreserved = independentUncertain.filter((observation) =>
    observation.supportedClaimsPreserved && !observation.wholeAnswerDestroyed).length;
  const wholeAnswerEvidence = countMetric(
    wholeAnswerDestroyed,
    independentUncertain.length,
    knowledgeSemanticGroundingReleaseMetricSampleMinimums.wholeAnswer
  );

  const metrics = {
    citationHandleValidity: rate(
      validCitations.length,
      citationPredictions.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.citationHandleValidity
    ),
    citationPrecision: rate(
      preciseCitations.length,
      citationPredictions.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.citationPrecision
    ),
    contradictionPrecision: rate(
      correctContradictions,
      contradictionPredictions.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.contradiction
    ),
    contradictionRecall: rate(
      correctContradictions,
      contradictionLabels.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.contradiction
    ),
    correctNoAnswer: rate(
      noAnswer.filter((observation) => observation.noAnswerPredicted).length,
      noAnswer.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.noAnswer
    ),
    criticalNumericDateAttribution: rate(
      criticalNumericDate.filter((observation) => observation.numericDateAttributionCorrect).length,
      criticalNumericDate.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.criticalNumericDate
    ),
    numericDateAttribution: rate(
      numericDate.filter((observation) => observation.numericDateAttributionCorrect).length,
      numericDate.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.numericDate
    ),
    unsupportedSourceDerivedRate: rate(
      // This is prevalence of adjudicated unsupported final-answer claims.
      // Genuine contradictions are deliberately excluded and are measured by
      // their own precision/recall gates; a validator prediction cannot erase
      // an unsupported claim that was present in the generated answer.
      sourceDerived.filter((observation) => observation.expectedDecision === "unsupported").length,
      sourceDerived.length,
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.sourceDerived
    )
  };

  const reasons: string[] = [];
  const minimumChecks: readonly [
    string,
    KnowledgeSemanticGroundingReleaseMetricRate,
    "minimum" | "maximum",
    number
  ][] = [
    ["citation_handle_validity", metrics.citationHandleValidity, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.citationHandleValidityMinimum],
    ["citation_precision", metrics.citationPrecision, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.citationPrecisionMinimum],
    ["contradiction_precision", metrics.contradictionPrecision, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.contradictionPrecisionMinimum],
    ["contradiction_recall", metrics.contradictionRecall, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.contradictionRecallMinimum],
    ["correct_no_answer", metrics.correctNoAnswer, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.correctNoAnswerMinimum],
    ["critical_numeric_date_attribution", metrics.criticalNumericDateAttribution, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.criticalNumericDateAttributionMinimum],
    ["numeric_date_attribution", metrics.numericDateAttribution, "minimum",
      knowledgeSemanticGroundingReleaseMetricGates.numericDateAttributionMinimum],
    ["unsupported_source_derived_rate", metrics.unsupportedSourceDerivedRate, "maximum",
      knowledgeSemanticGroundingReleaseMetricGates.unsupportedSourceDerivedRateMaximum]
  ];
  for (const [name, metric, predicate, threshold] of minimumChecks) {
    if (!input.requiredGates.includes(name as ScopeGate)) continue;
    const reason = scopeReason(name, metric, predicate, threshold);
    if (reason) reasons.push(reason);
  }
  if (observations.length < input.claimMinimum) reasons.push("claim_scope_sample_insufficient");
  if (input.requiredGates.includes("mandatory_regression_false_blockers")) {
    if (!regressionEvidence.sampleSufficient || !requiredRegressionClassesMeasured) {
      reasons.push("mandatory_regression_sample_insufficient");
    }
    if (requiredRegressionTotal > knowledgeSemanticGroundingReleaseMetricGates
      .temporalVersionReferenceFalseBlockerMaximum) {
      reasons.push("mandatory_regression_false_blocker");
    }
  }
  if (input.requiredGates.includes("whole_answer_preservation")) {
    if (!wholeAnswerEvidence.sampleSufficient) reasons.push("whole_answer_sample_insufficient");
    if (wholeAnswerDestroyed > knowledgeSemanticGroundingReleaseMetricGates
      .wholeAnswerDestructionMaximum) {
      reasons.push("whole_answer_destruction_detected");
    }
  }
  const gatesPassed = reasons.length === 0;

  return Object.freeze({
    claimCount: observations.length,
    citationHandleValidity: metrics.citationHandleValidity,
    citationPrecision: metrics.citationPrecision,
    contradictionPrecision: metrics.contradictionPrecision,
    contradictionRecall: metrics.contradictionRecall,
    correctNoAnswer: metrics.correctNoAnswer,
    criticalNumericDateAttribution: metrics.criticalNumericDateAttribution,
    gatesPassed,
    mandatoryRegressionFalseBlockers: Object.freeze({
      byClass: Object.freeze(regressionClasses),
      evidence: regressionEvidence,
      requiredClasses: Object.freeze([...input.requiredRegressionClasses]),
      requiredClassesMeasured: requiredRegressionClassesMeasured,
      requiredTotal: requiredRegressionTotal,
      sampleByClass: Object.freeze(regressionSamples),
      total: regressionTotal
    }),
    numericDateAttribution: metrics.numericDateAttribution,
    reasonCodes: [...new Set(reasons)].sort(),
    sourceDerivedClaimCount: sourceDerived.length,
    unsupportedSourceDerivedRate: metrics.unsupportedSourceDerivedRate,
    wholeAnswerDestruction: Object.freeze({
      destroyedCount: wholeAnswerDestroyed,
      evidence: wholeAnswerEvidence,
      preservedCount: wholeAnswerPreserved
    })
  });
}

function scopeWithClaimMinimum(
  observations: readonly MutableObservation[],
  claimMinimum: number,
  requiredGates: readonly ScopeGate[],
  requiredRegressionClasses: readonly KnowledgeSemanticGroundingReleaseRegressionClass[]
): KnowledgeSemanticGroundingReleaseMetricScope {
  return scopeMetrics({
    claimMinimum,
    observations,
    requiredGates,
    requiredRegressionClasses
  });
}

function languageScope(
  observations: readonly MutableObservation[],
  language: KnowledgeSemanticGroundingReleaseMetricLanguage
): KnowledgeSemanticGroundingReleaseMetricScope {
  return scopeWithClaimMinimum(
    observations.filter((observation) => observation.language === language),
    knowledgeSemanticGroundingReleaseMetricSampleMinimums.claimScope,
    allScopeGates,
    knowledgeSemanticGroundingReleaseRegressionClasses
  );
}

function sliceScope(
  observations: readonly MutableObservation[],
  slice: KnowledgeSemanticGroundingReleaseMetricSlice,
  claimMinimum: number
): KnowledgeSemanticGroundingReleaseMetricScope {
  const policy = sliceGatePolicies[slice];
  return scopeWithClaimMinimum(
    observations.filter((observation) => observation.slices.includes(slice)),
    claimMinimum,
    policy.gates,
    policy.regressionClasses
  );
}

function gateFromScope(
  scope: KnowledgeSemanticGroundingReleaseMetricScope
): Omit<KnowledgeSemanticGroundingReleaseMetrics["gates"],
  "allLanguagesPassed" | "allLanguagesSampleSufficient" |
  "allRequiredLanguageSlicesPassed" | "allRequiredLanguageSlicesSampleSufficient" |
  "allRequiredSlicesPassed" | "allRequiredSlicesSampleSufficient"> {
  const confidenceMetrics = [
    scope.citationHandleValidity,
    scope.citationPrecision,
    scope.contradictionPrecision,
    scope.contradictionRecall,
    scope.correctNoAnswer,
    scope.numericDateAttribution,
    scope.unsupportedSourceDerivedRate
  ].filter((metric) => metric.status === "measured" && metric.sampleSufficient);
  return {
    citationHandleValidity: scope.citationHandleValidity.status === "measured" &&
      scope.citationHandleValidity.sampleSufficient &&
      scope.citationHandleValidity.value === knowledgeSemanticGroundingReleaseMetricGates
        .citationHandleValidityMinimum,
    citationPrecision: scope.citationPrecision.status === "measured" &&
      scope.citationPrecision.sampleSufficient &&
      (scope.citationPrecision.value ?? -1) >=
        knowledgeSemanticGroundingReleaseMetricGates.citationPrecisionMinimum,
    contradictionPrecision: scope.contradictionPrecision.status === "measured" &&
      scope.contradictionPrecision.sampleSufficient &&
      (scope.contradictionPrecision.value ?? -1) >=
        knowledgeSemanticGroundingReleaseMetricGates.contradictionPrecisionMinimum,
    contradictionRecall: scope.contradictionRecall.status === "measured" &&
      scope.contradictionRecall.sampleSufficient &&
      (scope.contradictionRecall.value ?? -1) >=
        knowledgeSemanticGroundingReleaseMetricGates.contradictionRecallMinimum,
    correctNoAnswer: scope.correctNoAnswer.status === "measured" &&
      scope.correctNoAnswer.sampleSufficient &&
      (scope.correctNoAnswer.value ?? -1) >=
        knowledgeSemanticGroundingReleaseMetricGates.correctNoAnswerMinimum,
    criticalNumericDateAttribution: scope.criticalNumericDateAttribution.status === "measured" &&
      scope.criticalNumericDateAttribution.sampleSufficient &&
      scope.criticalNumericDateAttribution.value ===
        knowledgeSemanticGroundingReleaseMetricGates.criticalNumericDateAttributionMinimum,
    confidenceIntervalsStable: confidenceMetrics.length > 0 && confidenceMetrics.every((metric) =>
      metric.interval !== null && metric.interval.upper - metric.interval.lower <=
        knowledgeSemanticGroundingReleaseMetricGates.wilsonIntervalMaximumWidth),
    numericDateAttribution: scope.numericDateAttribution.status === "measured" &&
      scope.numericDateAttribution.sampleSufficient &&
      (scope.numericDateAttribution.value ?? -1) >=
        knowledgeSemanticGroundingReleaseMetricGates.numericDateAttributionMinimum,
    temporalVersionReferenceFalseBlockers: scope.mandatoryRegressionFalseBlockers.evidence.status ===
      "measured" && scope.mandatoryRegressionFalseBlockers.evidence.sampleSufficient &&
      scope.mandatoryRegressionFalseBlockers.requiredClassesMeasured &&
      scope.mandatoryRegressionFalseBlockers.requiredTotal ===
        knowledgeSemanticGroundingReleaseMetricGates.temporalVersionReferenceFalseBlockerMaximum,
    unsupportedSourceDerivedRate: scope.unsupportedSourceDerivedRate.status === "measured" &&
      scope.unsupportedSourceDerivedRate.sampleSufficient &&
      (scope.unsupportedSourceDerivedRate.value ?? Number.POSITIVE_INFINITY) <=
        knowledgeSemanticGroundingReleaseMetricGates.unsupportedSourceDerivedRateMaximum,
    wholeAnswerPreservation: scope.wholeAnswerDestruction.evidence.status === "measured" &&
      scope.wholeAnswerDestruction.evidence.sampleSufficient &&
      scope.wholeAnswerDestruction.destroyedCount ===
        knowledgeSemanticGroundingReleaseMetricGates.wholeAnswerDestructionMaximum
  };
}

function requiredSliceSampleSufficient(
  bySlice: Readonly<Record<KnowledgeSemanticGroundingReleaseMetricSlice, KnowledgeSemanticGroundingReleaseMetricScope>>
): boolean {
  return knowledgeSemanticGroundingReleaseRequiredSlices.every((slice) =>
    bySlice[slice].claimCount >= knowledgeSemanticGroundingReleaseMetricSampleMinimums.slice);
}

function requiredSliceGatesPassed(
  bySlice: Readonly<Record<KnowledgeSemanticGroundingReleaseMetricSlice, KnowledgeSemanticGroundingReleaseMetricScope>>
): boolean {
  return knowledgeSemanticGroundingReleaseRequiredSlices.every((slice) =>
    bySlice[slice].gatesPassed);
}

function requiredLanguageSliceSampleSufficient(
  byLanguageAndSlice: Readonly<Record<
    KnowledgeSemanticGroundingReleaseMetricLanguage,
    Readonly<Record<KnowledgeSemanticGroundingReleaseMetricSlice,
      KnowledgeSemanticGroundingReleaseMetricScope>>
  >>
): boolean {
  return knowledgeSemanticGroundingReleaseMetricLanguages.every((language) =>
    knowledgeSemanticGroundingReleaseRequiredSlices.every((slice) =>
      byLanguageAndSlice[language][slice].claimCount >=
        knowledgeSemanticGroundingReleaseMetricSampleMinimums.sliceLanguage));
}

function requiredLanguageSliceGatesPassed(
  byLanguageAndSlice: Readonly<Record<
    KnowledgeSemanticGroundingReleaseMetricLanguage,
    Readonly<Record<KnowledgeSemanticGroundingReleaseMetricSlice,
      KnowledgeSemanticGroundingReleaseMetricScope>>
  >>
): boolean {
  return knowledgeSemanticGroundingReleaseMetricLanguages.every((language) =>
    knowledgeSemanticGroundingReleaseRequiredSlices.every((slice) =>
      byLanguageAndSlice[language][slice].gatesPassed));
}

/**
 * Compute all PRD §28.3 aggregates from content-free observations.  The
 * returned `releaseGatePassed` is deliberately typed and fixed to `false`:
 * this module supplies evidence and gate arithmetic, while independent-human
 * provenance, freeze bindings, and candidate eligibility remain a separate
 * benchmark owner concern.
 */
export function measureKnowledgeSemanticGroundingReleaseMetrics(input: Readonly<{
  observations: readonly KnowledgeSemanticGroundingReleaseMetricObservation[];
}>): KnowledgeSemanticGroundingReleaseMetrics {
  const parsed = z.strictObject({
    observations: z.array(knowledgeSemanticGroundingReleaseMetricObservationSchema)
  }).parse(input);
  if (duplicateObservations(parsed.observations)) {
    throw new Error("knowledge_semantic_release_metrics_duplicate_claim");
  }

  const observations = parsed.observations as readonly MutableObservation[];
  const overall = scopeWithClaimMinimum(
    observations,
    knowledgeSemanticGroundingReleaseMetricSampleMinimums.claimScope,
    allScopeGates,
    knowledgeSemanticGroundingReleaseRegressionClasses
  );
  const byLanguage = Object.fromEntries(
    knowledgeSemanticGroundingReleaseMetricLanguages.map((language) => [
      language,
      languageScope(observations, language)
    ])
  ) as Record<KnowledgeSemanticGroundingReleaseMetricLanguage, KnowledgeSemanticGroundingReleaseMetricScope>;
  const bySlice = Object.fromEntries(
    knowledgeSemanticGroundingReleaseMetricSlices.map((slice) => [
      slice,
      sliceScope(observations, slice, knowledgeSemanticGroundingReleaseMetricSampleMinimums.slice)
    ])
  ) as Record<KnowledgeSemanticGroundingReleaseMetricSlice, KnowledgeSemanticGroundingReleaseMetricScope>;
  const byLanguageAndSlice = Object.fromEntries(
    knowledgeSemanticGroundingReleaseMetricLanguages.map((language) => [
      language,
      Object.fromEntries(knowledgeSemanticGroundingReleaseMetricSlices.map((slice) => [
        slice,
        sliceScope(
          observations.filter((observation) => observation.language === language),
          slice,
          knowledgeSemanticGroundingReleaseMetricSampleMinimums.sliceLanguage
        )
      ]))
    ])
  ) as Record<KnowledgeSemanticGroundingReleaseMetricLanguage, Readonly<Record<
    KnowledgeSemanticGroundingReleaseMetricSlice,
    KnowledgeSemanticGroundingReleaseMetricScope
  >>>;

  const languageGatesPassed = knowledgeSemanticGroundingReleaseMetricLanguages.every((language) =>
    byLanguage[language].gatesPassed);
  const languageSamplesSufficient = knowledgeSemanticGroundingReleaseMetricLanguages
    .every((language) => byLanguage[language].claimCount >=
      knowledgeSemanticGroundingReleaseMetricSampleMinimums.claimScope);
  const sliceSamplesSufficient = requiredSliceSampleSufficient(bySlice);
  const sliceGatesPassed = requiredSliceGatesPassed(bySlice);
  const languageSliceSamplesSufficient = requiredLanguageSliceSampleSufficient(byLanguageAndSlice);
  const languageSliceGatesPassed = requiredLanguageSliceGatesPassed(byLanguageAndSlice);
  const overallGates = gateFromScope(overall);
  const gates = Object.freeze({
    allLanguagesPassed: languageGatesPassed,
    allLanguagesSampleSufficient: languageSamplesSufficient,
    allRequiredLanguageSlicesPassed: languageSliceGatesPassed,
    allRequiredLanguageSlicesSampleSufficient: languageSliceSamplesSufficient,
    allRequiredSlicesPassed: sliceGatesPassed,
    allRequiredSlicesSampleSufficient: sliceSamplesSufficient,
    citationHandleValidity: overallGates.citationHandleValidity,
    citationPrecision: overallGates.citationPrecision,
    contradictionPrecision: overallGates.contradictionPrecision,
    contradictionRecall: overallGates.contradictionRecall,
    correctNoAnswer: overallGates.correctNoAnswer,
    criticalNumericDateAttribution: overallGates.criticalNumericDateAttribution,
    confidenceIntervalsStable: overallGates.confidenceIntervalsStable,
    numericDateAttribution: overallGates.numericDateAttribution,
    temporalVersionReferenceFalseBlockers: overallGates.temporalVersionReferenceFalseBlockers,
    unsupportedSourceDerivedRate: overallGates.unsupportedSourceDerivedRate,
    wholeAnswerPreservation: overallGates.wholeAnswerPreservation
  });
  const reasonCodes = new Set<string>(overall.reasonCodes);
  if (!languageSamplesSufficient) reasonCodes.add("language_sample_insufficient");
  if (!languageGatesPassed) reasonCodes.add("language_gate_not_passed");
  if (!sliceSamplesSufficient) reasonCodes.add("required_slice_sample_insufficient");
  if (!sliceGatesPassed) reasonCodes.add("required_slice_gate_not_passed");
  if (!languageSliceSamplesSufficient) {
    reasonCodes.add("required_language_slice_sample_insufficient");
  }
  if (!languageSliceGatesPassed) reasonCodes.add("required_language_slice_gate_not_passed");
  for (const [name, passed] of Object.entries(overallGates)) {
    if (!passed) reasonCodes.add(`${snakeCase(name)}_gate_not_passed`);
  }

  const report = {
    aggregateOnly: true as const,
    byLanguage: Object.freeze(byLanguage),
    byLanguageAndSlice: Object.freeze(Object.fromEntries(
      Object.entries(byLanguageAndSlice).map(([language, scopes]) => [
        language,
        Object.freeze(scopes)
      ])
    )) as typeof byLanguageAndSlice,
    bySlice: Object.freeze(bySlice),
    gates,
    overall,
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    releaseGatePassed: false as const,
    version: KNOWLEDGE_SEMANTIC_GROUNDING_RELEASE_METRICS_VERSION
  };
  return deepFreeze(knowledgeSemanticGroundingReleaseMetricsSchema.parse(report));
}

/** Alias retained for benchmark integration code that uses score terminology. */
export const scoreKnowledgeSemanticGroundingReleaseMetrics =
  measureKnowledgeSemanticGroundingReleaseMetrics;

/** Decode and freeze a content-free report imported from a private artifact. */
export function decodeKnowledgeSemanticGroundingReleaseMetrics(
  value: unknown
): KnowledgeSemanticGroundingReleaseMetrics {
  return deepFreeze(knowledgeSemanticGroundingReleaseMetricsSchema.parse(value));
}

export function assertKnowledgeSemanticGroundingReleaseMetrics(
  value: unknown
): asserts value is KnowledgeSemanticGroundingReleaseMetrics {
  decodeKnowledgeSemanticGroundingReleaseMetrics(value);
}
