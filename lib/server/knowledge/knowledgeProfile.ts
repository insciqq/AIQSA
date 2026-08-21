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

export const KNOWLEDGE_INDEX_PROFILE_ID = "installation";
export const KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v5";
export const KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION = 3 as const;

type KnowledgeProfileRoleOperation = "embeddings";
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
  embeddingProviderModelId: string
): readonly KnowledgeProfileOperationRole[] {
  return Object.freeze([
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
      providerModelId: embeddingProviderModelId,
      rawPrivateText: true,
      retention: "provider_policy" as const,
      timeoutMs: EMBEDDING_TIMEOUT_MS
    })
  ]);
}

export function knowledgeProfileConfiguration(
  input: Readonly<{ embeddingProviderModelId: string } & Record<string, unknown>>
): Prisma.InputJsonObject {
  return {
    operationRoles: profileOperationRoles(input.embeddingProviderModelId) as unknown as
      Prisma.InputJsonArray,
    rolePolicyVersion: KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION,
    schemaVersion: 5
  };
}

export function knowledgeProfileEgressPolicy(
  input: Readonly<{ embeddingProviderModelId: string } & Record<string, unknown>>
): Prisma.InputJsonObject {
  return {
    operations: profileOperationRoles(input.embeddingProviderModelId) as unknown as
      Prisma.InputJsonArray,
    policyVersion: KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION
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
  profileConfiguration: unknown;
}>): boolean {
  return canonicalJson(input.profileConfiguration) === canonicalJson(
    knowledgeProfileConfiguration({
      embeddingProviderModelId: input.embeddingProviderModelId
    })
  ) && canonicalJson(input.egressPolicy) === canonicalJson(
    knowledgeProfileEgressPolicy({
      embeddingProviderModelId: input.embeddingProviderModelId
    })
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
      pin: resolved.pin,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber
    }
  };
}
