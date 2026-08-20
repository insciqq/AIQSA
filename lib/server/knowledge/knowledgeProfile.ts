import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  loadEmbeddingProviderRole,
  loadProjectEmbeddingProviderRole,
  ProviderAdmissionError,
  type AdmissionPrisma,
  type EmbeddingProviderAdmissionRole
} from "../providerRuntime/admission";
import { ProviderConfigurationError } from "../providers/providerConfiguration";
import {
  createKnowledgeVectorSpacePin,
  type KnowledgeVectorSpacePin
} from "./indexProfile";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";

export const KNOWLEDGE_INDEX_PROFILE_ID = "installation";
export const KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v3";
export const KNOWLEDGE_PROFILE_SEMANTIC_EGRESS_POLICY_VERSION =
  "knowledge-profile-egress-v4";
export const KNOWLEDGE_PROFILE_PREVIOUS_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v2";
export const KNOWLEDGE_PROFILE_LEGACY_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v1";
export const KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION = 1 as const;
export const KNOWLEDGE_PROFILE_SEMANTIC_ROLE_POLICY_VERSION = 2 as const;
export const KNOWLEDGE_SEMANTIC_VALIDATOR_DEPLOYMENT_VERSION = 1 as const;
export const KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION =
  "knowledge-semantic-selection-freeze-v1" as const;

export const knowledgeProfileRoleOperations = [
  "embeddings",
  "vision_analysis",
  "query_planning",
  "reranking",
  "grounding_validation",
  "citation_repair",
  "answer_citation_retry"
] as const;

export type KnowledgeProfileRoleOperation = typeof knowledgeProfileRoleOperations[number];
export type KnowledgeProfileRoleMode = "disabled" | "external" | "local";
export type KnowledgeProfileRoleFallback =
  | "asset_only"
  | "citation_binding_fallback"
  | "deterministic_fusion"
  | "deterministic_planner"
  | "unavailable";

/**
 * Content-free commitment to a semantic candidate which has already passed
 * the independent selection-freeze contract. Runtime never derives this
 * authority from a request or the live Profile pointer. Version 1 is local
 * only: external execution remains unavailable until it has its own durable,
 * recovery-safe provider-attempt ledger.
 */
export type KnowledgeSemanticValidatorDeploymentV1 = Readonly<{
  authorization: "profile_authorized";
  calibrationOutputSha256: string;
  candidateId: string;
  candidateIdentitySha256: string;
  candidateImplementationSha256: string;
  egress: "local";
  executionClass: "real_model";
  finalOutputSha256: string;
  profileId: string;
  qualityEvidenceSha256: string;
  recoveryMode: "deterministic_replay";
  selectionFreezeVersion: typeof KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION;
  selectionManifestSha256: string;
  semanticProof: true;
  validatorVersion: number;
  version: typeof KNOWLEDGE_SEMANTIC_VALIDATOR_DEPLOYMENT_VERSION;
}>;

export type KnowledgeProfileOperationRole = Readonly<{
  allowedRepresentations: readonly string[];
  dataProcessingDisclosure: "code_default" | "profile_activation";
  fallback: KnowledgeProfileRoleFallback;
  logging: "content_free";
  maxCostMicros: number;
  maxInputBytes: number;
  maxInputTokens: number;
  mode: KnowledgeProfileRoleMode;
  operation: KnowledgeProfileRoleOperation;
  profileRevision: "owning_revision";
  providerModelId: string | null;
  rawPrivateText: boolean;
  retention: "none" | "provider_policy";
  semanticValidator?: KnowledgeSemanticValidatorDeploymentV1;
  timeoutMs: number;
}>;

export type KnowledgeVisionProfileDestination = Readonly<{
  connectionDisplayName: string;
  modelDisplayName: string;
  provider: string;
  providerModelId: string;
  supportsNativePdf: boolean;
}>;

export type KnowledgeVisionProfileResolution =
  | Readonly<{ kind: "asset_only" }>
  | Readonly<{ destination: KnowledgeVisionProfileDestination; kind: "configured" }>
  | Readonly<{ kind: "invalid" }>;

export type KnowledgeProfileExecutionAuthority = "installation" | "legacy_user";

export type ActiveKnowledgeProfile = Readonly<{
  chunkingProfileVersion: number;
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  executionAuthority: KnowledgeProfileExecutionAuthority;
  pin: KnowledgeVectorSpacePin;
  revisionId: string;
  revisionNumber: number;
}>;

export type ActiveKnowledgeProfileResolution =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "ok"; profile: ActiveKnowledgeProfile }>
  | Readonly<{ kind: "unavailable" }>;

export type KnowledgeProfileStore = AdmissionPrisma & Pick<
  Prisma.TransactionClient,
  "knowledgeIndexProfile"
>;

const EMBEDDING_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const EMBEDDING_MAX_INPUT_TOKENS = 512 * 1024;
const EMBEDDING_TIMEOUT_MS = 300_000;
const VISUAL_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const VISUAL_MAX_INPUT_TOKENS = 4_096;
const VISUAL_TIMEOUT_MS = 30_000;
const LOCAL_ROLE_MAX_INPUT_BYTES = 512 * 1024;
const LOCAL_ROLE_MAX_INPUT_TOKENS = 64 * 1024;
const LOCAL_ROLE_TIMEOUT_MS = 2_000;

function profileOperationRoles(input: Readonly<{
  embeddingProviderModelId: string;
  semanticValidatorDeployment?: KnowledgeSemanticValidatorDeploymentV1 | null;
  visionDestination: KnowledgeVisionProfileDestination | null;
}>): readonly KnowledgeProfileOperationRole[] {
  const externalCostCeiling = DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxEstimatedCostMicros;
  return Object.freeze([
    Object.freeze({
      allowedRepresentations: Object.freeze(["document_text_chunks", "search_queries"]),
      dataProcessingDisclosure: "profile_activation" as const,
      fallback: "unavailable" as const,
      logging: "content_free" as const,
      maxCostMicros: externalCostCeiling,
      maxInputBytes: EMBEDDING_MAX_INPUT_BYTES,
      maxInputTokens: EMBEDDING_MAX_INPUT_TOKENS,
      mode: "external" as const,
      operation: "embeddings" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: input.embeddingProviderModelId,
      rawPrivateText: true,
      retention: "provider_policy" as const,
      timeoutMs: EMBEDDING_TIMEOUT_MS
    }),
    Object.freeze(input.visionDestination ? {
      allowedRepresentations: Object.freeze(["visual_source_bytes", "visual_queries"]),
      dataProcessingDisclosure: "profile_activation" as const,
      fallback: "asset_only" as const,
      logging: "content_free" as const,
      maxCostMicros: externalCostCeiling,
      maxInputBytes: VISUAL_MAX_INPUT_BYTES,
      maxInputTokens: VISUAL_MAX_INPUT_TOKENS,
      mode: "external" as const,
      operation: "vision_analysis" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: input.visionDestination.providerModelId,
      rawPrivateText: true,
      retention: "provider_policy" as const,
      timeoutMs: VISUAL_TIMEOUT_MS
    } : {
      allowedRepresentations: Object.freeze(["visual_source_bytes", "visual_queries"]),
      dataProcessingDisclosure: "code_default" as const,
      fallback: "asset_only" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: 0,
      maxInputTokens: 0,
      mode: "disabled" as const,
      operation: "vision_analysis" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: null,
      rawPrivateText: false,
      retention: "none" as const,
      timeoutMs: 0
    }),
    Object.freeze({
      allowedRepresentations: Object.freeze(["knowledge_intent", "source_metadata"]),
      dataProcessingDisclosure: "code_default" as const,
      fallback: "deterministic_planner" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: 0,
      maxInputTokens: 0,
      mode: "disabled" as const,
      operation: "query_planning" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: null,
      rawPrivateText: false,
      retention: "none" as const,
      timeoutMs: 0
    }),
    Object.freeze({
      allowedRepresentations: Object.freeze(["knowledge_query", "candidate_passages"]),
      dataProcessingDisclosure: "code_default" as const,
      fallback: "deterministic_fusion" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: LOCAL_ROLE_MAX_INPUT_BYTES,
      maxInputTokens: LOCAL_ROLE_MAX_INPUT_TOKENS,
      mode: "local" as const,
      operation: "reranking" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: null,
      rawPrivateText: false,
      retention: "none" as const,
      timeoutMs: LOCAL_ROLE_TIMEOUT_MS
    }),
    Object.freeze({
      allowedRepresentations: Object.freeze(["answer_claims", "evidence_excerpts"]),
      dataProcessingDisclosure: "code_default" as const,
      fallback: "citation_binding_fallback" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: LOCAL_ROLE_MAX_INPUT_BYTES,
      maxInputTokens: LOCAL_ROLE_MAX_INPUT_TOKENS,
      mode: "local" as const,
      operation: "grounding_validation" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: null,
      rawPrivateText: false,
      retention: "none" as const,
      ...(input.semanticValidatorDeployment
        ? { semanticValidator: input.semanticValidatorDeployment }
        : {}),
      timeoutMs: LOCAL_ROLE_TIMEOUT_MS
    }),
    Object.freeze({
      allowedRepresentations: Object.freeze(["answer_text", "citation_handles"]),
      dataProcessingDisclosure: "code_default" as const,
      fallback: "citation_binding_fallback" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: 128 * 1024,
      maxInputTokens: 32 * 1024,
      mode: "local" as const,
      operation: "citation_repair" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: null,
      rawPrivateText: false,
      retention: "none" as const,
      timeoutMs: 1_000
    }),
    Object.freeze({
      allowedRepresentations: Object.freeze(["answer_request", "evidence_manifest"]),
      dataProcessingDisclosure: "code_default" as const,
      fallback: "citation_binding_fallback" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: 0,
      maxInputTokens: 0,
      mode: "disabled" as const,
      operation: "answer_citation_retry" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: null,
      rawPrivateText: false,
      retention: "none" as const,
      timeoutMs: 0
    })
  ]);
}

export function knowledgeProfileConfiguration(input: Readonly<{
  candidateLimit: number;
  embeddingProviderModelId: string;
  resultLimit: number;
  scoreThreshold: number;
  semanticValidatorDeployment?: KnowledgeSemanticValidatorDeploymentV1 | null;
  visionDestination?: KnowledgeVisionProfileDestination | null;
}>): Prisma.InputJsonObject {
  const semanticValidatorDeployment = input.semanticValidatorDeployment === undefined ||
      input.semanticValidatorDeployment === null
    ? null
    : decodeKnowledgeSemanticValidatorDeployment(input.semanticValidatorDeployment);
  if (input.semanticValidatorDeployment && (!semanticValidatorDeployment ||
    !knowledgeSemanticValidatorDeploymentReleased(semanticValidatorDeployment))) {
    throw new Error("knowledge_semantic_validator_deployment_unreleased");
  }
  return {
    executionBudgets: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    lexicalConfiguration: "current_fts",
    operationRoles: profileOperationRoles({
      embeddingProviderModelId: input.embeddingProviderModelId,
      semanticValidatorDeployment,
      visionDestination: input.visionDestination ?? null
    }) as unknown as Prisma.InputJsonArray,
    parserRouting: "current",
    retrievalBudgets: {
      candidateLimit: input.candidateLimit,
      resultLimit: input.resultLimit,
      scoreThreshold: input.scoreThreshold
    },
    rolePolicyVersion: semanticValidatorDeployment
      ? KNOWLEDGE_PROFILE_SEMANTIC_ROLE_POLICY_VERSION
      : KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION,
    schemaVersion: semanticValidatorDeployment ? 4 : 3,
    visualAnalysis: input.visionDestination ? {
      connectionDisplayName: input.visionDestination.connectionDisplayName,
      modelDisplayName: input.visionDestination.modelDisplayName,
      provider: input.visionDestination.provider,
      providerModelId: input.visionDestination.providerModelId,
      supportsNativePdf: input.visionDestination.supportsNativePdf
    } : null
  };
}

export function knowledgeProfileEgressPolicy(
  input: Readonly<{
    embeddingProviderModelId: string;
    semanticValidatorDeployment?: KnowledgeSemanticValidatorDeploymentV1 | null;
    visionDestination?: KnowledgeVisionProfileDestination | null;
  }>
): Prisma.InputJsonObject {
  const semanticValidatorDeployment = input.semanticValidatorDeployment === undefined ||
      input.semanticValidatorDeployment === null
    ? null
    : decodeKnowledgeSemanticValidatorDeployment(input.semanticValidatorDeployment);
  if (input.semanticValidatorDeployment && (!semanticValidatorDeployment ||
    !knowledgeSemanticValidatorDeploymentReleased(semanticValidatorDeployment))) {
    throw new Error("knowledge_semantic_validator_deployment_unreleased");
  }
  return {
    operations: profileOperationRoles({
      embeddingProviderModelId: input.embeddingProviderModelId,
      semanticValidatorDeployment,
      visionDestination: input.visionDestination ?? null
    }) as unknown as Prisma.InputJsonArray,
    policyVersion: semanticValidatorDeployment
      ? KNOWLEDGE_PROFILE_SEMANTIC_EGRESS_POLICY_VERSION
      : KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

const sha256 = /^[a-f0-9]{64}$/u;
const safeSemanticIdentity = /^[a-z0-9][a-z0-9_.-]{0,79}$/u;
// H6 can only deploy a validator whose frozen candidate identity already proves
// zero provider egress. System-model and hybrid candidates require an external
// recovery-safe attempt ledger and cannot be relabelled as local here.
const localSemanticCandidateIds = new Set(["local_multilingual_nli_v1"]);

/**
 * Deliberately empty until H6 has a real, independently verified selection
 * freeze. Adding an entry is the production promotion event: it must pin the
 * complete content-free deployment commitment, not merely a self-hashed
 * operator-supplied manifest. Shape decoding alone never grants authority.
 */
const releasedLocalSemanticValidatorDeployments = new Set<string>();

export function knowledgeSemanticValidatorDeploymentReleased(value: unknown): boolean {
  const deployment = decodeKnowledgeSemanticValidatorDeployment(value);
  return deployment !== null &&
    releasedLocalSemanticValidatorDeployments.has(canonicalJson(deployment));
}

function exactHashRecord(value: unknown, keys: readonly string[]): boolean {
  return record(value) && exactKeys(value, keys) &&
    keys.every((key) => typeof value[key] === "string" && sha256.test(value[key]));
}

function exactHashTuple(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && value[0] !== value[1] &&
    value.every((entry) => typeof entry === "string" && sha256.test(entry));
}

/**
 * Turns the self-hashed, aggregate-only selection artifact into the smaller
 * content-free commitment stored in an immutable Profile revision. Runtime
 * activation must use this boundary; labels and private evaluation content are
 * neither accepted nor copied into the Profile.
 */
export function knowledgeSemanticValidatorDeploymentFromSelectionFreeze(input: Readonly<{
  profileId: string;
  selectionFreeze: unknown;
  validatorVersion: number;
}>): KnowledgeSemanticValidatorDeploymentV1 | null {
  const freeze = input.selectionFreeze;
  if (!record(freeze) || !exactKeys(freeze, [
    "aggregateOnly", "artifactScope", "artifactType", "artifactVersion",
    "benchmarkReportSha256", "evaluationArtifacts", "finalReview", "humanTrust",
    "labelsIncluded", "manifestSha256", "privateContentIncluded", "releaseGatePassed",
    "selectedCandidate", "selectionEligible", "semanticProof"
  ]) || freeze.aggregateOnly !== true ||
    freeze.artifactScope !== "semantic_candidate_selection_only" ||
    freeze.artifactType !== "knowledge_semantic_selection_freeze" ||
    freeze.artifactVersion !== KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION ||
    freeze.labelsIncluded !== false || freeze.privateContentIncluded !== false ||
    freeze.releaseGatePassed !== false || freeze.selectionEligible !== true ||
    freeze.semanticProof !== true || typeof freeze.benchmarkReportSha256 !== "string" ||
    !sha256.test(freeze.benchmarkReportSha256) || typeof freeze.manifestSha256 !== "string" ||
    !sha256.test(freeze.manifestSha256) || !safeSemanticIdentity.test(input.profileId) ||
    !Number.isSafeInteger(input.validatorVersion) || input.validatorVersion < 1 ||
    input.validatorVersion > 10_000 || !exactHashRecord(freeze.evaluationArtifacts, [
      "calibrationFreezeManifestSha256", "candidateFreezeManifestSha256",
      "candidateSetDigest", "corpusSha256", "finalPredictionFreezeManifestSha256",
      "poolSha256"
    ]) || !record(freeze.finalReview) || !exactKeys(freeze.finalReview, [
      "adjudicationSha256", "mappingSha256", "packetSha256", "reviewScope",
      "reviewerSubmissionSha256s"
    ]) || freeze.finalReview.reviewScope !== "final" ||
    ![freeze.finalReview.adjudicationSha256, freeze.finalReview.mappingSha256,
      freeze.finalReview.packetSha256].every((value) =>
      typeof value === "string" && sha256.test(value)) ||
    !exactHashTuple(freeze.finalReview.reviewerSubmissionSha256s) ||
    !record(freeze.humanTrust) || !exactKeys(freeze.humanTrust, [
      "adjudicatorAttestationSha256", "anchorSetSha256", "evidenceSha256",
      "operatorAttestationSha256", "provenanceVerification",
      "reviewerAttestationSha256s", "verificationContextSha256", "version"
    ]) || freeze.humanTrust.provenanceVerification !==
      "operator_anchored_ed25519_verified" ||
    freeze.humanTrust.version !== "knowledge-semantic-human-trust-v1" ||
    ![freeze.humanTrust.adjudicatorAttestationSha256, freeze.humanTrust.anchorSetSha256,
      freeze.humanTrust.evidenceSha256, freeze.humanTrust.operatorAttestationSha256,
      freeze.humanTrust.verificationContextSha256].every((value) =>
      typeof value === "string" && sha256.test(value)) ||
    !exactHashTuple(freeze.humanTrust.reviewerAttestationSha256s) ||
    !record(freeze.selectedCandidate) || !exactKeys(freeze.selectedCandidate, [
      "authorization", "calibrationOutputSha256", "candidateId",
      "candidateIdentitySha256", "candidateImplementationSha256", "executionClass",
      "finalOutputSha256", "qualityEvidenceSha256"
    ]) || freeze.selectedCandidate.authorization !== "profile_authorized" ||
    freeze.selectedCandidate.executionClass !== "real_model" ||
    typeof freeze.selectedCandidate.candidateId !== "string" ||
    !localSemanticCandidateIds.has(freeze.selectedCandidate.candidateId) ||
    ![freeze.selectedCandidate.calibrationOutputSha256,
      freeze.selectedCandidate.candidateIdentitySha256,
      freeze.selectedCandidate.candidateImplementationSha256,
      freeze.selectedCandidate.finalOutputSha256,
      freeze.selectedCandidate.qualityEvidenceSha256].every((value) =>
      typeof value === "string" && sha256.test(value))) return null;
  const { manifestSha256, ...body } = freeze;
  if (createHash("sha256").update(canonicalJson(body), "utf8").digest("hex") !==
    manifestSha256) return null;
  const deployment = decodeKnowledgeSemanticValidatorDeployment({
    authorization: "profile_authorized",
    calibrationOutputSha256: freeze.selectedCandidate.calibrationOutputSha256,
    candidateId: freeze.selectedCandidate.candidateId,
    candidateIdentitySha256: freeze.selectedCandidate.candidateIdentitySha256,
    candidateImplementationSha256: freeze.selectedCandidate.candidateImplementationSha256,
    egress: "local",
    executionClass: "real_model",
    finalOutputSha256: freeze.selectedCandidate.finalOutputSha256,
    profileId: input.profileId,
    qualityEvidenceSha256: freeze.selectedCandidate.qualityEvidenceSha256,
    recoveryMode: "deterministic_replay",
    selectionFreezeVersion: KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION,
    selectionManifestSha256: manifestSha256,
    semanticProof: true,
    validatorVersion: input.validatorVersion,
    version: KNOWLEDGE_SEMANTIC_VALIDATOR_DEPLOYMENT_VERSION
  });
  return deployment && knowledgeSemanticValidatorDeploymentReleased(deployment)
    ? deployment
    : null;
}

export function decodeKnowledgeSemanticValidatorDeployment(
  value: unknown
): KnowledgeSemanticValidatorDeploymentV1 | null {
  if (!record(value) || !exactKeys(value, [
    "authorization", "calibrationOutputSha256", "candidateId",
    "candidateIdentitySha256", "candidateImplementationSha256", "egress",
    "executionClass", "finalOutputSha256", "profileId", "qualityEvidenceSha256",
    "recoveryMode", "selectionFreezeVersion", "selectionManifestSha256",
    "semanticProof", "validatorVersion", "version"
  ]) || value.authorization !== "profile_authorized" || value.egress !== "local" ||
    value.executionClass !== "real_model" || value.recoveryMode !== "deterministic_replay" ||
    value.selectionFreezeVersion !== KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION ||
    value.semanticProof !== true || value.version !== KNOWLEDGE_SEMANTIC_VALIDATOR_DEPLOYMENT_VERSION ||
    typeof value.candidateId !== "string" || !localSemanticCandidateIds.has(value.candidateId) ||
    typeof value.profileId !== "string" || !safeSemanticIdentity.test(value.profileId) ||
    typeof value.candidateIdentitySha256 !== "string" ||
      !sha256.test(value.candidateIdentitySha256) ||
    typeof value.candidateImplementationSha256 !== "string" ||
      !sha256.test(value.candidateImplementationSha256) ||
    typeof value.calibrationOutputSha256 !== "string" ||
      !sha256.test(value.calibrationOutputSha256) ||
    typeof value.finalOutputSha256 !== "string" ||
      !sha256.test(value.finalOutputSha256) ||
    typeof value.qualityEvidenceSha256 !== "string" ||
      !sha256.test(value.qualityEvidenceSha256) ||
    typeof value.selectionManifestSha256 !== "string" ||
      !sha256.test(value.selectionManifestSha256) ||
    !Number.isSafeInteger(value.validatorVersion) || Number(value.validatorVersion) < 1 ||
    Number(value.validatorVersion) > 10_000) return null;
  return Object.freeze({
    authorization: "profile_authorized",
    calibrationOutputSha256: value.calibrationOutputSha256,
    candidateId: value.candidateId,
    candidateIdentitySha256: value.candidateIdentitySha256,
    candidateImplementationSha256: value.candidateImplementationSha256,
    egress: "local",
    executionClass: "real_model",
    finalOutputSha256: value.finalOutputSha256,
    profileId: value.profileId,
    qualityEvidenceSha256: value.qualityEvidenceSha256,
    recoveryMode: "deterministic_replay",
    selectionFreezeVersion: KNOWLEDGE_SEMANTIC_SELECTION_FREEZE_VERSION,
    selectionManifestSha256: value.selectionManifestSha256,
    semanticProof: true,
    validatorVersion: Number(value.validatorVersion),
    version: KNOWLEDGE_SEMANTIC_VALIDATOR_DEPLOYMENT_VERSION
  });
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Legacy schema-v1 profiles are deliberately asset-only. Schema-v2/v3 pin
 * the exact optional installation vision destination into every artifact. */
export function knowledgeVisionProfileFromConfiguration(
  value: unknown
): KnowledgeVisionProfileResolution {
  if (!record(value)) return { kind: "invalid" };
  if (value.schemaVersion === 1 && value.visualAnalysis === undefined) {
    return { kind: "asset_only" };
  }
  if ((value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) ||
    !("visualAnalysis" in value)) return { kind: "invalid" };
  if (value.visualAnalysis === null) return { kind: "asset_only" };
  const destination = value.visualAnalysis;
  if (!record(destination) || !boundedText(destination.connectionDisplayName) ||
    !boundedText(destination.modelDisplayName) || !boundedText(destination.provider) ||
    !boundedText(destination.providerModelId) ||
    typeof destination.supportsNativePdf !== "boolean") return { kind: "invalid" };
  return {
    destination: Object.freeze({
      connectionDisplayName: destination.connectionDisplayName.trim(),
      modelDisplayName: destination.modelDisplayName.trim(),
      provider: destination.provider.trim(),
      providerModelId: destination.providerModelId.trim(),
      supportsNativePdf: destination.supportsNativePdf
    }),
    kind: "configured"
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function legacyEgressPolicyMatches(
  value: Record<string, unknown>,
  embeddingProviderModelId: string,
  visionDestination: KnowledgeVisionProfileDestination | null
): boolean {
  if (!Array.isArray(value.operations) ||
    (value.policyVersion !== KNOWLEDGE_PROFILE_LEGACY_EGRESS_POLICY_VERSION &&
      value.policyVersion !== KNOWLEDGE_PROFILE_PREVIOUS_EGRESS_POLICY_VERSION)) return false;
  if (value.policyVersion === KNOWLEDGE_PROFILE_LEGACY_EGRESS_POLICY_VERSION &&
    visionDestination) return false;
  const embeddings = value.operations.filter((operation) => record(operation) &&
    operation.operation === "embeddings");
  const visions = value.operations.filter((operation) => record(operation) &&
    operation.operation === "vision_analysis");
  if (embeddings.length !== 1 || visions.length !== (visionDestination ? 1 : 0) ||
    value.operations.length !== embeddings.length + visions.length) return false;
  const embedding = embeddings[0]!;
  if (!Array.isArray(embedding.representations) ||
    canonicalJson(embedding.representations) !==
      canonicalJson(["document_text_chunks", "search_queries"]) ||
    embedding.providerModelId !== undefined &&
      embedding.providerModelId !== embeddingProviderModelId) return false;
  if (!visionDestination) return true;
  const vision = visions[0]!;
  return vision.providerModelId === visionDestination.providerModelId &&
    Array.isArray(vision.representations) &&
    canonicalJson(vision.representations) ===
      canonicalJson(["visual_source_bytes", "visual_queries"]);
}

/** Decodes both the additive H2 role contract and immutable v1/v2 revisions.
 * Legacy rows receive the same local/disabled defaults in memory; no external
 * role is inferred beyond their already-approved embedding/vision operations. */
export function decodeKnowledgeProfileOperationRoles(input: Readonly<{
  configuration: unknown;
  egressPolicy: unknown;
  embeddingProviderModelId: string;
}>): readonly KnowledgeProfileOperationRole[] | null {
  if (!boundedText(input.embeddingProviderModelId) || !record(input.configuration) ||
    !record(input.egressPolicy)) return null;
  const vision = knowledgeVisionProfileFromConfiguration(input.configuration);
  if (vision.kind === "invalid") return null;
  const visionDestination = vision.kind === "configured" ? vision.destination : null;
  const expected = profileOperationRoles({
    embeddingProviderModelId: input.embeddingProviderModelId,
    visionDestination
  });
  if (input.configuration.schemaVersion === 3) {
    if (input.configuration.rolePolicyVersion !== KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION ||
      !Array.isArray(input.configuration.operationRoles) ||
      canonicalJson(input.configuration.operationRoles) !== canonicalJson(expected) ||
      input.egressPolicy.policyVersion !== KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION ||
      !Array.isArray(input.egressPolicy.operations) ||
      canonicalJson(input.egressPolicy.operations) !== canonicalJson(expected)) return null;
    return expected;
  }
  if (input.configuration.schemaVersion === 4) {
    if (input.configuration.rolePolicyVersion !==
        KNOWLEDGE_PROFILE_SEMANTIC_ROLE_POLICY_VERSION ||
      !Array.isArray(input.configuration.operationRoles) ||
      input.egressPolicy.policyVersion !== KNOWLEDGE_PROFILE_SEMANTIC_EGRESS_POLICY_VERSION ||
      !Array.isArray(input.egressPolicy.operations)) return null;
    const configuredGroundingRole = input.configuration.operationRoles.find((operation) =>
      record(operation) && operation.operation === "grounding_validation");
    const egressGroundingRole = input.egressPolicy.operations.find((operation) =>
      record(operation) && operation.operation === "grounding_validation");
    if (!record(configuredGroundingRole) || !record(egressGroundingRole)) return null;
    const semanticValidatorDeployment = decodeKnowledgeSemanticValidatorDeployment(
      configuredGroundingRole.semanticValidator
    );
    if (!semanticValidatorDeployment || canonicalJson(egressGroundingRole.semanticValidator) !==
      canonicalJson(semanticValidatorDeployment)) return null;
    const semanticExpected = profileOperationRoles({
      embeddingProviderModelId: input.embeddingProviderModelId,
      semanticValidatorDeployment,
      visionDestination
    });
    if (canonicalJson(input.configuration.operationRoles) !== canonicalJson(semanticExpected) ||
      canonicalJson(input.egressPolicy.operations) !== canonicalJson(semanticExpected)) return null;
    return semanticExpected;
  }
  if (input.configuration.schemaVersion !== 1 && input.configuration.schemaVersion !== 2) {
    return null;
  }
  return legacyEgressPolicyMatches(
    input.egressPolicy,
    input.embeddingProviderModelId,
    visionDestination
  ) ? expected : null;
}

export function knowledgeVisionEgressApproved(
  value: unknown,
  providerModelId: string
): boolean {
  if (!record(value) || !Array.isArray(value.operations)) return false;
  if (value.policyVersion === KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION ||
    value.policyVersion === KNOWLEDGE_PROFILE_SEMANTIC_EGRESS_POLICY_VERSION) {
    if (value.operations.length !== knowledgeProfileRoleOperations.length) return false;
    const roles = new Map(value.operations.flatMap((operation) =>
      record(operation) && typeof operation.operation === "string"
        ? [[operation.operation, operation] as const]
        : []));
    if (roles.size !== knowledgeProfileRoleOperations.length ||
      knowledgeProfileRoleOperations.some((operation) => !roles.has(operation))) return false;
    const safeModes = new Map([
      ["query_planning", "disabled"],
      ["reranking", "local"],
      ["citation_repair", "local"],
      ["answer_citation_retry", "disabled"]
    ] as const);
    if ([...safeModes].some(([operation, mode]) => {
      const role = roles.get(operation);
      return !role || role.mode !== mode || role.providerModelId !== null ||
        role.rawPrivateText !== false || role.maxCostMicros !== 0 ||
        role.retention !== "none";
    })) return false;
    const grounding = roles.get("grounding_validation");
    if (!grounding || grounding.mode !== "local" || grounding.providerModelId !== null ||
      grounding.rawPrivateText !== false || grounding.maxCostMicros !== 0 ||
      grounding.retention !== "none") return false;
    if (value.policyVersion === KNOWLEDGE_PROFILE_SEMANTIC_EGRESS_POLICY_VERSION) {
      if (!decodeKnowledgeSemanticValidatorDeployment(grounding.semanticValidator)) return false;
    } else if ("semanticValidator" in grounding) return false;
    const embedding = roles.get("embeddings");
    if (!embedding || embedding.mode !== "external" ||
      !boundedText(embedding.providerModelId)) return false;
    return value.operations.some((operation) => record(operation) &&
      operation.operation === "vision_analysis" && operation.mode === "external" &&
      operation.providerModelId === providerModelId && operation.rawPrivateText === true &&
      Array.isArray(operation.allowedRepresentations) &&
      operation.allowedRepresentations.length === 2 &&
      operation.allowedRepresentations[0] === "visual_source_bytes" &&
      operation.allowedRepresentations[1] === "visual_queries");
  }
  if (value.policyVersion !== KNOWLEDGE_PROFILE_PREVIOUS_EGRESS_POLICY_VERSION) return false;
  return value.operations.some((operation) => record(operation) &&
    operation.operation === "vision_analysis" &&
    operation.providerModelId === providerModelId &&
    Array.isArray(operation.representations) &&
    operation.representations.length === 2 &&
    operation.representations[0] === "visual_source_bytes" &&
    operation.representations[1] === "visual_queries");
}

function expectedPin(
  role: EmbeddingProviderAdmissionRole,
  deploymentId: string
): KnowledgeVectorSpacePin | null {
  return createKnowledgeVectorSpacePin({
    configuration: role.configuration,
    deploymentId
  });
}

function availabilityError(error: unknown): boolean {
  return error instanceof ProviderAdmissionError || error instanceof ProviderConfigurationError ||
    error instanceof Error && error.message === "provider_execution_snapshot_invalid";
}

export async function resolveKnowledgeProfileRevisionRole(
  client: AdmissionPrisma,
  revision: Readonly<{
    embeddingProviderModelId: string;
    executionAuthority: KnowledgeProfileExecutionAuthority;
    targetDimension: number;
    vectorSpaceFingerprint: string;
  }>,
  userId?: string
): Promise<Readonly<{
  pin: KnowledgeVectorSpacePin;
  role: EmbeddingProviderAdmissionRole;
}> | null> {
  try {
    const role = revision.executionAuthority === "installation"
      ? await loadProjectEmbeddingProviderRole(client, {
          providerModelId: revision.embeddingProviderModelId
        })
      : userId
        ? await loadEmbeddingProviderRole(client, {
            providerModelId: revision.embeddingProviderModelId,
            userId
          })
        : null;
    if (!role) return null;
    const pin = expectedPin(role, revision.embeddingProviderModelId);
    if (
      !pin ||
      !pin.indexSupported ||
      pin.fingerprint !== revision.vectorSpaceFingerprint.trim() ||
      pin.targetDimension !== revision.targetDimension
    ) return null;
    return { pin, role };
  } catch (error) {
    if (availabilityError(error)) return null;
    throw error;
  }
}

export async function resolveActiveKnowledgeProfile(
  client: KnowledgeProfileStore,
  userId: string
): Promise<ActiveKnowledgeProfileResolution> {
  const profile = await client.knowledgeIndexProfile.findUnique({
    include: { activeRevision: true },
    where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
  });
  const revision = profile?.activeRevision;
  if (!profile || !revision) return { kind: "missing" };
  if (revision.preflightStatus !== "ready" || revision.preflightErrorCode !== null) {
    return { kind: "unavailable" };
  }
  const resolved = await resolveKnowledgeProfileRevisionRole(client, {
    embeddingProviderModelId: revision.embeddingProviderModelId,
    executionAuthority: revision.executionAuthority,
    targetDimension: revision.targetDimension,
    vectorSpaceFingerprint: revision.vectorSpaceFingerprint
  }, userId);
  if (!resolved) return { kind: "unavailable" };
  return {
    kind: "ok",
    profile: {
      chunkingProfileVersion: revision.chunkingProfileVersion,
      embeddingConfiguration: revision.embeddingConfiguration,
      embeddingProviderModelId: revision.embeddingProviderModelId,
      executionAuthority: revision.executionAuthority,
      pin: resolved.pin,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber
    }
  };
}
