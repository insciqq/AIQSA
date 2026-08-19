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
import {
  countAccountKnowledgeOwnedData,
  type AccountKnowledgeDeletionHook
} from "../knowledge/accountDeletion";
import { MemoryCoordinatorError } from "../memory/coordinator/errors";
import { countAccountMemoryOwnedData } from "../memory/accountDeletion/inventory";
import type { AccountMemoryDeletionHook } from "../memory/accountDeletion/integration";

export type AdminUserSessionCommands = Pick<
  AdminRepository,
  | "approveUser"
  | "deleteStaleUser"
  | "disableUser"
  | "rejectUser"
  | "revokeAllSessions"
  | "revokeUserSessions"
>;

class AccountDeletionPurgeUnavailableError extends Error {
  constructor() {
    super("account_deletion_purge_unavailable");
    this.name = "AccountDeletionPurgeUnavailableError";
  }
}

export function createAdminUserSessionCommands(
  prisma: PrismaClient,
  options: Readonly<{
    accountKnowledgeDeletionHook?: () => AccountKnowledgeDeletionHook | null;
    accountMemoryDeletionHook?: () => AccountMemoryDeletionHook | null;
  }> = {}
): AdminUserSessionCommands {
  const accountKnowledgeDeletionHook = options.accountKnowledgeDeletionHook ?? (() => null);
  const accountMemoryDeletionHook = options.accountMemoryDeletionHook ?? (() => null);
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

      let admittedKnowledgeDeletion = false;
      let admittedMemoryDeletion = false;
      const deletionKicks: {
        knowledge: (() => void) | null;
        memory: (() => void) | null;
      } = { knowledge: null, memory: null };
      try {
        const result = await prisma.$transaction(async (tx) => {
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
            return "not_found" as const;
          }

          const statusDeletionBlock = adminUserDeletionBlock({
            ownedDataCount: 0,
            status: user.status
          });

          if (statusDeletionBlock) {
            return statusDeletionBlock;
          }

          const ownedData = await countUserOwnedAppData(tx, user.id);
          if (ownedData.nonPurgeable > 0) {
            return "user_has_owned_data" as const;
          }
          let knowledgeReady = ownedData.knowledge === 0;
          let memoryReady = ownedData.memory === 0;
          const knowledgeHook = ownedData.knowledge > 0
            ? accountKnowledgeDeletionHook()
            : null;
          const memoryHook = ownedData.memory > 0
            ? accountMemoryDeletionHook()
            : null;
          if (
            (ownedData.knowledge > 0 && !knowledgeHook) ||
            (ownedData.memory > 0 && !memoryHook)
          ) {
            throw new AccountDeletionPurgeUnavailableError();
          }
          if (ownedData.memory > 0) {
            const advanced = await memoryHook!.advance(tx, {
              now: new Date(),
              userId: user.id
            });
            if (!advanced.deletionPending && !advanced.readyForUserDeletion) {
              throw new AccountDeletionPurgeUnavailableError();
            }
            admittedMemoryDeletion = advanced.admitted;
            memoryReady = advanced.readyForUserDeletion;
            deletionKicks.memory = memoryHook!.kick;
          }
          if (ownedData.knowledge > 0) {
            const advanced = await knowledgeHook!.advance(tx, {
              now: new Date(),
              userId: user.id
            });
            if (!advanced.deletionPending && !advanced.readyForUserDeletion) {
              throw new AccountDeletionPurgeUnavailableError();
            }
            admittedKnowledgeDeletion = advanced.admitted;
            knowledgeReady = advanced.readyForUserDeletion;
            deletionKicks.knowledge = knowledgeHook!.kick;
          }
          if (!knowledgeReady || !memoryReady) {
            return "deletion_pending" as const;
          }

          await tx.user.delete({
            where: {
              id: user.id
            }
          });

          return "deleted" as const;
        });
        if (admittedMemoryDeletion) {
          deletionKicks.memory?.();
        }
        if (admittedKnowledgeDeletion) {
          deletionKicks.knowledge?.();
        }
        return result;
      } catch (error) {
        if (error instanceof AccountDeletionPurgeUnavailableError) {
          admittedKnowledgeDeletion = false;
          admittedMemoryDeletion = false;
          return "user_has_owned_data";
        }
        if (error instanceof MemoryCoordinatorError) {
          return "user_has_owned_data";
        }
        throw error;
      }
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

async function countUserOwnedAppData(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<Readonly<{ knowledge: number; memory: number; nonPurgeable: number }>> {
  const [
    accessGrants,
    authSessionsRevoked,
    attachments,
    chats,
    folders,
    mcpGrants,
    mcpOAuthConnections,
    mcpUserServers,
    modelRuns,
    assistantDefinitions,
    skillDefinitions,
    settings,
    sharedSnapshots,
    usageEvents,
    memory,
    knowledge
  ] = await Promise.all([
    tx.accessGrant.count({
      where: {
        userId
      }
    }),
    tx.authSession.count({
      where: {
        revokedByUserId: userId
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
        chat: { projectId: null },
        userId
      }
    }),
    tx.assistantDefinition.count({
      where: {
        ownerUserId: userId
      }
    }),
    tx.skillDefinition.count({
      where: {
        ownerUserId: userId
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
        memoryExecutionBindingId: null,
        userId
      }
    }),
    countAccountMemoryOwnedData(tx, userId),
    countAccountKnowledgeOwnedData(tx, userId)
  ]);

  const nonPurgeable = adminOwnedAppDataCount({
    accessGrants,
    authSessionsRevoked,
    attachments,
    chats,
    folders,
    knowledgeBases: 0,
    memory: 0,
    mcpGrants,
    mcpOAuthConnections,
    mcpUserServers,
    modelRuns,
    assistantDefinitions,
    skillDefinitions,
    settings,
    sharedSnapshots,
    usageEvents
  });
  return { knowledge, memory, nonPurgeable };
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
