import type { Prisma } from "@prisma/client";
import {
  loadEmbeddingProviderRole,
  ProviderAdmissionError,
  type AdmissionPrisma,
  type EmbeddingProviderAdmissionRole,
  type ProviderAdmissionRole
} from "../../providerRuntime/admission";
import {
  applySystemModelReasoningEffort,
  createSystemModelRoleResolver,
  type SystemModelRoleResolution
} from "../../providerRuntime/systemModelRole";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { SearchProbeBinding } from "../../search/probeBinding";
import type { LockedMemorySettings } from "../persistence/transaction";
import { memoryExecutionSha256 } from "./canonical";
import { memoryExecutionFailure } from "./errors";
import type { MemoryEgressConsentMode } from "./consentMode";
import {
  MEMORY_EXECUTION_ROLES,
  isMemoryEmbeddingRole,
  type MemoryExecutionRole
} from "./roles";

export const MEMORY_UTILITY_EGRESS_POLICY_VERSION = "memory-utility-egress-v1";

type MemoryPolicyPrisma = AdmissionPrisma & Pick<
  Prisma.TransactionClient,
  "systemModelPolicy"
>;

type SafeTargetAuthority = Readonly<{
  connectionId: string;
  connectionVersion: number;
  credentialId: string;
  credentialVersionId: string;
  modelVersion: number;
  providerModelId: string;
}>;

export type MemoryExecutionTargetFingerprints = Readonly<{
  configFingerprint: string;
  deploymentFingerprint: string;
  modelFingerprint: string;
  providerFingerprint: string;
}>;

export type ResolvedMemoryExecutionTarget = Readonly<{
  authority: SafeTargetAuthority;
  credentialSource: "default" | "group" | "user";
  destinationFingerprint: string;
  executionTargetFingerprint: string;
  policyRevision: number | null;
  compatibilityFingerprints: MemoryExecutionTargetFingerprints;
  snapshot: ProviderExecutionSnapshot;
}>;

export type MemoryPolicyDestination =
  | Readonly<{
      kind: "AVAILABLE";
      role: MemoryExecutionRole;
      target: ResolvedMemoryExecutionTarget;
    }>
  | Readonly<{
      code: "embedding_not_configured" | "embedding_unavailable" |
        "system_model_absent" | "system_model_unavailable";
      kind: "UNAVAILABLE";
      role: MemoryExecutionRole;
      selectedProviderModelId: string | null;
    }>;

export type ResolvedMemoryUtilityPolicy = Readonly<{
  destinations: readonly MemoryPolicyDestination[];
  fingerprint: string;
  policyVersion: typeof MEMORY_UTILITY_EGRESS_POLICY_VERSION;
  targets: ReadonlyMap<MemoryExecutionRole, ResolvedMemoryExecutionTarget>;
}>;

function exactAuthority(value: SearchProbeBinding | null | undefined): SafeTargetAuthority | null {
  if (
    !value ||
    !value.connectionId ||
    !value.credentialId ||
    !value.credentialVersionId ||
    !value.providerModelId ||
    !Number.isSafeInteger(value.connectionVersion) ||
    value.connectionVersion < 1 ||
    !Number.isSafeInteger(value.modelVersion) ||
    value.modelVersion < 1
  ) {
    return null;
  }
  return {
    connectionId: value.connectionId,
    connectionVersion: value.connectionVersion,
    credentialId: value.credentialId,
    credentialVersionId: value.credentialVersionId,
    modelVersion: value.modelVersion,
    providerModelId: value.providerModelId
  };
}

function endpointOrigin(snapshot: ProviderExecutionSnapshot): string {
  try {
    return new URL(snapshot.connection.apiRoot).origin;
  } catch {
    return memoryExecutionFailure("memory_execution_target_unavailable");
  }
}

function targetFor(
  role: MemoryExecutionRole,
  admitted: ProviderAdmissionRole | EmbeddingProviderAdmissionRole,
  policyRevision: number | null,
  reasoningEffort: string | null = null
): ResolvedMemoryExecutionTarget | null {
  const authority = exactAuthority(admitted.authority);
  const snapshot = admitted.snapshot;
  if (
    !authority ||
    !snapshot.credentialId ||
    !snapshot.credentialVersionId ||
    snapshot.credentialId !== authority.credentialId ||
    snapshot.credentialVersionId !== authority.credentialVersionId ||
    snapshot.connectionId !== authority.connectionId ||
    snapshot.providerModelId !== authority.providerModelId ||
    snapshot.model.adapterKind === "fake"
  ) {
    return null;
  }

  const destination = {
    adapterKind: snapshot.model.adapterKind,
    connectionConfigurationVersion: authority.connectionVersion,
    connectionId: authority.connectionId,
    credentialDestinationId: authority.credentialId,
    destinationClass: "external" as const,
    endpointConfiguration: snapshot.connection,
    endpointOrigin: endpointOrigin(snapshot),
    logicalRole: role,
    modelConfiguration: snapshot.model,
    modelConfigurationVersion: authority.modelVersion,
    providerFamily: snapshot.providerFamily,
    providerModelId: authority.providerModelId,
    upstreamModelId: snapshot.model.upstreamModelId
  };
  const destinationFingerprint = memoryExecutionSha256(destination);
  const executionSnapshot = applySystemModelReasoningEffort(snapshot, reasoningEffort);
  return {
    authority,
    credentialSource: admitted.credentialSource,
    destinationFingerprint,
    executionTargetFingerprint: memoryExecutionSha256({
      destination,
      credentialVersionId: authority.credentialVersionId,
      policyRevision,
      snapshot: executionSnapshot
    }),
    policyRevision,
    compatibilityFingerprints: {
      configFingerprint: memoryExecutionSha256({
        connection: snapshot.connection,
        connectionVersion: authority.connectionVersion,
        model: snapshot.model,
        modelVersion: authority.modelVersion
      }),
      deploymentFingerprint: memoryExecutionSha256({
        credentialDestinationId: authority.credentialId,
        providerModelId: authority.providerModelId,
        model: snapshot.model,
        modelVersion: authority.modelVersion
      }),
      modelFingerprint: memoryExecutionSha256({
        adapterKind: snapshot.model.adapterKind,
        upstreamModelId: snapshot.model.upstreamModelId
      }),
      providerFingerprint: memoryExecutionSha256({
        connectionId: authority.connectionId,
        connectionVersion: authority.connectionVersion,
        credentialDestinationId: authority.credentialId,
        endpointConfiguration: snapshot.connection,
        providerFamily: snapshot.providerFamily
      })
    },
    snapshot: executionSnapshot
  };
}

function systemFailure(
  resolution: Extract<SystemModelRoleResolution, { ok: false }>
): "system_model_absent" | "system_model_unavailable" {
  return resolution.code;
}

export function memoryVectorSpaceFingerprint(
  target: ResolvedMemoryExecutionTarget
): string | null {
  const model = target.snapshot.model;
  if (
    model.adapterKind !== "openai_embeddings_compatible" ||
    model.modelClass !== "embedding" ||
    !model.embedding
  ) {
    return null;
  }
  return memoryExecutionSha256({
    adapterKind: model.adapterKind,
    deploymentId: target.snapshot.providerModelId,
    embedding: model.embedding,
    schemaVersion: 1,
    upstreamModelId: model.upstreamModelId
  });
}

export async function resolveCurrentMemoryUtilityPolicy(
  db: MemoryPolicyPrisma,
  userId: string,
  settings: Pick<LockedMemorySettings, "embeddingProviderModelId">
): Promise<ResolvedMemoryUtilityPolicy> {
  const systemResolution = await createSystemModelRoleResolver(db).resolve();
  let embedding: EmbeddingProviderAdmissionRole | null = null;
  let embeddingUnavailable = false;
  if (settings.embeddingProviderModelId) {
    try {
      embedding = await loadEmbeddingProviderRole(db, {
        providerModelId: settings.embeddingProviderModelId,
        userId
      });
    } catch (error) {
      if (!(error instanceof ProviderAdmissionError)) throw error;
      embeddingUnavailable = true;
    }
  }

  const targets = new Map<MemoryExecutionRole, ResolvedMemoryExecutionTarget>();
  const destinations: MemoryPolicyDestination[] = MEMORY_EXECUTION_ROLES.map((role) => {
    if (isMemoryEmbeddingRole(role)) {
      const target = embedding ? targetFor(role, embedding, null) : null;
      if (target) {
        targets.set(role, target);
        return { kind: "AVAILABLE" as const, role, target };
      }
      return {
        code: settings.embeddingProviderModelId && embeddingUnavailable
          ? "embedding_unavailable" as const
          : settings.embeddingProviderModelId
            ? "embedding_unavailable" as const
            : "embedding_not_configured" as const,
        kind: "UNAVAILABLE" as const,
        role,
        selectedProviderModelId: settings.embeddingProviderModelId
      };
    }

    const target = systemResolution.ok
      ? targetFor(
          role,
          systemResolution.role,
          systemResolution.policyVersion,
          systemResolution.reasoningEffort
        )
      : null;
    if (target) {
      targets.set(role, target);
      return { kind: "AVAILABLE" as const, role, target };
    }
    return {
      code: systemResolution.ok ? "system_model_unavailable" : systemFailure(systemResolution),
      kind: "UNAVAILABLE" as const,
      role,
      selectedProviderModelId: systemResolution.ok
        ? systemResolution.providerModelId
        : null
    };
  });

  const safeDestinations = destinations.map((destination) => destination.kind === "AVAILABLE"
    ? {
        destinationFingerprint: destination.target.destinationFingerprint,
        kind: destination.kind,
        role: destination.role
      }
    : destination);
  return Object.freeze({
    destinations: Object.freeze(destinations),
    fingerprint: memoryExecutionSha256({
      destinations: safeDestinations,
      policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
    }),
    policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    targets,
  });
}

export function requireMemoryPolicyTarget(
  policy: ResolvedMemoryUtilityPolicy,
  role: MemoryExecutionRole
): ResolvedMemoryExecutionTarget {
  return policy.targets.get(role) ??
    memoryExecutionFailure("memory_execution_target_unavailable");
}

export function requireAcceptedMemoryUtilityPolicy(
  settings: Pick<
    LockedMemorySettings,
    "acceptedUtilityEgressAt" |
    "acceptedUtilityEgressFingerprint" |
    "acceptedUtilityPolicyVersion"
  >,
  policy: ResolvedMemoryUtilityPolicy,
  consentMode: MemoryEgressConsentMode
): void {
  if (consentMode === "ADMIN") return;
  if (
    !settings.acceptedUtilityEgressAt ||
    settings.acceptedUtilityPolicyVersion !== policy.policyVersion ||
    settings.acceptedUtilityEgressFingerprint !== policy.fingerprint
  ) {
    return memoryExecutionFailure("memory_execution_egress_consent_required");
  }
}
