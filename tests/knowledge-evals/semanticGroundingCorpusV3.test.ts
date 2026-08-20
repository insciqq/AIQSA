import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { segmentKnowledgeSemanticClaims } from "../../lib/server/knowledge/semanticGrounding";
import {
  assertKnowledgeSemanticGroundingReleaseCorpusEligible,
  auditKnowledgeSemanticGroundingReleaseCorpus,
  knowledgeSemanticGroundingReleaseSampleMinimums,
  runCurrentFenceSemanticGroundingBenchmark
} from "./semanticGrounding";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
  knowledgeSemanticGroundingFixtures,
  knowledgeSemanticGroundingSlices
} from "./semanticGroundingFixtures";

function claimSha256(claim: ReturnType<typeof segmentKnowledgeSemanticClaims>[number]): string {
  return createHash("sha256").update(JSON.stringify({
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    context: claim.context,
    ordinal: claim.ordinal,
    sourceShape: claim.sourceShape,
    text: claim.text,
    type: claim.type
  }), "utf8").digest("hex");
}

describe("Knowledge semantic grounding release corpus v3", () => {
  it("meets every frozen sample and split-integrity minimum", () => {
    const audit = auditKnowledgeSemanticGroundingReleaseCorpus();

    expect(() => assertKnowledgeSemanticGroundingReleaseCorpusEligible(audit)).not.toThrow();
    expect(audit).toMatchObject({
      automatedGateEligible: true,
      independentReviewGateEligible: true,
      reasonCodes: [],
      releaseGateEligible: true,
      splitIntegrity: {
        exactDocumentFamilyCollisionCount: 0,
        exactDocumentFamilySplitDisjoint: true,
        normalizedTemplateFamilyCollisionCount: 0,
        normalizedTemplateFamilySplitDisjoint: true
      }
    });
    expect(KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION)
      .toBe("knowledge-semantic-grounding-corpus-v3");

    const calibrationMinimums = knowledgeSemanticGroundingReleaseSampleMinimums.calibration;
    expect(audit.samples.calibration.claimCount).toBeGreaterThanOrEqual(
      calibrationMinimums.claimCount
    );
    expect(audit.samples.calibration.normalizedTemplateFamilyCount).toBeGreaterThanOrEqual(
      calibrationMinimums.normalizedTemplateFamilyCount
    );
    expect(audit.samples.calibration.normalizedTemplateFamilyCount)
      .toBe(audit.samples.calibration.documentFamilyCount);
    for (const language of ["en", "ru"] as const) {
      expect(audit.samples.calibration.languageClaims[language]).toBeGreaterThanOrEqual(
        calibrationMinimums.languageClaimCount
      );
    }
    for (const decision of ["contradicted", "supported", "uncertain", "unsupported"] as const) {
      expect(audit.samples.calibration.decisionClaims[decision]).toBeGreaterThanOrEqual(
        calibrationMinimums.decisionClaims[decision]
      );
    }

    const finalMinimums = knowledgeSemanticGroundingReleaseSampleMinimums.finalEvaluation;
    for (const sample of [audit.samples.heldOut, audit.samples.blindedReview]) {
      expect(sample.claimCount).toBeGreaterThanOrEqual(finalMinimums.claimCount);
      expect(sample.normalizedTemplateFamilyCount).toBeGreaterThanOrEqual(
        finalMinimums.normalizedTemplateFamilyCount
      );
      expect(sample.normalizedTemplateFamilyCount).toBe(sample.documentFamilyCount);
      for (const language of ["en", "ru"] as const) {
        expect(sample.languageClaims[language]).toBeGreaterThanOrEqual(
          finalMinimums.languageClaimCount
        );
      }
      for (const decision of ["contradicted", "supported", "uncertain", "unsupported"] as const) {
        expect(sample.decisionClaims[decision]).toBeGreaterThanOrEqual(
          finalMinimums.decisionClaims[decision]
        );
      }
      for (const slice of knowledgeSemanticGroundingSlices) {
        expect(sample.slices[slice].claimCount).toBeGreaterThanOrEqual(
          finalMinimums.sliceClaimCount
        );
        expect(sample.slices[slice].normalizedTemplateFamilyCount).toBeGreaterThanOrEqual(
          finalMinimums.sliceNormalizedTemplateFamilyCount
        );
        for (const language of ["en", "ru"] as const) {
          expect(sample.slices[slice].languageClaims[language]).toBeGreaterThanOrEqual(
            finalMinimums.sliceLanguageClaimCount
          );
          expect(sample.slices[slice].languageNormalizedTemplateFamilies[language])
            .toBeGreaterThanOrEqual(finalMinimums.sliceLanguageNormalizedTemplateFamilyCount);
        }
      }
    }
  });

  it("uses unique claim identities and keeps structural labels separate from release proof", () => {
    const claims = knowledgeSemanticGroundingFixtures.flatMap((fixture) =>
      segmentKnowledgeSemanticClaims({ answer: fixture.answer, evidence: fixture.evidence }));
    const claimHashes = claims.map(claimSha256);
    const arithmeticPlans = knowledgeSemanticGroundingFixtures.flatMap((fixture) =>
      fixture.arithmeticPlans.map((plan) => ({ fixture, plan })));
    const arithmeticLabels = knowledgeSemanticGroundingFixtures.flatMap((fixture) =>
      fixture.labels.filter((label) => label.slices.includes("derived_arithmetic"))
        .map((label) => ({ fixture, label })));
    const referenceFixtures = knowledgeSemanticGroundingFixtures.filter((fixture) =>
      fixture.split === "held_out" || fixture.split === "blinded_review").filter((fixture) =>
      fixture.labels.some((label) => label.slices.includes("reference_context")));
    const report = runCurrentFenceSemanticGroundingBenchmark();

    expect(claims).toHaveLength(681);
    expect(new Set(claimHashes).size).toBe(claimHashes.length);
    expect(arithmeticPlans).toHaveLength(70);
    expect(arithmeticLabels).toHaveLength(arithmeticPlans.length);
    expect(arithmeticLabels.every(({ fixture, label }) => fixture.arithmeticPlans.some((plan) =>
      plan.claimOrdinal === label.claimOrdinal &&
      plan.citationHandle === label.attributableHandles[0]))).toBe(true);
    for (const split of ["held_out", "blinded_review"] as const) {
      for (const language of ["en", "ru"] as const) {
        const labels = referenceFixtures.filter((fixture) =>
          fixture.split === split && fixture.language === language).flatMap((fixture) =>
          fixture.labels.filter((label) => label.slices.includes("reference_context")));
        expect(labels).toHaveLength(16);
        expect(new Set(labels.map((label) => label.decision)))
          .toEqual(new Set(["contradicted", "supported"]));
      }
    }
    expect(report).toMatchObject({
      blockingEligible: false,
      corpus: { labelProvenance: "generated_single_annotator" },
      releaseGatePassed: false,
      semanticProof: false
    });
    expect(report.limitations).toEqual(expect.arrayContaining([
      "no_independent_blinded_review",
      "structural_baseline_not_semantic",
      "synthetic_single_annotator_labels"
    ]));
  });
});
