import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
  createKnowledgeSemanticEd25519KeyId,
  createKnowledgeSemanticHumanTrustAnchorSet,
  createKnowledgeSemanticHumanTrustAttestation,
  createKnowledgeSemanticHumanTrustEvidence,
  encodeKnowledgeSemanticEd25519PublicKey,
  knowledgeSemanticHumanTrustAttestationPayloadSchema,
  knowledgeSemanticHumanTrustAttestationSha256,
  knowledgeSemanticHumanTrustPayloadSha256,
  verifyKnowledgeSemanticHumanTrust,
  type KnowledgeSemanticHumanTrustAnchor,
  type KnowledgeSemanticHumanTrustAnchorSet,
  type KnowledgeSemanticHumanTrustAttestation,
  type KnowledgeSemanticHumanTrustAttestationPayload,
  type KnowledgeSemanticHumanTrustEvidence,
  type KnowledgeSemanticHumanTrustExpectedArtifacts
} from "./semanticGroundingTrust";
import { verifyKnowledgeSemanticCandidateHumanTrust } from "./semanticGroundingBenchmark";

type Role = KnowledgeSemanticHumanTrustAnchor["role"];
type TestActor = Readonly<{
  anchor: KnowledgeSemanticHumanTrustAnchor;
  privateKey: KeyObject;
}>;

type TestMaterial = Readonly<{
  actors: Readonly<{
    adjudicator: TestActor;
    operator: TestActor;
    reviewerA: TestActor;
    reviewerB: TestActor;
  }>;
  anchorSet: KnowledgeSemanticHumanTrustAnchorSet;
  expected: KnowledgeSemanticHumanTrustExpectedArtifacts;
}>;

const CONFIGURED_AT = "2026-01-01T00:00:00.000Z";
const REVIEWER_A_AT = "2026-02-01T00:00:00.000Z";
const REVIEWER_B_AT = "2026-02-01T00:01:00.000Z";
const ADJUDICATED_AT = "2026-02-02T00:00:00.000Z";
const APPROVED_AT = "2026-02-03T00:00:00.000Z";
const EVALUATED_AT = "2026-02-04T00:00:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(`test-only:${value}`, "utf8").digest("hex");
}

function actor(role: Role, ordinal: string): TestActor {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64url = encodeKnowledgeSemanticEd25519PublicKey(publicKey);
  const common = {
    implementationParticipant: false as const,
    keyId: createKnowledgeSemanticEd25519KeyId(publicKeySpkiBase64url),
    notAfter: "2027-01-01T00:00:00.000Z",
    notBefore: "2025-01-01T00:00:00.000Z",
    principalSha256: digest(`ephemeral-principal-${ordinal}`),
    publicKeySpkiBase64url
  };
  const anchor: KnowledgeSemanticHumanTrustAnchor = role === "release_operator"
    ? {
        ...common,
        eligibility: "operator_controlled_release_authority",
        role
      }
    : {
        ...common,
        eligibility: "operator_vouched_external_human",
        role
      };
  return { anchor, privateKey };
}

function material(): TestMaterial {
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
  return {
    actors,
    anchorSet,
    expected: {
      adjudicationSha256: digest("adjudication-artifact"),
      calibrationFreezeManifestSha256: digest("calibration-freeze-manifest"),
      candidateFreezeManifestSha256: digest("candidate-freeze-manifest"),
      corpusSha256: digest("frozen-corpus"),
      packetSha256: digest("exact-blind-packet"),
      poolSha256: digest("frozen-pool"),
      predictionArtifactSha256: digest("frozen-prediction-artifact"),
      reviewMappingSha256: digest("private-review-mapping"),
      reviewerSubmissionSha256s: [
        digest("reviewer-a-submission"),
        digest("reviewer-b-submission")
      ]
    }
  };
}

function commonPayload(
  signer: TestActor,
  anchorSet: KnowledgeSemanticHumanTrustAnchorSet,
  signedAt: string
) {
  return {
    artifactType: "knowledge_semantic_human_trust_attestation_payload" as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
    keyId: signer.anchor.keyId,
    principalSha256: signer.anchor.principalSha256,
    signedAt,
    trustAnchorSetSha256: anchorSet.anchorSetSha256
  };
}

function reviewScope(expected: KnowledgeSemanticHumanTrustExpectedArtifacts) {
  return {
    corpusSha256: expected.corpusSha256,
    packetSha256: expected.packetSha256,
    poolSha256: expected.poolSha256
  };
}

function releaseScope(expected: KnowledgeSemanticHumanTrustExpectedArtifacts) {
  return {
    ...reviewScope(expected),
    calibrationFreezeManifestSha256: expected.calibrationFreezeManifestSha256,
    candidateFreezeManifestSha256: expected.candidateFreezeManifestSha256,
    predictionArtifactSha256: expected.predictionArtifactSha256,
    reviewMappingSha256: expected.reviewMappingSha256
  };
}

function reviewerPayload(input: Readonly<{
  anchorSet: KnowledgeSemanticHumanTrustAnchorSet;
  expected: KnowledgeSemanticHumanTrustExpectedArtifacts;
  signer: TestActor;
  signedAt: string;
  slot: "reviewer_a" | "reviewer_b";
}>): Extract<KnowledgeSemanticHumanTrustAttestationPayload, {
  role: "independent_reviewer";
}> {
  const index = input.slot === "reviewer_a" ? 0 : 1;
  return {
    ...commonPayload(input.signer, input.anchorSet, input.signedAt),
    declaration: {
      implementationAgent: false,
      modelGeneratedLabels: false,
      provenance: "external_human",
      reviewedIndependently: true
    },
    reviewScope: reviewScope(input.expected),
    reviewerSlot: input.slot,
    role: "independent_reviewer",
    statement: "independent_reviewer_submission",
    submissionSha256: input.expected.reviewerSubmissionSha256s[index]
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
  adjudicatorAttestation: KnowledgeSemanticHumanTrustAttestation;
  evidence: KnowledgeSemanticHumanTrustEvidence;
  operatorAttestation: KnowledgeSemanticHumanTrustAttestation;
  reviewerAttestations: readonly [
    KnowledgeSemanticHumanTrustAttestation,
    KnowledgeSemanticHumanTrustAttestation
  ];
}> {
  const reviewerASigner = options.reviewerA ?? input.actors.reviewerA;
  const reviewerBSigner = options.reviewerB ?? input.actors.reviewerB;
  const adjudicatorSigner = options.adjudicator ?? input.actors.adjudicator;
  const operatorSigner = options.operator ?? input.actors.operator;
  const reviewerA = createKnowledgeSemanticHumanTrustAttestation({
    payload: reviewerPayload({
      anchorSet: input.anchorSet,
      expected: input.expected,
      signer: reviewerASigner,
      signedAt: options.reviewerAAt ?? REVIEWER_A_AT,
      slot: "reviewer_a"
    }),
    privateKey: reviewerASigner.privateKey
  });
  const reviewerB = createKnowledgeSemanticHumanTrustAttestation({
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
    knowledgeSemanticHumanTrustAttestationSha256(reviewerA),
    knowledgeSemanticHumanTrustAttestationSha256(reviewerB)
  ];
  const adjudicatorPayload: KnowledgeSemanticHumanTrustAttestationPayload = {
    ...commonPayload(
      adjudicatorSigner,
      input.anchorSet,
      options.adjudicatorAt ?? ADJUDICATED_AT
    ),
    adjudicationSha256: input.expected.adjudicationSha256,
    declaration: {
      adjudicationCompleted: true,
      implementationAgent: false,
      provenance: "external_human",
      unresolvedMaterialDisagreements: 0
    },
    reviewScope: reviewScope(input.expected),
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s,
    role: "adjudicator",
    statement: "completed_adjudication"
  };
  const adjudicatorAttestation = createKnowledgeSemanticHumanTrustAttestation({
    payload: adjudicatorPayload,
    privateKey: adjudicatorSigner.privateKey
  });
  const operatorPayload: KnowledgeSemanticHumanTrustAttestationPayload = {
    ...commonPayload(operatorSigner, input.anchorSet, options.operatorAt ?? APPROVED_AT),
    adjudicationAttestationSha256:
      knowledgeSemanticHumanTrustAttestationSha256(adjudicatorAttestation),
    adjudicationSha256: input.expected.adjudicationSha256,
    authorization: "operator_reviewed_human_provenance_chain",
    releaseScope: releaseScope(input.expected),
    reviewerAttestationSha256s,
    reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s,
    role: "release_operator",
    statement: "release_provenance_approval"
  };
  const operatorAttestation = createKnowledgeSemanticHumanTrustAttestation({
    payload: operatorPayload,
    privateKey: operatorSigner.privateKey
  });
  return {
    adjudicatorAttestation,
    evidence: createKnowledgeSemanticHumanTrustEvidence({
      adjudicatorAttestation,
      operatorAttestation,
      reviewerAttestations: [reviewerA, reviewerB]
    }),
    operatorAttestation,
    reviewerAttestations: [reviewerA, reviewerB]
  };
}

function verify(input: TestMaterial, evidence: KnowledgeSemanticHumanTrustEvidence) {
  return verifyKnowledgeSemanticHumanTrust({
    anchorSet: input.anchorSet,
    evaluatedAt: EVALUATED_AT,
    evidence,
    expectedArtifacts: input.expected,
    pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
  });
}

function replaceReviewerA(
  chain: ReturnType<typeof assemble>,
  reviewerA: KnowledgeSemanticHumanTrustAttestation
): KnowledgeSemanticHumanTrustEvidence {
  return createKnowledgeSemanticHumanTrustEvidence({
    adjudicatorAttestation: chain.adjudicatorAttestation,
    operatorAttestation: chain.operatorAttestation,
    reviewerAttestations: [reviewerA, chain.reviewerAttestations[1]]
  });
}

describe("Knowledge semantic human trust contract", () => {
  it("is unverifiable and red unless every private trust input is supplied", () => {
    expect(verifyKnowledgeSemanticHumanTrust()).toEqual({
      aggregateOnly: true,
      artifactBindingsVerified: false,
      blockingEvidenceEligible: false,
      humanProvenanceGatePassed: false,
      operatorApprovalVerified: false,
      privateContentIncluded: false,
      provenanceVerification: "unverifiable",
      reasonCodes: [
        "trust_anchor_set_not_supplied",
        "trust_anchor_pin_not_supplied",
        "trusted_human_evidence_not_supplied",
        "expected_artifact_digests_not_supplied",
        "verification_time_not_supplied"
      ],
      signatureCounts: { adjudicators: 0, operators: 0, reviewers: 0 },
      signaturesVerified: false,
      verified: false,
      version: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION
    });
  });

  it("requires an independently supplied exact anchor-set pin before signature checks", () => {
    const trusted = material();
    const trustedChain = assemble(trusted);
    const common = {
      anchorSet: trusted.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: trustedChain.evidence,
      expectedArtifacts: trusted.expected
    };
    expect(verifyKnowledgeSemanticHumanTrust(common)).toMatchObject({
      reasonCodes: ["trust_anchor_pin_not_supplied"],
      signaturesVerified: false,
      verified: false
    });
    expect(verifyKnowledgeSemanticHumanTrust({
      ...common,
      pinnedAnchorSetSha256: "not-a-sha256"
    })).toMatchObject({
      reasonCodes: ["trust_anchor_pin_invalid"],
      signaturesVerified: false,
      verified: false
    });
    expect(verifyKnowledgeSemanticHumanTrust({
      ...common,
      pinnedAnchorSetSha256: digest("wrong-anchor-set")
    })).toMatchObject({
      reasonCodes: ["trust_anchor_pin_mismatch"],
      signaturesVerified: false,
      verified: false
    });

    const attacker = material();
    const attackerChain = assemble(attacker);
    expect(verifyKnowledgeSemanticHumanTrust({
      anchorSet: attacker.anchorSet,
      evaluatedAt: EVALUATED_AT,
      evidence: attackerChain.evidence,
      expectedArtifacts: attacker.expected,
      pinnedAnchorSetSha256: trusted.anchorSet.anchorSetSha256
    })).toMatchObject({
      artifactBindingsVerified: false,
      reasonCodes: ["trust_anchor_pin_mismatch"],
      signaturesVerified: false,
      verified: false
    });
  });

  it("verifies a canonical four-authority Ed25519 chain without projecting private data", () => {
    const input = material();
    const chain = assemble(input);
    const report = verify(input, chain.evidence);

    expect(report).toEqual({
      aggregateOnly: true,
      artifactBindingsVerified: true,
      blockingEvidenceEligible: true,
      humanProvenanceGatePassed: true,
      operatorApprovalVerified: true,
      privateContentIncluded: false,
      provenanceVerification: "operator_anchored_ed25519_verified",
      reasonCodes: [],
      signatureCounts: { adjudicators: 1, operators: 1, reviewers: 2 },
      signaturesVerified: true,
      verified: true,
      version: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION
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
    expect(knowledgeSemanticHumanTrustPayloadSha256(reordered)).toBe(
      knowledgeSemanticHumanTrustPayloadSha256(payload)
    );
    const canonicalResign = createKnowledgeSemanticHumanTrustAttestation({
      payload: knowledgeSemanticHumanTrustAttestationPayloadSchema.parse(reordered),
      privateKey: input.actors.reviewerA.privateKey
    });
    expect(canonicalResign.signature.value).toBe(
      chain.reviewerAttestations[0].signature.value
    );

    expect(verifyKnowledgeSemanticCandidateHumanTrust({
      calibrationFreezeManifestSha256: input.expected.calibrationFreezeManifestSha256,
      candidateFreezeManifestSha256: input.expected.candidateFreezeManifestSha256,
      humanTrust: {
        anchorSet: input.anchorSet,
        evaluatedAt: EVALUATED_AT,
        evidence: chain.evidence,
        pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
      },
      labels: {
        adjudicationSha256: input.expected.adjudicationSha256,
        corpusSha256: input.expected.corpusSha256,
        mappingSha256: input.expected.reviewMappingSha256,
        packetSha256: input.expected.packetSha256,
        poolSha256: input.expected.poolSha256,
        reviewerSubmissionSha256s: input.expected.reviewerSubmissionSha256s
      },
      predictionArtifactSha256: input.expected.predictionArtifactSha256
    })).toMatchObject({
      humanProvenanceGatePassed: true,
      provenanceVerification: "operator_anchored_ed25519_verified",
      verified: true
    });
  });

  it("rejects payload, signature, and every release-artifact binding tamper", () => {
    const input = material();
    const chain = assemble(input);
    const originalReviewer = chain.reviewerAttestations[0];
    expect(originalReviewer.payload.role).toBe("independent_reviewer");
    if (originalReviewer.payload.role !== "independent_reviewer") return;
    const tamperedPayload = {
      ...originalReviewer.payload,
      submissionSha256: digest("substituted-review-submission")
    };
    const payloadTamperedReviewer: KnowledgeSemanticHumanTrustAttestation = {
      ...originalReviewer,
      payload: tamperedPayload,
      payloadSha256: knowledgeSemanticHumanTrustPayloadSha256(tamperedPayload)
    };
    expect(verify(input, replaceReviewerA(chain, payloadTamperedReviewer))).toMatchObject({
      humanProvenanceGatePassed: false,
      reasonCodes: ["attestation_signature_invalid"],
      verified: false
    });

    const signatureBytes = Buffer.from(originalReviewer.signature.value, "base64url");
    signatureBytes[0] = signatureBytes[0]! ^ 1;
    const signatureTamperedReviewer: KnowledgeSemanticHumanTrustAttestation = {
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

    const expectedArtifactTampers: KnowledgeSemanticHumanTrustExpectedArtifacts[] = [
      { ...input.expected, corpusSha256: digest("substituted-corpus") },
      { ...input.expected, poolSha256: digest("substituted-pool") },
      { ...input.expected, packetSha256: digest("substituted-packet") },
      { ...input.expected, reviewMappingSha256: digest("substituted-mapping") },
      {
        ...input.expected,
        candidateFreezeManifestSha256: digest("substituted-candidate-freeze")
      },
      {
        ...input.expected,
        calibrationFreezeManifestSha256: digest("substituted-calibration-freeze")
      },
      { ...input.expected, predictionArtifactSha256: digest("substituted-predictions") },
      { ...input.expected, adjudicationSha256: digest("substituted-adjudication") },
      {
        ...input.expected,
        reviewerSubmissionSha256s: [
          digest("substituted-reviewer-a-submission"),
          input.expected.reviewerSubmissionSha256s[1]
        ]
      }
    ];
    for (const expectedArtifacts of expectedArtifactTampers) {
      expect(verifyKnowledgeSemanticHumanTrust({
        anchorSet: input.anchorSet,
        evaluatedAt: EVALUATED_AT,
        evidence: chain.evidence,
        expectedArtifacts,
        pinnedAnchorSetSha256: input.anchorSet.anchorSetSha256
      })).toMatchObject({
        artifactBindingsVerified: false,
        reasonCodes: ["artifact_binding_mismatch"],
        verified: false
      });
    }
  });

  it("requires two distinct external reviewer keys and separate adjudicator/operator authority", () => {
    const input = material();
    const duplicatedReviewerChain = assemble(input, { reviewerB: input.actors.reviewerA });
    expect(verify(input, duplicatedReviewerChain.evidence)).toMatchObject({
      reasonCodes: ["review_authorities_not_distinct"],
      verified: false
    });

    const roleEscalationChain = assemble(input, { reviewerA: input.actors.operator });
    expect(verify(input, roleEscalationChain.evidence)).toMatchObject({
      reasonCodes: ["attestation_role_mismatch"],
      verified: false
    });

    const attacker = actor("independent_reviewer", "unanchored-self-attester");
    const selfAttestedChain = assemble(input, { reviewerA: attacker });
    expect(verify(input, selfAttestedChain.evidence)).toMatchObject({
      reasonCodes: ["attestation_anchor_untrusted"],
      verified: false
    });

    const crossRolePrincipal = {
      ...input.actors.adjudicator.anchor,
      principalSha256: input.actors.reviewerA.anchor.principalSha256
    } as KnowledgeSemanticHumanTrustAnchor;
    expect(() => createKnowledgeSemanticHumanTrustAnchorSet({
      anchors: [
        input.actors.reviewerA.anchor,
        input.actors.reviewerB.anchor,
        crossRolePrincipal,
        input.actors.operator.anchor
      ],
      configuredAt: CONFIGURED_AT
    })).toThrow();

    const reviewerPayloadValue = reviewerPayload({
      anchorSet: input.anchorSet,
      expected: input.expected,
      signer: input.actors.reviewerA,
      signedAt: REVIEWER_A_AT,
      slot: "reviewer_a"
    });
    expect(knowledgeSemanticHumanTrustAttestationPayloadSchema.safeParse({
      ...reviewerPayloadValue,
      declaration: {
        ...reviewerPayloadValue.declaration,
        implementationAgent: true
      }
    }).success).toBe(false);
  });

  it("enforces anchor validity and reviewer-adjudicator-operator time ordering", () => {
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
