import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminKnowledgePdfProcessingDestination,
  AdminKnowledgePdfProcessingMode,
  AdminKnowledgeProfileDestination,
  AdminKnowledgeProfileRevision,
  AdminKnowledgeProfileSettings
} from "../../../contracts/adminKnowledge";
import {
  KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  createKnowledgeVectorSpacePin,
  type KnowledgeVectorSpacePin
} from "../../knowledge/indexProfile";
import {
  KNOWLEDGE_INDEX_PROFILE_ID,
  KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
  isCurrentKnowledgeProfilePolicy,
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "../../knowledge/knowledgeProfile";
import { scheduleKnowledgeProfileMigration } from "../../knowledge/profileMigration";
import {
  loadProjectEmbeddingProviderRole,
  ProviderAdmissionError
} from "../../providerRuntime/admission";
import { createAcceptedProviderRequestExecutor } from "../../providerRuntime/acceptedRequestExecutor";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";
import {
  normalizeProviderModelConfiguration,
  ProviderConfigurationError
} from "../../providers/providerConfiguration";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
import { createProviderVisionInputProbe } from "../../providers/visionInputProbe";

export type AdminKnowledgeProfileServiceErrorCode =
  | "knowledge_pdf_processing_mode_unavailable"
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

type ProcessingClient = Prisma.TransactionClient | PrismaClient;

type SystemModelPin = Readonly<{
  policyVersion: number;
  snapshot: ProviderExecutionSnapshot;
}>;

type InstallationDestinationResolver = (
  client: ProcessingClient,
  deploymentId: string
) => Promise<Readonly<{ pin: KnowledgeVectorSpacePin }> | null>;

type SystemModelResolver = (client: ProcessingClient) => Promise<SystemModelPin | null>;

type VisionProbe = (
  snapshot: ProviderExecutionSnapshot,
  signal?: AbortSignal
) => Promise<boolean>;

function embeddingDestination(revision: RevisionRecord): AdminKnowledgeProfileDestination {
  return {
    connectionDisplayName: revision.embeddingProviderModel.connection.displayName,
    deploymentId: revision.embeddingProviderModelId,
    modelDisplayName: revision.embeddingProviderModel.displayName,
    provider: revision.embeddingProviderModel.provider,
    targetDimension: revision.targetDimension
  };
}

function processingDestination(
  snapshot: ProviderExecutionSnapshot
): AdminKnowledgePdfProcessingDestination {
  return {
    connectionDisplayName: snapshot.connectionDisplayName,
    deploymentId: snapshot.providerModelId,
    modelDisplayName: snapshot.modelDisplayName,
    provider: snapshot.providerFamily,
    upstreamModelId: snapshot.model.upstreamModelId
  };
}

function revisionSnapshot(revision: Readonly<{
  pdfProcessingMode: AdminKnowledgePdfProcessingMode;
  pdfSystemModelPolicyVersion: number | null;
  pdfSystemModelSnapshot: unknown;
}>): SystemModelPin | null {
  if (revision.pdfProcessingMode === "local") return null;
  if (!Number.isSafeInteger(revision.pdfSystemModelPolicyVersion) ||
    Number(revision.pdfSystemModelPolicyVersion) < 1 ||
    revision.pdfSystemModelSnapshot === null) return null;
  try {
    return {
      policyVersion: Number(revision.pdfSystemModelPolicyVersion),
      snapshot: normalizeProviderExecutionSnapshot(revision.pdfSystemModelSnapshot)
    };
  } catch {
    return null;
  }
}

function revisionProjection(revision: RevisionRecord): AdminKnowledgeProfileRevision {
  const pin = revisionSnapshot(revision);
  if (revision.pdfProcessingMode !== "local" && !pin) {
    throw new Error("knowledge_profile_processing_snapshot_invalid");
  }
  return {
    activatedAt: revision.activatedAt.toISOString(),
    destination: embeddingDestination(revision),
    executionAuthority: revision.executionAuthority,
    id: revision.id,
    pdfProcessing: {
      destination: pin ? processingDestination(pin.snapshot) : null,
      mode: revision.pdfProcessingMode,
      parserProfileVersion: revision.pdfParserProfileVersion
    },
    revisionNumber: revision.revisionNumber
  };
}

function destinationLabel(value: Readonly<{
  connectionDisplayName: string;
  modelDisplayName: string;
}>): string {
  return `${value.connectionDisplayName} / ${value.modelDisplayName}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function samePin(left: SystemModelPin, right: SystemModelPin): boolean {
  return left.policyVersion === right.policyVersion &&
    canonicalJson(left.snapshot) === canonicalJson(right.snapshot);
}

function supportsMode(pin: SystemModelPin, mode: AdminKnowledgePdfProcessingMode): boolean {
  if (mode === "local") return true;
  return mode === "system_model_direct_pdf"
    ? pin.snapshot.model.capabilities.nativePdfInput === true
    : pin.snapshot.model.capabilities.vision === true;
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

export function createAdminKnowledgeProfileService(
  prisma: PrismaClient,
  options: Readonly<{
    probeVision?: VisionProbe;
    resolveInstallationDestination?: InstallationDestinationResolver;
    resolveSystemModel?: SystemModelResolver;
    scheduleMigration?: typeof scheduleKnowledgeProfileMigration;
  }> = {}
) {
  const defaultInstallationDestination: InstallationDestinationResolver = async (
    client,
    deploymentId
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
  const defaultSystemModel: SystemModelResolver = async (client) => {
    const resolved = await createSystemModelRoleResolver(client).resolve();
    if (!resolved.ok) return null;
    try {
      return {
        policyVersion: resolved.policyVersion,
        snapshot: normalizeProviderExecutionSnapshot(resolved.role.snapshot)
      };
    } catch {
      return null;
    }
  };
  const execute = createAcceptedProviderRequestExecutor(prisma);
  const defaultVisionProbe = createProviderVisionInputProbe({ execute }).probe;
  const installationDestination = options.resolveInstallationDestination ??
    defaultInstallationDestination;
  const resolveSystemModel = options.resolveSystemModel ?? defaultSystemModel;
  const probeVision = options.probeVision ?? defaultVisionProbe;
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

  function currentPolicy(revision: RevisionRecord): boolean {
    return isCurrentKnowledgeProfilePolicy({
      egressPolicy: revision.egressPolicy,
      embeddingProviderModelId: revision.embeddingProviderModelId,
      pdfProcessingMode: revision.pdfProcessingMode,
      pdfSystemModelSnapshot: revision.pdfSystemModelSnapshot,
      profileConfiguration: revision.profileConfiguration
    });
  }

  function legacyRevisionAvailable(revision: RevisionRecord): boolean {
    const model = revision.embeddingProviderModel;
    if (!model.enabled || model.activeVersion < 1 || model.activeConfig === null ||
      revision.pdfProcessingMode !== "local") return false;
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

  async function processingSnapshotAvailable(
    client: ProcessingClient,
    pin: SystemModelPin,
    mode: AdminKnowledgePdfProcessingMode
  ): Promise<boolean> {
    if (!supportsMode(pin, mode) || !pin.snapshot.credentialId ||
      !pin.snapshot.credentialVersionId) return false;
    const version = await client.providerCredentialVersion.findUnique({
      select: { credentialId: true, id: true, revokedAt: true },
      where: { id: pin.snapshot.credentialVersionId }
    });
    return Boolean(version && !version.revokedAt &&
      version.id === pin.snapshot.credentialVersionId &&
      version.credentialId === pin.snapshot.credentialId);
  }

  async function processingPreflight(
    mode: AdminKnowledgePdfProcessingMode
  ): Promise<SystemModelPin | null> {
    if (mode === "local") return null;
    let pin: SystemModelPin | null;
    try {
      pin = await resolveSystemModel(prisma);
    } catch {
      pin = null;
    }
    if (!pin || !supportsMode(pin, mode) ||
      !await processingSnapshotAvailable(prisma, pin, mode)) {
      throw new AdminKnowledgeProfileServiceError("knowledge_pdf_processing_mode_unavailable");
    }
    if (mode === "system_model_vision") {
      let verified = false;
      try {
        verified = await probeVision(pin.snapshot);
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new AdminKnowledgeProfileServiceError("knowledge_pdf_processing_mode_unavailable");
      }
    }
    return pin;
  }

  async function validRevisionForRollback(revision: RevisionRecord): Promise<SystemModelPin | null> {
    if (revision.executionAuthority !== "installation" ||
      revision.preflightStatus !== "ready" || revision.preflightErrorCode !== null ||
      !currentPolicy(revision)) {
      throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
    }
    const resolved = await installationDestination(prisma, revision.embeddingProviderModelId);
    if (!resolved || resolved.pin.fingerprint !== revision.vectorSpaceFingerprint.trim() ||
      resolved.pin.targetDimension !== revision.targetDimension) {
      throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
    }
    if (revision.pdfProcessingMode === "local") return null;
    const pin = revisionSnapshot(revision);
    if (!pin || !await processingSnapshotAvailable(prisma, pin, revision.pdfProcessingMode)) {
      throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
    }
    if (revision.pdfProcessingMode === "system_model_vision") {
      let verified = false;
      try {
        verified = await probeVision(pin.snapshot);
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
      }
    }
    return pin;
  }

  return {
    async activate(input: Readonly<{
      deploymentId: string;
      expectedVersion: number;
      now?: Date;
      pdfProcessingMode: AdminKnowledgePdfProcessingMode;
      userId: string;
    }>): Promise<void> {
      let processingPin: SystemModelPin | null = null;
      if (input.pdfProcessingMode !== "local") {
        const before = await prisma.knowledgeIndexProfile.findUnique({
          select: { version: true },
          where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
        });
        if (!before || before.version !== input.expectedVersion) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
        }
        processingPin = await processingPreflight(input.pdfProcessingMode);
      }
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
        if (processingPin) {
          const currentPin = await resolveSystemModel(tx);
          if (!currentPin || !samePin(processingPin, currentPin) ||
            !supportsMode(currentPin, input.pdfProcessingMode) ||
            !await processingSnapshotAvailable(tx, currentPin, input.pdfProcessingMode)) {
            throw new AdminKnowledgeProfileServiceError(
              "knowledge_pdf_processing_mode_unavailable"
            );
          }
        }
        const processingProviderModelId = processingPin?.snapshot.providerModelId ?? null;
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
              embeddingProviderModelId: input.deploymentId,
              pdfProcessingMode: input.pdfProcessingMode,
              pdfSystemModelProviderModelId: processingProviderModelId
            }),
            embeddingConfiguration: resolved.pin.configuration as unknown as Prisma.InputJsonValue,
            embeddingProviderModelId: input.deploymentId,
            executionAuthority: "installation",
            pdfParserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
            pdfProcessingMode: input.pdfProcessingMode,
            pdfSystemModelPolicyVersion: processingPin?.policyVersion ?? null,
            pdfSystemModelSnapshot: processingPin
              ? processingPin.snapshot as unknown as Prisma.InputJsonValue
              : Prisma.DbNull,
            preflightCheckedAt: now,
            preflightErrorCode: null,
            preflightStatus: "ready",
            profileConfiguration: knowledgeProfileConfiguration({
              embeddingProviderModelId: input.deploymentId,
              pdfProcessingMode: input.pdfProcessingMode,
              pdfSystemModelProviderModelId: processingProviderModelId
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
        await scheduleMigration(tx, { now, profileRevisionId: revision.id });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async list(): Promise<AdminKnowledgeProfileSettings> {
      const [
        profile,
        availableDestinations,
        legacyGenerations,
        profiledGenerations,
        totalBases,
        currentSystemModel
      ] = await Promise.all([
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
          where: { archivedAt: null, deletionRequestedAt: null, trashedAt: null }
        }),
        resolveSystemModel(prisma).catch(() => null)
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
      } else if (active.preflightStatus !== "ready" || active.preflightErrorCode !== null ||
        !currentPolicy(active)) {
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
        const processingPin = revisionSnapshot(active);
        const processingReady = active.pdfProcessingMode === "local" || Boolean(
          processingPin && await processingSnapshotAvailable(
            prisma,
            processingPin,
            active.pdfProcessingMode
          )
        );
        const ready = Boolean(resolved && processingReady &&
          resolved.pin.fingerprint === active.vectorSpaceFingerprint.trim() &&
          resolved.pin.targetDimension === active.targetDimension);
        health = ready
          ? { checkedAt: active.preflightCheckedAt.toISOString(), code: null, state: "ready" }
          : {
              checkedAt: active.preflightCheckedAt.toISOString(),
              code: "knowledge_profile_unavailable",
              state: "unavailable"
            };
      }
      const activeEmbedding = active ? embeddingDestination(active) : null;
      const activeProcessingPin = active ? revisionSnapshot(active) : null;
      const activePdfDestination = activeProcessingPin
        ? processingDestination(activeProcessingPin.snapshot)
        : null;
      const representations: AdminKnowledgeProfileSettings["egress"]["representations"] = [
        "document_text_chunks",
        "search_queries",
        ...(active?.pdfProcessingMode === "system_model_direct_pdf"
          ? ["original_pdf_page_ranges" as const]
          : active?.pdfProcessingMode === "system_model_vision"
            ? ["rendered_pdf_page_images" as const]
            : [])
      ];
      return {
        activeRevision: active ? revisionProjection(active) : null,
        availableDestinations,
        egress: {
          embeddingDestination: activeEmbedding ? destinationLabel(activeEmbedding) : null,
          pdfDestination: activePdfDestination ? destinationLabel(activePdfDestination) : null,
          representations
        },
        health,
        migration: {
          activeProfileBases,
          buildingProfileBases,
          legacyGenerations,
          profiledGenerations,
          totalBases
        },
        pdfProcessingOptions: [
          { available: true, mode: "local", representation: "local_only" },
          {
            available: Boolean(currentSystemModel && supportsMode(
              currentSystemModel,
              "system_model_direct_pdf"
            )),
            mode: "system_model_direct_pdf",
            representation: "original_pdf_page_ranges"
          },
          {
            available: Boolean(currentSystemModel && supportsMode(
              currentSystemModel,
              "system_model_vision"
            )),
            mode: "system_model_vision",
            representation: "rendered_pdf_page_images"
          }
        ],
        recentRevisions: profile.revisions.filter(currentPolicy).map(revisionProjection),
        systemModelDestination: currentSystemModel
          ? processingDestination(currentSystemModel.snapshot)
          : null,
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
      const preview = await prisma.knowledgeIndexProfile.findUnique({
        include: {
          revisions: {
            include: revisionInclude,
            where: { id: input.revisionId }
          }
        },
        where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
      });
      if (!preview || preview.version !== input.expectedVersion) {
        throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
      }
      const previewRevision = preview.revisions[0];
      if (!previewRevision) {
        throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
      }
      const previewPin = await validRevisionForRollback(previewRevision);
      const now = input.now ?? new Date();
      await serializable(() => prisma.$transaction(async (tx) => {
        const [profile, revision] = await Promise.all([
          tx.knowledgeIndexProfile.findUnique({
            select: { activeRevisionId: true, version: true },
            where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
          }),
          tx.knowledgeIndexProfileRevision.findFirst({
            include: revisionInclude,
            where: { id: input.revisionId, profileId: KNOWLEDGE_INDEX_PROFILE_ID }
          })
        ]);
        if (!profile || profile.version !== input.expectedVersion) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_stale");
        }
        if (!revision || revision.executionAuthority !== "installation" ||
          revision.preflightStatus !== "ready" || revision.preflightErrorCode !== null ||
          !currentPolicy(revision)) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
        }
        const resolved = await installationDestination(tx, revision.embeddingProviderModelId);
        if (!resolved || resolved.pin.fingerprint !== revision.vectorSpaceFingerprint.trim() ||
          resolved.pin.targetDimension !== revision.targetDimension) {
          throw new AdminKnowledgeProfileServiceError("knowledge_profile_revision_unavailable");
        }
        const exactPin = revisionSnapshot(revision);
        if ((previewPin === null) !== (exactPin === null) ||
          previewPin && exactPin && !samePin(previewPin, exactPin) ||
          exactPin && !await processingSnapshotAvailable(
            tx,
            exactPin,
            revision.pdfProcessingMode
          )) {
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
