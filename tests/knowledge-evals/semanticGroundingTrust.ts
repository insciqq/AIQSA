import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject
} from "node:crypto";
import { z } from "zod";

export const KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION =
  "knowledge-semantic-human-trust-v1" as const;

const SIGNATURE_DOMAIN =
  `AIQSA\0${KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION}\0attestation`;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const keyIdSchema = z.string().regex(/^ed25519-sha256:[a-f0-9]{64}$/u);
const principalSha256Schema = sha256Schema;
const canonicalTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  });
const canonicalBase64urlSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => Buffer.from(value, "base64url").toString("base64url") === value);
const ed25519SignatureSchema = canonicalBase64urlSchema.refine((value) =>
  Buffer.from(value, "base64url").length === 64);

const externalReviewerAnchorSchema = z.strictObject({
  eligibility: z.literal("operator_vouched_external_human"),
  implementationParticipant: z.literal(false),
  keyId: keyIdSchema,
  notAfter: canonicalTimestampSchema,
  notBefore: canonicalTimestampSchema,
  principalSha256: principalSha256Schema,
  publicKeySpkiBase64url: canonicalBase64urlSchema,
  role: z.literal("independent_reviewer")
});

const externalAdjudicatorAnchorSchema = z.strictObject({
  eligibility: z.literal("operator_vouched_external_human"),
  implementationParticipant: z.literal(false),
  keyId: keyIdSchema,
  notAfter: canonicalTimestampSchema,
  notBefore: canonicalTimestampSchema,
  principalSha256: principalSha256Schema,
  publicKeySpkiBase64url: canonicalBase64urlSchema,
  role: z.literal("adjudicator")
});

const releaseOperatorAnchorSchema = z.strictObject({
  eligibility: z.literal("operator_controlled_release_authority"),
  implementationParticipant: z.literal(false),
  keyId: keyIdSchema,
  notAfter: canonicalTimestampSchema,
  notBefore: canonicalTimestampSchema,
  principalSha256: principalSha256Schema,
  publicKeySpkiBase64url: canonicalBase64urlSchema,
  role: z.literal("release_operator")
});

export const knowledgeSemanticHumanTrustAnchorSchema = z.discriminatedUnion("role", [
  externalReviewerAnchorSchema,
  externalAdjudicatorAnchorSchema,
  releaseOperatorAnchorSchema
]);

const trustAnchorSetBodySchema = z.strictObject({
  anchors: z.array(knowledgeSemanticHumanTrustAnchorSchema).min(4).max(64),
  artifactType: z.literal("knowledge_semantic_human_trust_anchors"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION),
  configuredAt: canonicalTimestampSchema
});

export const knowledgeSemanticHumanTrustAnchorSetSchema = trustAnchorSetBodySchema.extend({
  anchorSetSha256: sha256Schema
}).superRefine((value, context) => {
  const { anchorSetSha256, ...body } = value;
  if (canonicalSha256(body) !== anchorSetSha256) {
    context.addIssue({ code: "custom", message: "trust-anchor digest mismatch" });
  }
  const keyIds = value.anchors.map((anchor) => anchor.keyId);
  const encodedKeys = value.anchors.map((anchor) => anchor.publicKeySpkiBase64url);
  if (new Set(keyIds).size !== keyIds.length ||
    new Set(encodedKeys).size !== encodedKeys.length) {
    context.addIssue({ code: "custom", message: "duplicate trust key" });
  }
  if (keyIds.some((keyId, index) => index > 0 && keyIds[index - 1]!.localeCompare(keyId) >= 0)) {
    context.addIssue({ code: "custom", message: "trust keys are not canonically ordered" });
  }
  const principalRoles = new Map<string, string>();
  for (const anchor of value.anchors) {
    if (Date.parse(anchor.notBefore) >= Date.parse(anchor.notAfter)) {
      context.addIssue({ code: "custom", message: "invalid trust-key interval" });
    }
    const priorRole = principalRoles.get(anchor.principalSha256);
    if (priorRole && priorRole !== anchor.role) {
      context.addIssue({ code: "custom", message: "principal crosses trust roles" });
    }
    principalRoles.set(anchor.principalSha256, anchor.role);
    try {
      const publicKey = parseEd25519PublicKey(anchor.publicKeySpkiBase64url);
      const encoded = encodeKnowledgeSemanticEd25519PublicKey(publicKey);
      if (encoded !== anchor.publicKeySpkiBase64url ||
        createKnowledgeSemanticEd25519KeyId(encoded) !== anchor.keyId) {
        context.addIssue({ code: "custom", message: "trust key identity mismatch" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "invalid Ed25519 public key" });
    }
  }
  if (value.anchors.filter((anchor) => anchor.role === "independent_reviewer").length < 2 ||
    !value.anchors.some((anchor) => anchor.role === "adjudicator") ||
    !value.anchors.some((anchor) => anchor.role === "release_operator")) {
    context.addIssue({ code: "custom", message: "required trust roles are missing" });
  }
});

const reviewScopeSchema = z.strictObject({
  corpusSha256: sha256Schema,
  packetSha256: sha256Schema,
  poolSha256: sha256Schema
});

const releaseScopeSchema = reviewScopeSchema.extend({
  calibrationFreezeManifestSha256: sha256Schema,
  candidateFreezeManifestSha256: sha256Schema,
  predictionArtifactSha256: sha256Schema,
  reviewMappingSha256: sha256Schema
});

const attestationCommonShape = {
  artifactType: z.literal("knowledge_semantic_human_trust_attestation_payload"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION),
  keyId: keyIdSchema,
  principalSha256: principalSha256Schema,
  signedAt: canonicalTimestampSchema,
  trustAnchorSetSha256: sha256Schema
} as const;

const reviewerAttestationPayloadSchema = z.strictObject({
  ...attestationCommonShape,
  declaration: z.strictObject({
    implementationAgent: z.literal(false),
    modelGeneratedLabels: z.literal(false),
    provenance: z.literal("external_human"),
    reviewedIndependently: z.literal(true)
  }),
  reviewScope: reviewScopeSchema,
  reviewerSlot: z.enum(["reviewer_a", "reviewer_b"]),
  role: z.literal("independent_reviewer"),
  statement: z.literal("independent_reviewer_submission"),
  submissionSha256: sha256Schema
});

const adjudicatorAttestationPayloadSchema = z.strictObject({
  ...attestationCommonShape,
  adjudicationSha256: sha256Schema,
  declaration: z.strictObject({
    adjudicationCompleted: z.literal(true),
    implementationAgent: z.literal(false),
    provenance: z.literal("external_human"),
    unresolvedMaterialDisagreements: z.literal(0)
  }),
  reviewScope: reviewScopeSchema,
  reviewerAttestationSha256s: z.tuple([sha256Schema, sha256Schema]),
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  role: z.literal("adjudicator"),
  statement: z.literal("completed_adjudication")
});

const operatorAttestationPayloadSchema = z.strictObject({
  ...attestationCommonShape,
  adjudicationAttestationSha256: sha256Schema,
  adjudicationSha256: sha256Schema,
  authorization: z.literal("operator_reviewed_human_provenance_chain"),
  releaseScope: releaseScopeSchema,
  reviewerAttestationSha256s: z.tuple([sha256Schema, sha256Schema]),
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  role: z.literal("release_operator"),
  statement: z.literal("release_provenance_approval")
});

export const knowledgeSemanticHumanTrustAttestationPayloadSchema =
  z.discriminatedUnion("role", [
    reviewerAttestationPayloadSchema,
    adjudicatorAttestationPayloadSchema,
    operatorAttestationPayloadSchema
  ]);

export const knowledgeSemanticHumanTrustAttestationSchema = z.strictObject({
  artifactType: z.literal("knowledge_semantic_human_trust_attestation"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION),
  payload: knowledgeSemanticHumanTrustAttestationPayloadSchema,
  payloadSha256: sha256Schema,
  signature: z.strictObject({
    algorithm: z.literal("Ed25519"),
    encoding: z.literal("base64url"),
    value: ed25519SignatureSchema
  })
}).superRefine((value, context) => {
  if (canonicalSha256(value.payload) !== value.payloadSha256) {
    context.addIssue({ code: "custom", message: "attestation payload digest mismatch" });
  }
});

const trustEvidenceBodySchema = z.strictObject({
  adjudicatorAttestation: knowledgeSemanticHumanTrustAttestationSchema,
  artifactType: z.literal("knowledge_semantic_human_trust_evidence"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION),
  operatorAttestation: knowledgeSemanticHumanTrustAttestationSchema,
  reviewerAttestations: z.tuple([
    knowledgeSemanticHumanTrustAttestationSchema,
    knowledgeSemanticHumanTrustAttestationSchema
  ])
});

export const knowledgeSemanticHumanTrustEvidenceSchema = trustEvidenceBodySchema.extend({
  evidenceSha256: sha256Schema
}).superRefine((value, context) => {
  const { evidenceSha256, ...body } = value;
  if (canonicalSha256(body) !== evidenceSha256) {
    context.addIssue({ code: "custom", message: "trust-evidence digest mismatch" });
  }
});

export const knowledgeSemanticHumanTrustExpectedArtifactsSchema = releaseScopeSchema.extend({
  adjudicationSha256: sha256Schema,
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema])
}).superRefine((value, context) => {
  if (value.reviewerSubmissionSha256s[0] === value.reviewerSubmissionSha256s[1]) {
    context.addIssue({ code: "custom", message: "review submissions are not distinct" });
  }
});

export type KnowledgeSemanticHumanTrustAnchor = z.infer<
  typeof knowledgeSemanticHumanTrustAnchorSchema
>;
export type KnowledgeSemanticHumanTrustAnchorSet = z.infer<
  typeof knowledgeSemanticHumanTrustAnchorSetSchema
>;
export type KnowledgeSemanticHumanTrustAttestationPayload = z.infer<
  typeof knowledgeSemanticHumanTrustAttestationPayloadSchema
>;
export type KnowledgeSemanticHumanTrustAttestation = z.infer<
  typeof knowledgeSemanticHumanTrustAttestationSchema
>;
export type KnowledgeSemanticHumanTrustEvidence = z.infer<
  typeof knowledgeSemanticHumanTrustEvidenceSchema
>;
export type KnowledgeSemanticHumanTrustExpectedArtifacts = z.infer<
  typeof knowledgeSemanticHumanTrustExpectedArtifactsSchema
>;

export type KnowledgeSemanticHumanTrustVerificationReason =
  | "artifact_binding_mismatch"
  | "attestation_anchor_untrusted"
  | "attestation_chain_mismatch"
  | "attestation_payload_digest_invalid"
  | "attestation_principal_mismatch"
  | "attestation_role_mismatch"
  | "attestation_sequence_invalid"
  | "attestation_signature_invalid"
  | "attestation_time_invalid"
  | "expected_artifact_digests_invalid"
  | "expected_artifact_digests_not_supplied"
  | "operator_authority_not_distinct"
  | "review_authorities_not_distinct"
  | "trust_anchor_pin_invalid"
  | "trust_anchor_pin_mismatch"
  | "trust_anchor_pin_not_supplied"
  | "trust_anchor_set_invalid"
  | "trust_anchor_set_not_supplied"
  | "trusted_human_evidence_invalid"
  | "trusted_human_evidence_not_supplied"
  | "verification_time_invalid"
  | "verification_time_not_supplied";

export type KnowledgeSemanticHumanTrustVerificationReport = Readonly<{
  aggregateOnly: true;
  artifactBindingsVerified: boolean;
  blockingEvidenceEligible: boolean;
  humanProvenanceGatePassed: boolean;
  operatorApprovalVerified: boolean;
  privateContentIncluded: false;
  provenanceVerification: "operator_anchored_ed25519_verified" | "unverifiable";
  reasonCodes: readonly KnowledgeSemanticHumanTrustVerificationReason[];
  signatureCounts: Readonly<{
    adjudicators: 0 | 1;
    operators: 0 | 1;
    reviewers: 0 | 2;
  }>;
  signaturesVerified: boolean;
  verified: boolean;
  version: typeof KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("knowledge_semantic_human_trust_value_invalid");
  return encoded;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (record(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}

function parseEd25519PublicKey(encoded: string): KeyObject {
  const der = Buffer.from(encoded, "base64url");
  if (der.toString("base64url") !== encoded) {
    throw new Error("knowledge_semantic_human_trust_public_key_encoding_invalid");
  }
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("knowledge_semantic_human_trust_public_key_invalid");
  }
  const canonicalDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(der)) {
    throw new Error("knowledge_semantic_human_trust_public_key_noncanonical");
  }
  return publicKey;
}

export function encodeKnowledgeSemanticEd25519PublicKey(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("knowledge_semantic_human_trust_public_key_invalid");
  }
  const encoded = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(encoded)) {
    throw new Error("knowledge_semantic_human_trust_public_key_invalid");
  }
  return encoded.toString("base64url");
}

export function createKnowledgeSemanticEd25519KeyId(
  publicKeySpkiBase64url: string
): string {
  const publicKey = parseEd25519PublicKey(publicKeySpkiBase64url);
  const canonicalKey = encodeKnowledgeSemanticEd25519PublicKey(publicKey);
  return `ed25519-sha256:${createHash("sha256")
    .update(Buffer.from(canonicalKey, "base64url")).digest("hex")}`;
}

export function createKnowledgeSemanticHumanTrustAnchorSet(input: Readonly<{
  anchors: readonly KnowledgeSemanticHumanTrustAnchor[];
  configuredAt: string;
}>): KnowledgeSemanticHumanTrustAnchorSet {
  const body = trustAnchorSetBodySchema.parse({
    anchors: [...input.anchors].sort((left, right) => left.keyId.localeCompare(right.keyId)),
    artifactType: "knowledge_semantic_human_trust_anchors",
    artifactVersion: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
    configuredAt: input.configuredAt
  });
  return deepFreeze(knowledgeSemanticHumanTrustAnchorSetSchema.parse({
    ...body,
    anchorSetSha256: canonicalSha256(body)
  }));
}

export function knowledgeSemanticHumanTrustPayloadSha256(payload: unknown): string {
  return canonicalSha256(knowledgeSemanticHumanTrustAttestationPayloadSchema.parse(payload));
}

function signatureBody(payload: KnowledgeSemanticHumanTrustAttestationPayload): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}\0${canonicalJson(payload)}`, "utf8");
}

export function createKnowledgeSemanticHumanTrustAttestation(input: Readonly<{
  payload: KnowledgeSemanticHumanTrustAttestationPayload;
  privateKey: KeyObject;
}>): KnowledgeSemanticHumanTrustAttestation {
  const payload = knowledgeSemanticHumanTrustAttestationPayloadSchema.parse(input.payload);
  if (input.privateKey.type !== "private" ||
    input.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("knowledge_semantic_human_trust_private_key_invalid");
  }
  const publicKey = createPublicKey(input.privateKey);
  const derivedKeyId = createKnowledgeSemanticEd25519KeyId(
    encodeKnowledgeSemanticEd25519PublicKey(publicKey)
  );
  if (derivedKeyId !== payload.keyId) {
    throw new Error("knowledge_semantic_human_trust_signing_key_mismatch");
  }
  const attestation = knowledgeSemanticHumanTrustAttestationSchema.parse({
    artifactType: "knowledge_semantic_human_trust_attestation",
    artifactVersion: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
    payload,
    payloadSha256: canonicalSha256(payload),
    signature: {
      algorithm: "Ed25519",
      encoding: "base64url",
      value: signBytes(null, signatureBody(payload), input.privateKey).toString("base64url")
    }
  });
  return deepFreeze(attestation);
}

export function knowledgeSemanticHumanTrustAttestationSha256(attestation: unknown): string {
  return canonicalSha256(knowledgeSemanticHumanTrustAttestationSchema.parse(attestation));
}

export function createKnowledgeSemanticHumanTrustEvidence(input: Readonly<{
  adjudicatorAttestation: KnowledgeSemanticHumanTrustAttestation;
  operatorAttestation: KnowledgeSemanticHumanTrustAttestation;
  reviewerAttestations: readonly [
    KnowledgeSemanticHumanTrustAttestation,
    KnowledgeSemanticHumanTrustAttestation
  ];
}>): KnowledgeSemanticHumanTrustEvidence {
  const body = trustEvidenceBodySchema.parse({
    adjudicatorAttestation: input.adjudicatorAttestation,
    artifactType: "knowledge_semantic_human_trust_evidence",
    artifactVersion: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION,
    operatorAttestation: input.operatorAttestation,
    reviewerAttestations: [...input.reviewerAttestations]
  });
  return deepFreeze(knowledgeSemanticHumanTrustEvidenceSchema.parse({
    ...body,
    evidenceSha256: canonicalSha256(body)
  }));
}

function unverifiedReport(
  reasonCodes: readonly KnowledgeSemanticHumanTrustVerificationReason[]
): KnowledgeSemanticHumanTrustVerificationReport {
  return deepFreeze({
    aggregateOnly: true,
    artifactBindingsVerified: false,
    blockingEvidenceEligible: false,
    humanProvenanceGatePassed: false,
    operatorApprovalVerified: false,
    privateContentIncluded: false,
    provenanceVerification: "unverifiable",
    reasonCodes: [...new Set(reasonCodes)],
    signatureCounts: { adjudicators: 0, operators: 0, reviewers: 0 },
    signaturesVerified: false,
    verified: false,
    version: KNOWLEDGE_SEMANTIC_HUMAN_TRUST_VERSION
  });
}

function verifiedReport(): KnowledgeSemanticHumanTrustVerificationReport {
  return deepFreeze({
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
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function selectedAnchor(
  anchorSet: KnowledgeSemanticHumanTrustAnchorSet,
  attestation: KnowledgeSemanticHumanTrustAttestation
): KnowledgeSemanticHumanTrustAnchor | undefined {
  return anchorSet.anchors.find((anchor) => anchor.keyId === attestation.payload.keyId);
}

function verifyAttestation(input: Readonly<{
  anchor: KnowledgeSemanticHumanTrustAnchor | undefined;
  anchorSet: KnowledgeSemanticHumanTrustAnchorSet;
  attestation: KnowledgeSemanticHumanTrustAttestation;
  evaluatedAt: string;
}>): KnowledgeSemanticHumanTrustVerificationReason | null {
  const { anchor, anchorSet, attestation } = input;
  if (!anchor) return "attestation_anchor_untrusted";
  if (anchor.role !== attestation.payload.role) return "attestation_role_mismatch";
  if (anchor.principalSha256 !== attestation.payload.principalSha256) {
    return "attestation_principal_mismatch";
  }
  if (attestation.payload.trustAnchorSetSha256 !== anchorSet.anchorSetSha256) {
    return "attestation_chain_mismatch";
  }
  const signedAt = Date.parse(attestation.payload.signedAt);
  if (signedAt < Date.parse(anchor.notBefore) || signedAt >= Date.parse(anchor.notAfter) ||
    signedAt < Date.parse(anchorSet.configuredAt) || signedAt > Date.parse(input.evaluatedAt)) {
    return "attestation_time_invalid";
  }
  if (canonicalSha256(attestation.payload) !== attestation.payloadSha256) {
    return "attestation_payload_digest_invalid";
  }
  const publicKey = parseEd25519PublicKey(anchor.publicKeySpkiBase64url);
  const signature = Buffer.from(attestation.signature.value, "base64url");
  if (!verifyBytes(null, signatureBody(attestation.payload), publicKey, signature)) {
    return "attestation_signature_invalid";
  }
  return null;
}

function expectedReviewScope(
  expected: KnowledgeSemanticHumanTrustExpectedArtifacts
): z.infer<typeof reviewScopeSchema> {
  return {
    corpusSha256: expected.corpusSha256,
    packetSha256: expected.packetSha256,
    poolSha256: expected.poolSha256
  };
}

function expectedReleaseScope(
  expected: KnowledgeSemanticHumanTrustExpectedArtifacts
): z.infer<typeof releaseScopeSchema> {
  return {
    ...expectedReviewScope(expected),
    calibrationFreezeManifestSha256: expected.calibrationFreezeManifestSha256,
    candidateFreezeManifestSha256: expected.candidateFreezeManifestSha256,
    predictionArtifactSha256: expected.predictionArtifactSha256,
    reviewMappingSha256: expected.reviewMappingSha256
  };
}

/**
 * Verifies only trusted-human provenance. A green result is eligible input to
 * the semantic release gate; it is not, by itself, a quality or release pass.
 * No identities, key ids, signatures, timestamps, labels, or artifact digests
 * are projected into the returned aggregate report.
 */
export function verifyKnowledgeSemanticHumanTrust(input: Readonly<{
  anchorSet?: unknown;
  evaluatedAt?: unknown;
  evidence?: unknown;
  expectedArtifacts?: unknown;
  pinnedAnchorSetSha256?: unknown;
}> = {}): KnowledgeSemanticHumanTrustVerificationReport {
  const missing: KnowledgeSemanticHumanTrustVerificationReason[] = [];
  if (input.anchorSet === undefined) missing.push("trust_anchor_set_not_supplied");
  if (input.pinnedAnchorSetSha256 === undefined) {
    missing.push("trust_anchor_pin_not_supplied");
  }
  if (input.evidence === undefined) missing.push("trusted_human_evidence_not_supplied");
  if (input.expectedArtifacts === undefined) {
    missing.push("expected_artifact_digests_not_supplied");
  }
  if (input.evaluatedAt === undefined) missing.push("verification_time_not_supplied");
  if (missing.length > 0) return unverifiedReport(missing);

  const parsedPin = sha256Schema.safeParse(input.pinnedAnchorSetSha256);
  if (!parsedPin.success) return unverifiedReport(["trust_anchor_pin_invalid"]);
  const parsedAnchorSet = knowledgeSemanticHumanTrustAnchorSetSchema.safeParse(input.anchorSet);
  if (!parsedAnchorSet.success) return unverifiedReport(["trust_anchor_set_invalid"]);
  const { anchorSetSha256: _anchorSetSha256, ...anchorSetBody } = parsedAnchorSet.data;
  if (canonicalSha256(anchorSetBody) !== parsedAnchorSet.data.anchorSetSha256) {
    return unverifiedReport(["trust_anchor_set_invalid"]);
  }
  if (parsedAnchorSet.data.anchorSetSha256 !== parsedPin.data) {
    return unverifiedReport(["trust_anchor_pin_mismatch"]);
  }
  const parsedEvidence = knowledgeSemanticHumanTrustEvidenceSchema.safeParse(input.evidence);
  if (!parsedEvidence.success) return unverifiedReport(["trusted_human_evidence_invalid"]);
  const { evidenceSha256: _evidenceSha256, ...evidenceBody } = parsedEvidence.data;
  if (canonicalSha256(evidenceBody) !== parsedEvidence.data.evidenceSha256) {
    return unverifiedReport(["trusted_human_evidence_invalid"]);
  }
  const parsedExpected = knowledgeSemanticHumanTrustExpectedArtifactsSchema.safeParse(
    input.expectedArtifacts
  );
  if (!parsedExpected.success) {
    return unverifiedReport(["expected_artifact_digests_invalid"]);
  }
  const parsedEvaluatedAt = canonicalTimestampSchema.safeParse(input.evaluatedAt);
  if (!parsedEvaluatedAt.success ||
    Date.parse(parsedEvaluatedAt.data) < Date.parse(parsedAnchorSet.data.configuredAt)) {
    return unverifiedReport(["verification_time_invalid"]);
  }

  const evidence = parsedEvidence.data;
  const attestations = [
    ...evidence.reviewerAttestations,
    evidence.adjudicatorAttestation,
    evidence.operatorAttestation
  ];
  for (const attestation of attestations) {
    const failure = verifyAttestation({
      anchor: selectedAnchor(parsedAnchorSet.data, attestation),
      anchorSet: parsedAnchorSet.data,
      attestation,
      evaluatedAt: parsedEvaluatedAt.data
    });
    if (failure) return unverifiedReport([failure]);
  }

  const [reviewerA, reviewerB] = evidence.reviewerAttestations;
  const adjudicator = evidence.adjudicatorAttestation;
  const operator = evidence.operatorAttestation;
  if (reviewerA.payload.role !== "independent_reviewer" ||
    reviewerB.payload.role !== "independent_reviewer" ||
    reviewerA.payload.reviewerSlot !== "reviewer_a" ||
    reviewerB.payload.reviewerSlot !== "reviewer_b" ||
    adjudicator.payload.role !== "adjudicator" || operator.payload.role !== "release_operator") {
    return unverifiedReport(["attestation_role_mismatch"]);
  }
  const keyIds = attestations.map((attestation) => attestation.payload.keyId);
  const principals = attestations.map((attestation) => attestation.payload.principalSha256);
  if (new Set(keyIds.slice(0, 2)).size !== 2 ||
    new Set(principals.slice(0, 2)).size !== 2) {
    return unverifiedReport(["review_authorities_not_distinct"]);
  }
  if (new Set(keyIds).size !== 4 || new Set(principals).size !== 4) {
    return unverifiedReport(["operator_authority_not_distinct"]);
  }
  const reviewerTimes = [reviewerA, reviewerB].map((attestation) =>
    Date.parse(attestation.payload.signedAt));
  const adjudicationTime = Date.parse(adjudicator.payload.signedAt);
  const operatorTime = Date.parse(operator.payload.signedAt);
  if (reviewerTimes.some((time) => time > adjudicationTime) ||
    adjudicationTime > operatorTime) {
    return unverifiedReport(["attestation_sequence_invalid"]);
  }

  const expected = parsedExpected.data;
  const reviewScope = expectedReviewScope(expected);
  const releaseScope = expectedReleaseScope(expected);
  if (!sameCanonical(reviewerA.payload.reviewScope, reviewScope) ||
    !sameCanonical(reviewerB.payload.reviewScope, reviewScope) ||
    reviewerA.payload.submissionSha256 !== expected.reviewerSubmissionSha256s[0] ||
    reviewerB.payload.submissionSha256 !== expected.reviewerSubmissionSha256s[1] ||
    !sameCanonical(adjudicator.payload.reviewScope, reviewScope) ||
    adjudicator.payload.adjudicationSha256 !== expected.adjudicationSha256 ||
    !sameCanonical(
      adjudicator.payload.reviewerSubmissionSha256s,
      expected.reviewerSubmissionSha256s
    ) || !sameCanonical(operator.payload.releaseScope, releaseScope) ||
    operator.payload.adjudicationSha256 !== expected.adjudicationSha256 ||
    !sameCanonical(operator.payload.reviewerSubmissionSha256s,
      expected.reviewerSubmissionSha256s)) {
    return unverifiedReport(["artifact_binding_mismatch"]);
  }

  const reviewerAttestationSha256s = [
    knowledgeSemanticHumanTrustAttestationSha256(reviewerA),
    knowledgeSemanticHumanTrustAttestationSha256(reviewerB)
  ] as const;
  const adjudicationAttestationSha256 =
    knowledgeSemanticHumanTrustAttestationSha256(adjudicator);
  if (!sameCanonical(
    adjudicator.payload.reviewerAttestationSha256s,
    reviewerAttestationSha256s
  ) || !sameCanonical(operator.payload.reviewerAttestationSha256s,
    reviewerAttestationSha256s) ||
    operator.payload.adjudicationAttestationSha256 !== adjudicationAttestationSha256) {
    return unverifiedReport(["attestation_chain_mismatch"]);
  }
  return verifiedReport();
}
