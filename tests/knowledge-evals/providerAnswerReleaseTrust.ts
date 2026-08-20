import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject
} from "node:crypto";
import { z } from "zod";
import * as providerAnswerPersistedRoute from "./providerAnswerPersistedRoute";
import type {
  ValidatedProviderAnswerPersistedRoutePromotion
} from "./providerAnswerPersistedRoute";

export const KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION =
  "knowledge-provider-answer-release-trust-v1" as const;

const SIGNATURE_DOMAIN =
  `AIQSA\0${KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION}\0attestation`;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const keyIdSchema = z.string().regex(/^ed25519-sha256:[a-f0-9]{64}$/u);
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

const externalHumanAnchorShape = {
  eligibility: z.literal("operator_vouched_external_human"),
  implementationParticipant: z.literal(false),
  keyId: keyIdSchema,
  notAfter: canonicalTimestampSchema,
  notBefore: canonicalTimestampSchema,
  principalSha256: sha256Schema,
  publicKeySpkiBase64url: canonicalBase64urlSchema,
  vouchedByKeyId: keyIdSchema,
  vouchedByPrincipalSha256: sha256Schema
} as const;

const independentReviewerAnchorSchema = z.strictObject({
  ...externalHumanAnchorShape,
  role: z.literal("independent_reviewer")
});

const adjudicatorAnchorSchema = z.strictObject({
  ...externalHumanAnchorShape,
  role: z.literal("adjudicator")
});

const releaseOperatorAnchorSchema = z.strictObject({
  eligibility: z.literal("operator_controlled_release_authority"),
  implementationParticipant: z.literal(false),
  keyId: keyIdSchema,
  notAfter: canonicalTimestampSchema,
  notBefore: canonicalTimestampSchema,
  principalSha256: sha256Schema,
  publicKeySpkiBase64url: canonicalBase64urlSchema,
  role: z.literal("release_operator")
});

export const providerAnswerReleaseTrustAnchorSchema = z.discriminatedUnion("role", [
  independentReviewerAnchorSchema,
  adjudicatorAnchorSchema,
  releaseOperatorAnchorSchema
]);

const trustAnchorSetBodySchema = z.strictObject({
  anchors: z.array(providerAnswerReleaseTrustAnchorSchema).min(4).max(64),
  artifactType: z.literal("knowledge_provider_answer_release_trust_anchors"),
  artifactVersion: z.literal(KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION),
  configuredAt: canonicalTimestampSchema
});

export const providerAnswerReleaseTrustAnchorSetSchema = trustAnchorSetBodySchema.extend({
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
  if (keyIds.some((keyId, index) =>
    index > 0 && keyIds[index - 1]!.localeCompare(keyId) >= 0)) {
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
      const encoded = encodeProviderAnswerReleaseEd25519PublicKey(publicKey);
      if (encoded !== anchor.publicKeySpkiBase64url ||
        createProviderAnswerReleaseEd25519KeyId(encoded) !== anchor.keyId) {
        context.addIssue({ code: "custom", message: "trust key identity mismatch" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "invalid Ed25519 public key" });
    }
  }

  const operators = value.anchors.filter((anchor) => anchor.role === "release_operator");
  if (value.anchors.filter((anchor) => anchor.role === "independent_reviewer").length < 2 ||
    !value.anchors.some((anchor) => anchor.role === "adjudicator") ||
    operators.length < 1) {
    context.addIssue({ code: "custom", message: "required trust roles are missing" });
  }
  for (const anchor of value.anchors) {
    if (anchor.role === "release_operator") continue;
    if (anchor.vouchedByKeyId === anchor.keyId ||
      anchor.vouchedByPrincipalSha256 === anchor.principalSha256) {
      context.addIssue({ code: "custom", message: "self-vouched trust root" });
      continue;
    }
    const voucher = operators.find((operator) =>
      operator.keyId === anchor.vouchedByKeyId &&
      operator.principalSha256 === anchor.vouchedByPrincipalSha256);
    if (!voucher) {
      context.addIssue({ code: "custom", message: "human root lacks operator voucher" });
    }
  }
});

const reviewScopeSchema = z.strictObject({
  mappingSha256: sha256Schema,
  outputFreezeSha256: sha256Schema,
  packetSha256: sha256Schema
});

const releaseScopeSchema = reviewScopeSchema.extend({
  persistedRoutePromotionReceiptSha256: sha256Schema
});

const attestationCommonShape = {
  artifactType: z.literal("knowledge_provider_answer_release_trust_attestation_payload"),
  artifactVersion: z.literal(KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION),
  keyId: keyIdSchema,
  principalSha256: sha256Schema,
  signedAt: canonicalTimestampSchema,
  trustAnchorSetSha256: sha256Schema
} as const;

const reviewerAttestationPayloadSchema = z.strictObject({
  ...attestationCommonShape,
  declaration: z.strictObject({
    implementationAgent: z.literal(false),
    modelGeneratedDecisions: z.literal(false),
    provenance: z.literal("external_human"),
    reviewedIndependently: z.literal(true)
  }),
  reviewScope: reviewScopeSchema,
  reviewerSlot: z.enum(["reviewer_a", "reviewer_b"]),
  reviewerSubmissionSha256: sha256Schema,
  role: z.literal("independent_reviewer"),
  statement: z.literal("independent_provider_answer_release_review")
});

const adjudicatorAttestationPayloadSchema = z.strictObject({
  ...attestationCommonShape,
  adjudicationSha256: sha256Schema,
  declaration: z.strictObject({
    adjudicationCompleted: z.literal(true),
    implementationAgent: z.literal(false),
    modelGeneratedDecisions: z.literal(false),
    provenance: z.literal("external_human"),
    unresolvedMaterialDisagreements: z.literal(0)
  }),
  reviewScope: reviewScopeSchema,
  reviewerAttestationSha256s: z.tuple([sha256Schema, sha256Schema]),
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  role: z.literal("adjudicator"),
  statement: z.literal("completed_provider_answer_release_adjudication")
});

const operatorAttestationPayloadSchema = z.strictObject({
  ...attestationCommonShape,
  adjudicationAttestationSha256: sha256Schema,
  adjudicationSha256: sha256Schema,
  authorization: z.literal("operator_reviewed_provider_answer_release_trust_chain"),
  releaseScope: releaseScopeSchema,
  reviewerAttestationSha256s: z.tuple([sha256Schema, sha256Schema]),
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  role: z.literal("release_operator"),
  statement: z.literal("provider_answer_release_provenance_approval")
});

export const providerAnswerReleaseTrustAttestationPayloadSchema =
  z.discriminatedUnion("role", [
    reviewerAttestationPayloadSchema,
    adjudicatorAttestationPayloadSchema,
    operatorAttestationPayloadSchema
  ]);

export const providerAnswerReleaseTrustAttestationSchema = z.strictObject({
  artifactType: z.literal("knowledge_provider_answer_release_trust_attestation"),
  artifactVersion: z.literal(KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION),
  payload: providerAnswerReleaseTrustAttestationPayloadSchema,
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
  adjudicatorAttestation: providerAnswerReleaseTrustAttestationSchema,
  artifactType: z.literal("knowledge_provider_answer_release_trust_evidence"),
  artifactVersion: z.literal(KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION),
  operatorAttestation: providerAnswerReleaseTrustAttestationSchema,
  reviewerAttestations: z.tuple([
    providerAnswerReleaseTrustAttestationSchema,
    providerAnswerReleaseTrustAttestationSchema
  ])
});

export const providerAnswerReleaseTrustEvidenceSchema = trustEvidenceBodySchema.extend({
  evidenceSha256: sha256Schema
}).superRefine((value, context) => {
  const { evidenceSha256, ...body } = value;
  if (canonicalSha256(body) !== evidenceSha256) {
    context.addIssue({ code: "custom", message: "trust-evidence digest mismatch" });
  }
});

export const providerAnswerReleaseTrustExpectedArtifactsSchema = releaseScopeSchema.extend({
  adjudicationSha256: sha256Schema,
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema])
}).superRefine((value, context) => {
  if (value.reviewerSubmissionSha256s[0] === value.reviewerSubmissionSha256s[1]) {
    context.addIssue({ code: "custom", message: "review submissions are not distinct" });
  }
  const roleBoundDigests = [
    value.adjudicationSha256,
    value.mappingSha256,
    value.outputFreezeSha256,
    value.packetSha256,
    value.persistedRoutePromotionReceiptSha256,
    ...value.reviewerSubmissionSha256s
  ];
  if (new Set(roleBoundDigests).size !== roleBoundDigests.length) {
    context.addIssue({ code: "custom", message: "artifact digest crosses binding roles" });
  }
});

export type ProviderAnswerReleaseTrustAnchor = z.infer<
  typeof providerAnswerReleaseTrustAnchorSchema
>;
export type ProviderAnswerReleaseTrustAnchorSet = z.infer<
  typeof providerAnswerReleaseTrustAnchorSetSchema
>;
export type ProviderAnswerReleaseTrustAttestationPayload = z.infer<
  typeof providerAnswerReleaseTrustAttestationPayloadSchema
>;
export type ProviderAnswerReleaseTrustAttestation = z.infer<
  typeof providerAnswerReleaseTrustAttestationSchema
>;
export type ProviderAnswerReleaseTrustEvidence = z.infer<
  typeof providerAnswerReleaseTrustEvidenceSchema
>;
export type ProviderAnswerReleaseTrustExpectedArtifacts = z.infer<
  typeof providerAnswerReleaseTrustExpectedArtifactsSchema
>;

export type ProviderAnswerReleaseTrustVerificationReason =
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
  | "human_anchor_voucher_mismatch"
  | "operator_authority_not_distinct"
  | "persisted_route_promotion_invalid"
  | "persisted_route_promotion_not_supplied"
  | "review_authorities_not_distinct"
  | "trust_anchor_pin_invalid"
  | "trust_anchor_pin_mismatch"
  | "trust_anchor_pin_not_supplied"
  | "trust_anchor_set_invalid"
  | "trust_anchor_set_not_supplied"
  | "trusted_review_evidence_invalid"
  | "trusted_review_evidence_not_supplied"
  | "verification_time_invalid"
  | "verification_time_not_supplied";

export type ProviderAnswerReleaseTrustVerificationReport = Readonly<{
  aggregateOnly: true;
  artifactBindingsVerified: boolean;
  fullProductionReleaseEligible: false;
  humanProvenanceGatePassed: boolean;
  operatorApprovalVerified: boolean;
  persistedRoutePromotionBindingVerified: boolean;
  privateContentIncluded: false;
  provenanceVerification: "operator_anchored_ed25519_verified" | "unverifiable";
  reasonCodes: readonly ProviderAnswerReleaseTrustVerificationReason[];
  signatureCounts: Readonly<{
    adjudicators: 0 | 1;
    operators: 0 | 1;
    reviewers: 0 | 2;
  }>;
  signaturesVerified: boolean;
  trustedReviewEvidenceEligible: boolean;
  verified: boolean;
  version: typeof KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION;
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
  if (encoded === undefined) {
    throw new Error("knowledge_provider_answer_release_trust_value_invalid");
  }
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
    throw new Error("knowledge_provider_answer_release_trust_public_key_encoding_invalid");
  }
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("knowledge_provider_answer_release_trust_public_key_invalid");
  }
  const canonicalDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(der)) {
    throw new Error("knowledge_provider_answer_release_trust_public_key_noncanonical");
  }
  return publicKey;
}

export function encodeProviderAnswerReleaseEd25519PublicKey(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("knowledge_provider_answer_release_trust_public_key_invalid");
  }
  const encoded = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(encoded)) {
    throw new Error("knowledge_provider_answer_release_trust_public_key_invalid");
  }
  return encoded.toString("base64url");
}

export function createProviderAnswerReleaseEd25519KeyId(
  publicKeySpkiBase64url: string
): string {
  const publicKey = parseEd25519PublicKey(publicKeySpkiBase64url);
  const canonicalKey = encodeProviderAnswerReleaseEd25519PublicKey(publicKey);
  return `ed25519-sha256:${createHash("sha256")
    .update(Buffer.from(canonicalKey, "base64url")).digest("hex")}`;
}

export function createProviderAnswerReleaseTrustAnchorSet(input: Readonly<{
  anchors: readonly ProviderAnswerReleaseTrustAnchor[];
  configuredAt: string;
}>): ProviderAnswerReleaseTrustAnchorSet {
  const body = trustAnchorSetBodySchema.parse({
    anchors: [...input.anchors].sort((left, right) => left.keyId.localeCompare(right.keyId)),
    artifactType: "knowledge_provider_answer_release_trust_anchors",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
    configuredAt: input.configuredAt
  });
  return deepFreeze(providerAnswerReleaseTrustAnchorSetSchema.parse({
    ...body,
    anchorSetSha256: canonicalSha256(body)
  }));
}

export function providerAnswerReleaseTrustPayloadSha256(payload: unknown): string {
  return canonicalSha256(providerAnswerReleaseTrustAttestationPayloadSchema.parse(payload));
}

function signatureBody(payload: ProviderAnswerReleaseTrustAttestationPayload): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}\0${canonicalJson(payload)}`, "utf8");
}

export function createProviderAnswerReleaseTrustAttestation(input: Readonly<{
  payload: ProviderAnswerReleaseTrustAttestationPayload;
  privateKey: KeyObject;
}>): ProviderAnswerReleaseTrustAttestation {
  const payload = providerAnswerReleaseTrustAttestationPayloadSchema.parse(input.payload);
  if (input.privateKey.type !== "private" ||
    input.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("knowledge_provider_answer_release_trust_private_key_invalid");
  }
  const publicKey = createPublicKey(input.privateKey);
  const derivedKeyId = createProviderAnswerReleaseEd25519KeyId(
    encodeProviderAnswerReleaseEd25519PublicKey(publicKey)
  );
  if (derivedKeyId !== payload.keyId) {
    throw new Error("knowledge_provider_answer_release_trust_signing_key_mismatch");
  }
  const attestation = providerAnswerReleaseTrustAttestationSchema.parse({
    artifactType: "knowledge_provider_answer_release_trust_attestation",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
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

export function providerAnswerReleaseTrustAttestationSha256(attestation: unknown): string {
  return canonicalSha256(providerAnswerReleaseTrustAttestationSchema.parse(attestation));
}

export function createProviderAnswerReleaseTrustEvidence(input: Readonly<{
  adjudicatorAttestation: ProviderAnswerReleaseTrustAttestation;
  operatorAttestation: ProviderAnswerReleaseTrustAttestation;
  reviewerAttestations: readonly [
    ProviderAnswerReleaseTrustAttestation,
    ProviderAnswerReleaseTrustAttestation
  ];
}>): ProviderAnswerReleaseTrustEvidence {
  const body = trustEvidenceBodySchema.parse({
    adjudicatorAttestation: input.adjudicatorAttestation,
    artifactType: "knowledge_provider_answer_release_trust_evidence",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION,
    operatorAttestation: input.operatorAttestation,
    reviewerAttestations: [...input.reviewerAttestations]
  });
  return deepFreeze(providerAnswerReleaseTrustEvidenceSchema.parse({
    ...body,
    evidenceSha256: canonicalSha256(body)
  }));
}

function unverifiedReport(
  reasonCodes: readonly ProviderAnswerReleaseTrustVerificationReason[]
): ProviderAnswerReleaseTrustVerificationReport {
  return deepFreeze({
    aggregateOnly: true,
    artifactBindingsVerified: false,
    fullProductionReleaseEligible: false,
    humanProvenanceGatePassed: false,
    operatorApprovalVerified: false,
    persistedRoutePromotionBindingVerified: false,
    privateContentIncluded: false,
    provenanceVerification: "unverifiable",
    reasonCodes: [...new Set(reasonCodes)],
    signatureCounts: { adjudicators: 0, operators: 0, reviewers: 0 },
    signaturesVerified: false,
    trustedReviewEvidenceEligible: false,
    verified: false,
    version: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_TRUST_VERSION
  });
}

function verifiedReport(): ProviderAnswerReleaseTrustVerificationReport {
  return deepFreeze({
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
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function selectedAnchor(
  anchorSet: ProviderAnswerReleaseTrustAnchorSet,
  attestation: ProviderAnswerReleaseTrustAttestation
): ProviderAnswerReleaseTrustAnchor | undefined {
  return anchorSet.anchors.find((anchor) => anchor.keyId === attestation.payload.keyId);
}

function verifyAttestation(input: Readonly<{
  anchor: ProviderAnswerReleaseTrustAnchor | undefined;
  anchorSet: ProviderAnswerReleaseTrustAnchorSet;
  attestation: ProviderAnswerReleaseTrustAttestation;
  evaluatedAt: string;
}>): ProviderAnswerReleaseTrustVerificationReason | null {
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
  expected: ProviderAnswerReleaseTrustExpectedArtifacts
): z.infer<typeof reviewScopeSchema> {
  return {
    mappingSha256: expected.mappingSha256,
    outputFreezeSha256: expected.outputFreezeSha256,
    packetSha256: expected.packetSha256
  };
}

function expectedReleaseScope(
  expected: ProviderAnswerReleaseTrustExpectedArtifacts
): z.infer<typeof releaseScopeSchema> {
  return {
    ...expectedReviewScope(expected),
    persistedRoutePromotionReceiptSha256: expected.persistedRoutePromotionReceiptSha256
  };
}

/**
 * Verifies only the provenance and exact artifact binding of an externally
 * completed provider-answer release review. A green result is eligible input
 * to the output-review gate; it is never a standalone production-release pass.
 * The persisted-route digest must come from the live capability minted only
 * after the production persistence, grounding, and viewer route completes;
 * a caller-supplied digest or disk audit sidecar is never execution authority.
 * The returned report contains no identities, keys, signatures, timestamps,
 * review decisions, or artifact digests.
 */
export function verifyProviderAnswerReleaseTrust(input: Readonly<{
  anchorSet?: unknown;
  evaluatedAt?: unknown;
  evidence?: unknown;
  expectedArtifacts?: unknown;
  persistedRoutePromotion?: ValidatedProviderAnswerPersistedRoutePromotion;
  pinnedAnchorSetSha256?: unknown;
}> = {}): ProviderAnswerReleaseTrustVerificationReport {
  const missing: ProviderAnswerReleaseTrustVerificationReason[] = [];
  if (input.anchorSet === undefined) missing.push("trust_anchor_set_not_supplied");
  if (input.pinnedAnchorSetSha256 === undefined) {
    missing.push("trust_anchor_pin_not_supplied");
  }
  if (input.evidence === undefined) missing.push("trusted_review_evidence_not_supplied");
  if (input.expectedArtifacts === undefined) {
    missing.push("expected_artifact_digests_not_supplied");
  }
  if (input.persistedRoutePromotion === undefined) {
    missing.push("persisted_route_promotion_not_supplied");
  }
  if (input.evaluatedAt === undefined) missing.push("verification_time_not_supplied");
  if (missing.length > 0) return unverifiedReport(missing);

  const parsedPin = sha256Schema.safeParse(input.pinnedAnchorSetSha256);
  if (!parsedPin.success) return unverifiedReport(["trust_anchor_pin_invalid"]);
  const parsedAnchorSet = providerAnswerReleaseTrustAnchorSetSchema.safeParse(input.anchorSet);
  if (!parsedAnchorSet.success) return unverifiedReport(["trust_anchor_set_invalid"]);
  const { anchorSetSha256: _anchorSetSha256, ...anchorSetBody } = parsedAnchorSet.data;
  if (canonicalSha256(anchorSetBody) !== parsedAnchorSet.data.anchorSetSha256) {
    return unverifiedReport(["trust_anchor_set_invalid"]);
  }
  if (parsedAnchorSet.data.anchorSetSha256 !== parsedPin.data) {
    return unverifiedReport(["trust_anchor_pin_mismatch"]);
  }
  const parsedEvidence = providerAnswerReleaseTrustEvidenceSchema.safeParse(input.evidence);
  if (!parsedEvidence.success) return unverifiedReport(["trusted_review_evidence_invalid"]);
  const { evidenceSha256: _evidenceSha256, ...evidenceBody } = parsedEvidence.data;
  if (canonicalSha256(evidenceBody) !== parsedEvidence.data.evidenceSha256) {
    return unverifiedReport(["trusted_review_evidence_invalid"]);
  }
  const parsedExpected = providerAnswerReleaseTrustExpectedArtifactsSchema.safeParse(
    input.expectedArtifacts
  );
  if (!parsedExpected.success) {
    return unverifiedReport(["expected_artifact_digests_invalid"]);
  }
  let persistedRouteBinding:
    providerAnswerPersistedRoute.ValidatedProviderAnswerPersistedRouteBinding;
  try {
    persistedRouteBinding =
      providerAnswerPersistedRoute.validatedProviderAnswerPersistedRouteBinding(
        input.persistedRoutePromotion
      );
  } catch {
    return unverifiedReport(["persisted_route_promotion_invalid"]);
  }
  if (persistedRouteBinding.receiptSha256 !==
      parsedExpected.data.persistedRoutePromotionReceiptSha256 ||
    persistedRouteBinding.mappingSha256 !== parsedExpected.data.mappingSha256 ||
    persistedRouteBinding.outputFreezeSha256 !==
      parsedExpected.data.outputFreezeSha256 ||
    persistedRouteBinding.packetSha256 !== parsedExpected.data.packetSha256) {
    return unverifiedReport(["artifact_binding_mismatch"]);
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
    adjudicator.payload.role !== "adjudicator" ||
    operator.payload.role !== "release_operator") {
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
  for (const humanAttestation of [reviewerA, reviewerB, adjudicator]) {
    const humanAnchor = selectedAnchor(parsedAnchorSet.data, humanAttestation);
    if (!humanAnchor || humanAnchor.role === "release_operator" ||
      humanAnchor.vouchedByKeyId !== operator.payload.keyId ||
      humanAnchor.vouchedByPrincipalSha256 !== operator.payload.principalSha256) {
      return unverifiedReport(["human_anchor_voucher_mismatch"]);
    }
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
    reviewerA.payload.reviewerSubmissionSha256 !== expected.reviewerSubmissionSha256s[0] ||
    reviewerB.payload.reviewerSubmissionSha256 !== expected.reviewerSubmissionSha256s[1] ||
    !sameCanonical(adjudicator.payload.reviewScope, reviewScope) ||
    adjudicator.payload.adjudicationSha256 !== expected.adjudicationSha256 ||
    !sameCanonical(adjudicator.payload.reviewerSubmissionSha256s,
      expected.reviewerSubmissionSha256s) ||
    !sameCanonical(operator.payload.releaseScope, releaseScope) ||
    operator.payload.adjudicationSha256 !== expected.adjudicationSha256 ||
    !sameCanonical(operator.payload.reviewerSubmissionSha256s,
      expected.reviewerSubmissionSha256s)) {
    return unverifiedReport(["artifact_binding_mismatch"]);
  }

  const reviewerAttestationSha256s = [
    providerAnswerReleaseTrustAttestationSha256(reviewerA),
    providerAnswerReleaseTrustAttestationSha256(reviewerB)
  ] as const;
  const adjudicationAttestationSha256 =
    providerAnswerReleaseTrustAttestationSha256(adjudicator);
  if (!sameCanonical(adjudicator.payload.reviewerAttestationSha256s,
    reviewerAttestationSha256s) ||
    !sameCanonical(operator.payload.reviewerAttestationSha256s,
      reviewerAttestationSha256s) ||
    operator.payload.adjudicationAttestationSha256 !== adjudicationAttestationSha256) {
    return unverifiedReport(["attestation_chain_mismatch"]);
  }
  return verifiedReport();
}
