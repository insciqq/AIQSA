import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { groundKnowledgeAnswer } from "../../lib/server/knowledge/grounding";
import {
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX,
  createPersistedProviderAnswerReviewArtifacts,
  providerAnswerEvalCases,
  providerAnswerEvalProfiles,
  runProviderAnswerEval,
  type ProviderAnswerOutputFreeze,
  type ProviderAnswerReviewMapping,
  type ProviderAnswerReviewPacket
} from "./providerAnswerEval";
import * as persistedRouteBoundary from "./providerAnswerPersistedRoute";
import type {
  ValidatedProviderAnswerPersistedRoutePromotion
} from "./providerAnswerPersistedRoute";
import {
  createProviderAnswerReleaseAdjudication,
  createProviderAnswerReleaseReviewerSubmission,
  providerAnswerReleaseReviewDimensions,
  type ProviderAnswerReleaseAdjudication,
  type ProviderAnswerReleaseOutputDecision,
  type ProviderAnswerReleaseReviewerSubmission
} from "./providerAnswerReleaseReview";
import {
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ORCHESTRATOR_VERSION,
  verifyProviderAnswerReleaseOrchestration
} from "./providerAnswerReleaseOrchestrator";
import {
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
  createProviderAnswerReleaseEd25519KeyId,
  createProviderAnswerReleaseTrustAnchorSet,
  createProviderAnswerReleaseTrustAttestation,
  createProviderAnswerReleaseTrustEvidence,
  encodeProviderAnswerReleaseEd25519PublicKey,
  providerAnswerReleaseTrustAttestationSha256,
  type ProviderAnswerReleaseTrustAnchor,
  type ProviderAnswerReleaseTrustAnchorSet,
  type ProviderAnswerReleaseTrustAttestationPayload,
  type ProviderAnswerReleaseTrustEvidence,
  type ProviderAnswerReleaseTrustExpectedArtifacts
} from "./providerAnswerReleaseTrust";

// Every decision and identity below is synthetic contract data. It is not
// independent review evidence and cannot be used as release proof.

type OutputArtifacts = Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}>;

type TestActor = Readonly<{
  anchor: ProviderAnswerReleaseTrustAnchor;
  privateKey: KeyObject;
}>;

type TestActors = Readonly<{
  adjudicator: TestActor;
  operator: TestActor;
  reviewerA: TestActor;
  reviewerB: TestActor;
}>;

type ReviewBundle = Readonly<{
  adjudication: ProviderAnswerReleaseAdjudication;
  submissions: readonly [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
}>;

const CONFIGURED_AT = "2026-01-01T00:00:00.000Z";
const REVIEWER_A_AT = "2026-02-01T00:00:00.000Z";
const REVIEWER_B_AT = "2026-02-01T00:01:00.000Z";
const ADJUDICATED_AT = "2026-02-02T00:00:00.000Z";
const APPROVED_AT = "2026-02-03T00:00:00.000Z";
const EVALUATED_AT = "2026-02-04T00:00:00.000Z";
const promotionBindings = new WeakMap<
  object,
  persistedRouteBoundary.ValidatedProviderAnswerPersistedRouteBinding
>();
const actualPromotionBinding =
  persistedRouteBoundary.validatedProviderAnswerPersistedRouteBinding;

let artifacts: OutputArtifacts;
let generationDirectory: string;

function digest(label: string): string {
  return createHash("sha256").update(`orchestrator-test:${label}`, "utf8").digest("hex");
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function generatePersistedArtifacts(): Promise<OutputArtifacts> {
  generationDirectory = await mkdtemp(join(
    "/tmp",
    KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX
  ));
  await chmod(generationDirectory, 0o700);
  let reviewOrdinal = 0;
  await runProviderAnswerEval({
    executePaid: true,
    prepareExecutor: () => async () => ({
      answer: "The selected sources do not provide enough evidence to answer.",
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
    }),
    randomId: () => `orchestrator-review-${++reviewOrdinal}`,
    randomIndex: () => 0,
    reviewDirectory: generationDirectory,
    selectedProvider: "anthropic"
  });
  const generated: OutputArtifacts = {
    freeze: await jsonFile(join(
      generationDirectory,
      KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE
    )),
    mapping: await jsonFile(join(
      generationDirectory,
      KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE
    )),
    packet: await jsonFile(join(
      generationDirectory,
      KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE
    ))
  };
  const profile = providerAnswerEvalProfiles().find((candidate) =>
    candidate.provider === "anthropic")!;
  return createPersistedProviderAnswerReviewArtifacts({
    completed: providerAnswerEvalCases().map((caseDefinition) => {
      const mapping = generated.mapping.entries.find((entry) =>
        entry.status === "complete" && entry.caseId === caseDefinition.id);
      if (!mapping || mapping.status !== "complete") {
        throw new Error("missing synthetic provider mapping");
      }
      const packet = generated.packet.items.find((item) =>
        item.reviewId === mapping.reviewId);
      if (!packet) throw new Error("missing synthetic provider packet item");
      return {
        answer: packet.answer,
        automatedGrounding: mapping.automatedGrounding,
        caseDefinition,
        citationViewerArtifacts: packet.citationViewerArtifacts.map((artifact) => ({
          provenance: "persisted_route" as const,
          releaseEvidenceEligible: true as const,
          viewer: artifact.viewer
        })),
        grounding: groundKnowledgeAnswer({
          answer: packet.answer,
          evidence: caseDefinition.evidence
        }),
        latencyMs: mapping.latencyMs,
        profile,
        reviewId: mapping.reviewId,
        usage: mapping.usage
      };
    }),
    randomIndex: () => 0
  });
}

function operatorActor(label: string): TestActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeProviderAnswerReleaseEd25519PublicKey(publicKey);
  return {
    anchor: {
      eligibility: "operator_controlled_release_authority",
      implementationParticipant: false,
      keyId: createProviderAnswerReleaseEd25519KeyId(publicKeySpkiBase64url),
      notAfter: "2027-01-01T00:00:00.000Z",
      notBefore: "2025-01-01T00:00:00.000Z",
      principalSha256: digest(`${label}-operator-principal`),
      publicKeySpkiBase64url,
      role: "release_operator"
    },
    privateKey
  };
}

function humanActor(
  role: "adjudicator" | "independent_reviewer",
  label: string,
  operator: TestActor
): TestActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeProviderAnswerReleaseEd25519PublicKey(publicKey);
  return {
    anchor: {
      eligibility: "operator_vouched_external_human",
      implementationParticipant: false,
      keyId: createProviderAnswerReleaseEd25519KeyId(publicKeySpkiBase64url),
      notAfter: "2027-01-01T00:00:00.000Z",
      notBefore: "2025-01-01T00:00:00.000Z",
      principalSha256: digest(`${label}-principal`),
      publicKeySpkiBase64url,
      role,
      vouchedByKeyId: operator.anchor.keyId,
      vouchedByPrincipalSha256: operator.anchor.principalSha256
    },
    privateKey
  };
}

function actors(label: string): TestActors {
  const operator = operatorActor(label);
  return {
    adjudicator: humanActor("adjudicator", `${label}-adjudicator`, operator),
    operator,
    reviewerA: humanActor("independent_reviewer", `${label}-reviewer-a`, operator),
    reviewerB: humanActor("independent_reviewer", `${label}-reviewer-b`, operator)
  };
}

function decisions(
  source: OutputArtifacts,
  firstAssessment: "pass" | "uncertain" = "pass"
): ProviderAnswerReleaseOutputDecision[] {
  return source.freeze.outputs.map(({ outputSha256, reviewId }, outputIndex) => ({
    dimensions: providerAnswerReleaseReviewDimensions.map((dimension, dimensionIndex) => ({
      assessment: outputIndex === 0 && dimensionIndex === 0
        ? firstAssessment
        : "pass" as const,
      dimension
    })),
    materialErrors: { citation: "none", factual: "none" },
    outputSha256,
    reviewId
  }));
}

function reviewBundle(
  source: OutputArtifacts,
  selectedActors: TestActors,
  firstAssessment: "pass" | "uncertain" = "pass"
): ReviewBundle {
  const reviewDecisions = decisions(source, firstAssessment);
  const reviewerA = createProviderAnswerReleaseReviewerSubmission({
    artifacts: source,
    decisions: reviewDecisions,
    reviewer: {
      completedIndependently: true,
      humanAttestation: "independent_external_human_release_review",
      implementationAgent: false,
      modelGeneratedDecisions: false,
      principalSha256: selectedActors.reviewerA.anchor.principalSha256,
      provenance: "external_human",
      role: "independent_reviewer"
    },
    reviewerSlot: "reviewer_a"
  });
  const reviewerB = createProviderAnswerReleaseReviewerSubmission({
    artifacts: source,
    decisions: reviewDecisions,
    reviewer: {
      completedIndependently: true,
      humanAttestation: "independent_external_human_release_review",
      implementationAgent: false,
      modelGeneratedDecisions: false,
      principalSha256: selectedActors.reviewerB.anchor.principalSha256,
      provenance: "external_human",
      role: "independent_reviewer"
    },
    reviewerSlot: "reviewer_b"
  });
  const submissions = [reviewerA, reviewerB] as const;
  return {
    adjudication: createProviderAnswerReleaseAdjudication({
      adjudicator: {
        humanAttestation: "external_human_release_review_adjudication",
        implementationAgent: false,
        modelGeneratedDecisions: false,
        principalSha256: selectedActors.adjudicator.anchor.principalSha256,
        provenance: "external_human",
        role: "adjudicator"
      },
      artifacts: source,
      decisions: reviewDecisions,
      disagreementResolutions: [],
      submissions
    }),
    submissions
  };
}

function promotion(source: OutputArtifacts, label: string): Readonly<{
  promotion: ValidatedProviderAnswerPersistedRoutePromotion;
  receiptSha256: string;
}> {
  const receiptSha256 = digest(`${label}-live-promotion-receipt`);
  const candidate = Object.freeze({
    receipt: Object.freeze({ label: "test-only-live-capability" }),
    report: Object.freeze({ aggregateOnly: true })
  }) as unknown as ValidatedProviderAnswerPersistedRoutePromotion;
  promotionBindings.set(candidate, Object.freeze({
    mappingSha256: source.mapping.mappingSha256,
    outputFreezeSha256: source.freeze.freezeSha256,
    packetSha256: source.packet.packetSha256,
    receiptSha256
  }));
  return { promotion: candidate, receiptSha256 };
}

function commonPayload(
  actor: TestActor,
  anchorSet: ProviderAnswerReleaseTrustAnchorSet,
  signedAt: string
) {
  return {
    artifactType: "knowledge_provider_answer_release_trust_attestation_payload" as const,
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
    keyId: actor.anchor.keyId,
    principalSha256: actor.anchor.principalSha256,
    signedAt,
    trustAnchorSetSha256: anchorSet.anchorSetSha256
  };
}

function trustEvidence(input: Readonly<{
  actors: TestActors;
  anchorSet: ProviderAnswerReleaseTrustAnchorSet;
  expected: ProviderAnswerReleaseTrustExpectedArtifacts;
}>): ProviderAnswerReleaseTrustEvidence {
  const reviewScope = {
    mappingSha256: input.expected.mappingSha256,
    outputFreezeSha256: input.expected.outputFreezeSha256,
    packetSha256: input.expected.packetSha256
  };
  const reviewer = (
    actor: TestActor,
    slot: "reviewer_a" | "reviewer_b",
    signedAt: string,
    submissionIndex: 0 | 1
  ) => createProviderAnswerReleaseTrustAttestation({
    payload: {
      ...commonPayload(actor, input.anchorSet, signedAt),
      declaration: {
        implementationAgent: false,
        modelGeneratedDecisions: false,
        provenance: "external_human",
        reviewedIndependently: true
      },
      reviewScope,
      reviewerSlot: slot,
      reviewerSubmissionSha256:
        input.expected.reviewerSubmissionSha256s[submissionIndex],
      role: "independent_reviewer",
      statement: "independent_provider_answer_release_review"
    },
    privateKey: actor.privateKey
  });
  const reviewerA = reviewer(input.actors.reviewerA, "reviewer_a", REVIEWER_A_AT, 0);
  const reviewerB = reviewer(input.actors.reviewerB, "reviewer_b", REVIEWER_B_AT, 1);
  const reviewerAttestationSha256s: [string, string] = [
    providerAnswerReleaseTrustAttestationSha256(reviewerA),
    providerAnswerReleaseTrustAttestationSha256(reviewerB)
  ];
  const adjudicatorPayload: ProviderAnswerReleaseTrustAttestationPayload = {
    ...commonPayload(input.actors.adjudicator, input.anchorSet, ADJUDICATED_AT),
    adjudicationSha256: input.expected.adjudicationSha256,
    declaration: {
      adjudicationCompleted: true,
      implementationAgent: false,
      modelGeneratedDecisions: false,
      provenance: "external_human",
      unresolvedMaterialDisagreements: 0
    },
    reviewScope,
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s,
    role: "adjudicator",
    statement: "completed_provider_answer_release_adjudication"
  };
  const adjudicator = createProviderAnswerReleaseTrustAttestation({
    payload: adjudicatorPayload,
    privateKey: input.actors.adjudicator.privateKey
  });
  const operatorPayload: ProviderAnswerReleaseTrustAttestationPayload = {
    ...commonPayload(input.actors.operator, input.anchorSet, APPROVED_AT),
    adjudicationAttestationSha256:
      providerAnswerReleaseTrustAttestationSha256(adjudicator),
    adjudicationSha256: input.expected.adjudicationSha256,
    authorization: "operator_reviewed_provider_answer_release_trust_chain",
    releaseScope: {
      ...reviewScope,
      persistedRoutePromotionReceiptSha256:
        input.expected.persistedRoutePromotionReceiptSha256
    },
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s,
    role: "release_operator",
    statement: "provider_answer_release_provenance_approval"
  };
  const operator = createProviderAnswerReleaseTrustAttestation({
    payload: operatorPayload,
    privateKey: input.actors.operator.privateKey
  });
  return createProviderAnswerReleaseTrustEvidence({
    adjudicatorAttestation: adjudicator,
    operatorAttestation: operator,
    reviewerAttestations: [reviewerA, reviewerB]
  });
}

function material(input: Readonly<{
  label: string;
  reviewActors?: TestActors;
  signingActors?: TestActors;
  firstAssessment?: "pass" | "uncertain";
}>) {
  const signingActors = input.signingActors ?? actors(`${input.label}-signing`);
  const reviewActors = input.reviewActors ?? signingActors;
  const review = reviewBundle(artifacts, reviewActors, input.firstAssessment);
  const live = promotion(artifacts, input.label);
  const anchorSet = createProviderAnswerReleaseTrustAnchorSet({
    anchors: Object.values(signingActors).map((actor) => actor.anchor),
    configuredAt: CONFIGURED_AT
  });
  const expected: ProviderAnswerReleaseTrustExpectedArtifacts = {
    adjudicationSha256: review.adjudication.adjudicationSha256,
    mappingSha256: artifacts.mapping.mappingSha256,
    outputFreezeSha256: artifacts.freeze.freezeSha256,
    packetSha256: artifacts.packet.packetSha256,
    persistedRoutePromotionReceiptSha256: live.receiptSha256,
    reviewerSubmissionSha256s: [
      review.submissions[0].submissionSha256,
      review.submissions[1].submissionSha256
    ]
  };
  return {
    input: {
      adjudication: review.adjudication,
      anchorSet,
      evaluatedAt: EVALUATED_AT,
      outputArtifacts: artifacts,
      persistedRoutePromotion: live.promotion,
      pinnedAnchorSetSha256: anchorSet.anchorSetSha256,
      reviewerSubmissions: review.submissions,
      trustEvidence: trustEvidence({ actors: signingActors, anchorSet, expected })
    },
    privateValues: {
      anchorSet,
      expected
    }
  };
}

beforeAll(async () => {
  vi.spyOn(
    persistedRouteBoundary,
    "validatedProviderAnswerPersistedRouteBinding"
  ).mockImplementation((candidate: unknown) => {
    if (typeof candidate === "object" && candidate !== null) {
      const binding = promotionBindings.get(candidate);
      if (binding) return binding;
    }
    return actualPromotionBinding(candidate);
  });
  artifacts = await generatePersistedArtifacts();
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (generationDirectory) {
    await rm(generationDirectory, { force: true, recursive: true });
  }
});

describe("provider answer release same-process orchestrator", () => {
  it("fails closed without the complete live and externally authored inputs", () => {
    expect(verifyProviderAnswerReleaseOrchestration()).toMatchObject({
      aggregateOnly: true,
      fullProductionReleaseEligible: false,
      providerAnswerReleaseEvidenceEligible: false,
      reasonCodes: ["input_incomplete"],
      version: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ORCHESTRATOR_VERSION
    });
  });

  it("verifies the exact live, review, principal, and pinned trust chain", () => {
    const trusted = material({ label: "valid" });
    const result = verifyProviderAnswerReleaseOrchestration(trusted.input);

    expect(result).toEqual({
      aggregateOnly: true,
      artifactBindingsVerified: true,
      citationViewerGatePassed: true,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: true,
      outputReviewGatePassed: true,
      persistedRoutePromotionBindingVerified: true,
      privateContentIncluded: false,
      providerAnswerReleaseEvidenceEligible: true,
      reasonCodes: [],
      reviewPrincipalBindingsVerified: true,
      reviewedOutputCount: 8,
      signatureCounts: { adjudicators: 1, operators: 1, reviewers: 2 },
      trustReasonCodes: [],
      trustedReviewEvidenceEligible: true,
      version: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ORCHESTRATOR_VERSION
    });
    const serialized = JSON.stringify(result);
    for (const value of [
      ...Object.values(trusted.privateValues.expected).flat(),
      ...trusted.privateValues.anchorSet.anchors.flatMap((anchor) => [
        anchor.keyId,
        anchor.principalSha256,
        anchor.publicKeySpkiBase64url
      ])
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("rejects a structural copy of the process-local promotion capability", () => {
    const trusted = material({ label: "copied-promotion" });
    const copiedPromotion = {
      receipt: trusted.input.persistedRoutePromotion.receipt,
      report: trusted.input.persistedRoutePromotion.report
    } as ValidatedProviderAnswerPersistedRoutePromotion;

    expect(verifyProviderAnswerReleaseOrchestration({
      ...trusted.input,
      persistedRoutePromotion: copiedPromotion
    })).toMatchObject({
      fullProductionReleaseEligible: false,
      persistedRoutePromotionBindingVerified: false,
      providerAnswerReleaseEvidenceEligible: false,
      reasonCodes: ["persisted_route_promotion_invalid"]
    });
  });

  it("binds signed reviewer identities to principals inside the review files", () => {
    const signingActors = actors("principal-substitution-signing");
    const reviewActors = actors("principal-substitution-review-files");
    const substituted = material({
      label: "principal-substitution",
      reviewActors,
      signingActors
    });

    expect(verifyProviderAnswerReleaseOrchestration(substituted.input)).toMatchObject({
      artifactBindingsVerified: true,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: false,
      persistedRoutePromotionBindingVerified: true,
      providerAnswerReleaseEvidenceEligible: false,
      reasonCodes: ["review_trust_principal_binding_mismatch"],
      reviewPrincipalBindingsVerified: false,
      trustedReviewEvidenceEligible: false
    });
  });

  it("keeps review-quality failure red after provenance succeeds", () => {
    const uncertain = material({
      firstAssessment: "uncertain",
      label: "uncertain-review"
    });

    expect(verifyProviderAnswerReleaseOrchestration(uncertain.input)).toMatchObject({
      artifactBindingsVerified: true,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: true,
      outputReviewGatePassed: false,
      providerAnswerReleaseEvidenceEligible: false,
      reasonCodes: ["output_review_gate_failed"],
      reviewPrincipalBindingsVerified: true,
      trustedReviewEvidenceEligible: true
    });
  });
});
