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
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import {
  createKnowledgeVectorSpacePin,
  type KnowledgeVectorSpacePin
} from "./indexProfile";

export const KNOWLEDGE_INDEX_PROFILE_ID = "installation";
export const KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v6";
export const KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION = 4 as const;
export const KNOWLEDGE_PDF_PARSER_PROFILE_VERSION = 1 as const;

export type KnowledgePdfProcessingMode =
  | "local"
  | "system_model_direct_pdf"
  | "system_model_vision";

type KnowledgeProfileRoleOperation = "embeddings" | "pdf_transcription";
type KnowledgeProfileRoleMode = "disabled" | "external";
type KnowledgeProfileRoleFallback =
  | "asset_only"
  | "unavailable";

type KnowledgeProfileOperationRole = Readonly<{
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
  timeoutMs: number;
}>;

export type KnowledgeProfileExecutionAuthority = "installation" | "legacy_user";

export type ActiveKnowledgeProfile = Readonly<{
  chunkingProfileVersion: number;
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  executionAuthority: KnowledgeProfileExecutionAuthority;
  pdfParserProfileVersion: number;
  pdfProcessingMode: KnowledgePdfProcessingMode;
  pdfSystemModelPolicyVersion: number | null;
  pdfSystemModelSnapshot: ProviderExecutionSnapshot | null;
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

function profileOperationRoles(
  input: Readonly<{
    embeddingProviderModelId: string;
    pdfProcessingMode: KnowledgePdfProcessingMode;
    pdfSystemModelProviderModelId: string | null;
  }>
): readonly KnowledgeProfileOperationRole[] {
  const roles: KnowledgeProfileOperationRole[] = [
    Object.freeze({
      allowedRepresentations: Object.freeze(["document_text_chunks", "search_queries"]),
      dataProcessingDisclosure: "profile_activation" as const,
      fallback: "unavailable" as const,
      logging: "content_free" as const,
      maxCostMicros: 0,
      maxInputBytes: EMBEDDING_MAX_INPUT_BYTES,
      maxInputTokens: EMBEDDING_MAX_INPUT_TOKENS,
      mode: "external" as const,
      operation: "embeddings" as const,
      profileRevision: "owning_revision" as const,
      providerModelId: input.embeddingProviderModelId,
      rawPrivateText: true,
      retention: "provider_policy" as const,
      timeoutMs: EMBEDDING_TIMEOUT_MS
    })
  ];
  if (input.pdfProcessingMode !== "local" && input.pdfSystemModelProviderModelId) {
    roles.push(Object.freeze({
      allowedRepresentations: Object.freeze([
        input.pdfProcessingMode === "system_model_direct_pdf"
          ? "pdf_page_ranges"
          : "rendered_pdf_page_images"
      ]),
      dataProcessingDisclosure: "profile_activation",
      fallback: "unavailable",
      logging: "content_free",
      maxCostMicros: 0,
      maxInputBytes: 50 * 1024 * 1024,
      maxInputTokens: 512 * 1024,
      mode: "external",
      operation: "pdf_transcription",
      profileRevision: "owning_revision",
      providerModelId: input.pdfSystemModelProviderModelId,
      rawPrivateText: input.pdfProcessingMode === "system_model_direct_pdf",
      retention: "provider_policy",
      timeoutMs: 300_000
    }));
  }
  return Object.freeze(roles);
}

export function knowledgeProfileConfiguration(
  input: Readonly<{
    embeddingProviderModelId: string;
    pdfProcessingMode?: KnowledgePdfProcessingMode;
    pdfSystemModelProviderModelId?: string | null;
  } & Record<string, unknown>>
): Prisma.InputJsonObject {
  const pdfProcessingMode = input.pdfProcessingMode ?? "local";
  return {
    operationRoles: profileOperationRoles({
      embeddingProviderModelId: input.embeddingProviderModelId,
      pdfProcessingMode,
      pdfSystemModelProviderModelId: input.pdfSystemModelProviderModelId ?? null
    }) as unknown as
      Prisma.InputJsonArray,
    pdfProcessingMode,
    rolePolicyVersion: KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION,
    schemaVersion: 6
  };
}

export function knowledgeProfileEgressPolicy(
  input: Readonly<{
    embeddingProviderModelId: string;
    pdfProcessingMode?: KnowledgePdfProcessingMode;
    pdfSystemModelProviderModelId?: string | null;
  } & Record<string, unknown>>
): Prisma.InputJsonObject {
  const pdfProcessingMode = input.pdfProcessingMode ?? "local";
  return {
    operations: profileOperationRoles({
      embeddingProviderModelId: input.embeddingProviderModelId,
      pdfProcessingMode,
      pdfSystemModelProviderModelId: input.pdfSystemModelProviderModelId ?? null
    }) as unknown as
      Prisma.InputJsonArray,
    policyVersion: KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION
  };
}

function legacyLocalProfileConfiguration(embeddingProviderModelId: string): unknown {
  return {
    operationRoles: profileOperationRoles({
      embeddingProviderModelId,
      pdfProcessingMode: "local",
      pdfSystemModelProviderModelId: null
    }),
    rolePolicyVersion: 3,
    schemaVersion: 5
  };
}

function legacyLocalEgressPolicy(embeddingProviderModelId: string): unknown {
  return {
    operations: profileOperationRoles({
      embeddingProviderModelId,
      pdfProcessingMode: "local",
      pdfSystemModelProviderModelId: null
    }),
    policyVersion: "knowledge-profile-egress-v5"
  };
}

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

/** Historical revisions remain decodable, but only the current embeddings-only
 * shape can become active again. */
export function isCurrentKnowledgeProfilePolicy(input: Readonly<{
  egressPolicy: unknown;
  embeddingProviderModelId: string;
  pdfProcessingMode?: KnowledgePdfProcessingMode;
  pdfSystemModelSnapshot?: unknown;
  profileConfiguration: unknown;
}>): boolean {
  const pdfProcessingMode = input.pdfProcessingMode ?? "local";
  let pdfSystemModelProviderModelId: string | null = null;
  if (pdfProcessingMode !== "local") {
    try {
      pdfSystemModelProviderModelId = normalizeProviderExecutionSnapshot(
        input.pdfSystemModelSnapshot
      ).providerModelId;
    } catch {
      return false;
    }
  } else if (input.pdfSystemModelSnapshot !== undefined &&
    input.pdfSystemModelSnapshot !== null) {
    return false;
  }
  const current = canonicalJson(input.profileConfiguration) === canonicalJson(
    knowledgeProfileConfiguration({
      embeddingProviderModelId: input.embeddingProviderModelId,
      pdfProcessingMode,
      pdfSystemModelProviderModelId
    })
  ) && canonicalJson(input.egressPolicy) === canonicalJson(
    knowledgeProfileEgressPolicy({
      embeddingProviderModelId: input.embeddingProviderModelId,
      pdfProcessingMode,
      pdfSystemModelProviderModelId
    })
  );
  if (current) return true;
  if (pdfProcessingMode !== "local") return false;
  return canonicalJson(input.profileConfiguration) === canonicalJson(
    legacyLocalProfileConfiguration(input.embeddingProviderModelId)
  ) && canonicalJson(input.egressPolicy) === canonicalJson(
    legacyLocalEgressPolicy(input.embeddingProviderModelId)
  );
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
  if (revision.executionAuthority !== "installation" ||
    !isCurrentKnowledgeProfilePolicy({
      egressPolicy: revision.egressPolicy,
      embeddingProviderModelId: revision.embeddingProviderModelId,
      pdfProcessingMode: revision.pdfProcessingMode,
      pdfSystemModelSnapshot: revision.pdfSystemModelSnapshot,
      profileConfiguration: revision.profileConfiguration
    }) || revision.preflightStatus !== "ready" || revision.preflightErrorCode !== null) {
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
      pdfParserProfileVersion: revision.pdfParserProfileVersion,
      pdfProcessingMode: revision.pdfProcessingMode,
      pdfSystemModelPolicyVersion: revision.pdfSystemModelPolicyVersion,
      pdfSystemModelSnapshot: revision.pdfSystemModelSnapshot === null
        ? null
        : normalizeProviderExecutionSnapshot(revision.pdfSystemModelSnapshot),
      pin: resolved.pin,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber
    }
  };
}
