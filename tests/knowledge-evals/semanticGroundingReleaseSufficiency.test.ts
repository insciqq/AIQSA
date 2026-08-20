import { describe, expect, it } from "vitest";
import {
  assertKnowledgeSemanticGroundingReleaseCorpusEligible,
  auditKnowledgeSemanticGroundingReleaseCorpus,
  knowledgeSemanticGroundingQualityGates,
  knowledgeSemanticGroundingReleaseSampleMinimums,
  runCurrentFenceSemanticGroundingBenchmark,
  type KnowledgeSemanticGroundingReleaseCorpusAuditFixture
} from "./semanticGrounding";

function auditFixture(input: Readonly<{
  documentFamily: string;
  id: string;
  language: "en" | "ru";
  split: "development" | "blinded_review";
}>): KnowledgeSemanticGroundingReleaseCorpusAuditFixture {
  return Object.freeze({
    ...input,
    labels: Object.freeze([])
  });
}

describe("Knowledge semantic release-corpus sufficiency", () => {
  it("keeps structural representation separate from release sample minima", () => {
    expect(knowledgeSemanticGroundingQualityGates.sliceLanguageClaimMinimum).toBe(1);
    expect(knowledgeSemanticGroundingReleaseSampleMinimums).toMatchObject({
      calibration: {
        claimCount: 80,
        languageClaimCount: 40,
        normalizedTemplateFamilyCount: 40
      },
      finalEvaluation: {
        claimCount: 240,
        languageClaimCount: 120,
        normalizedTemplateFamilyCount: 120,
        sliceClaimCount: 30,
        sliceLanguageClaimCount: 15,
        sliceNormalizedTemplateFamilyCount: 12
      }
    });
  });

  it("proves the expanded generated corpus meets the frozen structural sample contract", () => {
    const report = runCurrentFenceSemanticGroundingBenchmark();
    const evidence = report.corpus.releaseEvidence;

    expect(evidence).toMatchObject({
      automatedGateEligible: true,
      independentReviewGateEligible: true,
      releaseGateEligible: true,
      samples: {
        blindedReview: {
          claimCount: 256,
          documentFamilyCount: 128,
          normalizedTemplateFamilyCount: 128
        },
        calibration: {
          claimCount: 92,
          documentFamilyCount: 50,
          normalizedTemplateFamilyCount: 50
        },
        heldOut: {
          claimCount: 297,
          documentFamilyCount: 164,
          normalizedTemplateFamilyCount: 164
        }
      },
      splitIntegrity: {
        exactDocumentFamilyCollisionCount: 0,
        exactDocumentFamilySplitDisjoint: true,
        normalizedTemplateFamilyCollisionCount: 0,
        normalizedTemplateFamilySplitDisjoint: true
      },
      version: 1
    });
    expect(evidence.reasonCodes).toEqual([]);
    expect(report.limitations).not.toEqual(expect.arrayContaining([
      "normalized_template_family_split_leakage",
      "release_sample_sufficiency_not_met"
    ]));
    expect(JSON.stringify(evidence)).not.toMatch(/falcon|polaris|matrix-dev|matrix-blind/u);
  });

  it("cannot pass renamed dev/blind instances of the same generated template", () => {
    const audit = auditKnowledgeSemanticGroundingReleaseCorpus([
      auditFixture({
        documentFamily: "matrix-dev-falcon-en-direct-list",
        id: "dev-falcon-en-direct-list",
        language: "en",
        split: "development"
      }),
      auditFixture({
        documentFamily: "matrix-blind-polaris-en-direct-list",
        id: "blind-polaris-en-direct-list",
        language: "en",
        split: "blinded_review"
      })
    ]);

    expect(audit.splitIntegrity).toMatchObject({
      exactDocumentFamilyCollisionCount: 0,
      exactDocumentFamilySplitDisjoint: true,
      normalizedTemplateFamilyCollisionCount: 1,
      normalizedTemplateFamilySplitDisjoint: false
    });
    expect(audit.releaseGateEligible).toBe(false);
    expect(audit.reasonCodes).toContain("normalized_template_family_split_leakage");
    expect(() => assertKnowledgeSemanticGroundingReleaseCorpusEligible(audit))
      .toThrow("normalized_template_family_split_leakage");
  });
});
