import type { PrismaClient } from "@prisma/client";
import { listAdminDashboard } from "./adminDashboardQueries";
import { createAdminGroupGrantCommands } from "./adminGroupGrantCommands";
import { createAdminInviteRuleCommands } from "./adminInviteRuleCommands";
import type { AdminRepository } from "./adminRepositoryContract";
import type { AccountMemoryDeletionHook } from "../memory/accountDeletion/integration";
import { createAdminUserSessionCommands } from "./adminUserSessionCommands";

export type {
  AdminAccessGrantRecord,
  AdminAccessRuleRecord,
  AdminActorRecord,
  AdminApproveUserInput,
  AdminApproveUserResult,
  AdminCreateAccessRuleInput,
  AdminCreateGroupInput,
  AdminCreateInviteInput,
  AdminDashboard,
  AdminDashboardNavigation,
  AdminDeleteGroupResult,
  AdminDeleteInviteResult,
  AdminDeleteStaleInviteInput,
  AdminDeleteStaleUserInput,
  AdminDeleteUserResult,
  AdminDisableUserResult,
  AdminDeletionBlockReason,
  AdminDeletionInfo,
  AdminEntitlementSummary,
  AdminGroupRecord,
  AdminInviteRecord,
  AdminRenameGroupInput,
  AdminRejectUserResult,
  AdminRepository,
  AdminRevokeAllSessionsInput,
  AdminRevokeUserSessionsInput,
  AdminSetGroupGrantInput,
  AdminSetUserGroupsInput,
  AdminUsageDashboard,
  AdminUsageGroupRecord,
  AdminUsageProviderModelRecord,
  AdminUsageTokenTotals,
  AdminUsageUserRecord,
  AdminUserRecord
} from "./adminRepositoryContract";

export function createPrismaAdminRepository(
  prisma: PrismaClient,
  options: Readonly<{
    accountMemoryDeletionHook?: () => AccountMemoryDeletionHook | null;
  }> = {}
): AdminRepository {
  return {
    ...createAdminUserSessionCommands(prisma, options),
    ...createAdminGroupGrantCommands(prisma),
    ...createAdminInviteRuleCommands(prisma),
    async findAdminUser(userId) {
      return prisma.user.findUnique({
        select: {
          id: true,
          role: true,
          status: true
        },
        where: {
          id: userId
        }
      });
    },
    async listDashboard(actingAdminUserId) {
      return listAdminDashboard(prisma, { actingAdminUserId });
    }
  };
}
