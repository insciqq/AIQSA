import type { PrismaClient } from "@prisma/client";
import { adminGroupDeletionBlock } from "./adminDeletionMetadata";
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
    modelId: input.modelId ?? null,
    provider: input.provider ?? null,
    searchStrategy: input.searchStrategy ?? null,
    userId: null
  };
}

export function createAdminGroupGrantCommands(prisma: PrismaClient): AdminGroupGrantCommands {
  return {
    async archiveGroup(groupId) {
      const updated = await prisma.group.updateMany({
        data: {
          archivedAt: new Date()
        },
        where: {
          archivedAt: null,
          id: groupId
        }
      });

      return updated.count === 1;
    },
    async createGroup(input) {
      const name = normalizeAdminGroupName(input.name);

      if (!name) {
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

        const deletionBlock = adminGroupDeletionBlock({
          activeGrantCount: group.accessGrants.filter((grant) => grant.enabled).length,
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

      if (!name) {
        return null;
      }

      try {
        return serializeAdminGroup(
          await prisma.group.update({
            data: {
              name
            },
            include: adminGroupRecordInclude,
            where: {
              id: input.groupId
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
          id: true
        },
        where: {
          id: input.groupId
        }
      });

      if (!group || group.archivedAt) {
        return false;
      }

      const searchStrategy = input.searchStrategy?.trim() || null;
      const provider = input.provider?.trim() || null;
      const modelId = input.modelId?.trim() || null;

      if (searchStrategy) {
        if (searchStrategy === "search-disabled") {
          return false;
        }

        const strategy = await prisma.searchStrategy.findFirst({
          where: {
            enabled: true,
            strategyId: searchStrategy
          }
        });

        if (!strategy || provider || modelId) {
          return false;
        }
      } else if (provider && modelId) {
        const model = await prisma.providerModel.findFirst({
          where: {
            enabled: true,
            modelId,
            provider
          }
        });

        if (!model) {
          return false;
        }
      } else if (provider) {
        const providerModels = await prisma.providerModel.count({
          where: {
            enabled: true,
            provider
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
      const user = await prisma.user.findUnique({
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

      const groupIds = [...new Set(input.groupIds)];
      const activeGroups = await prisma.group.findMany({
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

      await prisma.$transaction(async (tx) => {
        await tx.userGroup.deleteMany({
          where: {
            group: {
              archivedAt: null
            },
            userId: input.userId
          }
        });

        for (const groupId of activeGroupIds) {
          await tx.userGroup.create({
            data: {
              groupId,
              role: "member",
              userId: input.userId
            }
          });
        }
      });

      return true;
    }
  };
}
