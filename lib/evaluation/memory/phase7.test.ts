import { describe, expect, it } from "vitest";
import {
  MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
  MEMORY_PHASE7_CORPUS_VERSION,
  MEMORY_PHASE7_EVALUATOR_VERSION,
  MEMORY_PHASE7_EVIDENCE_VERSION,
  MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
  MEMORY_PHASE7_RANDOM_SEED,
  MEMORY_PHASE7_SCORER_VERSION,
  MEMORY_PHASE7_SUITE_VERSION,
  decideMemoryPhase7CoreMateriality,
  decideMemoryPhase7HindsightGap,
  decideMemoryPhase7OptionalComponent,
  decideMemoryPhase7Profile,
  memoryPhase7RussianTextPreservesLanguage,
  memoryPhase7EvidenceIdentityIsCurrent,
  type MemoryPhase7BilingualScore
} from "./phase7";

function score(overrides: Partial<MemoryPhase7BilingualScore["EN"]> = {}) {
  return {
    criticalRecallAt5: { temporal: 0.9 },
    hardInvariantFailures: 0,
    irrelevantInjectionRate: 0,
    irrelevantInjectionUpper95: 0.02,
    recallAt5: 0.85,
    scopeAccuracy: 0.9,
    temporalAccuracy: 0.9,
    ...overrides
  };
}

function bilingual(
  overrides: Partial<MemoryPhase7BilingualScore["EN"]> = {}
): MemoryPhase7BilingualScore {
  return { EN: score(overrides), RU: score(overrides) };
}

describe("Phase 7 preregistered Memory quality decisions", () => {
  it("accepts bilingual material core lift and rejects safety or cohort regression", () => {
    expect(decideMemoryPhase7CoreMateriality({
      current: bilingual({ recallAt5: 0.87 }),
      hardCapabilityAfter: false,
      hardCapabilityBefore: false,
      previous: bilingual()
    })).toMatchObject({ material: true, reasons: ["RECALL_LIFT"], safetyPassed: true });

    expect(decideMemoryPhase7CoreMateriality({
      current: {
        EN: score({ recallAt5: 0.87 }),
        RU: score({ recallAt5: 0.86 })
      },
      hardCapabilityAfter: false,
      hardCapabilityBefore: false,
      previous: bilingual()
    }).material).toBe(false);

    expect(decideMemoryPhase7CoreMateriality({
      current: bilingual({
        criticalRecallAt5: { temporal: 0.87 },
        hardInvariantFailures: 1,
        recallAt5: 0.9
      }),
      hardCapabilityAfter: true,
      hardCapabilityBefore: false,
      previous: bilingual()
    })).toMatchObject({ material: false, safetyPassed: false });
  });

  it("keeps optional utilities off unless lift, safety, latency, and cost all pass", () => {
    expect(decideMemoryPhase7OptionalComponent({
      costUsdPerEligibleQuery: 0.001,
      current: bilingual({ recallAt5: 0.87 }),
      latencyP95Ms: 1_200,
      previous: bilingual()
    })).toEqual({
      enabled: true,
      latencyAndCostPassed: true,
      liftPassed: true,
      safetyPassed: true
    });
    expect(decideMemoryPhase7OptionalComponent({
      costUsdPerEligibleQuery: 0.003,
      current: bilingual({ recallAt5: 0.87 }),
      latencyP95Ms: 1_200,
      previous: bilingual()
    }).enabled).toBe(false);
    expect(decideMemoryPhase7OptionalComponent({
      costUsdPerEligibleQuery: 0.001,
      current: bilingual({ recallAt5: 0.86 }),
      latencyP95Ms: 1_200,
      previous: bilingual()
    }).enabled).toBe(false);
  });

  it("requires exact profile support, useful compression, language fidelity, and budget", () => {
    expect(decideMemoryPhase7Profile({
      compressionRatios: [0.45, 0.5, 0.55],
      eligibleCases: 40,
      estimatedCostUsdPerProjection: 0.01,
      latencyP95Ms: 8_000,
      producedCases: 39,
      russianLanguagePreserved: 100,
      russianSegments: 100,
      supportedSegments: 200,
      totalSegments: 200
    })).toMatchObject({
      enabled: true,
      exactSupportPassed: true,
      medianCompressionRatio: 0.5,
      yieldRate: 0.975
    });
    expect(decideMemoryPhase7Profile({
      compressionRatios: [0.5],
      eligibleCases: 40,
      estimatedCostUsdPerProjection: 0.01,
      latencyP95Ms: 8_000,
      producedCases: 40,
      russianLanguagePreserved: 99,
      russianSegments: 100,
      supportedSegments: 199,
      totalSegments: 200
    }).enabled).toBe(false);
    expect(decideMemoryPhase7Profile({
      compressionRatios: [0.5],
      eligibleCases: 1,
      estimatedCostUsdPerProjection: null,
      latencyP95Ms: 8_000,
      producedCases: 1,
      russianLanguagePreserved: 1,
      russianSegments: 1,
      supportedSegments: 1,
      totalSegments: 1
    })).toMatchObject({ enabled: false, operationalPassed: false });
  });

  it("treats Russian sentences with exact Latin technical terms as language-preserving", () => {
    expect(memoryPhase7RussianTextPreservesLanguage("ru")).toBe(true);
    expect(memoryPhase7RussianTextPreservesLanguage("mixed")).toBe(true);
    expect(memoryPhase7RussianTextPreservesLanguage("en")).toBe(false);
    expect(memoryPhase7RussianTextPreservesLanguage("und")).toBe(false);
  });

  it("applies strict Hindsight trigger gaps and similar-recall precision comparison", () => {
    expect(decideMemoryPhase7HindsightGap({
      native: {
        factPrecision: 0.95,
        factRecall: 0.9,
        russianRecallAt5: 0.85,
        temporalAccuracy: 0.9
      },
      reference: {
        factPrecision: 0.99,
        factRecall: 0.91,
        russianRecallAt5: 0.95,
        temporalAccuracy: 0.97
      }
    }).requiresFocusedQualityWork).toBe(false);
    expect(decideMemoryPhase7HindsightGap({
      native: {
        factPrecision: 0.9,
        factRecall: 0.9,
        russianRecallAt5: 0.84,
        temporalAccuracy: 0.9
      },
      reference: {
        factPrecision: 0.98,
        factRecall: 0.91,
        russianRecallAt5: 0.96,
        temporalAccuracy: 0.96
      }
    })).toMatchObject({ requiresFocusedQualityWork: true, similarFactRecall: true });
  });

  it("ignores additional diagnostic fields outside the Hindsight metric contract", () => {
    const metrics = {
      cases: 40,
      factPrecision: 0.95,
      factRecall: 0.9,
      russianRecallAt5: 0.9,
      temporalAccuracy: 0.9
    };
    expect(decideMemoryPhase7HindsightGap({
      native: metrics,
      reference: metrics
    })).toMatchObject({
      requiresFocusedQualityWork: false,
      similarFactRecall: true
    });
  });

  it("pins the complete Phase 7 evidence identity", () => {
    const current = {
      bootstrapSamples: MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
      corpusHash: MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
      corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
      evaluatorVersion: MEMORY_PHASE7_EVALUATOR_VERSION,
      evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
      randomSeed: MEMORY_PHASE7_RANDOM_SEED,
      scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
      suiteVersion: MEMORY_PHASE7_SUITE_VERSION
    };
    expect(memoryPhase7EvidenceIdentityIsCurrent(current)).toBe(true);
    expect(memoryPhase7EvidenceIdentityIsCurrent({
      ...current,
      randomSeed: MEMORY_PHASE7_RANDOM_SEED + 1
    })).toBe(false);
  });
});
