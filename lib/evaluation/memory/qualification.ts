import {
  MEMORY_CAPABILITY_ROLES,
  MEMORY_EVALUATION_LANGUAGES,
  type MemoryCapabilityRole,
  type MemoryEvaluationLanguage
} from "./contracts";
import { canonicalMemoryEvaluationJson } from "./canonical";

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const exactIsoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const MEMORY_QUALIFICATION_DECISIONS = [
  "QUALIFIED",
  "MISSING",
  "STALE",
  "EXPIRED",
  "NOT_YET_VALID",
  "UNAPPROVED",
  "SIGNATURE_INVALID",
  "AMBIGUOUS",
  "REGISTRY_INVALID"
] as const;
export type MemoryQualificationDecisionCode = (typeof MEMORY_QUALIFICATION_DECISIONS)[number];

export type MemoryQualificationKey = Readonly<{
  configFingerprint: string;
  corpusHash: string;
  corpusVersion: string;
  deploymentFingerprint: string;
  language: MemoryEvaluationLanguage;
  modelFingerprint: string;
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  providerFingerprint: string;
  retrievalConfigFingerprint: string;
  role: MemoryCapabilityRole;
  schemaVersion: string;
  scorerVersion: string;
  suiteVersion: string;
  vectorSpaceFingerprint: string | null;
}>;

export type MemoryCapabilityQualification = Readonly<{
  approval: Readonly<{
    approved: boolean;
    approvedAt: string;
    approvedBy: string;
    approvalId: string;
    expiresAt: string;
    signature: string;
  }>;
  evidenceDigest: string;
  key: MemoryQualificationKey;
  qualificationId: string;
}>;

export type MemoryQualificationRequirement = MemoryQualificationKey;

export type MemoryQualificationDecision = Readonly<{
  code: MemoryQualificationDecisionCode;
  qualificationId: string | null;
  qualified: boolean;
}>;

export type MemoryQualificationSignatureVerifier = (
  canonicalPayload: string,
  signature: string
) => boolean;

export const MEMORY_CAPABILITY_QUALIFICATION_REGISTRY: readonly MemoryCapabilityQualification[] =
  Object.freeze([]);

function validToken(value: unknown): value is string {
  return typeof value === "string" && safeToken.test(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !exactIsoInstant.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function keyIsValid(key: MemoryQualificationKey): boolean {
  return Boolean(key) && typeof key === "object" && !Array.isArray(key) && hasExactKeys(key, [
    "configFingerprint",
    "corpusHash",
    "corpusVersion",
    "deploymentFingerprint",
    "language",
    "modelFingerprint",
    "pipelineVersion",
    "policyVersion",
    "promptVersion",
    "providerFingerprint",
    "retrievalConfigFingerprint",
    "role",
    "schemaVersion",
    "scorerVersion",
    "suiteVersion",
    "vectorSpaceFingerprint"
  ]) && MEMORY_CAPABILITY_ROLES.includes(key.role) &&
    MEMORY_EVALUATION_LANGUAGES.includes(key.language) &&
    sha256.test(key.corpusHash) &&
    [
      key.configFingerprint,
      key.corpusVersion,
      key.deploymentFingerprint,
      key.modelFingerprint,
      key.pipelineVersion,
      key.policyVersion,
      key.promptVersion,
      key.providerFingerprint,
      key.retrievalConfigFingerprint,
      key.schemaVersion,
      key.scorerVersion,
      key.suiteVersion
    ].every(validToken) &&
    (key.vectorSpaceFingerprint === null || validToken(key.vectorSpaceFingerprint));
}

function qualificationIsValid(value: MemoryCapabilityQualification): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, [
    "approval",
    "evidenceDigest",
    "key",
    "qualificationId"
  ]) || !value.approval || typeof value.approval !== "object" ||
      Array.isArray(value.approval) || !hasExactKeys(value.approval, [
        "approvalId",
        "approved",
        "approvedAt",
        "approvedBy",
        "expiresAt",
        "signature"
      ])) return false;
  return validToken(value.qualificationId) &&
    sha256.test(value.evidenceDigest) &&
    keyIsValid(value.key) &&
    typeof value.approval?.approved === "boolean" &&
    validInstant(value.approval.approvedAt) &&
    validInstant(value.approval.expiresAt) &&
    validToken(value.approval.approvedBy) &&
    validToken(value.approval.approvalId) &&
    validToken(value.approval.signature);
}

function keyFingerprint(key: MemoryQualificationKey): string {
  return canonicalMemoryEvaluationJson(key);
}

function keysEqual(left: MemoryQualificationKey, right: MemoryQualificationKey): boolean {
  return keyFingerprint(left) === keyFingerprint(right);
}

export function canonicalMemoryQualificationPayload(
  qualification: MemoryCapabilityQualification
): string {
  return canonicalMemoryEvaluationJson({
    approval: {
      approved: qualification.approval.approved,
      approvedAt: qualification.approval.approvedAt,
      approvedBy: qualification.approval.approvedBy,
      approvalId: qualification.approval.approvalId,
      expiresAt: qualification.approval.expiresAt
    },
    evidenceDigest: qualification.evidenceDigest,
    key: qualification.key,
    qualificationId: qualification.qualificationId
  });
}

function decision(
  code: MemoryQualificationDecisionCode,
  qualificationId: string | null = null
): MemoryQualificationDecision {
  return { code, qualificationId, qualified: code === "QUALIFIED" };
}

export function decideMemoryCapabilityQualification(input: {
  now: string;
  registry: readonly MemoryCapabilityQualification[];
  requirement: MemoryQualificationRequirement;
  verifySignature: MemoryQualificationSignatureVerifier;
}): MemoryQualificationDecision {
  if (
    !validInstant(input.now) ||
    !keyIsValid(input.requirement) ||
    typeof input.verifySignature !== "function" ||
    !Array.isArray(input.registry) ||
    !input.registry.every(qualificationIsValid) ||
    new Set(input.registry.map(({ qualificationId }) => qualificationId)).size !== input.registry.length
  ) {
    return decision("REGISTRY_INVALID");
  }

  const sameCapability = input.registry.filter(({ key }) =>
    key.role === input.requirement.role && key.language === input.requirement.language
  );
  const exact = sameCapability.filter(({ key }) => keysEqual(key, input.requirement));
  if (exact.length > 1) return decision("AMBIGUOUS");
  if (exact.length === 0) {
    return decision(sameCapability.length === 0 ? "MISSING" : "STALE");
  }

  const qualification = exact[0]!;
  if (!qualification.approval.approved) {
    return decision("UNAPPROVED", qualification.qualificationId);
  }
  const now = Date.parse(input.now);
  if (Date.parse(qualification.approval.approvedAt) > now) {
    return decision("NOT_YET_VALID", qualification.qualificationId);
  }
  if (Date.parse(qualification.approval.expiresAt) <= now) {
    return decision("EXPIRED", qualification.qualificationId);
  }
  let signatureValid = false;
  try {
    signatureValid = input.verifySignature(
      canonicalMemoryQualificationPayload(qualification),
      qualification.approval.signature
    );
  } catch {
    signatureValid = false;
  }
  return signatureValid
    ? decision("QUALIFIED", qualification.qualificationId)
    : decision("SIGNATURE_INVALID", qualification.qualificationId);
}

export function decideAllMemoryCapabilityQualifications(input: {
  now: string;
  registry: readonly MemoryCapabilityQualification[];
  requirements: readonly MemoryQualificationRequirement[];
  verifySignature: MemoryQualificationSignatureVerifier;
}): Readonly<{
  decisions: readonly MemoryQualificationDecision[];
  qualified: boolean;
}> {
  if (input.requirements.length === 0) {
    return { decisions: [], qualified: false };
  }
  const decisions = input.requirements.map((requirement) =>
    decideMemoryCapabilityQualification({
      now: input.now,
      registry: input.registry,
      requirement,
      verifySignature: input.verifySignature
    })
  );
  return {
    decisions,
    qualified: decisions.every(({ qualified }) => qualified)
  };
}
