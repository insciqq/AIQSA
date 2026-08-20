import * as providerAnswerPersistedRoute from "./providerAnswerPersistedRoute";
import type {
  ValidatedProviderAnswerPersistedRouteBinding,
  ValidatedProviderAnswerPersistedRoutePromotion
} from "./providerAnswerPersistedRoute";
import {
  importProviderAnswerReleaseReviewEvidence,
  providerAnswerReleaseAdjudicationSchema,
  providerAnswerReleaseReviewerSubmissionSchema
} from "./providerAnswerReleaseReview";
import {
  providerAnswerReleaseTrustEvidenceSchema,
  verifyProviderAnswerReleaseTrust,
  type ProviderAnswerReleaseTrustVerificationReason
} from "./providerAnswerReleaseTrust";

export const KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ORCHESTRATOR_VERSION =
  "knowledge-provider-answer-release-orchestrator-v1" as const;

export type ProviderAnswerReleaseOrchestratorReason =
  | "citation_viewer_gate_failed"
  | "input_incomplete"
  | "output_review_gate_failed"
  | "persisted_route_promotion_invalid"
  | "release_review_artifacts_invalid"
  | "review_trust_principal_binding_mismatch"
  | "trust_chain_invalid";

export type ProviderAnswerReleaseOrchestratorReport = Readonly<{
  aggregateOnly: true;
  artifactBindingsVerified: boolean;
  citationViewerGatePassed: boolean;
  fullProductionReleaseEligible: false;
  humanProvenanceGatePassed: boolean;
  outputReviewGatePassed: boolean;
  persistedRoutePromotionBindingVerified: boolean;
  privateContentIncluded: false;
  providerAnswerReleaseEvidenceEligible: boolean;
  reasonCodes: readonly ProviderAnswerReleaseOrchestratorReason[];
  reviewPrincipalBindingsVerified: boolean;
  reviewedOutputCount: number;
  signatureCounts: Readonly<{
    adjudicators: 0 | 1;
    operators: 0 | 1;
    reviewers: 0 | 2;
  }>;
  trustReasonCodes: readonly ProviderAnswerReleaseTrustVerificationReason[];
  trustedReviewEvidenceEligible: boolean;
  version: typeof KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ORCHESTRATOR_VERSION;
}>;

export type ProviderAnswerReleaseOrchestratorInput = Readonly<{
  adjudication?: unknown;
  anchorSet?: unknown;
  evaluatedAt?: unknown;
  outputArtifacts?: Readonly<{
    freeze: unknown;
    mapping: unknown;
    packet: unknown;
  }>;
  persistedRoutePromotion?: ValidatedProviderAnswerPersistedRoutePromotion;
  pinnedAnchorSetSha256?: unknown;
  reviewerSubmissions?: readonly [unknown, unknown];
  trustEvidence?: unknown;
}>;

type ReportOverrides = Partial<Omit<
  ProviderAnswerReleaseOrchestratorReport,
  | "aggregateOnly"
  | "fullProductionReleaseEligible"
  | "privateContentIncluded"
  | "version"
>>;

function report(overrides: ReportOverrides = {}): ProviderAnswerReleaseOrchestratorReport {
  return Object.freeze({
    aggregateOnly: true,
    artifactBindingsVerified: false,
    citationViewerGatePassed: false,
    fullProductionReleaseEligible: false,
    humanProvenanceGatePassed: false,
    outputReviewGatePassed: false,
    persistedRoutePromotionBindingVerified: false,
    privateContentIncluded: false,
    providerAnswerReleaseEvidenceEligible: false,
    reasonCodes: Object.freeze([]),
    reviewPrincipalBindingsVerified: false,
    reviewedOutputCount: 0,
    signatureCounts: Object.freeze({ adjudicators: 0, operators: 0, reviewers: 0 }),
    trustReasonCodes: Object.freeze([]),
    trustedReviewEvidenceEligible: false,
    version: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ORCHESTRATOR_VERSION,
    ...overrides
  });
}

function allInputsSupplied(
  input: ProviderAnswerReleaseOrchestratorInput
): input is Required<ProviderAnswerReleaseOrchestratorInput> {
  return input.adjudication !== undefined &&
    input.anchorSet !== undefined &&
    input.evaluatedAt !== undefined &&
    input.outputArtifacts !== undefined &&
    input.persistedRoutePromotion !== undefined &&
    input.pinnedAnchorSetSha256 !== undefined &&
    input.reviewerSubmissions !== undefined &&
    input.trustEvidence !== undefined;
}

/**
 * Verifies one fresh persisted-route promotion, the externally authored
 * reviewer/adjudication artifacts, and the separately pinned operator trust
 * chain in the same process. The promotion is accepted only through the
 * process-local brand minted by the stateful capture; a receipt or a
 * structurally identical disk-rehydrated object is never accepted here.
 *
 * This function does not create, infer, copy, or repair review decisions. Its
 * result deliberately omits answers, decisions, identities, keys, signatures,
 * timestamps, and artifact digests. Even a green provider-answer evidence
 * result is only one release input, so the full-production field stays false.
 */
export function verifyProviderAnswerReleaseOrchestration(
  input: ProviderAnswerReleaseOrchestratorInput = {}
): ProviderAnswerReleaseOrchestratorReport {
  if (!allInputsSupplied(input)) {
    return report({ reasonCodes: Object.freeze(["input_incomplete"]) });
  }

  let promotionBinding: ValidatedProviderAnswerPersistedRouteBinding;
  try {
    promotionBinding =
      providerAnswerPersistedRoute.validatedProviderAnswerPersistedRouteBinding(
        input.persistedRoutePromotion
      );
  } catch {
    return report({
      reasonCodes: Object.freeze(["persisted_route_promotion_invalid"])
    });
  }

  let reviewReport: ReturnType<typeof importProviderAnswerReleaseReviewEvidence>;
  let reviewerA: ReturnType<typeof providerAnswerReleaseReviewerSubmissionSchema.parse>;
  let reviewerB: ReturnType<typeof providerAnswerReleaseReviewerSubmissionSchema.parse>;
  let adjudication: ReturnType<typeof providerAnswerReleaseAdjudicationSchema.parse>;
  try {
    reviewReport = importProviderAnswerReleaseReviewEvidence({
      adjudication: input.adjudication,
      ...input.outputArtifacts,
      submissions: input.reviewerSubmissions
    });
    const submissions = input.reviewerSubmissions
      .map((submission) => providerAnswerReleaseReviewerSubmissionSchema.parse(submission))
      .sort((left, right) => left.reviewerSlot.localeCompare(right.reviewerSlot));
    if (submissions.length !== 2 ||
      submissions[0]?.reviewerSlot !== "reviewer_a" ||
      submissions[1]?.reviewerSlot !== "reviewer_b") {
      throw new Error("knowledge_provider_answer_release_orchestrator_review_slots_invalid");
    }
    reviewerA = submissions[0];
    reviewerB = submissions[1];
    adjudication = providerAnswerReleaseAdjudicationSchema.parse(input.adjudication);
  } catch {
    return report({
      persistedRoutePromotionBindingVerified: true,
      reasonCodes: Object.freeze(["release_review_artifacts_invalid"])
    });
  }

  const expectedArtifacts = {
    adjudicationSha256: reviewReport.artifactBindings.adjudicationSha256,
    mappingSha256: reviewReport.artifactBindings.mappingSha256,
    outputFreezeSha256: reviewReport.artifactBindings.outputFreezeSha256,
    packetSha256: reviewReport.artifactBindings.packetSha256,
    persistedRoutePromotionReceiptSha256: promotionBinding.receiptSha256,
    reviewerSubmissionSha256s: reviewReport.artifactBindings.reviewerSubmissionSha256s
  };
  const trustReport = verifyProviderAnswerReleaseTrust({
    anchorSet: input.anchorSet,
    evaluatedAt: input.evaluatedAt,
    evidence: input.trustEvidence,
    expectedArtifacts,
    persistedRoutePromotion: input.persistedRoutePromotion,
    pinnedAnchorSetSha256: input.pinnedAnchorSetSha256
  });
  const common = {
    artifactBindingsVerified: trustReport.artifactBindingsVerified,
    citationViewerGatePassed: reviewReport.gates.citationViewerGatePassed,
    outputReviewGatePassed: reviewReport.gates.outputReviewGatePassed,
    persistedRoutePromotionBindingVerified:
      trustReport.persistedRoutePromotionBindingVerified,
    reviewedOutputCount: reviewReport.review.reviewedOutputCount,
    signatureCounts: trustReport.signatureCounts,
    trustReasonCodes: trustReport.reasonCodes,
    trustedReviewEvidenceEligible: trustReport.trustedReviewEvidenceEligible
  } as const;
  if (!trustReport.verified) {
    return report({
      ...common,
      reasonCodes: Object.freeze(["trust_chain_invalid"])
    });
  }

  const parsedTrustEvidence = providerAnswerReleaseTrustEvidenceSchema.safeParse(
    input.trustEvidence
  );
  if (!parsedTrustEvidence.success) {
    return report({
      ...common,
      reasonCodes: Object.freeze(["trust_chain_invalid"])
    });
  }
  const [reviewerAAttestation, reviewerBAttestation] =
    parsedTrustEvidence.data.reviewerAttestations;
  const adjudicatorAttestation = parsedTrustEvidence.data.adjudicatorAttestation;
  const reviewPrincipalBindingsVerified =
    reviewerAAttestation.payload.role === "independent_reviewer" &&
    reviewerAAttestation.payload.reviewerSlot === "reviewer_a" &&
    reviewerAAttestation.payload.principalSha256 === reviewerA.reviewer.principalSha256 &&
    reviewerBAttestation.payload.role === "independent_reviewer" &&
    reviewerBAttestation.payload.reviewerSlot === "reviewer_b" &&
    reviewerBAttestation.payload.principalSha256 === reviewerB.reviewer.principalSha256 &&
    adjudicatorAttestation.payload.role === "adjudicator" &&
    adjudicatorAttestation.payload.principalSha256 ===
      adjudication.adjudicator.principalSha256;
  if (!reviewPrincipalBindingsVerified) {
    return report({
      ...common,
      reasonCodes: Object.freeze(["review_trust_principal_binding_mismatch"]),
      trustedReviewEvidenceEligible: false
    });
  }

  const reasonCodes: ProviderAnswerReleaseOrchestratorReason[] = [];
  if (!reviewReport.gates.citationViewerGatePassed) {
    reasonCodes.push("citation_viewer_gate_failed");
  }
  if (!reviewReport.gates.outputReviewGatePassed) {
    reasonCodes.push("output_review_gate_failed");
  }
  const providerAnswerReleaseEvidenceEligible =
    reviewReport.gates.citationViewerGatePassed &&
    reviewReport.gates.outputReviewGatePassed;
  return report({
    ...common,
    humanProvenanceGatePassed: true,
    providerAnswerReleaseEvidenceEligible,
    reasonCodes: Object.freeze(reasonCodes),
    reviewPrincipalBindingsVerified: true
  });
}
