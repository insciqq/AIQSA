import { describe, expect, it } from "vitest";
import { runContextualKeyQualification } from
  "../../../../benchmarks/aiqsa-memory-contextual-key-qualification/contract";

describe("contextual-key qualification", () => {
  it("keeps strict grounding while measuring deterministic multilingual retrieval", () => {
    const report = runContextualKeyQualification();

    expect(report.corpus).toEqual({
      caseCount: 32,
      fixedSeed: "contextual-key-qualification-corpus-v1",
      priorDependentCount: 16
    });
    expect(report.metrics.rawKeyRecall).toEqual({
      at5: 0.5,
      at10: 0.5,
      at20: 0.625
    });
    expect(report.metrics.contextualKeyRecall).toEqual({
      at5: 1,
      at10: 1,
      at20: 1
    });
    expect(report.metrics).toMatchObject({
      contextualFallbackRate: 0,
      contextualGeneratedRate: 1,
      contextualOnlyGoldHitCountAt20: 12,
      contextualPriorDependencyRate: 0.5,
      deterministicDecoderSuccessRate: 1,
      missingSupportingDependencyCount: 0,
      rawOnlyGoldHitCountAt20: 0
    });
    expect(report.dimensions.byLanguage).toMatchObject({
      en: { fallbackRate: 0, generatedRate: 1, total: 8 },
      mixed: { fallbackRate: 0, generatedRate: 1, total: 4 },
      other: { fallbackRate: 0, generatedRate: 1, total: 8 },
      ru: { fallbackRate: 0, generatedRate: 1, total: 8 },
      und: { fallbackRate: 0, generatedRate: 1, total: 4 }
    });
    expect(report.adversarial).toMatchObject({
      acceptedUnsupportedDateCount: 0,
      acceptedUnsupportedEntityCount: 0,
      acceptedUnsupportedNumberCount: 0,
      rejectedCount: 4,
      rejectionReasonCounts: {
        DUPLICATE_STATEMENT: 1,
        UNSUPPORTED_DATE: 1,
        UNSUPPORTED_ENTITY: 1,
        UNSUPPORTED_NUMBER: 2
      }
    });
    expect(report.targetEvidence).toEqual({
      acceptedUnsupportedDateAndEntityIsZero: true,
      contextualRecallAt20WithinOnePoint: true,
      coreferenceImprovementAtLeastFivePoints: true,
      deterministicDecoderSuccessAtLeast99Percent: true,
      englishFallbackAtMost20Percent: true,
      missingSupportingDependencyIsZero: true,
      providerSuccessAtLeast99Percent: null,
      russianFallbackAtMost30Percent: true
    });
    expect(report.decision).toEqual({
      controlledEquivalenceEnabled: false,
      reason: "REAL_PROVIDER_EVIDENCE_UNAVAILABLE_STRICT_VALIDATOR_RETAINED",
      validatorMode: "STRICT_SOURCE_BOUND"
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Project Cedar");
    expect(serialized).not.toContain("rawSafeText");
    expect(serialized).not.toContain("contextualSearchText");
  });
});
