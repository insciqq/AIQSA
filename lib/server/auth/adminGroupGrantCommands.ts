import { Prisma, type PrismaClient } from "@prisma/client";
import { adminGroupDeletionBlock } from "./adminDeletionMetadata";
import { FULL_ACCESS_GROUP_NAME } from "./fullAccessGroup";
import { adminGroupRecordInclude } from "./adminPrismaRecords";
import type { AdminRepository } from "./adminRepositoryContract";
import { normalizeAdminGroupName } from "./adminRepositoryInputs";
import { serializeAdminGroup } from "./adminRepositorySerializers";

export type AdminGroupGrantCommands = Pick<
  AdminRepository,
  | "archiveGroup"
  | "createGroup"
  | "deleteEmptyGroup"
  | "renameGroup"
  | "setGroupGrant"
  | "setUserGroups"
>;

function grantWhere(input: {
  groupId: string;
  modelId?: string | null;
  provider?: string | null;
  searchStrategy?: string | null;
}) {
  return {
    groupId: input.groupId,
    providerConnectionId: input.modelId ? null : input.provider ?? null,
    providerModelId: input.modelId ?? null,
    searchStrategy: input.searchStrategy ?? null,
    userId: null
  };
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
    async setGroupGrant(input) {
      const group = await prisma.group.findUnique({
        select: {
          archivedAt: true,
          id: true,
          systemRole: true
        },
        where: {
          id: input.groupId
        }
      });

      if (!group || group.archivedAt || group.systemRole === "full_access") {
        return false;
      }

      const searchStrategy = input.searchStrategy?.trim() || null;
      const provider = input.provider?.trim() || null;
      const modelId = input.modelId?.trim() || null;

      if (searchStrategy) {
        if (searchStrategy === "search-disabled") {
          return false;
        }

        const option = await prisma.searchOption.findFirst({
          select: { id: true },
          where: {
            archivedAt: null,
            enabled: true,
            optionId: searchStrategy
          }
        });

        if (!option || provider || modelId) {
          return false;
        }
      } else if (provider && modelId) {
        const model = await prisma.providerModel.findFirst({
          where: {
            activeConfig: { not: Prisma.DbNull },
            activeVersion: { gt: 0 },
            connectionId: provider,
            enabled: true,
            id: modelId,
            connection: {
              activeConfig: { not: Prisma.DbNull },
              activeVersion: { gt: 0 },
              enabled: true
            }
          }
        });

        if (!model) {
          return false;
        }
      } else if (provider) {
        const providerModels = await prisma.providerModel.count({
          where: {
            activeConfig: { not: Prisma.DbNull },
            activeVersion: { gt: 0 },
            connectionId: provider,
            connection: {
              activeConfig: { not: Prisma.DbNull },
              activeVersion: { gt: 0 },
              enabled: true
            },
            enabled: true,
          }
        });

        if (providerModels === 0 || modelId) {
          return false;
        }
      } else {
        return false;
      }

      const where = grantWhere({
        groupId: input.groupId,
        modelId,
        provider,
        searchStrategy
      });

      await prisma.accessGrant.deleteMany({
        where
      });

      if (input.enabled) {
        await prisma.accessGrant.create({
          data: {
            enabled: true,
            ...where
          }
        });
      }

      return true;
    },
    async setUserGroups(input) {
      const groupIds = [...new Set(input.groupIds)];
      return prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          select: {
            id: true
          },
          where: {
            id: input.userId
          }
        });

        if (!user) {
          return false;
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

        return true;
      });
    }
  };
}
