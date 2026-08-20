import { chmod, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeSemanticGroundingCandidatePool } from "./semanticGroundingCandidates";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
  knowledgeSemanticGroundingFixtures
} from "./semanticGroundingFixtures";
import {
  createKnowledgeSemanticGroundingReviewArtifacts,
  importKnowledgeSemanticGroundingReviewEvidence,
  knowledgeSemanticGroundingReviewerSubmissionSha256,
  KNOWLEDGE_SEMANTIC_GROUNDING_ADJUDICATION_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_A_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_B_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_TRUST_EVIDENCE_FILE,
  readKnowledgeSemanticGroundingReviewEvidenceDirectory,
  validateKnowledgeSemanticGroundingReviewDirectory,
  writeKnowledgeSemanticGroundingReviewArtifacts,
  type KnowledgeSemanticGroundingAdjudication,
  type KnowledgeSemanticGroundingReviewPacket,
  type KnowledgeSemanticGroundingReviewerSubmission
} from "./semanticGroundingReview";

function deterministicIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
}

function artifacts(
  reviewScope: "calibration" | "final" = "final",
  evaluationBindings = reviewScope === "calibration"
    ? {
        calibrationFreezeManifestSha256: null,
        candidateFreezeManifestSha256: "a".repeat(64),
        finalPredictionFreezeManifestSha256: null
      }
    : {
        calibrationFreezeManifestSha256: "b".repeat(64),
        candidateFreezeManifestSha256: "a".repeat(64),
        finalPredictionFreezeManifestSha256: "c".repeat(64)
      }
) {
  return createKnowledgeSemanticGroundingReviewArtifacts({
    corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
    evaluationBindings,
    fixtures: knowledgeSemanticGroundingFixtures,
    randomId: deterministicIds(),
    randomIndex: () => 0,
    reviewScope
  });
}

function decisions(
  packet: KnowledgeSemanticGroundingReviewPacket,
  variant: "first" | "second" | "adjudicated"
) {
  return packet.claims.map((claim, index) => ({
    attributableEvidenceIds: variant === "second" && index === 0 && claim.evidence[0]
      ? [claim.evidence[0].reviewEvidenceId]
      : [],
    decision: variant === "second" && index === 0
      ? "supported" as const
      : "uncertain" as const,
    reviewClaimId: claim.reviewClaimId
  }));
}

function submission(
  packet: KnowledgeSemanticGroundingReviewPacket,
  id: string,
  variant: "first" | "second"
): KnowledgeSemanticGroundingReviewerSubmission {
  return {
    artifactType: "knowledge_semantic_grounding_reviewer_submission",
    artifactVersion: KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION,
    claims: decisions(packet, variant),
    corpusSha256: packet.corpusSha256,
    packetSha256: packet.packetSha256,
    poolSha256: packet.poolSha256,
    reviewer: {
      humanAttestation: "independent_human_semantic_review",
      id,
      implementationAgent: false,
      provenance: "external_human"
    }
  };
}

function completedReview() {
  // In-memory schema/adversarial fixture only. These neutral decisions are not
  // human review evidence and are never eligible benchmark labels.
  const reviewArtifacts = artifacts();
  const first = submission(reviewArtifacts.packet, "human-reviewer-schema-fixture-alpha", "first");
  const second = submission(reviewArtifacts.packet, "human-reviewer-schema-fixture-beta", "second");
  const adjudication: KnowledgeSemanticGroundingAdjudication = {
    adjudicator: {
      humanAttestation: "independent_human_semantic_review",
      id: "human-reviewer-schema-fixture-adjudicator",
      implementationAgent: false,
      provenance: "external_human"
    },
    annotatorSubmissionSha256s: [
      knowledgeSemanticGroundingReviewerSubmissionSha256(first),
      knowledgeSemanticGroundingReviewerSubmissionSha256(second)
    ],
    artifactType: "knowledge_semantic_grounding_adjudication",
    artifactVersion: KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION,
    claims: decisions(reviewArtifacts.packet, "adjudicated"),
    completed: true,
    corpusSha256: reviewArtifacts.packet.corpusSha256,
    disagreementResolutions: [{
      categories: ["support_label", "citation_binding"],
      reviewClaimId: reviewArtifacts.packet.claims[0]!.reviewClaimId
    }],
    packetSha256: reviewArtifacts.packet.packetSha256,
    poolSha256: reviewArtifacts.packet.poolSha256,
    unresolvedMaterialDisagreements: 0
  };
  return { adjudication, first, reviewArtifacts, second };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

describe("Knowledge semantic grounding independent review artifacts", () => {
  it("creates a randomized blind packet bound to exact claim-local evidence", () => {
    const { mapping, packet } = artifacts();
    const claimCount = createKnowledgeSemanticGroundingCandidatePool().entries.filter((entry) =>
      entry.split !== "calibration").length;

    expect(packet.claimCount).toBe(claimCount);
    expect(mapping.entries).toHaveLength(claimCount);
    expect(mapping).toMatchObject({
      annotationGuideVersion: "knowledge-hardening-annotation-guide-v1",
      corpusSha256: packet.corpusSha256,
      corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
      packetSha256: packet.packetSha256
    });
    expect(new Set(packet.claims.map((claim) => claim.reviewClaimId)).size).toBe(claimCount);
    expect(packet.claims[0]?.reviewClaimId).not.toBe(mapping.entries[0]?.reviewClaimId);
    const privatePacket = JSON.stringify(packet);
    const privateMapping = JSON.stringify(mapping);
    expect(privatePacket).not.toMatch(
      /"split"|fixtureId|documentFamily|expectedLabel|"labels"|candidate|modelId|validatorProfile/u
    );
    expect(privatePacket).not.toContain("held-en-neighborhood");
    expect(privatePacket).not.toContain("A separate archived policy prohibits guest access.");
    expect(privateMapping).not.toMatch(/Atlas exports|Береста|SAFE-2718|queryText|answerText|excerpt/u);

    const localMapping = mapping.entries.find((entry) =>
      entry.fixtureId === "held-en-neighborhood");
    const localPacket = packet.claims.find((claim) =>
      claim.reviewClaimId === localMapping?.reviewClaimId);
    expect(localPacket).toMatchObject({
      claim: { citationHandles: ["K1"], neighborhoodRule: "inline" },
      evidence: [{ citationHandle: "K1", excerpt: "The active policy permits guest access." }]
    });
    expect(localMapping).toMatchObject({
      claimSha256: localPacket?.claimSha256,
      neighborhoodSha256: localPacket?.neighborhoodSha256
    });
    const falseNoAnswerMapping = mapping.entries.find((entry) =>
      entry.fixtureId === "held-en-no-answer-wrong");
    const falseNoAnswerPacket = packet.claims.find((claim) =>
      claim.reviewClaimId === falseNoAnswerMapping?.reviewClaimId);
    expect(falseNoAnswerPacket).toMatchObject({
      claim: { citationHandles: [], type: "source_summary" },
      evidence: [{ excerpt: "The support window is seventy-two hours." }]
    });
    const trueNoAnswerMapping = mapping.entries.find((entry) =>
      entry.fixtureId === "held-en-no-answer-correct");
    expect(packet.claims.find((claim) =>
      claim.reviewClaimId === trueNoAnswerMapping?.reviewClaimId)?.evidence).toEqual([]);
  });

  it("separates calibration reveal from final review and commits exact freeze bindings", () => {
    const calibration = artifacts("calibration");
    const final = artifacts("final");

    expect(calibration.packet).toMatchObject({ claimCount: 92, reviewScope: "calibration" });
    expect(calibration.mapping.entries.every((entry) => entry.split === "calibration")).toBe(true);
    expect(calibration.mapping.evaluationBindings).toEqual({
      calibrationFreezeManifestSha256: null,
      candidateFreezeManifestSha256: "a".repeat(64),
      finalPredictionFreezeManifestSha256: null
    });
    expect(final.packet).toMatchObject({ claimCount: 589, reviewScope: "final" });
    expect(final.mapping.entries.every((entry) => entry.split !== "calibration")).toBe(true);
    expect(calibration.packet.evaluationCommitmentSha256)
      .not.toBe(final.packet.evaluationCommitmentSha256);
    expect(JSON.stringify(calibration.packet)).not.toContain("candidateFreezeManifestSha256");
  });

  it("rejects retroactive mapping substitution across frozen evaluation identities", () => {
    const completed = completedReview();
    const rebound = artifacts("final", {
      calibrationFreezeManifestSha256: "8".repeat(64),
      candidateFreezeManifestSha256: "9".repeat(64),
      finalPredictionFreezeManifestSha256: "7".repeat(64)
    });

    expect(rebound.packet.packetSha256).not.toBe(completed.reviewArtifacts.packet.packetSha256);
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication: completed.adjudication,
      mapping: rebound.mapping,
      packet: completed.reviewArtifacts.packet,
      submissions: [completed.first, completed.second]
    })).toThrow("knowledge_semantic_review_binding_invalid");
  });

  it("strictly imports two distinct external-human rounds and complete adjudication", () => {
    const { adjudication, first, reviewArtifacts, second } = completedReview();
    const claimCount = reviewArtifacts.packet.claimCount;

    const imported = importKnowledgeSemanticGroundingReviewEvidence({
      adjudication,
      mapping: reviewArtifacts.mapping,
      packet: reviewArtifacts.packet,
      submissions: [first, second]
    });

    expect(imported).toMatchObject({
      adjudicationComplete: true,
      corpusSha256: reviewArtifacts.packet.corpusSha256,
      disagreement: {
        attributionDisagreementCount: 1,
        adjudicationRate: expect.closeTo(1 / claimCount, 10),
        categoryCounts: {
          citation_binding: 1,
          claim_segmentation: 0,
          materiality: 0,
          support_label: 1,
          temporal_context: 0
        },
        decisionDisagreementCount: 1,
        exactAgreementCount: claimCount - 1,
        labelDistribution: {
          adjudicated: expect.any(Object),
          reviewerA: expect.any(Object),
          reviewerB: expect.any(Object)
        },
        reviewedClaimCount: claimCount
      },
      independentAnnotatorCount: 2,
      labelProvenance: "two_external_humans_adjudicated",
      provenanceVerification: "self_attested_unverified",
      reviewScope: "final",
      unresolvedMaterialDisagreements: 0
    });
    expect(imported.labels).toHaveLength(claimCount);
    expect(imported.disagreement.decisionConfusionMatrix.uncertain.supported).toBe(1);
    expect(JSON.stringify(imported)).not.toMatch(
      /Atlas exports|Береста|SAFE-2718|Guest export|\[K1\]|queryText|answerText|excerpt/u
    );
  });

  it("rejects self-review, duplicate reviewers, incomplete labels, and tampered bindings", () => {
    const { adjudication, first, reviewArtifacts, second } = completedReview();

    expect(() => createKnowledgeSemanticGroundingReviewArtifacts({
      corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
      evaluationBindings: {
        calibrationFreezeManifestSha256: "b".repeat(64),
        candidateFreezeManifestSha256: "a".repeat(64),
        finalPredictionFreezeManifestSha256: "c".repeat(64)
      },
      fixtures: knowledgeSemanticGroundingFixtures,
      randomId: () => "00000000-0000-4000-8000-000000000001",
      reviewScope: "final"
    })).toThrow("knowledge_semantic_review_opaque_id_duplicate");
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication,
      mapping: reviewArtifacts.mapping,
      packet: reviewArtifacts.packet,
      submissions: [first, first]
    })).toThrow("knowledge_semantic_review_annotators_not_distinct");
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication,
      mapping: reviewArtifacts.mapping,
      packet: reviewArtifacts.packet,
      submissions: [first, {
        ...second,
        reviewer: { ...second.reviewer, implementationAgent: true }
      }]
    })).toThrow();
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication,
      mapping: reviewArtifacts.mapping,
      packet: reviewArtifacts.packet,
      submissions: [first, { ...second, claims: second.claims.slice(1) }]
    })).toThrow("knowledge_semantic_review_incomplete");
    const citedClaimIndex = reviewArtifacts.packet.claims.findIndex((claim) =>
      claim.claim.citationHandles.length > 0);
    expect(citedClaimIndex).toBeGreaterThanOrEqual(0);
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication,
      mapping: reviewArtifacts.mapping,
      packet: reviewArtifacts.packet,
      submissions: [{
        ...first,
        claims: first.claims.map((claim, index) => index === citedClaimIndex
          ? { ...claim, decision: "supported" as const }
          : claim)
      }, second]
    })).toThrow("knowledge_semantic_review_support_unattributed");
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication: { ...adjudication, disagreementResolutions: [] },
      mapping: reviewArtifacts.mapping,
      packet: reviewArtifacts.packet,
      submissions: [first, second]
    })).toThrow("knowledge_semantic_review_disagreement_resolution_incomplete");
    expect(() => importKnowledgeSemanticGroundingReviewEvidence({
      adjudication,
      mapping: reviewArtifacts.mapping,
      packet: {
        ...reviewArtifacts.packet,
        claims: reviewArtifacts.packet.claims.map((claim, index) => index === 0
          ? { ...claim, queryText: `${claim.queryText} tampered` }
          : claim)
      },
      submissions: [first, second]
    })).toThrow("knowledge_semantic_review_artifact_digest_invalid");
  });

  it("writes and reads only owner-only files in an allowlisted /tmp directory", async () => {
    const directory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-review-");
    const directoryLink = `${directory}-link`;
    await chmod(directory, 0o700);
    const { adjudication, first, second } = completedReview();
    try {
      const reviewArtifacts = await writeKnowledgeSemanticGroundingReviewArtifacts({
        corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
        evaluationBindings: {
          calibrationFreezeManifestSha256: "b".repeat(64),
          candidateFreezeManifestSha256: "a".repeat(64),
          finalPredictionFreezeManifestSha256: "c".repeat(64)
        },
        fixtures: knowledgeSemanticGroundingFixtures,
        randomId: deterministicIds(),
        randomIndex: () => 0,
        reviewScope: "final",
        reviewDirectory: directory
      });
      await Promise.all([
        [KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_A_FILE, first],
        [KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_B_FILE, second],
        [KNOWLEDGE_SEMANTIC_GROUNDING_ADJUDICATION_FILE, adjudication]
      ].map(([fileName, value]) => writePrivateJson(resolve(directory, fileName as string), value)));
      await expect(readKnowledgeSemanticGroundingReviewEvidenceDirectory(directory))
        .resolves.toMatchObject({
          corpusSha256: reviewArtifacts.packet.corpusSha256,
          independentAnnotatorCount: 2
        });
      const forbiddenAnchorPath = resolve(directory, "human-trust-anchors.json");
      await writePrivateJson(forbiddenAnchorPath, { schemaFixture: "anchors" });
      await expect(readKnowledgeSemanticGroundingReviewEvidenceDirectory(directory))
        .rejects.toThrow("knowledge_semantic_review_directory_unsafe");
      await unlink(forbiddenAnchorPath);
      await writePrivateJson(
        resolve(directory, KNOWLEDGE_SEMANTIC_GROUNDING_TRUST_EVIDENCE_FILE),
        { schemaFixture: "evidence" }
      );
      await expect(readKnowledgeSemanticGroundingReviewEvidenceDirectory(directory))
        .resolves.toMatchObject({
          humanTrustEvidence: { schemaFixture: "evidence" }
        });
      await Promise.all([
        KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE,
        KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE,
        KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_A_FILE,
        KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_B_FILE,
        KNOWLEDGE_SEMANTIC_GROUNDING_ADJUDICATION_FILE,
        KNOWLEDGE_SEMANTIC_GROUNDING_TRUST_EVIDENCE_FILE
      ].map(async (fileName) => {
        expect((await stat(resolve(directory, fileName))).mode & 0o777).toBe(0o600);
      }));
      expect(await readFile(
        resolve(directory, KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE),
        "utf8"
      )).toContain("The Lark registry uses the Amber tier");

      await writePrivateJson(resolve(directory, "unexpected.json"), {});
      await expect(readKnowledgeSemanticGroundingReviewEvidenceDirectory(directory))
        .rejects.toThrow("knowledge_semantic_review_directory_unsafe");
      await chmod(directory, 0o755);
      await expect(validateKnowledgeSemanticGroundingReviewDirectory(directory, false))
        .rejects.toThrow("knowledge_semantic_review_directory_unsafe");
      await chmod(directory, 0o700);
      await symlink(directory, directoryLink, "dir");
      await expect(validateKnowledgeSemanticGroundingReviewDirectory(directoryLink, false))
        .rejects.toThrow("knowledge_semantic_review_directory_unsafe");
    } finally {
      await unlink(directoryLink).catch(() => undefined);
      await chmod(directory, 0o700);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
