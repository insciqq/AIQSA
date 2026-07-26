import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveEntitlements } from "../../auth/entitlements";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../../auth/fullAccessGroup";
import {
  filterAvailableProviderModels,
  filterExposedProviderModels,
  type CatalogProviderModelRow
} from "../../catalog/prismaCatalogData";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import type {
  AdminProviderCustomSetupCommitPlan,
  AdminProviderCustomSetupCommitResult,
  AdminProviderCustomSetupRepository
} from "./customSetupRepositoryContract";

type CustomSetupRepositoryOptions = Readonly<{
  exposeFake?: boolean;
}>;

class CustomSetupCatalogUnavailableError extends Error {}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function modelLegacyFields(configuration: ProviderModelConfiguration) {
  return {
    capabilities: json(configuration.capabilities),
    contextWindow: configuration.capabilities.contextWindow ?? 1,
    defaultParams: json(configuration.defaultParams),
    modelId: configuration.upstreamModelId,
    supportsNativeSearch: configuration.capabilities.nativeSearch,
    supportsPdf: configuration.capabilities.pdf,
    supportsReasoning: configuration.capabilities.reasoning,
    supportsVision: configuration.capabilities.vision
  };
}

function isSerializationConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  return error.code === "P2034" || (
    error.code === "P2010" &&
    typeof error.meta === "object" &&
    error.meta !== null &&
    error.meta.code === "40001"
  );
}

async function lockActorState(
  tx: Prisma.TransactionClient,
  plan: AdminProviderCustomSetupCommitPlan
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${plan.actor.userId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "UserSettings" WHERE "userId" = ${plan.actor.userId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "AuthSession" WHERE "id" = ${plan.actor.sessionId} FOR UPDATE
  `);
}

async function eligibleProviderModelIds(
  tx: Prisma.TransactionClient,
  userId: string,
  exposeFake: boolean
): Promise<Set<string>> {
  const [memberships, grants, models] = await Promise.all([
    tx.userGroup.findMany({
      include: { group: { select: { archivedAt: true, systemRole: true } } },
      where: { userId }
    }),
    tx.accessGrant.findMany({
      include: { providerModel: { select: { connectionId: true } } },
      where: {
        OR: [
          { userId },
          { group: { archivedAt: null, users: { some: { userId } } } }
        ]
      }
    }),
    tx.providerModel.findMany({
      include: {
        activeCredentialChecks: {
          select: {
            connectionId: true,
            connectionVersion: true,
            credentialId: true,
            credentialVersionId: true,
            modelVersion: true,
            providerModelId: true,
            status: true
          }
        },
        connection: {
          include: {
            credentials: {
              select: {
                activeVersion: { select: { id: true, revokedAt: true } },
                enabled: true,
                groupAssignments: { select: { credentialId: true, groupId: true } },
                id: true,
                userAssignments: {
                  select: { credentialId: true, userId: true },
                  where: { userId }
                }
              }
            }
          }
        }
      },
      where: { enabled: true, connection: { enabled: true } }
    })
  ]);
  const activeMemberships = memberships.filter(
    (membership) => !membership.group.archivedAt
  );
  const groupIds = activeMemberships.map((membership) => membership.groupId);
  const fullAccess = activeMemberships.some(
    (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
  );
  const entitlements = resolveEntitlements(userId, groupIds, grants.map((grant) => ({
    ...grant,
    providerModelConnectionId: grant.providerModel?.connectionId ?? null
  })), { fullAccess });
  const available = filterAvailableProviderModels({
    exposeFake,
    memberships,
    models: models as CatalogProviderModelRow[],
    userId
  });
  return new Set(
    filterExposedProviderModels({ entitlements, models: available }).map(({ id }) => id)
  );
}

async function applyCustomSetupPlan(
  tx: Prisma.TransactionClient,
  plan: AdminProviderCustomSetupCommitPlan,
  exposeFake: boolean
): Promise<Exclude<AdminProviderCustomSetupCommitResult, "catalog_unavailable">> {
  await lockActorState(tx, plan);
  const [actor, session, settings] = await Promise.all([
    tx.user.findUnique({
      select: { id: true, role: true, status: true },
      where: { id: plan.actor.userId }
    }),
    tx.authSession.findUnique({
      select: { expiresAt: true, revokedAt: true, userId: true },
      where: { id: plan.actor.sessionId }
    }),
    tx.userSettings.findUnique({
      select: { defaultProviderModelId: true },
      where: { userId: plan.actor.userId }
    })
  ]);
  if (
    actor?.role !== "admin" ||
    actor.status !== "active" ||
    !settings ||
    session?.userId !== plan.actor.userId ||
    session.revokedAt ||
    session.expiresAt <= plan.now
  ) {
    return "forbidden";
  }

  await tx.providerConnection.create({
    data: {
      activatedAt: plan.now,
      activeConfig: json(plan.connection.configuration),
      activeVersion: 1,
      defaultCredentialId: null,
      displayName: plan.connection.displayName,
      draftConfig: json(plan.connection.configuration),
      draftVersion: 1,
      enabled: true,
      family: "openai_compatible",
      id: plan.connection.id,
      unassignedPolicy: "require_assignment"
    }
  });
  await tx.providerModel.create({
    data: {
      activatedAt: plan.now,
      activeConfig: json(plan.model.configuration),
      activeVersion: 1,
      connectionId: plan.connection.id,
      displayName: plan.model.displayName,
      draftConfig: json(plan.model.configuration),
      draftVersion: 1,
      enabled: true,
      id: plan.model.id,
      provider: "openai_compatible",
      ...modelLegacyFields(plan.model.configuration)
    }
  });
  await tx.providerCredential.create({
    data: {
      activatedAt: plan.now,
      connectionId: plan.connection.id,
      draftSecretEnvelope: null,
      draftVersion: 1,
      enabled: true,
      id: plan.credential.id,
      label: plan.credential.label,
      testedAt: plan.checkedAt
    }
  });
  await tx.providerCredentialVersion.create({
    data: {
      activatedAt: plan.now,
      credentialId: plan.credential.id,
      id: plan.credential.versionId,
      secretEnvelope: plan.credential.secretEnvelope,
      testEvidence: json({
        authenticationMode: plan.connection.configuration.authenticationMode,
        method: "tiny_generation",
        version: 1
      }),
      testedAt: plan.checkedAt,
      version: 1
    }
  });
  await tx.providerCredential.update({
    data: { activeVersionId: plan.credential.versionId },
    where: { id: plan.credential.id }
  });
  await tx.providerUserCredentialAssignment.create({
    data: {
      connectionId: plan.connection.id,
      credentialId: plan.credential.id,
      userId: plan.actor.userId
    }
  });
  await tx.providerModelCredentialCheck.create({
    data: {
      checkedAt: plan.checkedAt,
      connectionId: plan.connection.id,
      connectionVersion: 1,
      credentialId: plan.credential.id,
      credentialVersionId: plan.credential.versionId,
      evidence: json(plan.evidence),
      modelVersion: 1,
      providerModelId: plan.model.id,
      status: "available"
    }
  });
  await tx.accessGrant.create({
    data: {
      enabled: true,
      groupId: null,
      id: plan.grantId,
      providerConnectionId: null,
      providerModelId: plan.model.id,
      searchStrategy: null,
      userId: plan.actor.userId
    }
  });

  const eligibleModelIds = await eligibleProviderModelIds(
    tx,
    plan.actor.userId,
    exposeFake
  );
  if (!eligibleModelIds.has(plan.model.id)) {
    throw new CustomSetupCatalogUnavailableError();
  }
  const priorDefaultUsable = Boolean(
    settings.defaultProviderModelId && eligibleModelIds.has(settings.defaultProviderModelId)
  );
  const defaultChanged = !priorDefaultUsable &&
    settings.defaultProviderModelId !== plan.model.id;
  if (!priorDefaultUsable) {
    await tx.userSettings.update({
      data: { defaultProviderModelId: plan.model.id },
      where: { userId: plan.actor.userId }
    });
  }
  return { defaultChanged, status: "ready" };
}

export function createPrismaAdminProviderCustomSetupRepository(
  prisma: PrismaClient,
  options: CustomSetupRepositoryOptions = {}
): AdminProviderCustomSetupRepository {
  const exposeFake = options.exposeFake ?? false;
  return {
    async commit(plan) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await prisma.$transaction(
            (tx) => applyCustomSetupPlan(tx, plan, exposeFake),
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 30_000
            }
          );
        } catch (error) {
          if (error instanceof CustomSetupCatalogUnavailableError) {
            return "catalog_unavailable";
          }
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2002" || error.code === "P2025" ||
              isSerializationConflict(error))
          ) {
            if (isSerializationConflict(error) && attempt < 2) continue;
            return "stale";
          }
          throw error;
        }
      }
      return "stale";
    }
  };
}
