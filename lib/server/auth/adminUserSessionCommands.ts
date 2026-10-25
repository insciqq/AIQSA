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
import { lockActiveAdmins, lockAuthUser } from "./transactionLocks";
import { MemoryCoordinatorError } from "../memory/coordinator/errors";
import { countAccountMemoryOwnedData } from "../memory/accountDeletion/inventory";
import type { AccountMemoryDeletionHook } from "../memory/accountDeletion/integration";
import { archivePersonalMcpServers } from "../mcp/personalArchive";
import {
  revokeAllInboundMcpGrants,
  revokeInboundMcpGrantsForUser
} from "../memoryMcp/oauth/repository";
import { revokeAllConnectDevices, revokeConnectDevicesForUser } from "../connect/revocation";
import { clearTelemetryIncidentUser } from "../telemetry/store";
import { revokeAllTelegramLinks, revokeTelegramLinksForUser } from "../telegram/linking/revocation";
import { deleteSignInRefusalsOfEmails } from "./signInRefusals";

export type AdminUserSessionCommands = Pick<
  AdminRepository,
  | "approveUser"
  | "deleteStaleUser"
  | "disableUser"
  | "rejectUser"
  | "resetUserTwoFactor"
  | "revokeAllSessions"
  | "revokeUserSessions"
  | "setUserRole"
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
    accountMemoryDeletionHook?: () => AccountMemoryDeletionHook | null;
    /** After commit: wakes MCP runtime revocation and finalization of archived personal servers. */
    accountMcpDeletionKick?: () => void;
  }> = {}
): AdminUserSessionCommands {
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

      let admittedMemoryDeletion = false;
      let personalMcpPending = false;
      const deletionKicks: { memory: (() => void) | null } = { memory: null };
      try {
        const result = await prisma.$transaction(async (tx) => {
          await lockAuthUser(tx, input.userId);
          const user = await tx.user.findUnique({
            select: {
              authIdentities: {
                select: {
                  normalizedEmail: true
                }
              },
              email: true,
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
          let memoryReady = ownedData.memory === 0;
          const memoryHook = ownedData.memory > 0
            ? accountMemoryDeletionHook()
            : null;
          if (ownedData.memory > 0 && !memoryHook) {
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
          if (ownedData.personalMcp > 0) {
            // Fence like a user disconnect; runtime finalization revokes the
            // tokens and removes the archived servers before a later attempt.
            await archivePersonalMcpServers(tx, { now: new Date(), ownerUserId: user.id });
            personalMcpPending = true;
          }
          if (!memoryReady || personalMcpPending) {
            return "deletion_pending" as const;
          }

          await clearTelemetryIncidentUser(tx, user.id);
          // Refused sign-ins under the account's emails; those naming the account go with it.
          await deleteSignInRefusalsOfEmails(tx, [
            user.email,
            ...user.authIdentities.map((identity) => identity.normalizedEmail)
          ]);
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

        // An administrator's disable is never SCIM's to undo, even when SCIM had asked for it too.
        const updated = await tx.user.updateMany({
          data: {
            scimDeactivatedAt: null,
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
      // The installation-wide response to a suspected compromise also ends inbound MCP grants and
      // Telegram links: a stolen session could have minted either, outliving every revoked session.
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
        // Likewise a device a stolen session paired, and every open terminal view.
        await revokeAllConnectDevices(tx);
        await revokeAllTelegramLinks(tx, { now, reason: "admin_revoke_all" });

        return result.count;
      });
    },
    async resetUserTwoFactor(input) {
      // Lock order of the user's own enrolment: the user row, then the factor row.
      return prisma.$transaction(async (tx) => {
        await lockAuthUser(tx, input.userId);
        const user = await tx.user.findUnique({ select: { id: true }, where: { id: input.userId } });

        if (!user) {
          return null;
        }

        await tx.authTotpFactor.deleteMany({ where: { userId: input.userId } });

        return revokeUserSessions(tx, input);
      });
    },
    async revokeUserSessions(input) {
      return prisma.$transaction((tx) => revokeUserSessions(tx, input));
    },
    async setUserRole(input) {
      if (input.userId === input.actingAdminUserId) {
        return "self_role_change_forbidden";
      }

      // Same lock order as disableUser: the active-admin set first, then the target row. Under
      // READ COMMITTED a waiting transaction re-checks locked rows, so after a concurrent demotion
      // or disable commits, the demoted actor is no longer in the set and is refused.
      return prisma.$transaction(async (tx) => {
        const activeAdmins = await lockActiveAdmins(tx);
        if (!activeAdmins.some((admin) => admin.id === input.actingAdminUserId)) {
          return "actor_forbidden";
        }

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

        if (target.status !== "active") {
          return "user_not_active";
        }

        if (target.role === input.role) {
          return "unchanged";
        }

        if (input.role === "user" && activeAdmins.length <= 1) {
          return "last_admin_forbidden";
        }

        // A manual change takes the role over from any external sign-in source.
        await tx.user.update({
          data: {
            role: input.role,
            roleManagedBy: null
          },
          where: {
            id: target.id
          }
        });

        return input.role === "admin" ? "granted" : "revoked";
      });
    }
  };
}

async function countUserOwnedAppData(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<Readonly<{ memory: number; nonPurgeable: number; personalMcp: number }>> {
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
    memory
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
        chat: { userId },
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
    countAccountMemoryOwnedData(tx, userId)
  ]);

  const nonPurgeable = adminOwnedAppDataCount({
    accessGrants,
    authSessionsRevoked,
    attachments,
    chats,
    folders,
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
  return { memory, nonPurgeable, personalMcp };
}

/** Ends the account's sessions, inbound MCP grants and Telegram link; disable and reject inherit all three. */
async function revokeUserSessions(
  tx: Prisma.TransactionClient,
  input: AdminRevokeUserSessionsInput
): Promise<number> {
  return revokeAccountAccess(tx, {
    now: new Date(),
    reason: "admin_revoke_user",
    revokedByUserId: input.revokedByUserId,
    userId: input.userId
  });
}

async function revokeAccountAccess(
  tx: Prisma.TransactionClient,
  input: {
    now: Date;
    reason: "admin_revoke_user" | "scim_deactivated";
    /** The acting administrator; null for SCIM, which acts for the identity provider. */
    revokedByUserId: string | null;
    userId: string;
  }
): Promise<number> {
  const result = await tx.authSession.updateMany({
    data: {
      revokedAt: input.now,
      revokedByUserId: input.revokedByUserId,
      revokedReason: input.reason
    },
    where: {
      revokedAt: null,
      userId: input.userId
    }
  });
  await revokeInboundMcpGrantsForUser(tx, {
    now: input.now,
    reason: input.reason,
    userId: input.userId
  });
  await revokeConnectDevicesForUser(tx, { userId: input.userId });
  await revokeTelegramLinksForUser(tx, {
    now: input.now,
    reason: input.reason,
    userId: input.userId
  });

  return result.count;
}

/** How a SCIM deactivation ended; nothing changed unless the variant says so. */
export type SystemDeactivationResult =
  | { kind: "already_inactive" }
  | { kind: "disabled" }
  | { kind: "last_admin" }
  | { kind: "not_found" };

/**
 * The system-actor variant of `disableUser`, for SCIM deactivation, inside the caller's
 * transaction. The caller already holds the active-admin set (`activeAdmins`) and then the user
 * row: `disableUser`'s lock order. It keeps `disableUser`'s guard without an acting
 * administrator: an active admin is not disabled when no other active admin could still sign
 * in. A disable revokes sessions, inbound MCP grants, Connect devices and Telegram links. An
 * account an administrator disabled or denied stays as it is, unmarked.
 */
export async function deactivateUserAsSystem(
  tx: Prisma.TransactionClient,
  input: { activeAdmins: readonly { id: string }[]; now: Date; userId: string }
): Promise<SystemDeactivationResult> {
  const target = await tx.user.findUnique({
    select: { id: true, role: true, scimDeactivatedAt: true, status: true },
    where: { id: input.userId }
  });

  if (!target) {
    return { kind: "not_found" };
  }

  if (target.status === "disabled" || target.status === "denied") {
    return { kind: "already_inactive" };
  }

  if (target.status === "active" && target.role === "admin") {
    // An admin whose own SCIM deactivation is pending cannot sign in, so it does not count.
    const otherAdmins = input.activeAdmins.map((admin) => admin.id).filter((id) => id !== target.id);
    const usableAdmins = otherAdmins.length
      ? await tx.user.count({ where: { id: { in: otherAdmins }, scimDeactivatedAt: null } })
      : 0;
    if (usableAdmins === 0) {
      return { kind: "last_admin" };
    }
  }

  const access = { now: input.now, reason: "scim_deactivated", revokedByUserId: null, userId: target.id } as const;
  await tx.user.update({
    data: { scimDeactivatedAt: target.scimDeactivatedAt ?? input.now, status: "disabled" },
    where: { id: target.id }
  });
  await revokeAccountAccess(tx, access);
  return { kind: "disabled" };
}

export type SystemReactivationResult = { kind: "active" } | { kind: "admin_disabled" } | { kind: "not_found" };

/**
 * SCIM reactivation inside the caller's transaction, with `deactivateUserAsSystem`'s locks
 * held: re-enables an account SCIM disabled, withdraws a pending SCIM deactivation, and
 * activates an account awaiting approval (the SCIM client is an admin-level integration). An
 * account an administrator disabled or denied stays so (`admin_disabled`).
 */
export async function reactivateUserAsSystem(
  tx: Prisma.TransactionClient,
  input: { userId: string }
): Promise<SystemReactivationResult> {
  const target = await tx.user.findUnique({
    select: { id: true, scimDeactivatedAt: true, status: true },
    where: { id: input.userId }
  });

  if (!target) {
    return { kind: "not_found" };
  }

  if (target.status === "denied" || (target.status === "disabled" && target.scimDeactivatedAt === null)) {
    return { kind: "admin_disabled" };
  }

  if (target.status !== "active") {
    await tx.user.update({ data: { scimDeactivatedAt: null, status: "active" }, where: { id: target.id } });
    await provisionActiveUser(tx, { userId: target.id });
  } else if (target.scimDeactivatedAt !== null) {
    await tx.user.update({ data: { scimDeactivatedAt: null }, where: { id: target.id } });
  }

  return { kind: "active" };
}
