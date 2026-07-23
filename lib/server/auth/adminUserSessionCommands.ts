import type { Prisma, PrismaClient } from "@prisma/client";
import {
  adminOwnedAppDataCount,
  adminUserDeletionBlock
} from "./adminDeletionMetadata";
import type {
  AdminRepository,
  AdminRevokeUserSessionsInput
} from "./adminRepositoryContract";
import { adminProvisioningGroupInputs } from "./adminRepositoryInputs";
import { provisionActiveUser } from "./provisioning";
import { lockAuthUser } from "./transactionLocks";

export type AdminUserSessionCommands = Pick<
  AdminRepository,
  | "approveUser"
  | "deleteStaleUser"
  | "disableUser"
  | "rejectUser"
  | "revokeAllSessions"
  | "revokeUserSessions"
>;

export function createAdminUserSessionCommands(prisma: PrismaClient): AdminUserSessionCommands {
  return {
    async approveUser(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthUser(tx, input.userId);
        const user = await tx.user.findUnique({
          select: {
            authIdentities: {
              select: {
                emailVerifiedAt: true
              }
            },
            id: true,
            status: true
          },
          where: {
            id: input.userId
          }
        });

        if (!user || user.status === "disabled" || user.status === "denied") {
          return "not_found";
        }

        if (!user.authIdentities.some((identity) => identity.emailVerifiedAt)) {
          return "not_verified";
        }

        await tx.user.update({
          data: {
            status: "active"
          },
          where: {
            id: user.id
          }
        });
        await provisionActiveUser(tx, {
          groups: adminProvisioningGroupInputs(input.groupIds),
          userId: user.id
        });

        return "approved";
      });
    },
    async deleteStaleUser(input) {
      if (input.userId === input.actingAdminUserId) {
        return "self_delete_forbidden";
      }

      return prisma.$transaction(async (tx) => {
        await lockAuthUser(tx, input.userId);
        const user = await tx.user.findUnique({
          select: {
            id: true,
            status: true
          },
          where: {
            id: input.userId
          }
        });

        if (!user) {
          return "not_found";
        }

        const statusDeletionBlock = adminUserDeletionBlock({
          ownedDataCount: 0,
          status: user.status
        });

        if (statusDeletionBlock) {
          return statusDeletionBlock;
        }

        const ownedDataCount = await countUserOwnedAppData(tx, user.id);
        const deletionBlock = adminUserDeletionBlock({
          ownedDataCount,
          status: user.status
        });

        if (deletionBlock) {
          return deletionBlock;
        }

        await tx.user.delete({
          where: {
            id: user.id
          }
        });

        return "deleted";
      });
    },
    async disableUser(input) {
      if (input.userId === input.revokedByUserId) {
        return "self_disable_forbidden";
      }

      return prisma.$transaction(async (tx) => {
        const activeAdmins = await lockActiveAdmins(tx);
        await lockAuthUser(tx, input.userId);
        const target = await tx.user.findUnique({
          select: {
            id: true,
            role: true,
            status: true
          },
          where: {
            id: input.userId
          }
        });

        if (!target) {
          return "not_found";
        }

        if (!activeAdmins.some((admin) => admin.id === input.revokedByUserId)) {
          return "last_admin_forbidden";
        }

        if (target.role === "admin" && target.status === "active" && activeAdmins.length <= 1) {
          return "last_admin_forbidden";
        }

        const updated = await tx.user.updateMany({
          data: {
            status: "disabled"
          },
          where: {
            id: target.id
          }
        });

        if (updated.count !== 1) {
          return "not_found";
        }

        await revokeUserSessions(tx, {
          revokedByUserId: input.revokedByUserId,
          userId: target.id
        });

        return "disabled";
      });
    },
    async rejectUser(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthUser(tx, input.userId);
        const updated = await tx.user.updateMany({
          data: {
            status: "denied"
          },
          where: {
            id: input.userId,
            status: "pending"
          }
        });

        if (updated.count !== 1) {
          return "not_found";
        }

        await revokeUserSessions(tx, {
          revokedByUserId: input.revokedByUserId,
          userId: input.userId
        });

        return "rejected";
      });
    },
    async revokeAllSessions(input) {
      const result = await prisma.authSession.updateMany({
        data: {
          revokedAt: new Date(),
          revokedByUserId: input.revokedByUserId,
          revokedReason: "admin_revoke_all"
        },
        where: {
          revokedAt: null
        }
      });

      return result.count;
    },
    async revokeUserSessions(input) {
      return revokeUserSessions(prisma, input);
    }
  };
}

async function countUserOwnedAppData(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const [
    accessGrants,
    attachments,
    chats,
    folders,
    mcpGrants,
    mcpOAuthConnections,
    mcpUserServers,
    modelRuns,
    promptPresets,
    settings,
    sharedSnapshots,
    usageEvents
  ] = await Promise.all([
    tx.accessGrant.count({
      where: {
        userId
      }
    }),
    tx.attachment.count({
      where: {
        userId
      }
    }),
    tx.chat.count({
      where: {
        userId
      }
    }),
    tx.folder.count({
      where: {
        userId
      }
    }),
    tx.mcpGrant.count({
      where: {
        userId
      }
    }),
    tx.mcpOAuthConnection.count({
      where: {
        userId
      }
    }),
    tx.mcpUserServer.count({
      where: {
        userId
      }
    }),
    tx.modelRun.count({
      where: {
        userId
      }
    }),
    tx.promptPreset.count({
      where: {
        userId
      }
    }),
    tx.userSettings.count({
      where: {
        userId
      }
    }),
    tx.sharedChatSnapshot.count({
      where: {
        ownerUserId: userId
      }
    }),
    tx.usageEvent.count({
      where: {
        userId
      }
    })
  ]);

  return adminOwnedAppDataCount({
    accessGrants,
    attachments,
    chats,
    folders,
    mcpGrants,
    mcpOAuthConnections,
    mcpUserServers,
    modelRuns,
    promptPresets,
    settings,
    sharedSnapshots,
    usageEvents
  });
}

async function lockActiveAdmins(tx: Prisma.TransactionClient): Promise<{ id: string }[]> {
  return tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "User"
    WHERE "role" = 'admin' AND "status" = 'active'
    ORDER BY "id"
    FOR UPDATE
  `;
}

async function revokeUserSessions(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: AdminRevokeUserSessionsInput
): Promise<number> {
  const result = await prisma.authSession.updateMany({
    data: {
      revokedAt: new Date(),
      revokedByUserId: input.revokedByUserId,
      revokedReason: "admin_revoke_user"
    },
    where: {
      revokedAt: null,
      userId: input.userId
    }
  });

  return result.count;
}
