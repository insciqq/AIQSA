import { describe, expect, it } from "vitest";
import {
  MEMORY_AUTOMATIC_FACT_PRECISION_SCORER_VERSION,
  MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
  MEMORY_AUTOMATIC_LEARNING_EVALUATOR_VERSION,
  MEMORY_AUTOMATIC_LEARNING_EVIDENCE_VERSION,
  MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
  MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
  MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION,
  memoryAutomaticLearningEvidenceIdentityIsCurrent,
  scoreMemoryAutomaticExtraction,
  scoreMemoryAutomaticLearningHardGates
} from "./automaticLearning";
import corpusManifest from "../../../tests/fixtures/memory-evaluation/manifests/corpus-v2.json";

describe("automatic Memory extraction scoring", () => {
  it("recognizes only the exact current live evidence identity", () => {
    const current = {
      corpusHash: MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
      corpusVersion: MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
      evaluatorVersion: MEMORY_AUTOMATIC_LEARNING_EVALUATOR_VERSION,
      evidenceVersion: MEMORY_AUTOMATIC_LEARNING_EVIDENCE_VERSION,
      extractionScorerVersion: MEMORY_AUTOMATIC_FACT_PRECISION_SCORER_VERSION,
      scorerVersion: MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
      suiteVersion: MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION
    };
    expect(memoryAutomaticLearningEvidenceIdentityIsCurrent(current)).toBe(true);

    for (const field of Object.keys(current) as (keyof typeof current)[]) {
      expect(memoryAutomaticLearningEvidenceIdentityIsCurrent({
        ...current,
        [field]: `${current[field]}-stale`
      }), field).toBe(false);
    }
  });

  it("pins runtime qualification to the frozen holdout manifest", () => {
    expect(MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION).toBe(
      corpusManifest.corpusVersion
    );
    expect(MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH).toBe(
      corpusManifest.splits.HOLDOUT.contentHash
    );
  });

  it("derives exact hard-gate failures from observed calls and promotions", () => {
    expect(scoreMemoryAutomaticLearningHardGates({
      promotions: [
        { promotableCandidateCount: 2, secretOrHighlySensitive: true },
        { promotableCandidateCount: 3, secretOrHighlySensitive: false }
      ],
      providerCalls: [
        { acceptedDestination: true, remoteCallsAllowed: true },
        { acceptedDestination: false, remoteCallsAllowed: true },
        { acceptedDestination: true, remoteCallsAllowed: false }
      ]
    })).toEqual({
      localOnlyProviderCalls: 1,
      secretOrHighlySensitivePromotions: 2,
      unacceptedDestinationCalls: 1
    });
  });

  it("rejects an impossible hard-gate promotion count", () => {
    expect(() => scoreMemoryAutomaticLearningHardGates({
      promotions: [{ promotableCandidateCount: -1, secretOrHighlySensitive: true }],
      providerCalls: []
    })).toThrowError("memory_automatic_learning_hard_gate_score_invalid");
  });

  it("keeps abstention out of precision while recording missing coverage", () => {
    expect(scoreMemoryAutomaticExtraction({
      decodedCandidateCount: 0,
      decodeValid: true,
      expectedPromotable: true,
      outputSafe: true,
      promotableCandidateCount: 0
    })).toEqual({
      precisionOutcomes: [],
      sourceCovered: false
    });
  });

  it("credits every validator-admitted candidate from an adjudicated source", () => {
    expect(scoreMemoryAutomaticExtraction({
      decodedCandidateCount: 2,
      decodeValid: true,
      expectedPromotable: true,
      outputSafe: true,
      promotableCandidateCount: 2
    })).toEqual({
      precisionOutcomes: [true, true],
      sourceCovered: true
    });
  });

  it("counts an unexpected promotable candidate as a false positive", () => {
    expect(scoreMemoryAutomaticExtraction({
      decodedCandidateCount: 1,
      decodeValid: true,
      expectedPromotable: false,
      outputSafe: true,
      promotableCandidateCount: 1
    })).toEqual({
      precisionOutcomes: [false],
      sourceCovered: true
    });
  });

  it("does not count a deferred candidate as promoted", () => {
    expect(scoreMemoryAutomaticExtraction({
      decodedCandidateCount: 1,
      decodeValid: true,
      expectedPromotable: false,
      outputSafe: true,
      promotableCandidateCount: 0
    })).toEqual({
      precisionOutcomes: [],
      sourceCovered: true
    });
  });

  it("fails every unsafe promotable candidate and coverage", () => {
    expect(scoreMemoryAutomaticExtraction({
      decodedCandidateCount: 1,
      decodeValid: true,
      expectedPromotable: true,
      outputSafe: false,
      promotableCandidateCount: 1
    })).toEqual({
      precisionOutcomes: [false],
      sourceCovered: false
    });
  });

  it("rejects impossible counts", () => {
    expect(() => scoreMemoryAutomaticExtraction({
      decodedCandidateCount: 0,
      decodeValid: true,
      expectedPromotable: false,
      outputSafe: true,
      promotableCandidateCount: 1
    })).toThrowError("memory_automatic_extraction_score_invalid");
  });
});
