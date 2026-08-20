import {
  createHash,
  generateKeyPairSync,
  type KeyObject
} from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeSemanticGroundingDecision } from
  "../../lib/server/knowledge/semanticGrounding";
import {
  runKnowledgeSemanticCalibrationFreeze,
  runKnowledgeSemanticCandidateBenchmark,
  runKnowledgeSemanticFinalPredictionFreeze
} from "./semanticGroundingBenchmark";
import {
  createKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticGroundingCandidatePool,
  createKnowledgeSemanticGroundingCandidates,
  type KnowledgeSemanticCandidateExecutor,
  type KnowledgeSemanticCandidateInput
} from "./semanticGroundingCandidates";
import { KNOWLEDGE_H0_ANNOTATION_GUIDE } from "./h0AnnotationGuide";
import type {
  KnowledgeSemanticGroundingImportedReviewEvidence
} from "./semanticGroundingReview";
import {
  assertKnowledgeSemanticSelectionFreeze,
  createKnowledgeSemanticSelectionFreeze,
  type KnowledgeSemanticSelectionFreezeInput
} from "./semanticGroundingSelection";
import { knowledgeSemanticGroundingFixtures } from "./semanticGroundingFixtures";
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

const CONFIGURED_AT = "2026-01-01T00:00:00.000Z";
const REVIEWED_AT = "2026-02-01T00:00:00.000Z";
const ADJUDICATED_AT = "2026-02-02T00:00:00.000Z";
const APPROVED_AT = "2026-02-03T00:00:00.000Z";
const EVALUATED_AT = "2026-02-04T00:00:00.000Z";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(`selection-test:${value}`, "utf8").digest("hex");
}

function decisionScores(decision: KnowledgeSemanticGroundingDecision) {
  return Object.freeze({
    contradicted: Number(decision === "contradicted"),
    supported: Number(decision === "supported"),
    uncertain: Number(decision === "uncertain"),
    unsupported: Number(decision === "unsupported")
  });
}

function inputKey(input: KnowledgeSemanticCandidateInput): string {
  return JSON.stringify(input);
}

function wrongDecision(
  decision: KnowledgeSemanticGroundingDecision
): KnowledgeSemanticGroundingDecision {
  return decision === "supported" ? "unsupported" : "supported";
}

function profileAuthorizedOracle(options: Readonly<{
  onValidate?: () => void;
  returnWrongDecisions?: boolean;
}> = {}): KnowledgeSemanticCandidateExecutor {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const fixtures = new Map(knowledgeSemanticGroundingFixtures.map((fixture) =>
    [fixture.id, fixture] as const));
  const labels = new Map(pool.entries.map((entry) => [
    inputKey(entry.input),
    fixtures.get(entry.fixtureId)!.labels.find((label) =>
      label.claimOrdinal === entry.ordinal)!
  ] as const));
  return Object.freeze({
    identity: Object.freeze({
      authorization: "profile_authorized" as const,
      backend: "selection-test-oracle",
      egress: "none" as const,
      executionClass: "real_model" as const,
      hardware: "cpu" as const,
      modelId: "private-selection-test-model",
      profile: "private-selection-test-profile",
      provider: "private-selection-test-provider",
      resources: Object.freeze({
        cpuLogicalCores: 1,
        gpuDevice: null,
        scope: "isolated_runner" as const
      }),
      revision: "selection-test-revision",
      version: 1
    }),
    async validate(input) {
      options.onValidate?.();
      const label = labels.get(inputKey(input));
      if (!label) throw new Error("selection_test_label_missing");
      const selectedDecision = options.returnWrongDecisions
        ? wrongDecision(label.decision)
        : label.decision;
      return Object.freeze({
        attributableHandles: label.attributableHandles,
        costMicros: 0,
        decisionScores: decisionScores(selectedDecision),
        inputTokens: 1,
        reasonFamily: selectedDecision === "contradicted"
          ? "same_context_conflict" as const
          : selectedDecision === "unsupported"
            ? "not_supported" as const
            : selectedDecision === "uncertain"
              ? "insufficient_context" as const
              : "entailed" as const,
        resourceUsage: Object.freeze({
          peakGpuMemoryBytes: null,
          peakRssBytes: 1
        }),
        usage: Object.freeze({
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
          providerRequestCount: 1,
          reasoningTokens: 0,
          status: "measured" as const,
          totalTokens: 2
        })
      });
    }
  });
}

function emptyConfusionMatrix() {
  return {
    contradicted: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 },
    supported: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 },
    uncertain: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 },
    unsupported: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 }
  } as const;
}

function importedReview(input: Readonly<{
  calibrationFreezeManifestSha256: string | null;
  candidateFreezeManifestSha256: string;
  finalPredictionFreezeManifestSha256: string | null;
  reviewScope: "calibration" | "final";
}>): KnowledgeSemanticGroundingImportedReviewEvidence {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const fixtures = new Map(knowledgeSemanticGroundingFixtures.map((fixture) =>
    [fixture.id, fixture] as const));
  const entries = pool.entries.filter((entry) => input.reviewScope === "calibration"
    ? entry.split === "calibration"
    : entry.split !== "calibration");
  const labels = entries.map((entry) => {
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
  const submissionA = digest(`${input.reviewScope}:reviewer-a`);
  const submissionB = digest(`${input.reviewScope}:reviewer-b`);
  return Object.freeze({
    adjudicationComplete: true,
    adjudicationSha256: digest(`${input.reviewScope}:adjudication`),
    annotationGuideVersion: KNOWLEDGE_H0_ANNOTATION_GUIDE.version,
    corpusSha256: pool.corpusSha256,
    evaluationBindings: Object.freeze({
      calibrationFreezeManifestSha256: input.calibrationFreezeManifestSha256,
      candidateFreezeManifestSha256: input.candidateFreezeManifestSha256,
      finalPredictionFreezeManifestSha256: input.finalPredictionFreezeManifestSha256
    }),
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
      decisionConfusionMatrix: emptyConfusionMatrix(),
      decisionDisagreementCount: 0,
      exactAgreementCount: labels.length,
      labelDistribution: Object.freeze({
        adjudicated: Object.freeze({
          contradicted: labels.filter((label) => label.decision === "contradicted").length,
          supported: labels.filter((label) => label.decision === "supported").length,
          uncertain: labels.filter((label) => label.decision === "uncertain").length,
          unsupported: labels.filter((label) => label.decision === "unsupported").length
        }),
        reviewerA: Object.freeze({
          contradicted: 0, supported: 0, uncertain: 0, unsupported: 0
        }),
        reviewerB: Object.freeze({
          contradicted: 0, supported: 0, uncertain: 0, unsupported: 0
        })
      }),
      rawExactAgreement: 1,
      reviewedClaimCount: labels.length
    }),
    independentAnnotatorCount: 2,
    labelProvenance: "two_external_humans_adjudicated",
    provenanceVerification: "self_attested_unverified",
    labels: Object.freeze(labels),
    mappingSha256: digest(`${input.reviewScope}:mapping`),
    packetSha256: digest(`${input.reviewScope}:packet`),
    poolSha256: pool.poolSha256,
    reviewerSubmissionSha256s: Object.freeze([submissionA, submissionB] as const),
    reviewScope: input.reviewScope,
    unresolvedMaterialDisagreements: 0
  });
}

type TestActor = Readonly<{
  anchor: KnowledgeSemanticHumanTrustAnchor;
  privateKey: KeyObject;
}>;

function actor(role: KnowledgeSemanticHumanTrustAnchor["role"], ordinal: string): TestActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeKnowledgeSemanticEd25519PublicKey(publicKey);
  const common = {
    implementationParticipant: false as const,
    keyId: createKnowledgeSemanticEd25519KeyId(publicKeySpkiBase64url),
    notAfter: "2027-01-01T00:00:00.000Z",
    notBefore: "2025-01-01T00:00:00.000Z",
    principalSha256: digest(`principal:${ordinal}`),
    publicKeySpkiBase64url
  };
  return {
    anchor: role === "release_operator"
      ? { ...common, eligibility: "operator_controlled_release_authority", role }
      : { ...common, eligibility: "operator_vouched_external_human", role },
    privateKey
  };
}

function commonPayload(input: Readonly<{
  actor: TestActor;
  anchorSetSha256: string;
  signedAt: string;
}>) {
  return {
    artifactType: "knowledge_semantic_human_trust_attestation_payload" as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
    keyId: input.actor.anchor.keyId,
    principalSha256: input.actor.anchor.principalSha256,
    signedAt: input.signedAt,
    trustAnchorSetSha256: input.anchorSetSha256
  };
}

function trustedHumanEvidence(expected: KnowledgeSemanticHumanTrustExpectedArtifacts) {
  const actors = {
    adjudicator: actor("adjudicator", "adjudicator"),
    operator: actor("release_operator", "operator"),
    reviewerA: actor("independent_reviewer", "reviewer-a"),
    reviewerB: actor("independent_reviewer", "reviewer-b")
  };
  const anchorSet = createKnowledgeSemanticHumanTrustAnchorSet({
    anchors: Object.values(actors).map((entry) => entry.anchor),
    configuredAt: CONFIGURED_AT
  });
  const reviewScope = {
    corpusSha256: expected.corpusSha256,
    packetSha256: expected.packetSha256,
    poolSha256: expected.poolSha256
  };
  const reviewer = (
    signer: TestActor,
    slot: "reviewer_a" | "reviewer_b",
    submissionSha256: string,
    signedAt: string
  ) => createKnowledgeSemanticHumanTrustAttestation({
    payload: {
      ...commonPayload({ actor: signer, anchorSetSha256: anchorSet.anchorSetSha256, signedAt }),
      declaration: {
        implementationAgent: false,
        modelGeneratedLabels: false,
        provenance: "external_human",
        reviewedIndependently: true
      },
      reviewScope,
      reviewerSlot: slot,
      role: "independent_reviewer",
      statement: "independent_reviewer_submission",
      submissionSha256
    },
    privateKey: signer.privateKey
  });
  const reviewerA = reviewer(
    actors.reviewerA,
    "reviewer_a",
    expected.reviewerSubmissionSha256s[0],
    REVIEWED_AT
  );
  const reviewerB = reviewer(
    actors.reviewerB,
    "reviewer_b",
    expected.reviewerSubmissionSha256s[1],
    "2026-02-01T00:01:00.000Z"
  );
  const reviewerAttestationSha256s: [string, string] = [
    knowledgeSemanticHumanTrustAttestationSha256(reviewerA),
    knowledgeSemanticHumanTrustAttestationSha256(reviewerB)
  ];
  const adjudicatorPayload: KnowledgeSemanticHumanTrustAttestationPayload = {
    ...commonPayload({
      actor: actors.adjudicator,
      anchorSetSha256: anchorSet.anchorSetSha256,
      signedAt: ADJUDICATED_AT
    }),
    adjudicationSha256: expected.adjudicationSha256,
    declaration: {
      adjudicationCompleted: true,
      implementationAgent: false,
      provenance: "external_human",
      unresolvedMaterialDisagreements: 0
    },
    reviewScope,
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: expected.reviewerSubmissionSha256s,
    role: "adjudicator",
    statement: "completed_adjudication"
  };
  const adjudicatorAttestation = createKnowledgeSemanticHumanTrustAttestation({
    payload: adjudicatorPayload,
    privateKey: actors.adjudicator.privateKey
  });
  const operatorPayload: KnowledgeSemanticHumanTrustAttestationPayload = {
    ...commonPayload({
      actor: actors.operator,
      anchorSetSha256: anchorSet.anchorSetSha256,
      signedAt: APPROVED_AT
    }),
    adjudicationAttestationSha256:
      knowledgeSemanticHumanTrustAttestationSha256(adjudicatorAttestation),
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
    reviewerSubmissionSha256s: expected.reviewerSubmissionSha256s,
    role: "release_operator",
    statement: "release_provenance_approval"
  };
  const operatorAttestation = createKnowledgeSemanticHumanTrustAttestation({
    payload: operatorPayload,
    privateKey: actors.operator.privateKey
  });
  const evidence = createKnowledgeSemanticHumanTrustEvidence({
    adjudicatorAttestation,
    operatorAttestation,
    reviewerAttestations: [reviewerA, reviewerB]
  });
  return { actors, anchorSet, evidence };
}

async function releaseInput(options: Readonly<{
  local?: KnowledgeSemanticCandidateExecutor;
  requireEligible?: boolean;
}> = {}) {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const local = options.local ?? profileAuthorizedOracle();
  const candidates = createKnowledgeSemanticGroundingCandidates({ local });
  const candidateFreeze = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
  const calibrationReview = importedReview({
    calibrationFreezeManifestSha256: null,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    finalPredictionFreezeManifestSha256: null,
    reviewScope: "calibration"
  });
  const calibrationFreeze = await runKnowledgeSemanticCalibrationFreeze({
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    frozenCandidateSetDigest: candidateFreeze.candidateSet.digest,
    frozenThresholdScheduleSha256: candidateFreeze.candidateSet.thresholdScheduleSha256,
    labels: calibrationReview,
    local
  });
  const finalPredictionFreeze = await runKnowledgeSemanticFinalPredictionFreeze({
    calibrationFreeze,
    candidateFreezeManifest: candidateFreeze,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    local
  });
  const unsignedReview = importedReview({
    calibrationFreezeManifestSha256: calibrationFreeze.manifestSha256,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    finalPredictionFreezeManifestSha256: finalPredictionFreeze.manifestSha256,
    reviewScope: "final"
  });
  const expected: KnowledgeSemanticHumanTrustExpectedArtifacts = {
    adjudicationSha256: unsignedReview.adjudicationSha256,
    calibrationFreezeManifestSha256: calibrationFreeze.manifestSha256,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    corpusSha256: pool.corpusSha256,
    packetSha256: unsignedReview.packetSha256,
    poolSha256: pool.poolSha256,
    predictionArtifactSha256: finalPredictionFreeze.manifestSha256,
    reviewMappingSha256: unsignedReview.mappingSha256,
    reviewerSubmissionSha256s: [...unsignedReview.reviewerSubmissionSha256s]
  };
  const trusted = trustedHumanEvidence(expected);
  const review = Object.freeze({
    ...unsignedReview,
    humanTrustEvidence: trusted.evidence
  });
  const humanTrust = Object.freeze({
    anchorSet: trusted.anchorSet,
    evaluatedAt: EVALUATED_AT,
    evidence: trusted.evidence,
    pinnedAnchorSetSha256: trusted.anchorSet.anchorSetSha256
  });
  const benchmarkReport = await runKnowledgeSemanticCandidateBenchmark({
    calibrationFreeze,
    candidateFreezeManifest: candidateFreeze,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    finalPredictionFreeze,
    frozenCandidateSetDigest: candidateFreeze.candidateSet.digest,
    frozenThresholdScheduleSha256: candidateFreeze.candidateSet.thresholdScheduleSha256,
    humanTrust,
    labels: review,
    local
  });
  if (options.requireEligible !== false &&
    (!benchmarkReport.semanticProof || !benchmarkReport.selection.selectionEligible)) {
    throw new Error(`selection_test_benchmark_red:${
      benchmarkReport.selection.reasonCodes.join(",")}`);
  }
  return {
    benchmarkReport,
    calibrationFreeze,
    candidateFreeze,
    finalPredictionFreeze,
    humanTrust,
    pool,
    review
  } satisfies KnowledgeSemanticSelectionFreezeInput;
}

type ReleaseInput = Awaited<ReturnType<typeof releaseInput>>;
let input: ReleaseInput;

describe("Knowledge semantic selection freeze", () => {
  beforeAll(async () => {
    input = await releaseInput();
  }, 30_000);

  it("freezes an exact trusted, profile-authorized semantic selection", () => {
    const manifest = createKnowledgeSemanticSelectionFreeze(input);

    expect(assertKnowledgeSemanticSelectionFreeze({ ...input, manifest })).toEqual(manifest);
    expect(manifest).toMatchObject({
      aggregateOnly: true,
      artifactScope: "semantic_candidate_selection_only",
      artifactType: "knowledge_semantic_selection_freeze",
      labelsIncluded: false,
      privateContentIncluded: false,
      releaseGatePassed: false,
      selectedCandidate: {
        authorization: "profile_authorized",
        executionClass: "real_model",
        finalOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      selectionEligible: true,
      semanticProof: true
    });
    expect(manifest.selectedCandidate.candidateId).toBe(
      input.benchmarkReport.selection.selectedCandidateId
    );
  });

  it("rejects a rehashed forged-green report without executing after labels", async () => {
    let calls = 0;
    const bad = await releaseInput({
      local: profileAuthorizedOracle({
        onValidate: () => { calls += 1; },
        returnWrongDecisions: true
      }),
      requireEligible: false
    });
    expect(bad.benchmarkReport.semanticProof).toBe(false);
    const selectedCandidateId = input.benchmarkReport.selection.selectedCandidateId;
    if (!selectedCandidateId) throw new Error("selection_test_selected_candidate_missing");
    const goodCandidate = input.benchmarkReport.candidates.find((candidate) =>
      candidate.identity.id === selectedCandidateId);
    const badCandidate = bad.benchmarkReport.candidates.find((candidate) =>
      candidate.identity.id === selectedCandidateId);
    if (!goodCandidate || goodCandidate.executionStatus !== "complete" ||
      goodCandidate.quality.status !== "measured_from_imported_human_labels" ||
      !badCandidate || badCandidate.executionStatus !== "complete" ||
      badCandidate.quality.status !== "measured_from_imported_human_labels") {
      throw new Error("selection_test_candidate_quality_missing");
    }
    const forgedCandidates = bad.benchmarkReport.candidates.map((candidate) =>
      candidate.identity.id === selectedCandidateId
        ? Object.freeze({ ...badCandidate, quality: goodCandidate.quality })
        : candidate);
    const forgedReport = Object.freeze({
      ...bad.benchmarkReport,
      blindedExecution: Object.freeze({
        ...bad.benchmarkReport.blindedExecution,
        releaseEvidenceEligible: true
      }),
      candidates: Object.freeze(forgedCandidates),
      contractValid: true,
      selection: input.benchmarkReport.selection,
      semanticProof: true
    }) as typeof bad.benchmarkReport;
    expect(canonicalSha256(forgedReport)).toMatch(/^[a-f0-9]{64}$/u);

    const callsBeforeSelection = calls;
    expect(() => createKnowledgeSemanticSelectionFreeze({
      ...bad,
      benchmarkReport: forgedReport
    })).toThrow("knowledge_semantic_candidate_benchmark_selection_evidence_mismatch");
    expect(calls).toBe(callsBeforeSelection);
  }, 30_000);

  it("rejects digest tampering and a digest-valid cross-run prediction swap", () => {
    const manifest = createKnowledgeSemanticSelectionFreeze(input);
    expect(() => assertKnowledgeSemanticSelectionFreeze({
      ...input,
      manifest: {
        ...manifest,
        selectedCandidate: {
          ...manifest.selectedCandidate,
          finalOutputSha256: "f".repeat(64)
        }
      }
    })).toThrow("knowledge_semantic_selection_freeze_digest_mismatch");
    const { manifestSha256: _manifestSha256, ...manifestBody } = manifest;
    const reboundBody = {
      ...manifestBody,
      selectedCandidate: {
        ...manifest.selectedCandidate,
        finalOutputSha256: "e".repeat(64)
      }
    };
    expect(() => assertKnowledgeSemanticSelectionFreeze({
      ...input,
      manifest: {
        ...reboundBody,
        manifestSha256: canonicalSha256(reboundBody)
      }
    })).toThrow("knowledge_semantic_selection_freeze_binding_mismatch");

    const selectedId = manifest.selectedCandidate.candidateId;
    const candidates = input.finalPredictionFreeze.candidates.map((candidate) => {
      if (candidate.candidateId !== selectedId || candidate.executionStatus !== "complete") {
        return candidate;
      }
      const outputs = candidate.outputs.map((output, index) => index === 0
        ? Object.freeze({ ...output, latencyMicroseconds: output.latencyMicroseconds + 1 })
        : output);
      return Object.freeze({
        ...candidate,
        outputSha256: canonicalSha256(outputs),
        outputs: Object.freeze(outputs)
      });
    });
    const { manifestSha256: _oldSha256, ...oldBody } = input.finalPredictionFreeze;
    const swappedBody = { ...oldBody, candidates: Object.freeze(candidates) };
    const swappedFinalPredictionFreeze = Object.freeze({
      ...swappedBody,
      manifestSha256: canonicalSha256(swappedBody)
    });
    expect(() => assertKnowledgeSemanticSelectionFreeze({
      ...input,
      finalPredictionFreeze: swappedFinalPredictionFreeze,
      manifest
    })).toThrow("knowledge_semantic_selection_review_binding_invalid");
  });

  it("rejects review/trust cross-swaps and evaluation-only benchmark paths", () => {
    const manifest = createKnowledgeSemanticSelectionFreeze(input);
    expect(() => assertKnowledgeSemanticSelectionFreeze({
      ...input,
      manifest,
      review: Object.freeze({
        ...input.review,
        packetSha256: digest("cross-run-packet")
      })
    })).toThrow("knowledge_semantic_selection_human_trust_not_verified");

    const evaluationOnlyReport = Object.freeze({
      ...input.benchmarkReport,
      selection: Object.freeze({
        reasonCodes: Object.freeze(["selected_candidate_not_runtime_authorized"]),
        selectedCandidateId: input.benchmarkReport.selection.selectedCandidateId,
        selectionEligible: false
      }),
      semanticProof: false
    });
    expect(() => createKnowledgeSemanticSelectionFreeze({
      ...input,
      benchmarkReport: evaluationOnlyReport
    })).toThrow("knowledge_semantic_candidate_benchmark_selection_evidence_mismatch");
  });

  it("contains hashes and aggregate decisions, never labels, text, or trust identities", () => {
    const manifest = createKnowledgeSemanticSelectionFreeze(input);
    const serialized = JSON.stringify(manifest);
    const selected = input.finalPredictionFreeze.candidates.find((candidate) =>
      candidate.candidateId === manifest.selectedCandidate.candidateId);
    if (!selected || selected.candidateIdentity.availability !== "available") {
      throw new Error("selection_test_selected_identity_missing");
    }
    const trust = input.humanTrust.anchorSet;
    if (!record(trust) || !Array.isArray(trust.anchors)) {
      throw new Error("selection_test_trust_anchor_missing");
    }
    for (const forbidden of [
      knowledgeSemanticGroundingFixtures[0]!.evidence.originalIntent.query,
      knowledgeSemanticGroundingFixtures[0]!.answer,
      knowledgeSemanticGroundingFixtures[0]!.evidence.items[0]!.excerpt,
      selected.candidateIdentity.executor.modelId,
      selected.candidateIdentity.executor.profile,
      selected.candidateIdentity.executor.provider,
      ...trust.anchors.flatMap((anchor) => record(anchor)
        ? [anchor.keyId, anchor.principalSha256, anchor.publicKeySpkiBase64url]
        : []),
      ...input.review.labels.slice(0, 3).flatMap((label) => [
        label.fixtureId,
        label.claimSha256,
        label.neighborhoodSha256
      ])
    ]) {
      if (typeof forbidden === "string") expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/attributableHandles|decisionScores|signature/u);
  });
});
