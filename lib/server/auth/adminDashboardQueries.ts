import { Prisma, type PrismaClient } from "@prisma/client";
import { adminUserDeletionInfo, adminUserOwnedDataCount } from "./adminDeletionMetadata";
import { loadAdminGrantableCatalog } from "./adminCatalogQueries";
import { adminGroupRecordInclude } from "./adminPrismaRecords";
import type { AdminDashboard, AdminDashboardNavigation } from "./adminRepositoryContract";
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
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "./fullAccessGroup";

const adminDashboardUserSelect = {
  _count: {
    select: {
      accessGrants: true,
      authSessionsRevoked: true,
      attachments: true,
      chats: true,
      folders: true,
      knowledgeBases: true,
      mcpGrants: true,
      mcpOAuthConnections: true,
      mcpUserServers: true,
      modelRuns: true,
      assistantDefinitions: true,
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
          name: true,
          systemRole: true
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
  actingAdminUserId: string;
  now?: Date;
}>;

type AdminNavigationSummaryInput = Readonly<{
  actingAdminUserId: string;
  hasAccessRules: boolean;
  hasEnabledGroupAccessGrants: boolean;
  hasMcpGroupGrants: boolean;
  hasMcpServers: boolean;
  hasProviderGroupCredentialAssignments: boolean;
  hasSmtpConfiguration: boolean;
  invites: readonly Pick<AdminDashboard["invites"][number], "deletion">[];
  users: readonly Pick<
    AdminDashboard["users"][number],
    "effectiveEntitlements" | "id" | "role" | "status"
  >[];
}>;

export function hasTeamMcpGroupGrants(
  groups: readonly Readonly<{
    mcpGrants: readonly Readonly<{ canUse: boolean }>[];
    systemRole: typeof FULL_ACCESS_GROUP_SYSTEM_ROLE | null;
  }>[]
): boolean {
  return groups.some(
    (group) => group.systemRole !== FULL_ACCESS_GROUP_SYSTEM_ROLE &&
      group.mcpGrants.some((grant) => grant.canUse)
  );
}

export function summarizeAdminNavigation(
  input: AdminNavigationSummaryInput
): AdminDashboardNavigation {
  const onlyUser = input.users[0];
  const actingAdminIsOnlyUser = input.users.length === 1 &&
    onlyUser?.id === input.actingAdminUserId &&
    onlyUser.role === "admin" &&
    onlyUser.status === "active";
  const teamSignals = input.hasAccessRules ||
    input.hasEnabledGroupAccessGrants ||
    input.hasMcpGroupGrants ||
    input.hasProviderGroupCredentialAssignments ||
    input.invites.length > 0;

  return {
    advancedConfigured: input.hasMcpServers || input.hasSmtpConfiguration,
    attention: {
      activeUsersWithoutModelAccess: input.users.filter(
        (user) => user.id !== input.actingAdminUserId &&
          user.status === "active" &&
          user.effectiveEntitlements.models.length === 0 &&
          user.effectiveEntitlements.providers.length === 0
      ).length,
      openInvites: input.invites.filter((invite) => invite.deletion.reason === "invite_open").length,
      pendingUsers: input.users.filter((user) => user.status === "pending").length
    },
    teamConfigured: !actingAdminIsOnlyUser || teamSignals
  };
}

export async function listAdminDashboard(
  prisma: PrismaClient,
  options: AdminDashboardQueryOptions
): Promise<AdminDashboard> {
  const now = options.now ?? new Date();
  const [
    users,
    groups,
    accessRules,
    invites,
    catalog,
    grants,
    usageRows,
    mcpServer,
    smtpConfiguration
  ] = await Promise.all([
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
        providerConnectionId: true,
        providerModel: {
          select: { connectionId: true }
        },
        providerModelId: true,
        searchStrategy: true,
        userId: true
      },
      where: {
        enabled: true
      }
    }),
    loadAdminUsageQueryRows(prisma),
    prisma.mcpServer.findFirst({
      select: { id: true },
      where: { archivedAt: null }
    }),
    prisma.smtpControl.findFirst({
      select: {
        id: true
      },
      where: {
        OR: [
          {
            activeConfig: {
              not: Prisma.DbNull
            }
          },
          {
            draftConfig: {
              not: Prisma.DbNull
            }
          }
        ]
      }
    })
  ]);
  const groupNamesById = new Map(groups.map((group) => [group.id, { name: group.name }]));
  const usage = serializeAdminUsageDashboard({
    groups,
    providerModelRows: usageRows.providerModelRows,
    userRows: usageRows.userRows,
    users
  });
  const serializedAccessRules = accessRules.map((rule) => serializeAdminRule(rule, groupNamesById));
  const serializedGroups = groups.map(serializeAdminGroup);
  const serializedInvites = invites.map((invite) => serializeAdminInvite(invite, groupNamesById, now));
  const serializedUsers = users.map((user) => {
    const activeMemberships = user.groups.filter(
      (membership) => !membership.group.archivedAt
    );
    const activeGroupIds = activeMemberships.map((membership) => membership.groupId);

    return {
      deletion: adminUserDeletionInfo({
        ownedDataCount: adminUserOwnedDataCount(user),
        status: user.status
      }),
      displayName: user.displayName,
      effectiveEntitlements: serializeAdminEntitlements({
        catalog,
        fullAccess: activeMemberships.some(
          (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
        ),
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
  });
  const navigation = summarizeAdminNavigation({
    actingAdminUserId: options.actingAdminUserId,
    hasAccessRules: accessRules.length > 0,
    hasEnabledGroupAccessGrants: groups.some((group) =>
      group.accessGrants.some((grant) => grant.enabled)
    ),
    // Generated Full access grants are installation foundation, not evidence
    // that the operator configured a multi-user/team policy.
    hasMcpGroupGrants: hasTeamMcpGroupGrants(groups),
    hasMcpServers: Boolean(mcpServer),
    hasProviderGroupCredentialAssignments: groups.some(
      (group) => group._count.providerCredentialAssignments > 0
    ),
    hasSmtpConfiguration: Boolean(smtpConfiguration),
    invites: serializedInvites,
    users: serializedUsers
  });

  return {
    accessRules: serializedAccessRules,
    catalog,
    groups: serializedGroups,
    invites: serializedInvites,
    navigation,
    usage,
    users: serializedUsers
  };
}
