import type { PrismaClient } from "@prisma/client";
import { adminInviteDeletionBlock } from "./adminDeletionMetadata";
import type { AdminRepository } from "./adminRepositoryContract";
import {
  adminProvisioningGroupInputs,
  normalizeAdminRuleValue
} from "./adminRepositoryInputs";
import {
  serializeAdminInvite,
  serializeAdminRule
} from "./adminRepositorySerializers";
import { isPlausibleEmail, normalizeAuthEmail } from "./password";

export type AdminInviteRuleCommands = Pick<
  AdminRepository,
  | "createAccessRule"
  | "createInvite"
  | "deleteAccessRule"
  | "deleteStaleInvite"
  | "revokeInvite"
>;

export function createAdminInviteRuleCommands(prisma: PrismaClient): AdminInviteRuleCommands {
  return {
    async createAccessRule(input) {
      const normalizedValue = normalizeAdminRuleValue(input.kind, input.value);

      if (!normalizedValue) {
        return null;
      }

      return prisma.$transaction(async (tx) => {
        const rule = await tx.authAccessRule.upsert({
          create: {
            createdByUserId: input.createdByUserId,
            kind: input.kind,
            value: normalizedValue
          },
          update: {
            enabled: true
          },
          where: {
            kind_value: {
              kind: input.kind,
              value: normalizedValue
            }
          }
        });

        await tx.authAccessRuleGroup.deleteMany({
          where: {
            accessRuleId: rule.id
          }
        });

        for (const group of adminProvisioningGroupInputs(input.groupIds)) {
          await tx.authAccessRuleGroup.create({
            data: {
              accessRuleId: rule.id,
              groupId: group.groupId,
              role: group.role
            }
          });
        }

        return serializeAdminRule(
          await tx.authAccessRule.findUniqueOrThrow({
            include: {
              defaultGroups: {
                include: {
                  group: true
                }
              }
            },
            where: {
              id: rule.id
            }
          })
        );
      });
    },
    async createInvite(input) {
      const normalizedEmail = normalizeAuthEmail(input.email);

      if (!isPlausibleEmail(normalizedEmail)) {
        return null;
      }

      return prisma.$transaction(async (tx) => {
        const invite = await tx.authInvite.create({
          data: {
            createdByUserId: input.createdByUserId,
            email: input.email.trim(),
            expiresAt: input.expiresAt,
            normalizedEmail
          }
        });

        for (const group of adminProvisioningGroupInputs(input.groupIds)) {
          await tx.authInviteGroup.create({
            data: {
              groupId: group.groupId,
              inviteId: invite.id,
              role: group.role
            }
          });
        }

        await tx.authFlowToken.create({
          data: {
            expiresAt: input.expiresAt,
            inviteId: invite.id,
            normalizedEmail,
            purpose: "invite_acceptance",
            sentToEmail: input.email.trim(),
            tokenHash: input.tokenHash
          }
        });

        return serializeAdminInvite(
          await tx.authInvite.findUniqueOrThrow({
            include: {
              defaultGroups: {
                include: {
                  group: true
                }
              }
            },
            where: {
              id: invite.id
            }
          })
        );
      });
    },
    async deleteAccessRule(ruleId) {
      const deleted = await prisma.authAccessRule.deleteMany({
        where: {
          id: ruleId
        }
      });

      return deleted.count === 1;
    },
    async deleteStaleInvite(input) {
      return prisma.$transaction(async (tx) => {
        const invite = await tx.authInvite.findUnique({
          where: {
            id: input.inviteId
          }
        });

        if (!invite) {
          return "not_found";
        }

        const deletionBlock = adminInviteDeletionBlock(invite, input.now);

        if (deletionBlock) {
          return deletionBlock;
        }

        await tx.authInvite.delete({
          where: {
            id: invite.id
          }
        });

        return "deleted";
      });
    },
    async revokeInvite(inviteId) {
      const updated = await prisma.authInvite.updateMany({
        data: {
          revokedAt: new Date()
        },
        where: {
          id: inviteId,
          revokedAt: null
        }
      });

      return updated.count === 1;
    }
  };
}
