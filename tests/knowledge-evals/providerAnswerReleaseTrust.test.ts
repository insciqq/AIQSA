import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as persistedRouteBoundary from "./providerAnswerPersistedRoute";
import type {
  ValidatedProviderAnswerPersistedRoutePromotion
} from "./providerAnswerPersistedRoute";
import {
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
  createProviderAnswerReleaseEd25519KeyId,
  createProviderAnswerReleaseTrustAnchorSet,
  createProviderAnswerReleaseTrustAttestation,
  createProviderAnswerReleaseTrustEvidence,
  encodeProviderAnswerReleaseEd25519PublicKey,
  providerAnswerReleaseTrustAttestationPayloadSchema,
  providerAnswerReleaseTrustAttestationSha256,
  providerAnswerReleaseTrustPayloadSha256,
  verifyProviderAnswerReleaseTrust,
  type ProviderAnswerReleaseTrustAnchor,
  type ProviderAnswerReleaseTrustAnchorSet,
  type ProviderAnswerReleaseTrustAttestation,
  type ProviderAnswerReleaseTrustAttestationPayload,
  type ProviderAnswerReleaseTrustEvidence,
  type ProviderAnswerReleaseTrustExpectedArtifacts
} from "./providerAnswerReleaseTrust";

type Role = ProviderAnswerReleaseTrustAnchor["role"];
type HumanRole = Exclude<Role, "release_operator">;
type TestActor = Readonly<{
  anchor: ProviderAnswerReleaseTrustAnchor;
  privateKey: KeyObject;
}>;
type TestMaterial = Readonly<{
  actors: Readonly<{
    adjudicator: TestActor;
    operator: TestActor;
    reviewerA: TestActor;
    reviewerB: TestActor;
  }>;
  anchorSet: ProviderAnswerReleaseTrustAnchorSet;
  expected: ProviderAnswerReleaseTrustExpectedArtifacts;
  promotion: ValidatedProviderAnswerPersistedRoutePromotion;
}>;

const CONFIGURED_AT = "2026-01-01T00:00:00.000Z";
const REVIEWER_A_AT = "2026-02-01T00:00:00.000Z";
const REVIEWER_B_AT = "2026-02-01T00:01:00.000Z";
const ADJUDICATED_AT = "2026-02-02T00:00:00.000Z";
const APPROVED_AT = "2026-02-03T00:00:00.000Z";
const EVALUATED_AT = "2026-02-04T00:00:00.000Z";
const testPromotionBindings = new WeakMap<
  object,
  persistedRouteBoundary.ValidatedProviderAnswerPersistedRouteBinding
>();
const actualPromotionBinding =
  persistedRouteBoundary.validatedProviderAnswerPersistedRouteBinding;

// These hermetic tests isolate trust-chain logic from the stateful live
// capture. The persisted-route Prisma lane exercises the real WeakSet minting
// boundary and proves that disk/structural copies do not acquire this brand.
beforeAll(() => {
  vi.spyOn(
    persistedRouteBoundary,
    "validatedProviderAnswerPersistedRouteBinding"
  ).mockImplementation((promotion: unknown) => {
    if (typeof promotion === "object" && promotion !== null) {
      const testBinding = testPromotionBindings.get(promotion);
      if (testBinding) return testBinding;
    }
    return actualPromotionBinding(promotion);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function digest(value: string): string {
  return createHash("sha256").update(`test-only:${value}`, "utf8").digest("hex");
}

function operatorActor(ordinal: string): TestActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeProviderAnswerReleaseEd25519PublicKey(publicKey);
  return {
    anchor: {
      eligibility: "operator_controlled_release_authority",
      implementationParticipant: false,
      keyId: createProviderAnswerReleaseEd25519KeyId(publicKeySpkiBase64url),
      notAfter: "2027-01-01T00:00:00.000Z",
      notBefore: "2025-01-01T00:00:00.000Z",
      principalSha256: digest(`ephemeral-principal-${ordinal}`),
      publicKeySpkiBase64url,
      role: "release_operator"
    },
    privateKey
  };
}

function humanActor(role: HumanRole, ordinal: string, operator: TestActor): TestActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeProviderAnswerReleaseEd25519PublicKey(publicKey);
  return {
    anchor: {
      eligibility: "operator_vouched_external_human",
      implementationParticipant: false,
      keyId: createProviderAnswerReleaseEd25519KeyId(publicKeySpkiBase64url),
      notAfter: "2027-01-01T00:00:00.000Z",
      notBefore: "2025-01-01T00:00:00.000Z",
      principalSha256: digest(`ephemeral-principal-${ordinal}`),
      publicKeySpkiBase64url,
      role,
      vouchedByKeyId: operator.anchor.keyId,
      vouchedByPrincipalSha256: operator.anchor.principalSha256
    },
    privateKey
  };
}

function material(suffix = "trusted"): TestMaterial {
  const operator = operatorActor(`${suffix}-operator`);
  const actors = {
    adjudicator: humanActor("adjudicator", `${suffix}-adjudicator`, operator),
    operator,
    reviewerA: humanActor("independent_reviewer", `${suffix}-reviewer-a`, operator),
    reviewerB: humanActor("independent_reviewer", `${suffix}-reviewer-b`, operator)
  };
  const anchorSet = createProviderAnswerReleaseTrustAnchorSet({
    anchors: Object.values(actors).map((entry) => entry.anchor),
    configuredAt: CONFIGURED_AT
  });
  const expected: ProviderAnswerReleaseTrustExpectedArtifacts = {
    adjudicationSha256: digest(`${suffix}-release-adjudication`),
    mappingSha256: digest(`${suffix}-private-review-mapping`),
    outputFreezeSha256: digest(`${suffix}-provider-output-freeze`),
    packetSha256: digest(`${suffix}-blind-review-packet`),
    persistedRoutePromotionReceiptSha256: digest(
      `${suffix}-persisted-route-promotion-receipt`
    ),
    reviewerSubmissionSha256s: [
      digest(`${suffix}-reviewer-a-submission`),
      digest(`${suffix}-reviewer-b-submission`)
    ]
  };
  const promotion = Object.freeze({
    receipt: Object.freeze({
      output: Object.freeze({
        mappingSha256: expected.mappingSha256,
        outputFreezeSha256: expected.outputFreezeSha256,
        packetSha256: expected.packetSha256
      })
    })
  }) as unknown as ValidatedProviderAnswerPersistedRoutePromotion;
  testPromotionBindings.set(promotion, Object.freeze({
    mappingSha256: expected.mappingSha256,
    outputFreezeSha256: expected.outputFreezeSha256,
    packetSha256: expected.packetSha256,
    receiptSha256: expected.persistedRoutePromotionReceiptSha256
  }));
  return {
    actors,
    anchorSet,
    expected,
    promotion
  };
}

function commonPayload(
  signer: TestActor,
  anchorSet: ProviderAnswerReleaseTrustAnchorSet,
  signedAt: string
) {
  return {
    artifactType: "knowledge_provider_answer_release_trust_attestation_payload" as const,
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
    keyId: signer.anchor.keyId,
    principalSha256: signer.anchor.principalSha256,
    signedAt,
    trustAnchorSetSha256: anchorSet.anchorSetSha256
  };
}

function reviewScope(expected: ProviderAnswerReleaseTrustExpectedArtifacts) {
  return {
    mappingSha256: expected.mappingSha256,
    outputFreezeSha256: expected.outputFreezeSha256,
    packetSha256: expected.packetSha256
  };
}

function releaseScope(expected: ProviderAnswerReleaseTrustExpectedArtifacts) {
  return {
    ...reviewScope(expected),
    persistedRoutePromotionReceiptSha256: expected.persistedRoutePromotionReceiptSha256
  };
}

function reviewerPayload(input: Readonly<{
  anchorSet: ProviderAnswerReleaseTrustAnchorSet;
  expected: ProviderAnswerReleaseTrustExpectedArtifacts;
  signer: TestActor;
  signedAt: string;
  slot: "reviewer_a" | "reviewer_b";
}>): Extract<ProviderAnswerReleaseTrustAttestationPayload, {
  role: "independent_reviewer";
}> {
  const index = input.slot === "reviewer_a" ? 0 : 1;
  return {
    ...commonPayload(input.signer, input.anchorSet, input.signedAt),
    declaration: {
      implementationAgent: false,
      modelGeneratedDecisions: false,
      provenance: "external_human",
      reviewedIndependently: true
    },
    reviewScope: reviewScope(input.expected),
    reviewerSlot: input.slot,
    reviewerSubmissionSha256: input.expected.reviewerSubmissionSha256s[index],
    role: "independent_reviewer",
    statement: "independent_provider_answer_release_review"
  };
}

function assemble(input: TestMaterial, options: Readonly<{
  adjudicator?: TestActor;
  adjudicatorAt?: string;
  operator?: TestActor;
  operatorAt?: string;
  reviewerA?: TestActor;
  reviewerAAt?: string;
  reviewerB?: TestActor;
  reviewerBAt?: string;
}> = {}): Readonly<{
  adjudicatorAttestation: ProviderAnswerReleaseTrustAttestation;
  evidence: ProviderAnswerReleaseTrustEvidence;
  operatorAttestation: ProviderAnswerReleaseTrustAttestation;
  reviewerAttestations: readonly [
    ProviderAnswerReleaseTrustAttestation,
    ProviderAnswerReleaseTrustAttestation
  ];
}> {
  const reviewerASigner = options.reviewerA ?? input.actors.reviewerA;
  const reviewerBSigner = options.reviewerB ?? input.actors.reviewerB;
  const adjudicatorSigner = options.adjudicator ?? input.actors.adjudicator;
  const operatorSigner = options.operator ?? input.actors.operator;
  const reviewerA = createProviderAnswerReleaseTrustAttestation({
    payload: reviewerPayload({
      anchorSet: input.anchorSet,
      expected: input.expected,
      signer: reviewerASigner,
      signedAt: options.reviewerAAt ?? REVIEWER_A_AT,
      slot: "reviewer_a"
    }),
    privateKey: reviewerASigner.privateKey
  });
  const reviewerB = createProviderAnswerReleaseTrustAttestation({
    payload: reviewerPayload({
      anchorSet: input.anchorSet,
      expected: input.expected,
      signer: reviewerBSigner,
      signedAt: options.reviewerBAt ?? REVIEWER_B_AT,
      slot: "reviewer_b"
    }),
    privateKey: reviewerBSigner.privateKey
  });
  const reviewerAttestationSha256s: [string, string] = [
    providerAnswerReleaseTrustAttestationSha256(reviewerA),
    providerAnswerReleaseTrustAttestationSha256(reviewerB)
  ];
  const adjudicatorPayload: ProviderAnswerReleaseTrustAttestationPayload = {
    ...commonPayload(
      adjudicatorSigner,
      input.anchorSet,
      options.adjudicatorAt ?? ADJUDICATED_AT
    ),
    adjudicationSha256: input.expected.adjudicationSha256,
    declaration: {
      adjudicationCompleted: true,
      implementationAgent: false,
      modelGeneratedDecisions: false,
      provenance: "external_human",
      unresolvedMaterialDisagreements: 0
    },
    reviewScope: reviewScope(input.expected),
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s,
    role: "adjudicator",
    statement: "completed_provider_answer_release_adjudication"
  };
  const adjudicatorAttestation = createProviderAnswerReleaseTrustAttestation({
    payload: adjudicatorPayload,
    privateKey: adjudicatorSigner.privateKey
  });
  const operatorPayload: ProviderAnswerReleaseTrustAttestationPayload = {
    ...commonPayload(operatorSigner, input.anchorSet, options.operatorAt ?? APPROVED_AT),
    adjudicationAttestationSha256:
      providerAnswerReleaseTrustAttestationSha256(adjudicatorAttestation),
    adjudicationSha256: input.expected.adjudicationSha256,
    authorization: "operator_reviewed_provider_answer_release_trust_chain",
    releaseScope: releaseScope(input.expected),
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s,
    role: "release_operator",
    statement: "provider_answer_release_provenance_approval"
  };
  const operatorAttestation = createProviderAnswerReleaseTrustAttestation({
    payload: operatorPayload,
    privateKey: operatorSigner.privateKey
  });
  return {
    adjudicatorAttestation,
    evidence: createProviderAnswerReleaseTrustEvidence({
      adjudicatorAttestation,
      operatorAttestation,
      reviewerAttestations: [reviewerA, reviewerB]
    }),
    operatorAttestation,
    reviewerAttestations: [reviewerA, reviewerB]
  };
}

function verify(input: TestMaterial, evidence: ProviderAnswerReleaseTrustEvidence) {
  return verifyProviderAnswerReleaseTrust({
    anchorSet: input.anchorSet,
    evaluatedAt: EVALUATED_AT,
    evidence,
    expectedArtifacts: input.expected,
    persistedRoutePromotion: input.promotion,
    pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
  });
}

function replaceReviewerA(
  chain: ReturnType<typeof assemble>,
  reviewerA: ProviderAnswerReleaseTrustAttestation
): ProviderAnswerReleaseTrustEvidence {
  return createProviderAnswerReleaseTrustEvidence({
    adjudicatorAttestation: chain.adjudicatorAttestation,
    operatorAttestation: chain.operatorAttestation,
    reviewerAttestations: [reviewerA, chain.reviewerAttestations[1]]
  });
}

describe("provider answer release trust contract", () => {
  it("is red unless every private trust input is supplied", () => {
    expect(verifyProviderAnswerReleaseTrust()).toEqual({
      aggregateOnly: true,
      artifactBindingsVerified: false,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: false,
      operatorApprovalVerified: false,
      persistedRoutePromotionBindingVerified: false,
      privateContentIncluded: false,
      provenanceVerification: "unverifiable",
      reasonCodes: [
        "trust_anchor_set_not_supplied",
        "trust_anchor_pin_not_supplied",
        "trusted_review_evidence_not_supplied",
        "expected_artifact_digests_not_supplied",
        "persisted_route_promotion_not_supplied",
        "verification_time_not_supplied"
      ],
      signatureCounts: { adjudicators: 0, operators: 0, reviewers: 0 },
      signaturesVerified: false,
      trustedReviewEvidenceEligible: false,
      verified: false,
      version: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION
    });
  });

  it("requires a separately supplied exact anchor-set pin", () => {
    const trusted = material();
    const chain = assemble(trusted);
    const common = {
      anchorSet: trusted.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: chain.evidence,
      expectedArtifacts: trusted.expected,
      persistedRoutePromotion: trusted.promotion
    };
    expect(verifyProviderAnswerReleaseTrust(common)).toMatchObject({
      reasonCodes: ["trust_anchor_pin_not_supplied"],
      signaturesVerified: false,
      verified: false
    });
    expect(verifyProviderAnswerReleaseTrust({
      ...common,
      pinnedAnchorSetSha256: "not-a-sha256"
    })).toMatchObject({
      reasonCodes: ["trust_anchor_pin_invalid"],
      signaturesVerified: false,
      verified: false
    });
    expect(verifyProviderAnswerReleaseTrust({
      ...common,
      pinnedAnchorSetSha256: digest("wrong-anchor-set")
    })).toMatchObject({
      reasonCodes: ["trust_anchor_pin_mismatch"],
      signaturesVerified: false,
      verified: false
    });

    const attacker = material("attacker");
    expect(verifyProviderAnswerReleaseTrust({
      anchorSet: attacker.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: assemble(attacker).evidence,
      expectedArtifacts: attacker.expected,
      persistedRoutePromotion: attacker.promotion,
      pinnedAnchorSetSha256: trusted.anchorSet.anchorSetSha256
    })).toMatchObject({
      reasonCodes: ["trust_anchor_pin_mismatch"],
      signaturesVerified: false,
      verified: false
    });
  });

  it("verifies the four-authority chain without making a release decision", () => {
    const input = material();
    const chain = assemble(input);
    const report = verify(input, chain.evidence);

    expect(report).toEqual({
      aggregateOnly: true,
      artifactBindingsVerified: true,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: true,
      operatorApprovalVerified: true,
      persistedRoutePromotionBindingVerified: true,
      privateContentIncluded: false,
      provenanceVerification: "operator_anchored_ed25519_verified",
      reasonCodes: [],
      signatureCounts: { adjudicators: 1, operators: 1, reviewers: 2 },
      signaturesVerified: true,
      trustedReviewEvidenceEligible: true,
      verified: true,
      version: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION
    });
    const serializedReport = JSON.stringify(report);
    for (const privateValue of [
      ...Object.values(input.expected).flat(),
      ...input.anchorSet.anchors.flatMap((anchor) => [
        anchor.keyId,
        anchor.principalSha256,
        anchor.publicKeySpkiBase64url
      ]),
      ...chain.reviewerAttestations.map((attestation) => attestation.signature.value),
      chain.adjudicatorAttestation.signature.value,
      chain.operatorAttestation.signature.value
    ]) {
      expect(serializedReport).not.toContain(privateValue);
    }

    const payload = chain.reviewerAttestations[0].payload;
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(providerAnswerReleaseTrustPayloadSha256(reordered)).toBe(
      providerAnswerReleaseTrustPayloadSha256(payload)
    );
    const canonicalResign = createProviderAnswerReleaseTrustAttestation({
      payload: providerAnswerReleaseTrustAttestationPayloadSchema.parse(reordered),
      privateKey: input.actors.reviewerA.privateKey
    });
    expect(canonicalResign.signature.value).toBe(
      chain.reviewerAttestations[0].signature.value
    );
  });

  it("requires the live promotion capability and its exact persisted output scope", () => {
    const input = material("live-boundary");
    const chain = assemble(input);
    expect(verifyProviderAnswerReleaseTrust({
      anchorSet: input.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: chain.evidence,
      expectedArtifacts: input.expected,
      pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
    })).toMatchObject({
      reasonCodes: ["persisted_route_promotion_not_supplied"],
      trustedReviewEvidenceEligible: false,
      verified: false
    });
    const structuralCopy = {
      receipt: input.promotion.receipt,
      report: input.promotion.report
    } as ValidatedProviderAnswerPersistedRoutePromotion;
    expect(verifyProviderAnswerReleaseTrust({
      anchorSet: input.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: chain.evidence,
      expectedArtifacts: input.expected,
      persistedRoutePromotion: structuralCopy,
      pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
    })).toMatchObject({
      persistedRoutePromotionBindingVerified: false,
      reasonCodes: ["persisted_route_promotion_invalid"],
      trustedReviewEvidenceEligible: false,
      verified: false
    });

    const reviewA = material("cross-run-a");
    const reviewB = material("cross-run-b");
    expect(verifyProviderAnswerReleaseTrust({
      anchorSet: reviewB.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: assemble(reviewB).evidence,
      expectedArtifacts: reviewB.expected,
      persistedRoutePromotion: reviewA.promotion,
      pinnedAnchorSetSha256: reviewB.anchorSet.anchorSetSha256
    })).toMatchObject({
      artifactBindingsVerified: false,
      persistedRoutePromotionBindingVerified: false,
      reasonCodes: ["artifact_binding_mismatch"],
      trustedReviewEvidenceEligible: false,
      verified: false
    });
  });

  it("rejects signature tamper and every provider-review artifact substitution", () => {
    const input = material();
    const chain = assemble(input);
    const originalReviewer = chain.reviewerAttestations[0];
    expect(originalReviewer.payload.role).toBe("independent_reviewer");
    if (originalReviewer.payload.role !== "independent_reviewer") return;

    const tamperedPayload = {
      ...originalReviewer.payload,
      reviewerSubmissionSha256: digest("substituted-review-submission")
    };
    const payloadTamperedReviewer: ProviderAnswerReleaseTrustAttestation = {
      ...originalReviewer,
      payload: tamperedPayload,
      payloadSha256: providerAnswerReleaseTrustPayloadSha256(tamperedPayload)
    };
    expect(verify(input, replaceReviewerA(chain, payloadTamperedReviewer))).toMatchObject({
      reasonCodes: ["attestation_signature_invalid"],
      verified: false
    });

    const signatureBytes = Buffer.from(originalReviewer.signature.value, "base64url");
    signatureBytes[0] = signatureBytes[0]! ^ 1;
    const signatureTamperedReviewer: ProviderAnswerReleaseTrustAttestation = {
      ...originalReviewer,
      signature: {
        ...originalReviewer.signature,
        value: signatureBytes.toString("base64url")
      }
    };
    expect(verify(input, replaceReviewerA(chain, signatureTamperedReviewer))).toMatchObject({
      reasonCodes: ["attestation_signature_invalid"],
      verified: false
    });

    const expectedArtifactTampers: ProviderAnswerReleaseTrustExpectedArtifacts[] = [
      { ...input.expected, outputFreezeSha256: digest("substituted-output-freeze") },
      { ...input.expected, packetSha256: digest("substituted-packet") },
      { ...input.expected, mappingSha256: digest("substituted-mapping") },
      { ...input.expected, adjudicationSha256: digest("substituted-adjudication") },
      {
        ...input.expected,
        persistedRoutePromotionReceiptSha256: digest("substituted-promotion-receipt")
      },
      {
        ...input.expected,
        reviewerSubmissionSha256s: [
          digest("substituted-reviewer-a-submission"),
          input.expected.reviewerSubmissionSha256s[1]
        ]
      }
    ];
    for (const expectedArtifacts of expectedArtifactTampers) {
      expect(verifyProviderAnswerReleaseTrust({
        anchorSet: input.anchorSet,
        evaluatedAt: EVALUATED_AT,
        evidence: chain.evidence,
        expectedArtifacts,
        persistedRoutePromotion: input.promotion,
        pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
      })).toMatchObject({
        artifactBindingsVerified: false,
        persistedRoutePromotionBindingVerified: false,
        reasonCodes: ["artifact_binding_mismatch"],
        verified: false
      });
    }

    expect(verifyProviderAnswerReleaseTrust({
      anchorSet: input.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: chain.evidence,
      expectedArtifacts: {
        ...input.expected,
        outputFreezeSha256: input.expected.packetSha256
      },
      persistedRoutePromotion: input.promotion,
      pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
    })).toMatchObject({
      reasonCodes: ["expected_artifact_digests_invalid"],
      verified: false
    });
  });

  it("rejects a validly signed reviewer substitution not chained by adjudication", () => {
    const input = material();
    const chain = assemble(input);
    const replacement = createProviderAnswerReleaseTrustAttestation({
      payload: reviewerPayload({
        anchorSet: input.anchorSet,
        expected: input.expected,
        signer: input.actors.reviewerA,
        signedAt: "2026-02-01T00:00:01.000Z",
        slot: "reviewer_a"
      }),
      privateKey: input.actors.reviewerA.privateKey
    });

    expect(verify(input, replaceReviewerA(chain, replacement))).toMatchObject({
      artifactBindingsVerified: false,
      reasonCodes: ["attestation_chain_mismatch"],
      signaturesVerified: false,
      verified: false
    });
  });

  it("rejects duplicate, role-escalated, unanchored, and self-vouched authorities", () => {
    const input = material();
    const duplicateReviewer = assemble(input, { reviewerB: input.actors.reviewerA });
    expect(verify(input, duplicateReviewer.evidence)).toMatchObject({
      reasonCodes: ["review_authorities_not_distinct"],
      verified: false
    });

    const roleEscalation = assemble(input, { reviewerA: input.actors.operator });
    expect(verify(input, roleEscalation.evidence)).toMatchObject({
      reasonCodes: ["attestation_role_mismatch"],
      verified: false
    });

    const attackerOperator = operatorActor("self-attester-voucher");
    const attacker = humanActor(
      "independent_reviewer",
      "unanchored-self-attester",
      attackerOperator
    );
    const selfAttestedChain = assemble(input, { reviewerA: attacker });
    expect(verify(input, selfAttestedChain.evidence)).toMatchObject({
      reasonCodes: ["attestation_anchor_untrusted"],
      verified: false
    });

    const reviewerAnchor = input.actors.reviewerA.anchor;
    expect(reviewerAnchor.role).toBe("independent_reviewer");
    if (reviewerAnchor.role !== "independent_reviewer") return;
    const selfVouchedAnchor: ProviderAnswerReleaseTrustAnchor = {
      ...reviewerAnchor,
      vouchedByKeyId: reviewerAnchor.keyId,
      vouchedByPrincipalSha256: reviewerAnchor.principalSha256
    };
    expect(() => createProviderAnswerReleaseTrustAnchorSet({
      anchors: [
        selfVouchedAnchor,
        input.actors.reviewerB.anchor,
        input.actors.adjudicator.anchor,
        input.actors.operator.anchor
      ],
      configuredAt: CONFIGURED_AT
    })).toThrow();

    const selfVouchedAnchorSet = structuredClone(input.anchorSet);
    const selfVouchedReviewer = selfVouchedAnchorSet.anchors.find((anchor) =>
      anchor.role === "independent_reviewer");
    expect(selfVouchedReviewer?.role).toBe("independent_reviewer");
    if (selfVouchedReviewer?.role !== "independent_reviewer") return;
    selfVouchedReviewer.vouchedByKeyId = selfVouchedReviewer.keyId;
    selfVouchedReviewer.vouchedByPrincipalSha256 = selfVouchedReviewer.principalSha256;
    expect(verifyProviderAnswerReleaseTrust({
      anchorSet: selfVouchedAnchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: assemble(input).evidence,
      expectedArtifacts: input.expected,
      persistedRoutePromotion: input.promotion,
      pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
    })).toMatchObject({
      reasonCodes: ["trust_anchor_set_invalid"],
      verified: false
    });

    const crossRolePrincipal: ProviderAnswerReleaseTrustAnchor = {
      ...input.actors.adjudicator.anchor,
      principalSha256: input.actors.reviewerA.anchor.principalSha256
    };
    expect(() => createProviderAnswerReleaseTrustAnchorSet({
      anchors: [
        input.actors.reviewerA.anchor,
        input.actors.reviewerB.anchor,
        crossRolePrincipal,
        input.actors.operator.anchor
      ],
      configuredAt: CONFIGURED_AT
    })).toThrow();

    const payload = reviewerPayload({
      anchorSet: input.anchorSet,
      expected: input.expected,
      signer: input.actors.reviewerA,
      signedAt: REVIEWER_A_AT,
      slot: "reviewer_a"
    });
    expect(providerAnswerReleaseTrustAttestationPayloadSchema.safeParse({
      ...payload,
      declaration: { ...payload.declaration, implementationAgent: true }
    }).success).toBe(false);
  });

  it("requires the signing operator to be the human roots' distinct voucher", () => {
    const input = material();
    const substituteOperator = operatorActor("substitute-operator");
    const anchorSet = createProviderAnswerReleaseTrustAnchorSet({
      anchors: [
        ...input.anchorSet.anchors,
        substituteOperator.anchor
      ],
      configuredAt: CONFIGURED_AT
    });
    const substituted: TestMaterial = {
      ...input,
      actors: { ...input.actors, operator: substituteOperator },
      anchorSet
    };

    expect(verify(substituted, assemble(substituted).evidence)).toMatchObject({
      reasonCodes: ["human_anchor_voucher_mismatch"],
      verified: false
    });
  });

  it("enforces review-adjudication-operator time ordering and anchor validity", () => {
    const input = material();
    const outOfOrder = assemble(input, {
      reviewerAAt: "2026-02-02T00:00:01.000Z"
    });
    expect(verify(input, outOfOrder.evidence)).toMatchObject({
      reasonCodes: ["attestation_sequence_invalid"],
      verified: false
    });

    const beforeConfiguration = assemble(input, {
      reviewerAAt: "2025-12-31T23:59:59.999Z"
    });
    expect(verify(input, beforeConfiguration.evidence)).toMatchObject({
      reasonCodes: ["attestation_time_invalid"],
      verified: false
    });
  });
});
