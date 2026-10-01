import type { Prisma, PrismaClient } from "@prisma/client";
import {
  adminOwnedAppDataCount,
  adminUserDeletionBlock
} from "./adminDeletionMetadata";
import type {
  AdminDisableUserProjectOwnerRequired,
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
import { archivePersonalMcpServers } from "../mcp/personalArchive";
import {
  revokeAllInboundMcpGrants,
  revokeInboundMcpGrantsForUser
} from "../memoryMcp/oauth/repository";

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
    /** After commit: wakes MCP runtime revocation and finalization of archived personal servers. */
    accountMcpDeletionKick?: () => void;
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
      let personalMcpPending = false;
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
          if (ownedData.personalMcp > 0) {
            // Fence like a user disconnect; runtime finalization revokes the
            // tokens and removes the archived servers before a later attempt.
            await archivePersonalMcpServers(tx, { now: new Date(), ownerUserId: user.id });
            personalMcpPending = true;
          }
          if (!knowledgeReady || !memoryReady || personalMcpPending) {
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
        if (personalMcpPending) {
          try {
            options.accountMcpDeletionKick?.();
          } catch {
            // The archive is durable; the runtime's periodic reconcile finalizes it.
          }
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

        // Checked before the status write so the deferred Project-owner trigger never has to
        // roll back the whole disable (and its session revocation) at COMMIT.
        const ownerConflict = await soleOwnedProjectConflict(tx, target.id);
        if (ownerConflict) {
          return ownerConflict;
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
      // The installation-wide response to a suspected compromise also ends inbound MCP grants: a
      // stolen session could have minted one that would otherwise outlive every revoked session.
      return prisma.$transaction(async (tx) => {
        const now = new Date();
        const result = await tx.authSession.updateMany({
          data: {
            revokedAt: now,
            revokedByUserId: input.revokedByUserId,
            revokedReason: "admin_revoke_all"
          },
          where: {
            revokedAt: null
          }
        });
        await revokeAllInboundMcpGrants(tx, { now, reason: "admin_revoke_all" });

        return result.count;
      });
    },
    async revokeUserSessions(input) {
      return prisma.$transaction((tx) => revokeUserSessions(tx, input));
    }
  };
}

async function countUserOwnedAppData(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<Readonly<{ knowledge: number; memory: number; nonPurgeable: number; personalMcp: number }>> {
  // Rows of a personal server can name only its owner (database fence); they
  // leave with its finalization. Installation MCP rows keep the account.
  const installationMcp = { server: { ownerUserId: null }, userId };
  const [
    accessGrants,
    authSessionsRevoked,
    attachments,
    chats,
    folders,
    mcpGrants,
    mcpOAuthConnections,
    mcpUserServers,
    personalMcp,
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
      where: installationMcp
    }),
    tx.mcpOAuthConnection.count({
      where: installationMcp
    }),
    tx.mcpUserServer.count({
      where: installationMcp
    }),
    tx.mcpServer.count({
      where: {
        ownerUserId: userId
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
  return { knowledge, memory, nonPurgeable, personalMcp };
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

/** Bounds the Projects named in a disable conflict; `projectCount` still reports all of them. */
const SOLE_OWNED_PROJECT_LIST_LIMIT = 20;

/**
 * Finds the non-deleting Projects in which the user is the only active direct Owner, after
 * locking every non-deleting Project the user directly owns. Project grant and lifecycle writers
 * lock the Project row first: one that committed while these locks were awaited is seen by the
 * re-read below, and one that waits here fails its serializable row lock afterwards because the
 * status change rewrites the Project row (access-revision trigger), so it cannot act on the old
 * Owner set. A concurrent co-Owner disable waits here and then sees this one.
 */
async function soleOwnedProjectConflict(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<AdminDisableUserProjectOwnerRequired | null> {
  const owned = await tx.$queryRaw<{ id: string }[]>`
    SELECT project_row."id"
    FROM "Project" AS project_row
    WHERE project_row."status" <> 'DELETING'
      AND EXISTS (
        SELECT 1
        FROM "ProjectGrant" AS grant_row
        WHERE grant_row."projectId" = project_row."id"
          AND grant_row."userId" = ${userId}
          AND grant_row."groupId" IS NULL
          AND grant_row."role" = 'OWNER'
      )
    ORDER BY project_row."id"
    FOR UPDATE
  `;
  if (owned.length === 0) {
    return null;
  }

  // A separate statement: under READ COMMITTED it sees every transaction that committed while
  // the locks above were awaited.
  const soleOwned = await tx.project.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { name: true, status: true },
    where: {
      grants: {
        some: { groupId: null, role: "OWNER", userId }
      },
      id: { in: owned.map(({ id }) => id) },
      NOT: {
        grants: {
          some: {
            groupId: null,
            role: "OWNER",
            user: { status: "active" },
            userId: { not: userId }
          }
        }
      },
      status: { not: "DELETING" }
    }
  });
  if (soleOwned.length === 0) {
    return null;
  }

  return {
    kind: "project_owner_required",
    projectCount: soleOwned.length,
    projects: soleOwned.slice(0, SOLE_OWNED_PROJECT_LIST_LIMIT).map((project) => ({
      name: project.name,
      status: project.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE"
    }))
  };
}

/** Ends the account's sessions and inbound MCP grants; disable and reject inherit both. */
async function revokeUserSessions(
  tx: Prisma.TransactionClient,
  input: AdminRevokeUserSessionsInput
): Promise<number> {
  const now = new Date();
  const result = await tx.authSession.updateMany({
    data: {
      revokedAt: now,
      revokedByUserId: input.revokedByUserId,
      revokedReason: "admin_revoke_user"
    },
    where: {
      revokedAt: null,
      userId: input.userId
    }
  });
  await revokeInboundMcpGrantsForUser(tx, {
    now,
    reason: "admin_revoke_user",
    userId: input.userId
  });

  return result.count;
}
