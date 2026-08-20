import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  knowledgeSemanticGroundingCliErrorCode,
  KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE,
  parseKnowledgeSemanticGroundingCliArgs,
  runKnowledgeSemanticGroundingCli
} from "./semanticGroundingCli";
import {
  createKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticGroundingCandidatePool,
  createKnowledgeSemanticGroundingCandidates
} from "./semanticGroundingCandidates";
import { knowledgeSemanticGroundingFixtures } from "./semanticGroundingFixtures";
import type {
  KnowledgeSemanticGroundingImportedReviewEvidence
} from "./semanticGroundingReview";
import { KNOWLEDGE_H0_ANNOTATION_GUIDE } from "./h0AnnotationGuide";
import {
  KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
  createKnowledgeSemanticEd25519KeyId,
  createKnowledgeSemanticHumanTrustAnchorSet,
  createKnowledgeSemanticHumanTrustAttestation,
  createKnowledgeSemanticHumanTrustEvidence,
  encodeKnowledgeSemanticEd25519PublicKey,
  knowledgeSemanticHumanTrustAttestationSha256,
  type KnowledgeSemanticHumanTrustAnchor,
  type KnowledgeSemanticHumanTrustAttestationPayload,
  type KnowledgeSemanticHumanTrustExpectedArtifacts
} from "./semanticGroundingTrust";

type TrustActor = Readonly<{
  anchor: KnowledgeSemanticHumanTrustAnchor;
  privateKey: KeyObject;
}>;

function fixtureDigest(value: string): string {
  return createHash("sha256").update(`cli-test:${value}`, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function trustActor(
  role: KnowledgeSemanticHumanTrustAnchor["role"],
  ordinal: string
): TrustActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeKnowledgeSemanticEd25519PublicKey(publicKey);
  const common = {
    implementationParticipant: false as const,
    keyId: createKnowledgeSemanticEd25519KeyId(publicKeySpkiBase64url),
    notAfter: "2027-01-01T00:00:00.000Z",
    notBefore: "2025-01-01T00:00:00.000Z",
    principalSha256: fixtureDigest(`principal-${ordinal}`),
    publicKeySpkiBase64url
  };
  return {
    anchor: role === "release_operator"
      ? { ...common, eligibility: "operator_controlled_release_authority", role }
      : { ...common, eligibility: "operator_vouched_external_human", role },
    privateKey
  };
}

function createCliTrustChain(expected: KnowledgeSemanticHumanTrustExpectedArtifacts) {
  const actors = {
    adjudicator: trustActor("adjudicator", "adjudicator"),
    operator: trustActor("release_operator", "operator"),
    reviewerA: trustActor("independent_reviewer", "reviewer-a"),
    reviewerB: trustActor("independent_reviewer", "reviewer-b")
  };
  const anchorSet = createKnowledgeSemanticHumanTrustAnchorSet({
    anchors: Object.values(actors).map((actor) => actor.anchor),
    configuredAt: "2026-01-01T00:00:00.000Z"
  });
  const common = (actor: TrustActor, signedAt: string) => ({
    artifactType: "knowledge_semantic_human_trust_attestation_payload" as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
    keyId: actor.anchor.keyId,
    principalSha256: actor.anchor.principalSha256,
    signedAt,
    trustAnchorSetSha256: anchorSet.anchorSetSha256
  });
  const reviewScope = {
    corpusSha256: expected.corpusSha256,
    packetSha256: expected.packetSha256,
    poolSha256: expected.poolSha256
  };
  const reviewer = (
    actor: TrustActor,
    reviewerSlot: "reviewer_a" | "reviewer_b",
    signedAt: string,
    submissionSha256: string
  ) => createKnowledgeSemanticHumanTrustAttestation({
    payload: {
      ...common(actor, signedAt),
      declaration: {
        implementationAgent: false,
        modelGeneratedLabels: false,
        provenance: "external_human",
        reviewedIndependently: true
      },
      reviewScope,
      reviewerSlot,
      role: "independent_reviewer",
      statement: "independent_reviewer_submission",
      submissionSha256
    },
    privateKey: actor.privateKey
  });
  const reviewerA = reviewer(
    actors.reviewerA,
    "reviewer_a",
    "2026-02-01T00:00:00.000Z",
    expected.reviewerSubmissionSha256s[0]
  );
  const reviewerB = reviewer(
    actors.reviewerB,
    "reviewer_b",
    "2026-02-01T00:01:00.000Z",
    expected.reviewerSubmissionSha256s[1]
  );
  const reviewerAttestationSha256s: [string, string] = [
    knowledgeSemanticHumanTrustAttestationSha256(reviewerA),
    knowledgeSemanticHumanTrustAttestationSha256(reviewerB)
  ];
  const adjudicatorPayload: KnowledgeSemanticHumanTrustAttestationPayload = {
    ...common(actors.adjudicator, "2026-02-02T00:00:00.000Z"),
    adjudicationSha256: expected.adjudicationSha256,
    declaration: {
      adjudicationCompleted: true,
      implementationAgent: false,
      provenance: "external_human",
      unresolvedMaterialDisagreements: 0
    },
    reviewScope,
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: [...expected.reviewerSubmissionSha256s],
    role: "adjudicator",
    statement: "completed_adjudication"
  };
  const adjudicator = createKnowledgeSemanticHumanTrustAttestation({
    payload: adjudicatorPayload,
    privateKey: actors.adjudicator.privateKey
  });
  const operatorPayload: KnowledgeSemanticHumanTrustAttestationPayload = {
    ...common(actors.operator, "2026-02-03T00:00:00.000Z"),
    adjudicationAttestationSha256:
      knowledgeSemanticHumanTrustAttestationSha256(adjudicator),
    adjudicationSha256: expected.adjudicationSha256,
    authorization: "operator_reviewed_human_provenance_chain",
    releaseScope: {
      ...reviewScope,
      calibrationFreezeManifestSha256: expected.calibrationFreezeManifestSha256,
      candidateFreezeManifestSha256: expected.candidateFreezeManifestSha256,
      predictionArtifactSha256: expected.predictionArtifactSha256,
      reviewMappingSha256: expected.reviewMappingSha256
    },
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: [...expected.reviewerSubmissionSha256s],
    role: "release_operator",
    statement: "release_provenance_approval"
  };
  const operator = createKnowledgeSemanticHumanTrustAttestation({
    payload: operatorPayload,
    privateKey: actors.operator.privateKey
  });
  return {
    anchorSet,
    evidence: createKnowledgeSemanticHumanTrustEvidence({
      adjudicatorAttestation: adjudicator,
      operatorAttestation: operator,
      reviewerAttestations: [reviewerA, reviewerB]
    })
  };
}

function testOnlyImportedEvidence(
  reviewScope: "calibration" | "final" = "final",
  evaluationBindings: KnowledgeSemanticGroundingImportedReviewEvidence["evaluationBindings"] =
    reviewScope === "calibration"
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
): KnowledgeSemanticGroundingImportedReviewEvidence {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const fixtures = new Map(knowledgeSemanticGroundingFixtures.map((fixture) =>
    [fixture.id, fixture] as const));
  const labels = pool.entries.filter((entry) => reviewScope === "calibration"
    ? entry.split === "calibration"
    : entry.split !== "calibration").map((entry) => {
    const label = fixtures.get(entry.fixtureId)!.labels.find((candidate) =>
      candidate.claimOrdinal === entry.ordinal)!;
    return Object.freeze({
      attributableHandles: label.attributableHandles,
      claimOrdinal: entry.ordinal,
      claimSha256: entry.claimSha256,
      decision: label.decision,
      fixtureId: entry.fixtureId,
      language: entry.language,
      neighborhoodSha256: entry.neighborhoodSha256,
      split: entry.split
    });
  });
  const emptyDecisions = Object.freeze({
    contradicted: 0,
    supported: 0,
    uncertain: 0,
    unsupported: 0
  });
  return Object.freeze({
    adjudicationComplete: true as const,
    adjudicationSha256: "3".repeat(64),
    annotationGuideVersion: KNOWLEDGE_H0_ANNOTATION_GUIDE.version,
    corpusSha256: pool.corpusSha256,
    evaluationBindings: Object.freeze({ ...evaluationBindings }),
    disagreement: Object.freeze({
      attributionDisagreementCount: 0,
      adjudicationRate: 0,
      categoryCounts: Object.freeze({
        citation_binding: 0,
        claim_segmentation: 0,
        materiality: 0,
        support_label: 0,
        temporal_context: 0
      }),
      decisionConfusionMatrix: Object.freeze({
        contradicted: emptyDecisions,
        supported: emptyDecisions,
        uncertain: emptyDecisions,
        unsupported: emptyDecisions
      }),
      decisionDisagreementCount: 0,
      exactAgreementCount: labels.length,
      labelDistribution: Object.freeze({
        adjudicated: emptyDecisions,
        reviewerA: emptyDecisions,
        reviewerB: emptyDecisions
      }),
      rawExactAgreement: 1,
      reviewedClaimCount: labels.length
    }),
    independentAnnotatorCount: 2 as const,
    labelProvenance: "two_external_humans_adjudicated" as const,
    labels: Object.freeze(labels),
    mappingSha256: "1".repeat(64),
    packetSha256: "2".repeat(64),
    poolSha256: pool.poolSha256,
    provenanceVerification: "self_attested_unverified" as const,
    reviewerSubmissionSha256s: Object.freeze([
      "4".repeat(64),
      "5".repeat(64)
    ] as const),
    reviewScope,
    unresolvedMaterialDisagreements: 0 as const
  });
}

function finalTrustArgs(anchorPath: string, pin = "a".repeat(64)): string[] {
  return [
    "--freeze-manifest",
    "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/freeze-manifest.json",
    "--calibration-freeze",
    "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/calibration-freeze.json",
    "--final-prediction-freeze",
    "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/final-prediction-freeze.json",
    "--review-directory",
    "/tmp/aiqsa-knowledge-semantic-review-abcdef",
    "--trust-anchor-set",
    anchorPath,
    "--trust-anchor-set-sha256",
    pin
  ];
}

async function writeTestOnlyFreezeChain(directory: string): Promise<Readonly<{
  calibrationPath: string;
  candidatePath: string;
  finalPredictionPath: string;
}>> {
  const candidatePath = `${directory}/freeze-manifest.json`;
  const calibrationPath = `${directory}/calibration-freeze.json`;
  const finalPredictionPath = `${directory}/final-prediction-freeze.json`;
  await runKnowledgeSemanticGroundingCli(["--write-freeze-manifest", candidatePath]);
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
    manifestSha256: string;
  };
  const labels = testOnlyImportedEvidence("calibration", {
    calibrationFreezeManifestSha256: null,
    candidateFreezeManifestSha256: candidate.manifestSha256,
    finalPredictionFreezeManifestSha256: null
  });
  await runKnowledgeSemanticGroundingCli([
    "--freeze-manifest",
    candidatePath,
    "--review-directory",
    "/tmp/aiqsa-knowledge-semantic-review-test-chain",
    "--write-calibration-freeze",
    calibrationPath
  ], { readReviewEvidenceDirectory: vi.fn().mockResolvedValue(labels) });
  await runKnowledgeSemanticGroundingCli([
    "--freeze-manifest",
    candidatePath,
    "--calibration-freeze",
    calibrationPath,
    "--write-final-prediction-freeze",
    finalPredictionPath
  ]);
  return Object.freeze({ calibrationPath, candidatePath, finalPredictionPath });
}

describe("Knowledge semantic benchmark CLI", () => {
  it("keeps every external or human lane explicit and off by default", () => {
    expect(parseKnowledgeSemanticGroundingCliArgs([])).toEqual({
      calibrationFreezePath: null,
      executePaidSystemModel: false,
      finalPredictionFreezePath: null,
      freezeManifestPath: null,
      help: false,
      localRunnerConfigPath: null,
      prepareReviewDirectory: null,
      prepareReviewScope: null,
      reviewDirectory: null,
      trustAnchorSetPath: null,
      trustAnchorSetSha256: null,
      writeCalibrationFreezePath: null,
      writeFinalPredictionFreezePath: null,
      writeFreezeManifestPath: null
    });
    expect(KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE).toContain(
      "--execute-paid-system-model"
    );
    expect(KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE).toContain(
      "--trust-anchor-set-sha256"
    );
    expect(KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE).toContain(
      "Preparing/importing artifacts never authors, simulates, or accepts human judgments."
    );
  });

  it("parses absolute opt-in paths and rejects conflicts or unknown flags", () => {
    expect(parseKnowledgeSemanticGroundingCliArgs([
      "--local-runner-config",
      "/tmp/semantic-local-config.json",
      "--freeze-manifest",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/freeze-manifest.json",
      "--calibration-freeze",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/calibration-freeze.json",
      "--final-prediction-freeze",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/final-prediction-freeze.json",
      "--review-directory",
      "/tmp/aiqsa-knowledge-semantic-review-abcdef"
    ])).toMatchObject({
      localRunnerConfigPath: "/tmp/semantic-local-config.json",
      reviewDirectory: "/tmp/aiqsa-knowledge-semantic-review-abcdef"
    });
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--freeze-manifest",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/freeze-manifest.json",
      "--calibration-freeze",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/calibration-freeze.json",
      "--review-directory",
      "/tmp/aiqsa-knowledge-semantic-review-abcdef"
    ])).toThrow("knowledge_semantic_final_prediction_freeze_required");
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--prepare-review-directory",
      "/tmp/aiqsa-knowledge-semantic-review-abcdef",
      "--review-scope",
      "final",
      "--execute-paid-system-model"
    ])).toThrow("knowledge_semantic_cli_argument_conflict");
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--review-directory",
      "/tmp/aiqsa-knowledge-semantic-review-abcdef"
    ])).toThrow("knowledge_semantic_cli_freeze_manifest_required");
    expect(parseKnowledgeSemanticGroundingCliArgs([
      "--freeze-manifest",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/freeze-manifest.json",
      "--write-calibration-freeze",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/calibration-freeze.json",
      "--review-directory",
      "/tmp/aiqsa-knowledge-semantic-review-abcdef"
    ])).toMatchObject({
      freezeManifestPath:
        "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/freeze-manifest.json",
      reviewDirectory: "/tmp/aiqsa-knowledge-semantic-review-abcdef",
      writeCalibrationFreezePath:
        "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/calibration-freeze.json"
    });
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--local-runner-config",
      "relative.json"
    ])).toThrow("knowledge_semantic_cli_path_invalid");
    expect(() => parseKnowledgeSemanticGroundingCliArgs(["--unknown"]))
      .toThrow("knowledge_semantic_cli_argument_invalid");
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--trust-anchor-set",
      "/tmp/aiqsa-knowledge-semantic-trust-abcdef/trust-anchors.json"
    ])).toThrow("knowledge_semantic_cli_trust_anchor_pair_required");
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--trust-anchor-set-sha256",
      "a".repeat(64)
    ])).toThrow("knowledge_semantic_cli_trust_anchor_pair_required");
    expect(() => parseKnowledgeSemanticGroundingCliArgs(finalTrustArgs(
      "/tmp/aiqsa-knowledge-semantic-trust-abcdef/trust-anchors.json",
      "A".repeat(64)
    ))).toThrow("knowledge_semantic_cli_trust_anchor_pin_invalid");
    expect(() => parseKnowledgeSemanticGroundingCliArgs([
      "--freeze-manifest",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/freeze-manifest.json",
      "--calibration-freeze",
      "/tmp/aiqsa-knowledge-semantic-freeze-abcdef/calibration-freeze.json",
      "--review-directory",
      "/tmp/aiqsa-knowledge-semantic-review-abcdef",
      "--trust-anchor-set",
      "/tmp/aiqsa-knowledge-semantic-trust-abcdef/trust-anchors.json",
      "--trust-anchor-set-sha256",
      "a".repeat(64)
    ])).toThrow("knowledge_semantic_cli_trust_anchor_purpose_invalid");
  });

  it("runs the default aggregate report without optional execution", async () => {
    const resolveSystemModelExecutor = vi.fn();
    const report = await runKnowledgeSemanticGroundingCli([], { resolveSystemModelExecutor });
    if (!report || !("candidates" in report)) throw new Error("expected_candidate_report");

    expect(report.contractValid).toBe(true);
    expect(report.selection.selectionEligible).toBe(false);
    expect(report.candidates.map((candidate) => candidate.executionStatus)).toEqual([
      "complete",
      "unavailable",
      "unavailable",
      "unavailable"
    ]);
    expect(resolveSystemModelExecutor).not.toHaveBeenCalled();
  });

  it("writes and reuses an owner-only content-free freeze artifact", async () => {
    const directory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-freeze-");
    await chmod(directory, 0o700);
    const manifestPath = `${directory}/freeze-manifest.json`;
    try {
      const prepared = await runKnowledgeSemanticGroundingCli([
        "--write-freeze-manifest",
        manifestPath
      ]);
      if (!prepared || !("artifactCreated" in prepared)) {
        throw new Error("expected_freeze_preparation_report");
      }
      expect(prepared).toMatchObject({
        aggregateOnly: true,
        artifactCreated: "freeze-manifest.json",
        candidateCount: 4,
        externalExecutionPerformed: false,
        labelsUsed: false,
        selectionEligible: false,
        semanticProof: false
      });
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
      const serialized = await readFile(manifestPath, "utf8");
      expect(serialized).not.toMatch(
        /Atlas|Береста|SAFE-2718|127\.0\.0\.1|"(?:answer|claim|evidence|labels|query|text)"/u
      );

      const evaluated = await runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        manifestPath
      ]);
      if (!evaluated || !("candidates" in evaluated)) {
        throw new Error("expected_candidate_report");
      }
      expect(evaluated.candidateSet).toMatchObject({
        frozen: true,
        thresholdContractFrozen: false
      });
      expect(evaluated.selection.selectionEligible).toBe(false);
      expect(evaluated.semanticProof).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("materializes calibration-only outputs before final non-calibration scoring", async () => {
    const directory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-freeze-");
    const trustDirectory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-trust-");
    await chmod(directory, 0o700);
    await chmod(trustDirectory, 0o700);
    const candidatePath = `${directory}/freeze-manifest.json`;
    const calibrationPath = `${directory}/calibration-freeze.json`;
    const finalPredictionPath = `${directory}/final-prediction-freeze.json`;
    const trustAnchorPath = `${trustDirectory}/trust-anchors.json`;
    let labels = testOnlyImportedEvidence("calibration");
    const readReviewEvidenceDirectory = vi.fn().mockImplementation(async () => labels);
    try {
      await runKnowledgeSemanticGroundingCli([
        "--write-freeze-manifest",
        candidatePath
      ]);
      const candidateManifest = JSON.parse(await readFile(candidatePath, "utf8")) as {
        manifestSha256: string;
      };
      labels = testOnlyImportedEvidence("calibration", {
        calibrationFreezeManifestSha256: null,
        candidateFreezeManifestSha256: candidateManifest.manifestSha256,
        finalPredictionFreezeManifestSha256: null
      });
      const calibration = await runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        candidatePath,
        "--review-directory",
        "/tmp/aiqsa-knowledge-semantic-review-testcal",
        "--write-calibration-freeze",
        calibrationPath
      ], { readReviewEvidenceDirectory });
      if (!calibration || !("externalExecutionScope" in calibration)) {
        throw new Error("expected_calibration_freeze_report");
      }
      expect(calibration).toMatchObject({
        artifactCreated: "calibration-freeze.json",
        candidateCount: 4,
        externalExecutionScope: "calibration_split_only",
        labelsStored: false,
        selectionEligible: false,
        semanticProof: false
      });
      expect((await stat(calibrationPath)).mode & 0o777).toBe(0o600);
      const serialized = await readFile(calibrationPath, "utf8");
      expect(serialized).not.toMatch(/Atlas|Береста|SAFE-2718|"(?:answer|evidence|labels|query|text)"/u);
      expect(JSON.parse(serialized)).toMatchObject({
        labelsStored: false,
        candidates: expect.arrayContaining([expect.objectContaining({
          candidateId: "current_structural_fence_v4",
          executionStatus: "complete",
          outputs: expect.arrayContaining([expect.objectContaining({
            claimSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
          })])
        })])
      });

      const finalFreeze = await runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        candidatePath,
        "--calibration-freeze",
        calibrationPath,
        "--write-final-prediction-freeze",
        finalPredictionPath
      ]);
      if (!finalFreeze || !("externalExecutionScope" in finalFreeze)) {
        throw new Error("expected_final_prediction_freeze_report");
      }
      expect(finalFreeze).toMatchObject({
        artifactCreated: "final-prediction-freeze.json",
        externalExecutionScope: "development_held_out_blinded_without_labels",
        labelsStored: false,
        selectionEligible: false,
        semanticProof: false
      });
      expect((await stat(finalPredictionPath)).mode & 0o777).toBe(0o600);
      const finalSerialized = await readFile(finalPredictionPath, "utf8");
      expect(finalSerialized).not.toMatch(/Atlas|Береста|SAFE-2718|"(?:answer|evidence|labels|query|text)"/u);
      const calibrationManifest = JSON.parse(await readFile(calibrationPath, "utf8")) as {
        manifestSha256: string;
      };
      const predictionManifest = JSON.parse(finalSerialized) as { manifestSha256: string };
      labels = testOnlyImportedEvidence("final", {
        calibrationFreezeManifestSha256: calibrationManifest.manifestSha256,
        candidateFreezeManifestSha256: candidateManifest.manifestSha256,
        finalPredictionFreezeManifestSha256: predictionManifest.manifestSha256
      });
      const trust = createCliTrustChain({
        adjudicationSha256: labels.adjudicationSha256,
        calibrationFreezeManifestSha256: calibrationManifest.manifestSha256,
        candidateFreezeManifestSha256: candidateManifest.manifestSha256,
        corpusSha256: labels.corpusSha256,
        packetSha256: labels.packetSha256,
        poolSha256: labels.poolSha256,
        predictionArtifactSha256: predictionManifest.manifestSha256,
        reviewMappingSha256: labels.mappingSha256,
        reviewerSubmissionSha256s: [...labels.reviewerSubmissionSha256s]
      });
      labels = Object.freeze({ ...labels, humanTrustEvidence: trust.evidence });
      await writeFile(trustAnchorPath, `${JSON.stringify(trust.anchorSet)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await chmod(trustAnchorPath, 0o600);

      const finalReport = await runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        candidatePath,
        "--review-directory",
        "/tmp/aiqsa-knowledge-semantic-review-testcal",
        "--calibration-freeze",
        calibrationPath,
        "--final-prediction-freeze",
        finalPredictionPath,
        "--trust-anchor-set",
        trustAnchorPath,
        "--trust-anchor-set-sha256",
        trust.anchorSet.anchorSetSha256
      ], {
        readReviewEvidenceDirectory,
        verificationTime: () => "2026-08-20T00:00:00.000Z"
      });
      if (!finalReport || !("candidates" in finalReport)) {
        throw new Error("expected_final_candidate_report");
      }
      expect(finalReport.candidateSet).toMatchObject({
        frozen: true,
        thresholdContractFrozen: true
      });
      expect(finalReport.candidates[0]).toMatchObject({
        executionStatus: "complete",
        performance: { measuredClaims: 589 },
        quality: {
          calibration: { thresholdFrozenBeforeHeldOut: true },
          selection: { split: "held_out" }
        }
      });
      expect(finalReport.selection.selectionEligible).toBe(false);
      expect(finalReport.semanticProof).toBe(false);
      expect(finalReport.humanReview).toMatchObject({
        provenanceVerification: "operator_anchored_ed25519_verified",
        reasonCodes: [],
        trust: { verified: true }
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(trustDirectory, { force: true, recursive: true });
    }
  });

  it("rejects fake or digest-tampered candidate freezes before preparing review", async () => {
    const freezeDirectory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-freeze-");
    const reviewDirectory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-review-");
    await chmod(freezeDirectory, 0o700);
    await chmod(reviewDirectory, 0o700);
    const candidatePath = `${freezeDirectory}/freeze-manifest.json`;
    const prepareArgs = [
      "--freeze-manifest",
      candidatePath,
      "--prepare-review-directory",
      reviewDirectory,
      "--review-scope",
      "calibration"
    ];
    try {
      await writeFile(candidatePath, JSON.stringify({ manifestSha256: "a".repeat(64) }), {
        encoding: "utf8",
        mode: 0o600
      });
      await expect(runKnowledgeSemanticGroundingCli(prepareArgs))
        .rejects.toThrow("knowledge_semantic_freeze_manifest_invalid");

      const pool = createKnowledgeSemanticGroundingCandidatePool();
      const valid = createKnowledgeSemanticCandidateFreezeManifest({
        candidates: createKnowledgeSemanticGroundingCandidates(),
        pool
      });
      await writeFile(candidatePath, `${JSON.stringify({
        ...valid,
        manifestSha256: "f".repeat(64)
      })}\n`, "utf8");
      await expect(runKnowledgeSemanticGroundingCli(prepareArgs))
        .rejects.toThrow("knowledge_semantic_freeze_manifest_digest_mismatch");
    } finally {
      await rm(freezeDirectory, { force: true, recursive: true });
      await rm(reviewDirectory, { force: true, recursive: true });
    }
  });

  it("validates the complete artifact triple before reading final review evidence", async () => {
    const freezeDirectory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-freeze-");
    const reviewDirectory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-review-");
    const invalidReviewDirectory = await mkdtemp(
      "/tmp/aiqsa-knowledge-semantic-review-"
    );
    await chmod(freezeDirectory, 0o700);
    await chmod(reviewDirectory, 0o700);
    await chmod(invalidReviewDirectory, 0o700);
    const chain = await writeTestOnlyFreezeChain(freezeDirectory);
    const reviewReader = vi.fn();
    const resolveSystemModelExecutor = vi.fn();
    try {
      const prepared = await runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        chain.candidatePath,
        "--calibration-freeze",
        chain.calibrationPath,
        "--final-prediction-freeze",
        chain.finalPredictionPath,
        "--prepare-review-directory",
        reviewDirectory,
        "--review-scope",
        "final"
      ], { resolveSystemModelExecutor });
      expect(prepared).toMatchObject({
        humanReviewPending: true,
        reviewScope: "final",
        selectionEligible: false
      });
      expect(resolveSystemModelExecutor).not.toHaveBeenCalled();

      const finalArtifact = JSON.parse(
        await readFile(chain.finalPredictionPath, "utf8")
      ) as Readonly<Record<string, unknown>> & Readonly<{ manifestSha256: string }>;
      const { manifestSha256: _manifestSha256, ...finalBody } = finalArtifact;
      const mismatchedBody = {
        ...finalBody,
        calibrationFreezeManifestSha256: "e".repeat(64)
      };
      await writeFile(chain.finalPredictionPath, `${JSON.stringify({
        ...mismatchedBody,
        manifestSha256: canonicalSha256(mismatchedBody)
      })}\n`, "utf8");

      await expect(runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        chain.candidatePath,
        "--calibration-freeze",
        chain.calibrationPath,
        "--final-prediction-freeze",
        chain.finalPredictionPath,
        "--review-directory",
        "/tmp/aiqsa-knowledge-semantic-review-final-chain"
      ], { readReviewEvidenceDirectory: reviewReader }))
        .rejects.toThrow("knowledge_semantic_final_prediction_freeze_binding_mismatch");
      expect(reviewReader).not.toHaveBeenCalled();

      await expect(runKnowledgeSemanticGroundingCli([
        "--freeze-manifest",
        chain.candidatePath,
        "--calibration-freeze",
        chain.calibrationPath,
        "--final-prediction-freeze",
        chain.finalPredictionPath,
        "--prepare-review-directory",
        invalidReviewDirectory,
        "--review-scope",
        "final"
      ])).rejects.toThrow("knowledge_semantic_final_prediction_freeze_binding_mismatch");
    } finally {
      await rm(freezeDirectory, { force: true, recursive: true });
      await rm(reviewDirectory, { force: true, recursive: true });
      await rm(invalidReviewDirectory, { force: true, recursive: true });
    }
  });

  it("rejects non-allowlisted or non-private freeze paths", async () => {
    await expect(runKnowledgeSemanticGroundingCli([
      "--write-freeze-manifest",
      "/tmp/freeze-manifest.json"
    ])).rejects.toThrow("knowledge_semantic_freeze_path_invalid");

    const directory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-freeze-");
    const manifestPath = `${directory}/freeze-manifest.json`;
    await chmod(directory, 0o755);
    try {
      await expect(runKnowledgeSemanticGroundingCli([
        "--write-freeze-manifest",
        manifestPath
      ])).rejects.toThrow("knowledge_semantic_freeze_directory_unsafe");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("requires a purpose-bound owner-only non-symlink trust-anchor file", async () => {
    await expect(runKnowledgeSemanticGroundingCli(finalTrustArgs(
      "/tmp/trust-anchors.json"
    ))).rejects.toThrow("knowledge_semantic_trust_anchor_path_invalid");

    const directory = await mkdtemp("/tmp/aiqsa-knowledge-semantic-trust-");
    const anchorPath = `${directory}/trust-anchors.json`;
    const targetPath = `${directory}/anchor-target.json`;
    await chmod(directory, 0o700);
    try {
      await writeFile(anchorPath, "", { encoding: "utf8", mode: 0o600 });
      await expect(runKnowledgeSemanticGroundingCli(finalTrustArgs(anchorPath)))
        .rejects.toThrow("knowledge_semantic_trust_anchor_unsafe");

      await writeFile(anchorPath, "{}\n", { encoding: "utf8" });
      await chmod(anchorPath, 0o644);
      await expect(runKnowledgeSemanticGroundingCli(finalTrustArgs(anchorPath)))
        .rejects.toThrow("knowledge_semantic_trust_anchor_unsafe");

      await chmod(anchorPath, 0o600);
      await chmod(directory, 0o755);
      await expect(runKnowledgeSemanticGroundingCli(finalTrustArgs(anchorPath)))
        .rejects.toThrow("knowledge_semantic_trust_anchor_unsafe");
      await chmod(directory, 0o700);

      await unlink(anchorPath);
      await writeFile(targetPath, "{}\n", { encoding: "utf8", mode: 0o600 });
      await symlink(targetPath, anchorPath);
      await expect(runKnowledgeSemanticGroundingCli(finalTrustArgs(anchorPath)))
        .rejects.toThrow("knowledge_semantic_trust_anchor_unsafe");
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prints help without running the benchmark and sanitizes unexpected errors", async () => {
    await expect(runKnowledgeSemanticGroundingCli(["--help"])).resolves.toBeNull();
    expect(knowledgeSemanticGroundingCliErrorCode(
      new Error("knowledge_semantic_cli_argument_invalid")
    )).toBe("knowledge_semantic_cli_argument_invalid");
    expect(knowledgeSemanticGroundingCliErrorCode(
      new Error("raw provider body must not be printed")
    )).toBe("knowledge_semantic_benchmark_failed");
  });
});
