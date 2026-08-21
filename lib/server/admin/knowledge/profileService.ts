import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminKnowledgeProfileDestination,
  AdminKnowledgeProfileRevision,
  AdminKnowledgeProfileSettings
} from "../../../contracts/adminKnowledge";
import {
  loadProjectEmbeddingProviderRole,
  ProviderAdmissionError
} from "../../providerRuntime/admission";
import {
  normalizeProviderModelConfiguration,
  ProviderConfigurationError
} from "../../providers/providerConfiguration";
import {
  KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  createKnowledgeVectorSpacePin,
  type KnowledgeVectorSpacePin
} from "../../knowledge/indexProfile";
import {
  KNOWLEDGE_INDEX_PROFILE_ID,
  isCurrentKnowledgeProfilePolicy,
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "../../knowledge/knowledgeProfile";
import { scheduleKnowledgeProfileMigration } from "../../knowledge/profileMigration";

export type AdminKnowledgeProfileServiceErrorCode =
  | "knowledge_profile_destination_unavailable"
  | "knowledge_profile_revision_unavailable"
  | "knowledge_profile_stale";

export class AdminKnowledgeProfileServiceError extends Error {
  constructor(readonly code: AdminKnowledgeProfileServiceErrorCode) {
    super(code);
    this.name = "AdminKnowledgeProfileServiceError";
  }
}

const revisionInclude = {
  embeddingProviderModel: {
    include: { connection: { select: { displayName: true } } }
  }
} satisfies Prisma.KnowledgeIndexProfileRevisionInclude;

type RevisionRecord = Prisma.KnowledgeIndexProfileRevisionGetPayload<{
  include: typeof revisionInclude;
}>;

function destination(revision: RevisionRecord): AdminKnowledgeProfileDestination {
  return {
    connectionDisplayName: revision.embeddingProviderModel.connection.displayName,
    deploymentId: revision.embeddingProviderModelId,
    modelDisplayName: revision.embeddingProviderModel.displayName,
    provider: revision.embeddingProviderModel.provider,
    targetDimension: revision.targetDimension
  };
}

function revisionProjection(revision: RevisionRecord): AdminKnowledgeProfileRevision {
  return {
    activatedAt: revision.activatedAt.toISOString(),
    destination: destination(revision),
    executionAuthority: revision.executionAuthority,
    id: revision.id,
    revisionNumber: revision.revisionNumber
  };
}

function destinationLabel(value: AdminKnowledgeProfileDestination): string {
  return `${value.connectionDisplayName} / ${value.modelDisplayName}`;
}

function isRetryableSerialization(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function availabilityFailure(error: unknown): boolean {
  return error instanceof ProviderAdmissionError || error instanceof ProviderConfigurationError ||
    error instanceof Error && error.message === "provider_execution_snapshot_invalid";
}

async function serializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < 2 && isRetryableSerialization(error)) continue;
      throw error;
    }
  }
  throw new Error("knowledge_profile_serializable_retry_exhausted");
}

type InstallationDestinationResolver = (
  client: Prisma.TransactionClient | PrismaClient,
  deploymentId: string
) => Promise<Readonly<{ pin: KnowledgeVectorSpacePin }> | null>;

export function createAdminKnowledgeProfileService(
  prisma: PrismaClient,
  options: Readonly<{
    resolveInstallationDestination?: InstallationDestinationResolver;
    scheduleMigration?: typeof scheduleKnowledgeProfileMigration;
  }> = {}
) {
  const defaultInstallationDestination: InstallationDestinationResolver = async (
    client: Prisma.TransactionClient | PrismaClient,
    deploymentId: string
  ) => {
    try {
      const role = await loadProjectEmbeddingProviderRole(client, {
        providerModelId: deploymentId
      });
      const pin = createKnowledgeVectorSpacePin({
        configuration: role.configuration,
        deploymentId
      });
      return pin?.indexSupported ? { pin } : null;
    } catch (error) {
      if (availabilityFailure(error)) return null;
      throw error;
    }
  };
  const installationDestination = options.resolveInstallationDestination ??
    defaultInstallationDestination;
  const scheduleMigration = options.scheduleMigration ?? scheduleKnowledgeProfileMigration;

  async function listAvailableDestinations(): Promise<AdminKnowledgeProfileDestination[]> {
    const models = await prisma.providerModel.findMany({
      include: { connection: { select: { displayName: true } } },
      orderBy: [
        { connection: { displayName: "asc" } },
        { displayName: "asc" },
        { id: "asc" }
      ],
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          enabled: true
        },
        enabled: true,
        modelClass: "embedding"
      }
    });
    const candidates = await Promise.all(models.map(async (model) => {
      const resolved = await installationDestination(prisma, model.id);
      return resolved ? {
        connectionDisplayName: model.connection.displayName,
        deploymentId: model.id,
        modelDisplayName: model.displayName,
        provider: model.provider,
        targetDimension: resolved.pin.targetDimension
      } satisfies AdminKnowledgeProfileDestination : null;
    }));
    return candidates.filter((candidate): candidate is AdminKnowledgeProfileDestination =>
      candidate !== null);
  }

  function legacyRevisionAvailable(revision: RevisionRecord): boolean {
    const model = revision.embeddingProviderModel;
    if (!model.enabled || model.activeVersion < 1 || model.activeConfig === null) return false;
    try {
      const pin = createKnowledgeVectorSpacePin({
        configuration: normalizeProviderModelConfiguration(model.activeConfig),
        deploymentId: model.id
      });
      return Boolean(pin?.indexSupported &&
        pin.fingerprint === revision.vectorSpaceFingerprint.trim() &&
        pin.targetDimension === revision.targetDimension);
    } catch {
      return false;
    }
  }

  return {
    async activate(input: Readonly<{
      deploymentId: string;
      expectedVersion: number;
      now?: Date;
      userId: string;
    }>): Promise<void> {
      const now = input.now ?? new Date();
      await serializable(() => prisma.$transaction(async (tx) => {
        const profile = await tx.knowledgeIndexProfile.findUnique({
          select: { version: true },
          where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
        });
        if (!profile || profile.version !== input.expectedVersion) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
        }
        const resolved = await installationDestination(tx, input.deploymentId);
        if (!resolved) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_destination_unavailable");
        }
        const lastRevision = await tx.knowledgeIndexProfileRevision.findFirst({
          orderBy: { revisionNumber: "desc" },
          select: { revisionNumber: true },
          where: { profileId: KNOWLEDGE_INDEX_PROFILE_ID }
        });
        const revision = await tx.knowledgeIndexProfileRevision.create({
          data: {
            activatedAt: now,
            chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
            egressPolicy: knowledgeProfileEgressPolicy({
              embeddingProviderModelId: input.deploymentId
            }),
            embeddingConfiguration: resolved.pin.configuration as unknown as Prisma.InputJsonValue,
            embeddingProviderModelId: input.deploymentId,
            executionAuthority: "installation",
            preflightCheckedAt: now,
            preflightErrorCode: null,
            preflightStatus: "ready",
            profileConfiguration: knowledgeProfileConfiguration({
              embeddingProviderModelId: input.deploymentId
            }),
            profileId: KNOWLEDGE_INDEX_PROFILE_ID,
            revisionNumber: (lastRevision?.revisionNumber ?? 0) + 1,
            targetDimension: resolved.pin.targetDimension,
            vectorSpaceFingerprint: resolved.pin.fingerprint
          },
          select: { id: true }
        });
        const updated = await tx.knowledgeIndexProfile.updateMany({
          data: {
            activeRevisionId: revision.id,
            updatedByUserId: input.userId,
            version: { increment: 1 }
          },
          where: { id: KNOWLEDGE_INDEX_PROFILE_ID, version: input.expectedVersion }
        });
        if (updated.count !== 1) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
        }
        await scheduleMigration(tx, {
          now,
          profileRevisionId: revision.id
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async list(): Promise<AdminKnowledgeProfileSettings> {
      const [profile, availableDestinations, legacyGenerations, profiledGenerations, totalBases] =
        await Promise.all([
          prisma.knowledgeIndexProfile.findUnique({
            include: {
              activeRevision: { include: revisionInclude },
              revisions: {
                include: revisionInclude,
                orderBy: { revisionNumber: "desc" },
                take: 10
              },
              updatedBy: { select: { displayName: true, id: true } }
            },
            where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
          }),
          listAvailableDestinations(),
          prisma.knowledgeIndexGeneration.count({
            where: { profileRevision: { executionAuthority: "legacy_user" } }
          }),
          prisma.knowledgeIndexGeneration.count({
            where: { profileRevisionId: { not: null } }
          }),
          prisma.knowledgeBase.count({
            where: {
              archivedAt: null,
              deletionRequestedAt: null,
              trashedAt: null
            }
          })
        ]);
      if (!profile) throw new Error("installation_knowledge_profile_missing");
      const active = profile.activeRevision;
      const [activeProfileBases, buildingProfileBases] = active
        ? await Promise.all([
            prisma.knowledgeBase.count({
              where: {
                activeIndexGeneration: { profileRevisionId: active.id, status: "active" },
                archivedAt: null,
                deletionRequestedAt: null,
                trashedAt: null
              }
            }),
            prisma.knowledgeIndexGeneration.count({
              where: {
                knowledgeBase: {
                  archivedAt: null,
                  deletionRequestedAt: null,
                  trashedAt: null
                },
                profileRevisionId: active.id,
                sourceIndexGenerationId: { not: null },
                status: "building"
              }
            })
          ])
        : [0, 0];
      let health: AdminKnowledgeProfileSettings["health"];
      if (!active) {
        health = {
          checkedAt: null,
          code: "knowledge_profile_not_configured",
          state: "not_configured"
        };
      } else if (active.preflightStatus !== "ready" || active.preflightErrorCode !== null) {
        health = {
          checkedAt: active.preflightCheckedAt.toISOString(),
          code: "knowledge_profile_unavailable",
          state: "unavailable"
        };
      } else if (active.executionAuthority === "legacy_user") {
        health = legacyRevisionAvailable(active)
          ? {
              checkedAt: active.preflightCheckedAt.toISOString(),
              code: "knowledge_profile_legacy_authority",
              state: "ready_with_warnings"
            }
          : {
              checkedAt: active.preflightCheckedAt.toISOString(),
              code: "knowledge_profile_unavailable",
              state: "unavailable"
            };
      } else {
        const resolved = await installationDestination(prisma, active.embeddingProviderModelId);
        const ready = Boolean(resolved &&
          resolved.pin.fingerprint === active.vectorSpaceFingerprint.trim() &&
          resolved.pin.targetDimension === active.targetDimension);
        if (!ready) {
          health = {
            checkedAt: active.preflightCheckedAt.toISOString(),
            code: "knowledge_profile_unavailable",
            state: "unavailable"
          };
        } else {
          health = { checkedAt: active.preflightCheckedAt.toISOString(), code: null, state: "ready" };
        }
      }
      const activeDestination = active ? destination(active) : null;
      return {
        activeRevision: active ? revisionProjection(active) : null,
        availableDestinations,
        egress: {
          destination: activeDestination ? destinationLabel(activeDestination) : null,
          representations: ["document_text_chunks", "search_queries"]
        },
        health,
        migration: {
          activeProfileBases,
          buildingProfileBases,
          legacyGenerations,
          profiledGenerations,
          totalBases
        },
        recentRevisions: profile.revisions
          .filter((revision) => isCurrentKnowledgeProfilePolicy({
            egressPolicy: revision.egressPolicy,
            embeddingProviderModelId: revision.embeddingProviderModelId,
            profileConfiguration: revision.profileConfiguration
          }))
          .map(revisionProjection),
        updatedAt: profile.updatedAt.toISOString(),
        updatedBy: profile.updatedBy,
        version: profile.version
      };
    },

    async rollback(input: Readonly<{
      expectedVersion: number;
      now?: Date;
      revisionId: string;
      userId: string;
    }>): Promise<void> {
      const now = input.now ?? new Date();
      await serializable(() => prisma.$transaction(async (tx) => {
        const [profile, revision] = await Promise.all([
          tx.knowledgeIndexProfile.findUnique({
            select: { activeRevisionId: true, version: true },
            where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
          }),
          tx.knowledgeIndexProfileRevision.findFirst({
            where: { id: input.revisionId, profileId: KNOWLEDGE_INDEX_PROFILE_ID }
          })
        ]);
        if (!profile || profile.version !== input.expectedVersion) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
        }
        if (!revision || revision.executionAuthority !== "installation" ||
          revision.preflightStatus !== "ready" || revision.preflightErrorCode !== null ||
          !isCurrentKnowledgeProfilePolicy({
            egressPolicy: revision.egressPolicy,
            embeddingProviderModelId: revision.embeddingProviderModelId,
            profileConfiguration: revision.profileConfiguration
          })) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
        }
        const resolved = await installationDestination(tx, revision.embeddingProviderModelId);
        if (!resolved || resolved.pin.fingerprint !== revision.vectorSpaceFingerprint.trim() ||
          resolved.pin.targetDimension !== revision.targetDimension) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
        }
        if (profile.activeRevisionId === revision.id) {
          await scheduleMigration(tx, { now, profileRevisionId: revision.id });
          return;
        }
        const updated = await tx.knowledgeIndexProfile.updateMany({
          data: {
            activeRevisionId: revision.id,
            updatedByUserId: input.userId,
            version: { increment: 1 }
          },
          where: { id: KNOWLEDGE_INDEX_PROFILE_ID, version: input.expectedVersion }
        });
        if (updated.count !== 1) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
        }
        await scheduleMigration(tx, { now, profileRevisionId: revision.id });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    }
  };
}
