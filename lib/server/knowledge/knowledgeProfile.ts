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
export const KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v2";
export const KNOWLEDGE_PROFILE_LEGACY_EGRESS_POLICY_VERSION = "knowledge-profile-egress-v1";

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

export function knowledgeProfileConfiguration(input: Readonly<{
  candidateLimit: number;
  resultLimit: number;
  scoreThreshold: number;
  visionDestination?: KnowledgeVisionProfileDestination | null;
}>): Prisma.InputJsonObject {
  return {
    executionBudgets: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    lexicalConfiguration: "current_fts",
    parserRouting: "current",
    retrievalBudgets: {
      candidateLimit: input.candidateLimit,
      resultLimit: input.resultLimit,
      scoreThreshold: input.scoreThreshold
    },
    schemaVersion: 2,
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
  visionDestination: KnowledgeVisionProfileDestination | null = null
): Prisma.InputJsonObject {
  return {
    operations: [
      {
        operation: "embeddings",
        representations: ["document_text_chunks", "search_queries"]
      },
      ...(visionDestination ? [{
        operation: "vision_analysis",
        providerModelId: visionDestination.providerModelId,
        representations: ["visual_source_bytes", "visual_queries"]
      }] : [])
    ],
    policyVersion: KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Legacy schema-v1 profiles are deliberately asset-only. Schema-v2 pins the
 * exact optional installation vision destination into every source artifact. */
export function knowledgeVisionProfileFromConfiguration(
  value: unknown
): KnowledgeVisionProfileResolution {
  if (!record(value)) return { kind: "invalid" };
  if (value.schemaVersion === 1 && value.visualAnalysis === undefined) {
    return { kind: "asset_only" };
  }
  if (value.schemaVersion !== 2 || !("visualAnalysis" in value)) return { kind: "invalid" };
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

export function knowledgeVisionEgressApproved(
  value: unknown,
  providerModelId: string
): boolean {
  if (!record(value) || value.policyVersion !== KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION ||
    !Array.isArray(value.operations)) return false;
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
