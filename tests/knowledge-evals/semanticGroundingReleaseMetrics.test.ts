import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertKnowledgeSemanticGroundingReleaseMetrics,
  decodeKnowledgeSemanticGroundingReleaseMetrics,
  knowledgeSemanticGroundingReleaseMetricGates,
  knowledgeSemanticGroundingReleaseMetricLanguages,
  knowledgeSemanticGroundingReleaseMetricSampleMinimums,
  knowledgeSemanticGroundingReleaseMetricSlices,
  measureKnowledgeSemanticGroundingReleaseMetrics,
  wilsonConfidenceInterval,
  type KnowledgeSemanticGroundingReleaseMetricObservation
} from "./semanticGroundingReleaseMetrics";

const allMetricSlices = [...knowledgeSemanticGroundingReleaseMetricSlices];
let observationOrdinal = 0;

function observation(
  overrides: Partial<KnowledgeSemanticGroundingReleaseMetricObservation> = {}
): KnowledgeSemanticGroundingReleaseMetricObservation {
  const claimSha256 = createHash("sha256")
    .update(`release-metrics-test-observation:${observationOrdinal++}`)
    .digest("hex");
  return {
    availableCitationHandles: ["K1"],
    claimSha256,
    criticalNumericDate: false,
    expectedCitationHandles: ["K1"],
    expectedDecision: "supported",
    independentUncertainClaim: false,
    language: "en",
    mandatoryRegression: "temporal",
    noAnswerExpected: false,
    noAnswerPredicted: false,
    numericDate: false,
    numericDateAttributionCorrect: false,
    predictedCitationHandles: ["K1"],
    predictedDecision: "supported",
    slices: allMetricSlices,
    sourceDerived: true,
    supportedClaimsPreserved: false,
    wholeAnswerDestroyed: false,
    ...overrides
  };
}

function sufficientObservations(): KnowledgeSemanticGroundingReleaseMetricObservation[] {
  const observations = Array.from({ length: 200 }, (_, index) => {
    const language = index % 2 === 0 ? "en" as const : "ru" as const;
    const expectedDecision = index < 40
      ? "contradicted" as const
      : index < 44
        ? "unsupported" as const
        : "supported" as const;
    const numericDate = index < 100;
    return observation({
      criticalNumericDate: index < 10,
      expectedDecision,
      independentUncertainClaim: index === 198 || index === 199,
      language,
      mandatoryRegression: (["temporal", "version", "reference"] as const)[index % 3]!,
      numericDate,
      numericDateAttributionCorrect: !numericDate || index < 98,
      // Deliberately predict supported for unsupported labels: the final-answer
      // unsupported rate is label-derived, not a validator-prediction rate.
      predictedDecision: expectedDecision === "unsupported" ? "supported" : expectedDecision,
      supportedClaimsPreserved: index === 198 || index === 199
    });
  });
  observations.push(...Array.from({ length: 30 }, (_, index) => observation({
    availableCitationHandles: [],
    expectedCitationHandles: [],
    expectedDecision: "supported",
    language: index % 2 === 0 ? "en" : "ru",
    mandatoryRegression: null,
    noAnswerExpected: true,
    noAnswerPredicted: index > 1,
    predictedCitationHandles: [],
    slices: ["no_answer"],
    sourceDerived: false
  })));
  return observations;
}

describe("Knowledge semantic grounding release metrics", () => {
  it("computes deterministic Wilson intervals and makes zero evidence unavailable", () => {
    expect(wilsonConfidenceInterval({ numerator: 50, denominator: 100 })).toEqual({
      confidenceLevel: 0.95,
      lower: 0.40383153,
      upper: 0.59616847
    });
    expect(wilsonConfidenceInterval({ numerator: 0, denominator: 0 })).toBeNull();
    expect(() => wilsonConfidenceInterval({ numerator: 2, denominator: 1 }))
      .toThrow("knowledge_semantic_release_metrics_interval_input_invalid");
    expect(() => wilsonConfidenceInterval({
      confidenceLevel: 0.95,
      numerator: Number.MAX_SAFE_INTEGER + 1,
      denominator: Number.MAX_SAFE_INTEGER + 1
    })).toThrow("knowledge_semantic_release_metrics_interval_input_invalid");
  });

  it("reports every zero denominator as unavailable instead of a vacuous pass", () => {
    const report = measureKnowledgeSemanticGroundingReleaseMetrics({ observations: [] });

    expect(report.overall).toMatchObject({
      claimCount: 0,
      citationHandleValidity: {
        denominator: 0,
        interval: null,
        sampleSufficient: false,
        status: "unavailable",
        value: null
      },
      citationPrecision: { status: "unavailable", value: null },
      contradictionPrecision: { status: "unavailable", value: null },
      contradictionRecall: { status: "unavailable", value: null },
      correctNoAnswer: { status: "unavailable", value: null },
      criticalNumericDateAttribution: { status: "unavailable", value: null },
      numericDateAttribution: { status: "unavailable", value: null },
      unsupportedSourceDerivedRate: { status: "unavailable", value: null }
    });
    expect(Object.values(report.gates)).toEqual(expect.arrayContaining([false]));
    expect(Object.values(report.gates).every((passed) => passed === false)).toBe(true);
    expect(report.releaseGatePassed).toBe(false);
    expect(Object.keys(report.byLanguage)).toEqual([...knowledgeSemanticGroundingReleaseMetricLanguages]);
    expect(Object.keys(report.bySlice)).toEqual([...knowledgeSemanticGroundingReleaseMetricSlices]);
    expect(Object.keys(report.byLanguageAndSlice.en))
      .toEqual([...knowledgeSemanticGroundingReleaseMetricSlices]);
  });

  it("calculates the PRD gates from adjudicated outcomes, handles, and regression flags", () => {
    const report = measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: sufficientObservations()
    });

    expect(report.overall).toMatchObject({
      claimCount: 230,
      citationHandleValidity: {
        denominator: 200,
        numerator: 200,
        value: 1
      },
      citationPrecision: {
        denominator: 200,
        numerator: 200,
        value: 1
      },
      contradictionPrecision: {
        denominator: 40,
        numerator: 40,
        value: 1
      },
      contradictionRecall: {
        denominator: 40,
        numerator: 40,
        value: 1
      },
      correctNoAnswer: {
        denominator: 30,
        numerator: 28,
        value: 0.93333333
      },
      criticalNumericDateAttribution: {
        denominator: 10,
        numerator: 10,
        value: 1
      },
      mandatoryRegressionFalseBlockers: {
        byClass: { reference: 0, temporal: 0, version: 0 },
        total: 0
      },
      numericDateAttribution: {
        denominator: 100,
        numerator: 98,
        value: knowledgeSemanticGroundingReleaseMetricGates.numericDateAttributionMinimum
      },
      unsupportedSourceDerivedRate: {
        denominator: 200,
        numerator: 4,
        value: knowledgeSemanticGroundingReleaseMetricGates.unsupportedSourceDerivedRateMaximum
      },
      wholeAnswerDestruction: {
        destroyedCount: 0,
        preservedCount: 2
      }
    });
    expect(report.gates).toMatchObject({
      allLanguagesPassed: true,
      allLanguagesSampleSufficient: true,
      allRequiredLanguageSlicesPassed: true,
      allRequiredLanguageSlicesSampleSufficient: true,
      allRequiredSlicesPassed: true,
      allRequiredSlicesSampleSufficient: true,
      citationHandleValidity: true,
      citationPrecision: true,
      contradictionPrecision: true,
      contradictionRecall: true,
      confidenceIntervalsStable: true,
      correctNoAnswer: true,
      criticalNumericDateAttribution: true,
      numericDateAttribution: true,
      temporalVersionReferenceFalseBlockers: true,
      unsupportedSourceDerivedRate: true,
      wholeAnswerPreservation: true
    });
    expect(report.byLanguage.en.unsupportedSourceDerivedRate.value).toBe(0.02);
    expect(report.byLanguage.ru.numericDateAttribution.value).toBe(0.98);
    expect(report.byLanguageAndSlice.en.contradiction.gatesPassed).toBe(true);
    expect(report.byLanguageAndSlice.ru.reference_context.gatesPassed).toBe(true);
    expect(report.releaseGatePassed).toBe(false);
  });

  it("fails exact critical, handle, regression, and localized-repair gates", () => {
    const observations = sufficientObservations();
    observations[0] = observation({
      ...observations[0],
      availableCitationHandles: ["K2"],
      criticalNumericDate: true,
      expectedCitationHandles: ["K2"],
      expectedDecision: "supported",
      mandatoryRegression: "reference",
      numericDate: true,
      numericDateAttributionCorrect: false,
      predictedCitationHandles: ["K1"],
      predictedDecision: "unsupported",
      supportedClaimsPreserved: false,
      wholeAnswerDestroyed: true,
      independentUncertainClaim: true
    });
    for (let index = 1; index <= 10; index += 1) {
      observations[index] = observation({
        ...observations[index],
        expectedCitationHandles: ["K2"]
      });
    }
    const report = measureKnowledgeSemanticGroundingReleaseMetrics({ observations });

    expect(report.gates).toMatchObject({
      citationHandleValidity: false,
      citationPrecision: false,
      criticalNumericDateAttribution: false,
      temporalVersionReferenceFalseBlockers: false,
      wholeAnswerPreservation: false
    });
    expect(report.overall.mandatoryRegressionFalseBlockers).toMatchObject({
      byClass: { reference: 1 },
      total: 1
    });
    expect(report.overall.wholeAnswerDestruction.destroyedCount).toBe(1);
    expect(report.reasonCodes).toEqual(expect.arrayContaining([
      "critical_numeric_date_attribution_gate_not_passed",
      "mandatory_regression_false_blocker",
      "whole_answer_destruction_detected"
    ]));
  });

  it("does not promote a perfect but insufficient language or slice", () => {
    const report = measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: [observation({ independentUncertainClaim: true, supportedClaimsPreserved: true })]
    });

    expect(report.overall.citationPrecision).toMatchObject({
      sampleMinimum: knowledgeSemanticGroundingReleaseMetricSampleMinimums.citationPrecision,
      sampleSufficient: false,
      status: "measured",
      value: 1
    });
    expect(report.overall.gatesPassed).toBe(false);
    expect(report.byLanguage.en.gatesPassed).toBe(false);
    expect(report.byLanguage.ru.citationPrecision.status).toBe("unavailable");
    expect(report.bySlice.citation_neighborhood.gatesPassed).toBe(false);
    expect(report.gates.citationPrecision).toBe(false);
    expect(report.gates.allLanguagesPassed).toBe(false);
    expect(report.gates.allLanguagesSampleSufficient).toBe(false);
  });

  it("gates each slice only on its relevant metrics and regression class", () => {
    const noAnswerOnly = Array.from({ length: 30 }, (_, index) => observation({
      availableCitationHandles: [],
      expectedCitationHandles: [],
      independentUncertainClaim: false,
      mandatoryRegression: null,
      noAnswerExpected: true,
      noAnswerPredicted: index < 27,
      predictedCitationHandles: [],
      slices: ["no_answer"],
      sourceDerived: false
    }));
    const noAnswerReport = measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: noAnswerOnly
    });

    expect(noAnswerReport.bySlice.no_answer).toMatchObject({
      citationPrecision: { status: "unavailable", value: null },
      correctNoAnswer: { denominator: 30, numerator: 27, value: 0.9 },
      gatesPassed: true,
      numericDateAttribution: { status: "unavailable", value: null }
    });
    expect(noAnswerReport.byLanguageAndSlice.en.no_answer.gatesPassed).toBe(true);
    expect(noAnswerReport.overall.gatesPassed).toBe(false);

    const temporalOnly = Array.from({ length: 30 }, () => observation({
      availableCitationHandles: [],
      expectedCitationHandles: [],
      mandatoryRegression: "temporal",
      predictedCitationHandles: [],
      slices: ["temporal_non_contradiction"],
      sourceDerived: false
    }));
    const temporalReport = measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: temporalOnly
    });

    expect(temporalReport.bySlice.temporal_non_contradiction).toMatchObject({
      gatesPassed: true,
      mandatoryRegressionFalseBlockers: {
        requiredClasses: ["temporal"],
        requiredClassesMeasured: true,
        requiredTotal: 0
      }
    });
    expect(temporalReport.bySlice.reference_context.gatesPassed).toBe(false);
    expect(temporalReport.overall.mandatoryRegressionFalseBlockers).toMatchObject({
      requiredClasses: ["reference", "temporal", "version"],
      requiredClassesMeasured: false
    });
  });

  it("uses an exact aggregate schema and never projects claim keys", () => {
    const claimSha256 = createHash("sha256").update("content-free-test-key").digest("hex");
    const report = measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: [observation({
        claimSha256,
        independentUncertainClaim: true,
        supportedClaimsPreserved: true
      })]
    });

    expect(JSON.stringify(report)).not.toContain(claimSha256);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.byLanguageAndSlice.en)).toBe(true);
    expect(() => assertKnowledgeSemanticGroundingReleaseMetrics(report)).not.toThrow();
    expect(decodeKnowledgeSemanticGroundingReleaseMetrics(
      JSON.parse(JSON.stringify(report)) as unknown
    )).toEqual(report);

    const withUnknownSlice = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const bySlice = withUnknownSlice.bySlice as Record<string, unknown>;
    bySlice.unreviewed_private_slice = bySlice.citation_neighborhood;
    expect(() => decodeKnowledgeSemanticGroundingReleaseMetrics(withUnknownSlice)).toThrow();

    const withTamperedRate = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const overall = withTamperedRate.overall as Record<string, unknown>;
    const citationPrecision = overall.citationPrecision as Record<string, unknown>;
    citationPrecision.value = 0.5;
    expect(() => decodeKnowledgeSemanticGroundingReleaseMetrics(withTamperedRate)).toThrow();

    const observationWithAnswerText = {
      ...observation(),
      answerText: "must not enter metrics"
    };
    expect(() => measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: [observationWithAnswerText]
    })).toThrow();
    expect(() => measureKnowledgeSemanticGroundingReleaseMetrics({
      observations: [
        observation({ claimSha256 }),
        observation({ claimSha256, language: "ru" })
      ]
    })).toThrow("knowledge_semantic_release_metrics_duplicate_claim");
  });
});
