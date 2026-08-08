import type { PrismaClient } from "@prisma/client";
import { resolveEntitlements } from "../auth/entitlements";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "../auth/fullAccessGroup";
import { resolveEffectiveModelDefaultId } from "../catalog/currentUserCatalog";
import {
  exposeFakeProvider,
  filterAvailableProviderModels,
  filterExposedProviderModels,
  providerModelCatalogAuthorityInclude,
  providerModelToCatalogEntry,
  type CatalogProviderModelRow
} from "../catalog/prismaCatalogData";

type ChatCreationDefaultsPrisma = Pick<
  PrismaClient,
  | "accessGrant"
  | "modelPolicy"
  | "providerModel"
  | "userGroup"
  | "userSettings"
>;

export type ChatCreationDefaults = Readonly<{
  defaultFolderId: string | null;
  defaultProviderModelId: string | null;
}>;

export async function loadChatCreationDefaults(
  db: ChatCreationDefaultsPrisma,
  userId: string,
  env: Record<string, string | undefined> = process.env
): Promise<ChatCreationDefaults | null> {
  const [settings, policy] = await Promise.all([
    db.userSettings.findUnique({
      select: {
        defaultFolderId: true,
        defaultProviderModelId: true
      },
      where: { userId }
    }),
    db.modelPolicy.findUnique({
      select: { defaultProviderModelId: true },
      where: { id: "installation" }
    })
  ]);
  if (!settings) return null;

  const selectedModelId = resolveEffectiveModelDefaultId({
    organizationModelId: policy?.defaultProviderModelId ?? null,
    personalModelId: settings.defaultProviderModelId
  });
  if (!selectedModelId) {
    return {
      defaultFolderId: settings.defaultFolderId,
      defaultProviderModelId: null
    };
  }

  const [memberships, grants, model] = await Promise.all([
    db.userGroup.findMany({
      include: {
        group: {
          select: {
            archivedAt: true,
            systemRole: true
          }
        }
      },
      where: { userId }
    }),
    db.accessGrant.findMany({
      include: {
        providerModel: {
          select: { connectionId: true }
        }
      },
      where: {
        AND: [
          {
            OR: [
              { userId },
              { group: { archivedAt: null, users: { some: { userId } } } }
            ]
          },
          {
            OR: [
              { providerModelId: selectedModelId },
              {
                providerConnection: {
                  models: { some: { id: selectedModelId } }
                }
              }
            ]
          }
        ],
        enabled: true
      }
    }),
    db.providerModel.findFirst({
      include: providerModelCatalogAuthorityInclude(userId),
      where: {
        connection: { enabled: true },
        enabled: true,
        id: selectedModelId,
        modelClass: "answer"
      }
    })
  ]);
  if (!model) {
    return {
      defaultFolderId: settings.defaultFolderId,
      defaultProviderModelId: null
    };
  }

  const activeMemberships = memberships.filter(
    (membership) => membership.group.archivedAt === null
  );
  const groupIds = activeMemberships.map((membership) => membership.groupId);
  const entitlements = resolveEntitlements(
    userId,
    groupIds,
    grants.map((grant) => ({
      ...grant,
      providerModelConnectionId: grant.providerModel?.connectionId ?? null
    })),
    {
      fullAccess: activeMemberships.some(
        (membership) =>
          membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
      )
    }
  );
  const available = filterAvailableProviderModels({
    exposeFake: exposeFakeProvider(env),
    memberships,
    models: [model as CatalogProviderModelRow],
    userId
  });
  const exposed = filterExposedProviderModels({
    entitlements,
    models: available
  });
  const catalogModel = exposed[0]
    ? providerModelToCatalogEntry(exposed[0])
    : null;

  return {
    defaultFolderId: settings.defaultFolderId,
    defaultProviderModelId: catalogModel?.modelId === selectedModelId
      ? selectedModelId
      : null
  };
}
