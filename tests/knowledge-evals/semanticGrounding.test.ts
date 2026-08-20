import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION,
  segmentKnowledgeSemanticClaims,
  type KnowledgeSemanticGroundingDecision,
  type KnowledgeSemanticReasonFamily
} from "../../lib/server/knowledge/semanticGrounding";
import {
  assertKnowledgeSemanticGroundingBenchmarkContract,
  knowledgeSemanticGroundingQualityGates,
  runCurrentFenceSemanticGroundingBenchmark,
  scoreKnowledgeSemanticGroundingPredictions
} from "./semanticGrounding";
import {
  knowledgeSemanticGroundingFixtures,
  knowledgeSemanticGroundingSlices
} from "./semanticGroundingFixtures";

function reason(decision: KnowledgeSemanticGroundingDecision): KnowledgeSemanticReasonFamily {
  if (decision === "supported") return "entailed";
  if (decision === "contradicted") return "same_context_conflict";
  if (decision === "unsupported") return "not_supported";
  return "insufficient_context";
}

function labelReplayPredictions() {
  return knowledgeSemanticGroundingFixtures.map((fixture) => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: fixture.answer,
      evidence: fixture.evidence
    });
    return {
      fixtureId: fixture.id,
      predictions: fixture.labels.map((label, index) => ({
        attributableHandles: label.attributableHandles,
        claimOrdinal: claims[index]!.ordinal,
        confidence: 1,
        decision: label.decision,
        reasonFamily: reason(label.decision),
        validatorProfile: "label-replay-test-only",
        validatorVersion: 1,
        version: KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION
      }))
    };
  });
}

describe("Knowledge semantic grounding shadow benchmark", () => {
  it("measures the current structural fence without presenting it as semantic proof", () => {
    const report = runCurrentFenceSemanticGroundingBenchmark();

    expect(() => assertKnowledgeSemanticGroundingBenchmarkContract(report)).not.toThrow();
    expect(report).toMatchObject({
      blockingEligible: false,
      candidate: {
        blockingEligible: false,
        independentLabelReviewComplete: false,
        profile: "current-structural-fence-v4",
        semanticProof: false,
        version: 4
      },
      claimCount: 681,
      contractValid: true,
      corpus: {
        fixtureCount: 364,
        labelProvenance: "generated_single_annotator",
        languages: { en: 184, ru: 180 },
        releaseEvidence: {
          automatedGateEligible: true,
          independentReviewGateEligible: true,
          reasonCodes: [],
          releaseGateEligible: true,
          splitIntegrity: {
            exactDocumentFamilyCollisionCount: 0,
            normalizedTemplateFamilyCollisionCount: 0
          }
        },
        splitClaims: {
          blinded_review: 256,
          calibration: 92,
          development: 36,
          held_out: 297
        },
        splitFixtures: {
          blinded_review: 128,
          calibration: 50,
          development: 22,
          held_out: 164
        },
        version: "knowledge-semantic-grounding-corpus-v3"
      },
      metrics: {
        attributionAccuracy: 1,
        contradictionPrecision: 0.833333,
        contradictionRecall: 0.083333,
        dateConsistencyAccuracy: 0.135135,
        decisionAccuracy: 0.23569,
        genericEntailmentAccuracy: 0.064103,
        locatorAccuracy: 0.485294,
        noAnswerAccuracy: 0.485714,
        temporalFalseBlockers: 32,
        versionAttributionAccuracy: 0.135135
      },
      releaseGatePassed: false,
      semanticProof: false,
      semanticQualityGatePassed: false,
      version: 1
    });
    expect(report.limitations).toEqual(expect.arrayContaining([
      "no_independent_blinded_review",
      "structural_baseline_not_semantic",
      "synthetic_single_annotator_labels"
    ]));
    expect(report.limitations).not.toEqual(expect.arrayContaining([
      "normalized_template_family_split_leakage",
      "release_sample_sufficiency_not_met"
    ]));
    expect(JSON.stringify(report)).not.toMatch(
      /Atlas|Береста|SAFE-2718|held-en|held-ru|\[K1\]/u
    );
  });

  it("scores future prediction sets against frozen labels without changing the corpus", () => {
    const report = scoreKnowledgeSemanticGroundingPredictions({
      candidate: {
        blockingEligible: false,
        independentLabelReviewComplete: false,
        profile: "label-replay-test-only",
        semanticProof: false,
        version: 1
      },
      predictions: labelReplayPredictions()
    });

    expect(report.metrics).toMatchObject({
      attributionAccuracy: 1,
      contradictionPrecision: 1,
      contradictionRecall: 1,
      decisionAccuracy: 1,
      factualCorrectness: 1,
      groundedCorrectness: 1
    });
    expect(report.semanticQualityGatePassed).toBe(false);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.semanticProof).toBe(false);
    expect(report.blockingEligible).toBe(false);
  });

  it("keeps every evaluation split bilingual, family-disjoint, and slice-complete", () => {
    const splitNames = ["development", "calibration", "held_out", "blinded_review"] as const;
    const familySplits = new Map<string, Set<string>>();
    for (const fixture of knowledgeSemanticGroundingFixtures) {
      const splits = familySplits.get(fixture.documentFamily) ?? new Set<string>();
      splits.add(fixture.split);
      familySplits.set(fixture.documentFamily, splits);
    }

    expect([...familySplits.values()].every((splits) => splits.size === 1)).toBe(true);
    for (const split of splitNames) {
      const fixtures = knowledgeSemanticGroundingFixtures.filter((fixture) =>
        fixture.split === split);
      expect(fixtures.length).toBeGreaterThan(0);
      expect(new Set(fixtures.map((fixture) => fixture.language))).toEqual(new Set(["en", "ru"]));
      expect(new Set(fixtures.map((fixture) => fixture.documentFamily)).size)
        .toBe(fixtures.length);
    }

    for (const split of ["held_out", "blinded_review"] as const) {
      const fixtures = knowledgeSemanticGroundingFixtures.filter((fixture) =>
        fixture.split === split);
      const claims = fixtures.flatMap((fixture) => fixture.labels);
      expect(claims.length).toBeGreaterThanOrEqual(
        knowledgeSemanticGroundingQualityGates.heldOutClaimMinimum
      );
      for (const slice of knowledgeSemanticGroundingSlices) {
        expect(claims.filter((claim) => claim.slices.includes(slice)).length)
          .toBeGreaterThanOrEqual(knowledgeSemanticGroundingQualityGates.sliceClaimMinimums[slice]);
        for (const language of ["en", "ru"] as const) {
          expect(fixtures
            .filter((fixture) => fixture.language === language)
            .flatMap((fixture) => fixture.labels)
            .filter((claim) => claim.slices.includes(slice)).length)
            .toBeGreaterThanOrEqual(knowledgeSemanticGroundingQualityGates.sliceLanguageClaimMinimum);
        }
      }
      for (const type of ["coverage_claim", "general_knowledge"] as const) {
        for (const language of ["en", "ru"] as const) {
          expect(fixtures
            .filter((fixture) => fixture.language === language)
            .flatMap((fixture) => fixture.labels)
            .filter((claim) => claim.type === type).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("fails closed when a candidate omits a fixture", () => {
    expect(() => scoreKnowledgeSemanticGroundingPredictions({
      candidate: {
        blockingEligible: false,
        independentLabelReviewComplete: false,
        profile: "incomplete-candidate",
        semanticProof: false,
        version: 1
      },
      predictions: labelReplayPredictions().slice(1)
    })).toThrow("knowledge_semantic_prediction_fixture_coverage_incomplete");
  });
});
