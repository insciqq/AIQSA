import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminGroupGrantChange } from "@/lib/contracts/admin";
import { adminGroupDeletionBlock } from "./adminDeletionMetadata";
import { FULL_ACCESS_GROUP_NAME } from "./fullAccessGroup";
import { adminGroupRecordInclude } from "./adminPrismaRecords";
import type { AdminRepository, AdminSetGroupGrantsResult } from "./adminRepositoryContract";
import { normalizeAdminGroupName } from "./adminRepositoryInputs";
import { serializeAdminGroup } from "./adminRepositorySerializers";

export type AdminGroupGrantCommands = Pick<
  AdminRepository,
  | "archiveGroup"
  | "createGroup"
  | "deleteEmptyGroup"
  | "renameGroup"
  | "setGroupGrants"
  | "setUserGroups"
>;

type GrantWhere = {
  groupId: string;
  providerConnectionId: string | null;
  providerModelId: string | null;
  searchStrategy: string | null;
  userId: null;
};

type GrantTransaction = Pick<Prisma.TransactionClient, "accessGrant" | "group" | "providerModel" | "searchOption">;

/** Thrown inside the grant transaction so Prisma rolls every earlier change back. */
class GroupGrantBatchRejected extends Error {
  constructor(readonly result: Exclude<AdminSetGroupGrantsResult, { kind: "applied" }>) {
    super(`group grant batch rejected: ${result.kind}`);
  }
}

const activeProviderConnection = {
  activeConfig: { not: Prisma.DbNull },
  activeVersion: { gt: 0 },
  enabled: true
} as const;

/**
 * Resolves the exact principal and target. Additions require an available
 * resource; removal also accepts disabled or archived targets.
 */
async function resolveGrantTarget(
  tx: GrantTransaction,
  groupId: string,
  change: AdminGroupGrantChange
): Promise<GrantWhere | null> {
  const searchStrategy = change.searchStrategy?.trim() || null;
  const provider = change.provider?.trim() || null;
  const modelId = change.modelId?.trim() || null;

  if (!change.enabled) {
    const where: GrantWhere = {
      groupId,
      providerConnectionId: modelId ? null : provider,
      providerModelId: modelId,
      searchStrategy,
      userId: null
    };
    const existing = await tx.accessGrant.findFirst({
      select: { providerModel: { select: { connectionId: true } } },
      where
    });
    if (existing && modelId && existing.providerModel?.connectionId !== provider) return null;
    return where;
  }

  if (searchStrategy) {
    if (searchStrategy === "search-disabled" || provider || modelId) return null;
    const option = await tx.searchOption.findFirst({
      select: { id: true },
      where: { archivedAt: null, enabled: true, optionId: searchStrategy }
    });
    if (!option) return null;
    return { groupId, providerConnectionId: null, providerModelId: null, searchStrategy, userId: null };
  }

  if (!provider) return null;

  if (modelId) {
    const model = await tx.providerModel.findFirst({
      select: { id: true },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: activeProviderConnection,
        connectionId: provider,
        enabled: true,
        id: modelId
      }
    });
    if (!model) return null;
    return { groupId, providerConnectionId: null, providerModelId: modelId, searchStrategy: null, userId: null };
  }

  const providerModels = await tx.providerModel.count({
    where: {
      activeConfig: { not: Prisma.DbNull },
      activeVersion: { gt: 0 },
      connection: activeProviderConnection,
      connectionId: provider,
      enabled: true
    }
  });
  if (providerModels === 0) return null;
  return { groupId, providerConnectionId: provider, providerModelId: null, searchStrategy: null, userId: null };
}

function reservedFullAccessName(name: string): boolean {
  return name.toLowerCase() === FULL_ACCESS_GROUP_NAME.toLowerCase();
}

export function createAdminGroupGrantCommands(prisma: PrismaClient): AdminGroupGrantCommands {
  return {
    async archiveGroup(groupId) {
      return prisma.$transaction(async (tx) => {
        const group = await tx.group.findFirst({
          select: {
            mcpGrants: {
              select: { serverId: true },
              where: { canUse: true }
            },
            systemRole: true,
            users: { select: { userId: true } }
          },
          where: { archivedAt: null, id: groupId }
        });
        if (!group || group.systemRole === "full_access") return false;

        await tx.group.update({
          data: { archivedAt: new Date() },
          where: { id: groupId }
        });

        const serverIds = [...new Set(group.mcpGrants.map((grant) => grant.serverId))];
        for (const membership of group.users) {
          if (serverIds.length) {
            await tx.mcpUserServer.updateMany({
              data: { desiredRuntimeGenerationId: null },
              where: { serverId: { in: serverIds }, userId: membership.userId }
            });
          }
          for (const serverId of serverIds) {
            const canStillUse = await tx.mcpGrant.count({
              where: {
                canUse: true,
                serverId,
                OR: [
                  { userId: membership.userId },
                  {
                    group: {
                      archivedAt: null,
                      users: { some: { userId: membership.userId } }
                    }
                  }
                ]
              }
            });
            if (!canStillUse) {
              await tx.mcpUserServer.updateMany({
                data: { enabled: false },
                where: { serverId, userId: membership.userId }
              });
            }
          }
        }

        return true;
      });
    },
    async createGroup(input) {
      const name = normalizeAdminGroupName(input.name);

      if (!name || reservedFullAccessName(name)) {
        return null;
      }

      try {
        return serializeAdminGroup(
          await prisma.group.create({
            data: {
              name
            },
            include: adminGroupRecordInclude
          })
        );
      } catch {
        return null;
      }
    },
    async deleteEmptyGroup(groupId) {
      return prisma.$transaction(async (tx) => {
        const group = await tx.group.findUnique({
          include: adminGroupRecordInclude,
          where: {
            id: groupId
          }
        });

        if (!group) {
          return "not_found";
        }

        if (group.systemRole === "full_access") {
          return "system_group_forbidden";
        }

        const deletionBlock = adminGroupDeletionBlock({
          activeGrantCount:
            group.accessGrants.filter((grant) => grant.enabled).length +
            group.mcpGrants.filter((grant) => grant.canUse).length +
            group._count.providerCredentialAssignments +
            group._count.assistantPublications +
            group._count.knowledgeBasePublications,
          memberCount: group._count.users
        });

        if (deletionBlock) {
          return deletionBlock;
        }

        await tx.group.delete({
          where: {
            id: group.id
          }
        });

        return "deleted";
      });
    },
    async renameGroup(input) {
      const name = normalizeAdminGroupName(input.name);

      if (!name || reservedFullAccessName(name)) {
        return null;
      }

      try {
        const group = await prisma.group.findFirst({
          select: { id: true },
          where: {
            id: input.groupId,
            systemRole: null
          }
        });

        if (!group) {
          return null;
        }

        return serializeAdminGroup(
          await prisma.group.update({
            data: {
              name
            },
            include: adminGroupRecordInclude,
            where: {
              id: group.id
            }
          })
        );
      } catch {
        return null;
      }
    },
    async setGroupGrants(input) {
      try {
        return await prisma.$transaction(async (tx) => {
          const group = await tx.group.findUnique({
            select: { archivedAt: true, id: true, systemRole: true },
            where: { id: input.groupId }
          });
          if (!group) throw new GroupGrantBatchRejected({ kind: "group_not_found" });
          if (group.systemRole === "full_access") throw new GroupGrantBatchRejected({ kind: "system_group_forbidden" });
          if (group.archivedAt) throw new GroupGrantBatchRejected({ kind: "group_archived" });

          for (const [index, change] of input.changes.entries()) {
            const where = await resolveGrantTarget(tx, group.id, change);
            if (!where) throw new GroupGrantBatchRejected({ change: index, kind: "invalid_change" });
            await tx.accessGrant.deleteMany({ where });
            if (change.enabled) {
              await tx.accessGrant.create({ data: { enabled: true, ...where } });
            }
          }

          return { kind: "applied" as const };
        });
      } catch (error) {
        if (error instanceof GroupGrantBatchRejected) return error.result;
        throw error;
      }
    },
    async setUserGroups(input) {
      const groupIds = [...new Set(input.groupIds)];
      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.findUnique({
            select: {
              id: true
            },
            where: {
              id: input.userId
            }
          });

          if (!user) {
            return "user_not_found" as const;
          }

          const activeGroups = await tx.group.findMany({
            select: {
              id: true
            },
            where: {
              archivedAt: null,
              id: {
                in: groupIds
              }
            }
          });
          const activeGroupIds = new Set(activeGroups.map((group) => group.id));
          const currentMemberships = await tx.userGroup.findMany({
            select: { groupId: true },
            where: { group: { archivedAt: null }, userId: input.userId }
          });
          const currentGroupIds = new Set(
            currentMemberships.map((membership) => membership.groupId)
          );
          const expectedGroupIds = [...new Set(input.expectedGroupIds)].sort();
          if (JSON.stringify([...currentGroupIds].sort()) !== JSON.stringify(expectedGroupIds)) {
            return "user_access_stale" as const;
          }
          const removedGroupIds = [...currentGroupIds].filter(
            (groupId) => !activeGroupIds.has(groupId)
          );
          const addedGroupIds = [...activeGroupIds].filter(
            (groupId) => !currentGroupIds.has(groupId)
          );
          const affectedGroupIds = [...new Set([
            ...currentMemberships.map((membership) => membership.groupId),
            ...activeGroupIds
          ])];
          const affectedMcpServers = affectedGroupIds.length
            ? await tx.mcpGrant.findMany({
                distinct: ["serverId"],
                select: { serverId: true },
                where: { canUse: true, groupId: { in: affectedGroupIds } }
              })
            : [];

          if (removedGroupIds.length) {
            await tx.userGroup.deleteMany({
              where: {
                groupId: { in: removedGroupIds },
                userId: input.userId
              }
            });
          }

          for (const groupId of addedGroupIds) {
            await tx.userGroup.create({
              data: {
                groupId,
                role: "member",
                userId: input.userId
              }
            });
          }

          const affectedServerIds = affectedMcpServers.map((grant) => grant.serverId);
          if (affectedServerIds.length) {
            await tx.mcpUserServer.updateMany({
              data: { desiredRuntimeGenerationId: null },
              where: { serverId: { in: affectedServerIds }, userId: input.userId }
            });
            for (const serverId of affectedServerIds) {
              const canStillUse = await tx.mcpGrant.count({
                where: {
                  canUse: true,
                  serverId,
                  OR: [
                    { userId: input.userId },
                    ...(activeGroupIds.size ? [{ groupId: { in: [...activeGroupIds] } }] : [])
                  ]
                }
              });
              if (!canStillUse) {
                await tx.mcpUserServer.updateMany({
                  data: { enabled: false },
                  where: { serverId, userId: input.userId }
                });
              }
            }
          }

          return "applied" as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return "user_access_stale";
        throw error;
      }
    }
  };
}
