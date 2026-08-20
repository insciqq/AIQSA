import { createHash } from "node:crypto";
import { z } from "zod";
import { knowledgeSemanticGroundingDecisions } from
  "../../lib/server/knowledge/semanticGrounding";
import {
  assertKnowledgeSemanticCandidateBenchmarkSelectionEvidence,
  assertKnowledgeSemanticFinalArtifactFreezeChain,
  type KnowledgeSemanticCandidateBenchmarkReport
} from "./semanticGroundingBenchmark";
import type {
  KnowledgeSemanticCandidateId,
  KnowledgeSemanticCandidatePool
} from "./semanticGroundingCandidates";
import type {
  KnowledgeSemanticGroundingImportedReviewEvidence
} from "./semanticGroundingReview";
import {
  KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
  knowledgeSemanticHumanTrustAnchorSetSchema,
  knowledgeSemanticHumanTrustAttestationSha256,
  knowledgeSemanticHumanTrustEvidenceSchema,
  verifyKnowledgeSemanticHumanTrust
} from "./semanticGroundingTrust";

export const KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION =
  "knowledge-semantic-selection-freeze-v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const candidateIdSchema = z.enum([
  "current_structural_fence_v4",
  "local_multilingual_nli_v1",
  "system_model_semantic_v1",
  "hybrid_semantic_v1"
]);
const evaluationArtifactsSchema = z.strictObject({
  calibrationFreezeManifestSha256: sha256Schema,
  candidateFreezeManifestSha256: sha256Schema,
  candidateSetDigest: sha256Schema,
  corpusSha256: sha256Schema,
  finalPredictionFreezeManifestSha256: sha256Schema,
  poolSha256: sha256Schema
});
const finalReviewSchema = z.strictObject({
  adjudicationSha256: sha256Schema,
  mappingSha256: sha256Schema,
  packetSha256: sha256Schema,
  reviewScope: z.literal("final"),
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema])
});
const humanTrustSchema = z.strictObject({
  adjudicatorAttestationSha256: sha256Schema,
  anchorSetSha256: sha256Schema,
  evidenceSha256: sha256Schema,
  operatorAttestationSha256: sha256Schema,
  provenanceVerification: z.literal("operator_anchored_ed25519_verified"),
  reviewerAttestationSha256s: z.tuple([sha256Schema, sha256Schema]),
  verificationContextSha256: sha256Schema,
  version: z.literal(KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION)
});
const selectedCandidateSchema = z.strictObject({
  authorization: z.literal("profile_authorized"),
  calibrationOutputSha256: sha256Schema,
  candidateId: candidateIdSchema,
  candidateIdentitySha256: sha256Schema,
  candidateImplementationSha256: sha256Schema,
  executionClass: z.literal("real_model"),
  finalOutputSha256: sha256Schema,
  qualityEvidenceSha256: sha256Schema
});
const selectionFreezeBodySchema = z.strictObject({
  aggregateOnly: z.literal(true),
  artifactScope: z.literal("semantic_candidate_selection_only"),
  artifactType: z.literal("knowledge_semantic_selection_freeze"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION),
  benchmarkReportSha256: sha256Schema,
  evaluationArtifacts: evaluationArtifactsSchema,
  finalReview: finalReviewSchema,
  humanTrust: humanTrustSchema,
  labelsIncluded: z.literal(false),
  privateContentIncluded: z.literal(false),
  releaseGatePassed: z.literal(false),
  selectedCandidate: selectedCandidateSchema,
  selectionEligible: z.literal(true),
  semanticProof: z.literal(true)
});
const selectionFreezeSchema = selectionFreezeBodySchema.extend({
  manifestSha256: sha256Schema
});

export type KnowledgeSemanticSelectionFreezeManifest = Readonly<
  z.infer<typeof selectionFreezeSchema>
>;

export type KnowledgeSemanticSelectionHumanTrustInput = Readonly<{
  anchorSet: unknown;
  evaluatedAt: unknown;
  evidence: unknown;
  pinnedAnchorSetSha256: unknown;
}>;

export type KnowledgeSemanticSelectionFreezeInput = Readonly<{
  benchmarkReport: KnowledgeSemanticCandidateBenchmarkReport;
  calibrationFreeze: unknown;
  candidateFreeze: unknown;
  finalPredictionFreeze: unknown;
  humanTrust: KnowledgeSemanticSelectionHumanTrustInput;
  pool: KnowledgeSemanticCandidatePool;
  review: KnowledgeSemanticGroundingImportedReviewEvidence;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("knowledge_semantic_selection_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("knowledge_semantic_selection_value_invalid");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertFinalReviewBinding(input: Readonly<{
  calibrationFreezeManifestSha256: string;
  candidateFreezeManifestSha256: string;
  finalPredictionFreezeManifestSha256: string;
  pool: KnowledgeSemanticCandidatePool;
  review: KnowledgeSemanticGroundingImportedReviewEvidence;
}>): void {
  const { pool, review } = input;
  if (review.reviewScope !== "final" || !review.adjudicationComplete ||
    review.independentAnnotatorCount !== 2 || review.unresolvedMaterialDisagreements !== 0 ||
    review.labelProvenance !== "two_external_humans_adjudicated" ||
    review.corpusSha256 !== pool.corpusSha256 || review.poolSha256 !== pool.poolSha256 ||
    review.evaluationBindings.candidateFreezeManifestSha256 !==
      input.candidateFreezeManifestSha256 ||
    review.evaluationBindings.calibrationFreezeManifestSha256 !==
      input.calibrationFreezeManifestSha256 ||
    review.evaluationBindings.finalPredictionFreezeManifestSha256 !==
      input.finalPredictionFreezeManifestSha256) {
    throw new Error("knowledge_semantic_selection_review_binding_invalid");
  }
  const artifactHashes = [
    review.adjudicationSha256,
    review.mappingSha256,
    review.packetSha256,
    ...review.reviewerSubmissionSha256s
  ];
  if (review.reviewerSubmissionSha256s.length !== 2 ||
    review.reviewerSubmissionSha256s[0] === review.reviewerSubmissionSha256s[1] ||
    artifactHashes.some((value) => !sha256Schema.safeParse(value).success)) {
    throw new Error("knowledge_semantic_selection_review_binding_invalid");
  }

  const finalEntries = pool.entries.filter((entry) => entry.split !== "calibration");
  const entryByKey = new Map<string, KnowledgeSemanticCandidatePool["entries"][number]>(
    finalEntries.map((entry) => [
      `${entry.fixtureId}:${entry.ordinal}`,
      entry
    ] as const)
  );
  const seen = new Set<string>();
  if (review.labels.length !== finalEntries.length || review.labels.some((label) => {
    const key = `${label.fixtureId}:${label.claimOrdinal}`;
    const entry = entryByKey.get(key);
    if (!entry || seen.has(key)) return true;
    seen.add(key);
    return label.claimSha256 !== entry.claimSha256 ||
      label.neighborhoodSha256 !== entry.neighborhoodSha256 ||
      label.language !== entry.language || label.split !== entry.split ||
      !knowledgeSemanticGroundingDecisions.includes(label.decision) ||
      label.attributableHandles.length !== new Set(label.attributableHandles).size ||
      label.attributableHandles.some((handle) =>
        !entry.input.citationHandles.includes(handle));
  }) || seen.size !== finalEntries.length) {
    throw new Error("knowledge_semantic_selection_review_coverage_invalid");
  }
}

function selectionFreezeBody(
  input: KnowledgeSemanticSelectionFreezeInput
): z.infer<typeof selectionFreezeBodySchema> {
  const chain = assertKnowledgeSemanticFinalArtifactFreezeChain({
    calibrationFreeze: input.calibrationFreeze,
    candidateFreeze: input.candidateFreeze,
    finalPredictionFreeze: input.finalPredictionFreeze,
    pool: input.pool
  });
  assertFinalReviewBinding({
    calibrationFreezeManifestSha256: chain.calibrationFreeze.manifestSha256,
    candidateFreezeManifestSha256: chain.candidateFreeze.manifestSha256,
    finalPredictionFreezeManifestSha256: chain.finalPredictionFreeze.manifestSha256,
    pool: input.pool,
    review: input.review
  });

  const anchorSet = knowledgeSemanticHumanTrustAnchorSetSchema.safeParse(
    input.humanTrust.anchorSet
  );
  const evidence = knowledgeSemanticHumanTrustEvidenceSchema.safeParse(
    input.humanTrust.evidence
  );
  const pinnedAnchorSetSha256 = sha256Schema.safeParse(
    input.humanTrust.pinnedAnchorSetSha256
  );
  if (!anchorSet.success || !evidence.success || !pinnedAnchorSetSha256.success ||
    input.review.humanTrustEvidence === undefined ||
    !sameCanonical(input.review.humanTrustEvidence, evidence.data)) {
    throw new Error("knowledge_semantic_selection_human_trust_artifact_invalid");
  }
  const expectedArtifacts = {
    adjudicationSha256: input.review.adjudicationSha256,
    calibrationFreezeManifestSha256: chain.calibrationFreeze.manifestSha256,
    candidateFreezeManifestSha256: chain.candidateFreeze.manifestSha256,
    corpusSha256: input.review.corpusSha256,
    packetSha256: input.review.packetSha256,
    poolSha256: input.review.poolSha256,
    predictionArtifactSha256: chain.finalPredictionFreeze.manifestSha256,
    reviewMappingSha256: input.review.mappingSha256,
    reviewerSubmissionSha256s: input.review.reviewerSubmissionSha256s
  };
  const trust = verifyKnowledgeSemanticHumanTrust({
    anchorSet: anchorSet.data,
    evaluatedAt: input.humanTrust.evaluatedAt,
    evidence: evidence.data,
    expectedArtifacts,
    pinnedAnchorSetSha256: pinnedAnchorSetSha256.data
  });
  if (!trust.verified || !trust.humanProvenanceGatePassed ||
    !trust.blockingEvidenceEligible || !trust.artifactBindingsVerified) {
    throw new Error("knowledge_semantic_selection_human_trust_not_verified");
  }

  const report = input.benchmarkReport;
  const derived = assertKnowledgeSemanticCandidateBenchmarkSelectionEvidence({
    calibrationFreeze: chain.calibrationFreeze,
    candidateFreeze: chain.candidateFreeze,
    finalPredictionFreeze: chain.finalPredictionFreeze,
    humanTrust: trust,
    labels: input.review,
    pool: input.pool,
    report
  });
  if (!derived.contractValid || !derived.semanticProof ||
    !derived.selection.selectionEligible || derived.selection.reasonCodes.length !== 0 ||
    derived.selection.selectedCandidateId === null ||
    !derived.blindedExecution.finalPredictionsFrozenBeforeBlindLabels ||
    !derived.blindedExecution.releaseEvidenceEligible || !derived.candidateSet.frozen ||
    !derived.candidateSet.thresholdContractFrozen ||
    derived.candidateSet.digest !== chain.candidateFreeze.candidateSet.digest ||
    derived.candidateSet.corpusSha256 !== input.pool.corpusSha256 ||
    derived.candidateSet.poolSha256 !== input.pool.poolSha256 ||
    derived.corpus.corpusSha256 !== input.pool.corpusSha256 ||
    derived.corpus.poolSha256 !== input.pool.poolSha256 ||
    !derived.corpus.arithmetic.passed ||
    !derived.corpus.releaseEvidence.releaseGateEligible) {
    throw new Error("knowledge_semantic_selection_benchmark_not_eligible");
  }
  if (derived.humanReview.labelsStatus !== "imported" ||
    !derived.humanReview.adjudicationComplete ||
    derived.humanReview.independentAnnotatorCount !== 2 ||
    derived.humanReview.unresolvedMaterialDisagreements !== 0 ||
    derived.humanReview.reasonCodes.length !== 0 ||
    derived.humanReview.provenanceVerification !==
      "operator_anchored_ed25519_verified" ||
    !sameCanonical(derived.humanReview.disagreement, input.review.disagreement) ||
    !sameCanonical(derived.humanReview.trust, trust)) {
    throw new Error("knowledge_semantic_selection_benchmark_trust_mismatch");
  }

  const selectedCandidateId = derived.selection.selectedCandidateId as
    KnowledgeSemanticCandidateId;
  const selectedFinal = chain.finalPredictionFreeze.candidates.find((candidate) =>
    candidate.candidateId === selectedCandidateId);
  const selectedCalibration = chain.calibrationFreeze.candidates.find((candidate) =>
    candidate.candidateId === selectedCandidateId);
  const selectedEvidence = derived.candidates.find((candidate) =>
    candidate.identity.id === selectedCandidateId);
  if (!selectedFinal || selectedFinal.executionStatus !== "complete" ||
    selectedFinal.candidateIdentity.availability !== "available" ||
    selectedFinal.candidateIdentity.executor.authorization !== "profile_authorized" ||
    selectedFinal.candidateIdentity.executor.executionClass !== "real_model" ||
    !selectedCalibration || selectedCalibration.executionStatus !== "complete" ||
    !selectedEvidence || selectedEvidence.executionStatus !== "complete" ||
    selectedEvidence.identity.authorization !== "profile_authorized" ||
    selectedEvidence.identity.executionClass !== "real_model" ||
    selectedEvidence.cost.status !== "measured" ||
    selectedEvidence.outage.fallbackReplay !== "verified" ||
    selectedEvidence.quality.status !== "measured_from_imported_human_labels" ||
    !selectedEvidence.quality.heldOutGatesPassed ||
    !selectedEvidence.quality.blindedReviewQualityGatesPassed ||
    !selectedEvidence.quality.blindedReviewAcceptancePassed ||
    !selectedEvidence.quality.gatesPassed ||
    selectedEvidence.quality.provenanceVerification !== "verified_external_humans") {
    throw new Error("knowledge_semantic_selection_candidate_not_eligible");
  }

  const evaluatedAt = z.string().safeParse(input.humanTrust.evaluatedAt);
  if (!evaluatedAt.success) {
    throw new Error("knowledge_semantic_selection_human_trust_artifact_invalid");
  }
  return selectionFreezeBodySchema.parse({
    aggregateOnly: true,
    artifactScope: "semantic_candidate_selection_only",
    artifactType: "knowledge_semantic_selection_freeze",
    artifactVersion: KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION,
    benchmarkReportSha256: canonicalSha256(report),
    evaluationArtifacts: {
      calibrationFreezeManifestSha256: chain.calibrationFreeze.manifestSha256,
      candidateFreezeManifestSha256: chain.candidateFreeze.manifestSha256,
      candidateSetDigest: chain.candidateFreeze.candidateSet.digest,
      corpusSha256: input.pool.corpusSha256,
      finalPredictionFreezeManifestSha256: chain.finalPredictionFreeze.manifestSha256,
      poolSha256: input.pool.poolSha256
    },
    finalReview: {
      adjudicationSha256: input.review.adjudicationSha256,
      mappingSha256: input.review.mappingSha256,
      packetSha256: input.review.packetSha256,
      reviewScope: "final",
      reviewerSubmissionSha256s: [...input.review.reviewerSubmissionSha256s]
    },
    humanTrust: {
      adjudicatorAttestationSha256: knowledgeSemanticHumanTrustAttestationSha256(
        evidence.data.adjudicatorAttestation
      ),
      anchorSetSha256: anchorSet.data.anchorSetSha256,
      evidenceSha256: evidence.data.evidenceSha256,
      operatorAttestationSha256: knowledgeSemanticHumanTrustAttestationSha256(
        evidence.data.operatorAttestation
      ),
      provenanceVerification: "operator_anchored_ed25519_verified",
      reviewerAttestationSha256s: evidence.data.reviewerAttestations.map(
        knowledgeSemanticHumanTrustAttestationSha256
      ),
      verificationContextSha256: canonicalSha256({
        evaluatedAt: evaluatedAt.data,
        pinnedAnchorSetSha256: pinnedAnchorSetSha256.data
      }),
      version: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION
    },
    labelsIncluded: false,
    privateContentIncluded: false,
    releaseGatePassed: false,
    selectedCandidate: {
      authorization: "profile_authorized",
      calibrationOutputSha256: selectedCalibration.calibrationOutputSha256,
      candidateId: selectedFinal.candidateId,
      candidateIdentitySha256: canonicalSha256(selectedFinal.candidateIdentity),
      candidateImplementationSha256: selectedFinal.candidateIdentity.implementation.digest,
      executionClass: "real_model",
      finalOutputSha256: selectedFinal.outputSha256,
      qualityEvidenceSha256: canonicalSha256(selectedEvidence.quality)
    },
    selectionEligible: true,
    semanticProof: true
  });
}

/** Creates a content-free commitment to an already validated semantic selection.
 * It cannot run candidates, read labels, or upgrade an evaluation-only identity. */
export function createKnowledgeSemanticSelectionFreeze(
  input: KnowledgeSemanticSelectionFreezeInput
): KnowledgeSemanticSelectionFreezeManifest {
  const body = selectionFreezeBody(input);
  return Object.freeze(selectionFreezeSchema.parse({
    ...body,
    manifestSha256: canonicalSha256(body)
  }));
}

/** Revalidates every source artifact and rejects a digest-valid cross-run swap. */
export function assertKnowledgeSemanticSelectionFreeze(
  input: KnowledgeSemanticSelectionFreezeInput & Readonly<{ manifest: unknown }>
): KnowledgeSemanticSelectionFreezeManifest {
  const parsed = selectionFreezeSchema.safeParse(input.manifest);
  if (!parsed.success) throw new Error("knowledge_semantic_selection_freeze_invalid");
  const { manifestSha256, ...body } = parsed.data;
  if (canonicalSha256(body) !== manifestSha256) {
    throw new Error("knowledge_semantic_selection_freeze_digest_mismatch");
  }
  const expected = createKnowledgeSemanticSelectionFreeze(input);
  if (!sameCanonical(parsed.data, expected)) {
    throw new Error("knowledge_semantic_selection_freeze_binding_mismatch");
  }
  return Object.freeze(parsed.data);
}
