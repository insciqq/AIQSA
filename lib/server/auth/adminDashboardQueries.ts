import type { Prisma, PrismaClient } from "@prisma/client";
import { adminUserDeletionInfo, adminUserOwnedDataCount } from "./adminDeletionMetadata";
import { loadAdminGrantableCatalog } from "./adminCatalogQueries";
import { adminGroupRecordInclude } from "./adminPrismaRecords";
import type { AdminDashboard } from "./adminRepositoryContract";
import {
  serializeAdminEntitlements,
  serializeAdminGroup,
  serializeAdminInvite,
  serializeAdminLastSession,
  serializeAdminRule
} from "./adminRepositorySerializers";
import { serializeAdminMemberships } from "./adminSerializationPrimitives";
import { serializeAdminUsageDashboard } from "./adminUsageAggregation";
import { loadAdminUsageQueryRows } from "./adminUsageQueries";

const adminDashboardUserSelect = {
  _count: {
    select: {
      accessGrants: true,
      attachments: true,
      chats: true,
      folders: true,
      mcpGrants: true,
      mcpOAuthConnections: true,
      mcpUserServers: true,
      modelRuns: true,
      promptPresets: true,
      sharedSnapshots: true,
      usageEvents: true
    }
  },
  authIdentities: {
    select: {
      emailVerifiedAt: true
    }
  },
  authSessions: {
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      createdAt: true,
      lastSeenAt: true
    },
    take: 5
  },
  displayName: true,
  email: true,
  groups: {
    select: {
      group: {
        select: {
          archivedAt: true,
          name: true
        }
      },
      groupId: true,
      role: true
    }
  },
  id: true,
  role: true,
  settings: {
    select: {
      id: true
    }
  },
  status: true
} satisfies Prisma.UserSelect;

export type AdminDashboardQueryOptions = Readonly<{
  now?: Date;
}>;

export async function listAdminDashboard(
  prisma: PrismaClient,
  options: AdminDashboardQueryOptions = {}
): Promise<AdminDashboard> {
  const now = options.now ?? new Date();
  const [users, groups, accessRules, invites, catalog, grants, usageRows] = await Promise.all([
    prisma.user.findMany({
      orderBy: {
        createdAt: "desc"
      },
      select: adminDashboardUserSelect
    }),
    prisma.group.findMany({
      include: adminGroupRecordInclude,
      orderBy: {
        name: "asc"
      }
    }),
    prisma.authAccessRule.findMany({
      orderBy: [
        {
          kind: "asc"
        },
        {
          value: "asc"
        }
      ],
      select: {
        defaultGroups: {
          select: {
            groupId: true,
            role: true
          }
        },
        enabled: true,
        id: true,
        kind: true,
        value: true
      }
    }),
    prisma.authInvite.findMany({
      orderBy: {
        createdAt: "desc"
      },
      select: {
        acceptedAt: true,
        defaultGroups: {
          select: {
            groupId: true,
            role: true
          }
        },
        email: true,
        expiresAt: true,
        id: true,
        normalizedEmail: true,
        revokedAt: true
      }
    }),
    loadAdminGrantableCatalog(prisma),
    prisma.accessGrant.findMany({
      select: {
        enabled: true,
        groupId: true,
        id: true,
        modelId: true,
        provider: true,
        searchStrategy: true,
        userId: true
      },
      where: {
        enabled: true
      }
    }),
    loadAdminUsageQueryRows(prisma)
  ]);
  const groupNamesById = new Map(groups.map((group) => [group.id, { name: group.name }]));
  const usage = serializeAdminUsageDashboard({
    groups,
    providerModelRows: usageRows.providerModelRows,
    userRows: usageRows.userRows,
    users
  });

  return {
    accessRules: accessRules.map((rule) => serializeAdminRule(rule, groupNamesById)),
    catalog,
    groups: groups.map(serializeAdminGroup),
    invites: invites.map((invite) => serializeAdminInvite(invite, groupNamesById, now)),
    usage,
    users: users.map((user) => {
      const activeGroupIds = user.groups
        .filter((membership) => !membership.group.archivedAt)
        .map((membership) => membership.groupId);

      return {
        deletion: adminUserDeletionInfo({
          ownedDataCount: adminUserOwnedDataCount(user),
          status: user.status
        }),
        displayName: user.displayName,
        effectiveEntitlements: serializeAdminEntitlements({
          grants,
          groupIds: activeGroupIds,
          userId: user.id
        }),
        email: user.email,
        groups: serializeAdminMemberships(user.groups),
        hasVerifiedIdentity: user.authIdentities.some((identity) => Boolean(identity.emailVerifiedAt)),
        id: user.id,
        lastSessionAt: serializeAdminLastSession(user.authSessions),
        role: user.role,
        status: user.status
      };
    })
  };
}
