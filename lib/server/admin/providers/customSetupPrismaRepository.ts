import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveEntitlements } from "../../auth/entitlements";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../../auth/fullAccessGroup";
import {
  filterAvailableProviderModels,
  filterExposedProviderModels,
  type CatalogProviderModelRow
} from "../../catalog/prismaCatalogData";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { searchDraftHash } from "../../search/configuration";
import { searchValidationFingerprint } from "../../search/probeBinding";
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

function modelColumns(configuration: ProviderModelConfiguration) {
  return {
    capabilities: json(configuration.capabilities),
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
      where: { enabled: true, modelClass: "answer", connection: { enabled: true } }
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

function validateSearchPlan(plan: AdminProviderCustomSetupCommitPlan): void {
  const search = plan.search;
  if (!search) return;
  const primaryModel = plan.models[0];
  const connectionId = plan.connection.id;
  if (
    !primaryModel ||
    primaryModel.configuration.adapterKind !== "openai_responses_compatible" ||
    primaryModel.configuration.capabilities.nativeSearch !== true ||
    search.optionId !== `custom-web-search:${connectionId}` ||
    search.optionRowId !== `custom-web-search-option:${connectionId}` ||
    search.hosted.id !== `custom-web-search-hosted:${connectionId}` ||
    search.hosted.strategyId !== search.hosted.id ||
    search.client.id !== `custom-web-search-client:${connectionId}` ||
    search.client.strategyId !== search.client.id ||
    search.displayName.length < 1 ||
    search.displayName.length > 160 ||
    search.description.length < 1 ||
    search.description.length > 500 ||
    search.evidence.method !== "configuration" ||
    search.evidence.protocol !== "openai_responses_web_search" ||
    search.evidence.status !== "available" ||
    search.evidence.normalizedSourceCount !== 0 ||
    search.hosted.draft.adapterKind !== "answer_provider_hosted" ||
    search.hosted.draft.credentialMode !== "answer_provider" ||
    search.hosted.draft.protocol !== "openai_responses_web_search" ||
    search.hosted.draft.providerModelId !== null ||
    search.client.draft.adapterKind !== "provider_model_client" ||
    search.client.draft.credentialMode !== "provider_model" ||
    search.client.draft.protocol !== "openai_responses_web_search" ||
    search.client.draft.providerModelId !== primaryModel.id ||
    searchDraftHash(search.hosted.draft) !== search.hosted.draftHash ||
    searchDraftHash(search.client.draft) !== search.client.draftHash
  ) {
    throw new CustomSetupCatalogUnavailableError();
  }
}

async function createSearchGraph(
  tx: Prisma.TransactionClient,
  plan: AdminProviderCustomSetupCommitPlan
): Promise<"needs_attention" | "ready" | null> {
  const search = plan.search;
  if (!search) return null;
  const primaryModel = plan.models[0]!;

  await tx.searchOption.create({
    data: {
      description: search.description,
      displayName: search.displayName,
      enabled: true,
      id: search.optionRowId,
      kind: "web_search",
      optionId: search.optionId,
      sourceConnectionId: plan.connection.id
    }
  });

  const routes = [
    {
      ...search.hosted,
      kind: "openai_native_web_search",
      modelId: null,
      providerModelId: null
    },
    {
      ...search.client,
      kind: "provider_model_web_search",
      modelId: primaryModel.configuration.upstreamModelId,
      providerModelId: primaryModel.id
    }
  ] as const;
  for (const route of routes) {
    const routeEvidence = search.evidence;
    const validationFingerprint = searchValidationFingerprint(routeEvidence);
    await tx.searchStrategy.create({
      data: {
        adapterKind: route.draft.adapterKind,
        config: json(route.draft),
        credentialMode: route.draft.credentialMode,
        description: search.description,
        displayName: search.displayName,
        draft: json(route.draft),
        draftTestEvidence: json(routeEvidence),
        enabled: true,
        id: route.id,
        kind: route.kind,
        modelId: route.modelId,
        provider: "openai_compatible",
        providerModelId: route.providerModelId,
        searchOptionId: search.optionRowId,
        strategyId: route.strategyId,
        testedDraftHash: route.draftHash
      }
    });
    await tx.searchIntegrationRevision.create({
      data: {
        adapterKind: route.draft.adapterKind,
        configuration: json(route.draft),
        credentialMode: route.draft.credentialMode,
        draftHash: route.draftHash,
        id: route.revisionId,
        providerModelId: route.providerModelId,
        revisionNumber: 1,
        searchStrategyId: route.id,
        validationEvidence: json(routeEvidence),
        validationFingerprint
      }
    });
    await tx.searchStrategy.update({
      data: {
        activatedAt: plan.now,
        activeRevisionId: route.revisionId
      },
      where: { id: route.id }
    });
  }

  await tx.accessGrant.create({
    data: {
      enabled: true,
      groupId: null,
      id: search.grantId,
      providerConnectionId: null,
      providerModelId: null,
      searchStrategy: search.optionId,
      userId: plan.actor.userId
    }
  });
  return "ready";
}

async function applyCustomSetupPlan(
  tx: Prisma.TransactionClient,
  plan: AdminProviderCustomSetupCommitPlan,
  exposeFake: boolean
): Promise<Exclude<AdminProviderCustomSetupCommitResult, "catalog_unavailable">> {
  await lockActorState(tx, plan);
  validateSearchPlan(plan);
  if (plan.models.length === 0) throw new CustomSetupCatalogUnavailableError();
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
      select: { id: true },
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
  for (const model of plan.models) {
    await tx.providerModel.create({
      data: {
        activatedAt: plan.now,
        activeConfig: json(model.configuration),
        activeVersion: 1,
        connectionId: plan.connection.id,
        displayName: model.displayName,
        draftConfig: json(model.configuration),
        draftVersion: 1,
        enabled: true,
        id: model.id,
        provider: "openai_compatible",
        ...modelColumns(model.configuration)
      }
    });
  }
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
  for (const model of plan.models) {
    await tx.providerModelCredentialCheck.create({
      data: {
        checkedAt: plan.checkedAt,
        connectionId: plan.connection.id,
        connectionVersion: 1,
        credentialId: plan.credential.id,
        credentialVersionId: plan.credential.versionId,
        evidence: json(model.evidence),
        modelVersion: 1,
        providerModelId: model.id,
        status: "available"
      }
    });
    await tx.accessGrant.create({
      data: {
        enabled: true,
        groupId: null,
        id: model.grantId,
        providerConnectionId: null,
        providerModelId: model.id,
        searchStrategy: null,
        userId: plan.actor.userId
      }
    });
  }
  const search = await createSearchGraph(tx, plan);

  const eligibleModelIds = await eligibleProviderModelIds(
    tx,
    plan.actor.userId,
    exposeFake
  );
  if (plan.models.some((model) => !eligibleModelIds.has(model.id))) {
    throw new CustomSetupCatalogUnavailableError();
  }
  return {
    defaultChanged: false,
    ...(plan.search ? { search } : {}),
    status: "ready"
  };
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
