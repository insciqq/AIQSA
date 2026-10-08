import { Prisma, type PrismaClient } from "@prisma/client";
import {
  isSignInOutcomeCode,
  type AdminGroupSignIn,
  type AdminMembershipManager,
  type AdminUserSignIn,
  type AdminUserSignInIdentity
} from "@/lib/contracts/adminSignIn";
import {
  EXTERNAL_GROUP_LIST_MAX,
  EXTERNAL_GROUP_SOURCES,
  externalGroupNameSchema,
  isExternalGroupSource,
  type ExternalGroupSource
} from "@/lib/contracts/authSignInMethods";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import { logEvent } from "../observability";
import { lockAuthUser } from "./transactionLocks";

type ManagedMembershipTransaction = Pick<Prisma.TransactionClient, "authIdentity" | "group" | "groupExternalName">;

/** The sources whose identities of a user manage group memberships, in a stable order. */
function managingSources(providers: Iterable<string>): ExternalGroupSource[] {
  const present = new Set(providers);
  return EXTERNAL_GROUP_SOURCES.filter((source) => present.has(source));
}

/**
 * Which of the given groups an IdP manages for this user: groups SCIM pushes, and groups with an
 * external name for a source the user has an identity with. The next SCIM push or sign-in
 * would undo a manual change to such a membership, so administrators cannot make one.
 */
export async function managedMemberships(
  tx: ManagedMembershipTransaction,
  input: { groupIds: readonly string[]; userId: string }
): Promise<Map<string, AdminMembershipManager>> {
  const managed = new Map<string, AdminMembershipManager>();
  if (!input.groupIds.length) return managed;
  const groupIds = [...new Set(input.groupIds)];
  const [scimGroups, identities] = await Promise.all([
    tx.group.findMany({ select: { id: true }, where: { id: { in: groupIds }, scimExternalId: { not: null } } }),
    tx.authIdentity.findMany({ select: { provider: true }, where: { userId: input.userId } })
  ]);
  for (const group of scimGroups) managed.set(group.id, "scim");
  const sources = managingSources(identities.map((identity) => identity.provider));
  if (!sources.length) return managed;
  const names = await tx.groupExternalName.findMany({
    select: { groupId: true, source: true },
    where: { groupId: { in: groupIds }, source: { in: sources } }
  });
  for (const source of sources) {
    for (const name of names) {
      if (name.source === source && !managed.has(name.groupId)) managed.set(name.groupId, source);
    }
  }
  return managed;
}

export type SignInManagementFailureCode =
  | "external_name_duplicate"
  | "external_name_invalid"
  | "external_name_limit"
  | "external_name_not_found"
  | "group_archived"
  | "group_not_found"
  | "identity_last_sign_in_method"
  | "identity_not_found"
  | "identity_unlink_forbidden"
  | "user_not_found";

export type SignInManagementResult<T> = { ok: true; value: T } | { code: SignInManagementFailureCode; ok: false };

/** The source each admin-active method binds identities to, for the "previous source" marker. */
export type CurrentIdentitySources = Partial<Record<ExternalGroupSource, string>>;

export type SignInManagementRepository = {
  addExternalName(input: { groupId: string; source: unknown; value: unknown }): Promise<SignInManagementResult<AdminGroupSignIn>>;
  readGroup(groupId: string): Promise<AdminGroupSignIn | null>;
  readUser(userId: string, currentSources: CurrentIdentitySources): Promise<AdminUserSignIn | null>;
  removeExternalName(input: { externalNameId: string; groupId: string }): Promise<SignInManagementResult<AdminGroupSignIn>>;
  unlinkIdentity(input: {
    confirmLastSignInMethod: boolean;
    currentSources: CurrentIdentitySources;
    identityId: string;
    userId: string;
  }): Promise<SignInManagementResult<AdminUserSignIn>>;
};

type ReadClient = Pick<Prisma.TransactionClient, "authIdentity" | "group" | "groupExternalName" | "user" | "userGroup">;

async function groupProjection(client: ReadClient, groupId: string): Promise<AdminGroupSignIn | null> {
  const group = await client.group.findUnique({
    select: {
      externalNames: { orderBy: [{ source: "asc" }, { value: "asc" }], select: { id: true, source: true, value: true } },
      id: true,
      scimExternalId: true
    },
    where: { id: groupId }
  });
  if (!group) return null;
  const scimManaged = group.scimExternalId !== null;
  const sources = managingSources(group.externalNames.map((name) => name.source));
  const members = scimManaged || sources.length
    ? await client.userGroup.findMany({
        select: {
          user: { select: { authIdentities: { select: { provider: true } } } },
          userId: true
        },
        where: { groupId }
      })
    : [];
  const managedMembers: AdminGroupSignIn["managedMembers"] = [];
  for (const member of members) {
    if (scimManaged) {
      managedMembers.push({ managedBy: "scim", userId: member.userId });
      continue;
    }
    const providers = new Set<string>(member.user.authIdentities.map((identity) => identity.provider));
    const source = sources.find((candidate) => providers.has(candidate));
    if (source) managedMembers.push({ managedBy: source, userId: member.userId });
  }
  return {
    externalNames: group.externalNames.map((name) => ({ id: name.id, source: name.source, value: name.value })),
    managedMembers: managedMembers.sort((left, right) => left.userId.localeCompare(right.userId)),
    scimManaged
  };
}

async function userProjection(
  client: ReadClient,
  userId: string,
  currentSources: CurrentIdentitySources
): Promise<AdminUserSignIn | null> {
  const user = await client.user.findUnique({
    select: {
      authIdentities: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          createdAt: true,
          id: true,
          lastSyncedAt: true,
          lastSyncWarning: true,
          passwordHash: true,
          provider: true,
          source: true
        }
      },
      groups: { select: { groupId: true }, where: { group: { archivedAt: null } } },
      id: true
    },
    where: { id: userId }
  });
  if (!user) return null;
  const identities: AdminUserSignInIdentity[] = [];
  for (const identity of user.authIdentities) {
    if (identity.provider === "password") continue;
    const currentSource = isExternalGroupSource(identity.provider) ? currentSources[identity.provider] : undefined;
    identities.push({
      createdAt: identity.createdAt.toISOString(),
      id: identity.id,
      lastSyncedAt: identity.lastSyncedAt?.toISOString() ?? null,
      lastSyncWarning: isSignInOutcomeCode(identity.lastSyncWarning) ? identity.lastSyncWarning : null,
      provider: identity.provider,
      sourceCurrent: currentSource === undefined || identity.source === null ? null : identity.source === currentSource
    });
  }
  const managed = await managedMemberships(client, {
    groupIds: user.groups.map((membership) => membership.groupId),
    userId
  });
  return {
    hasPassword: user.authIdentities.some((identity) => identity.provider === "password" && Boolean(identity.passwordHash)),
    identities,
    managedGroups: [...managed.entries()]
      .map(([groupId, managedBy]) => ({ groupId, managedBy }))
      .sort((left, right) => left.groupId.localeCompare(right.groupId))
  };
}

function audit(code: string): void {
  logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code });
}

export function createPrismaSignInManagementRepository(prisma: PrismaClient): SignInManagementRepository {
  return {
    async readGroup(groupId) {
      return groupProjection(prisma, groupId).catch(retainDatabaseFailure);
    },

    async addExternalName(input) {
      const value = externalGroupNameSchema.safeParse(input.value);
      if (!isExternalGroupSource(input.source) || !value.success) return { code: "external_name_invalid", ok: false };
      const source = input.source;
      try {
        return await prisma.$transaction<SignInManagementResult<AdminGroupSignIn>>(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Group" WHERE "id" = ${input.groupId} FOR UPDATE`;
          const group = await tx.group.findUnique({ select: { archivedAt: true }, where: { id: input.groupId } });
          if (!group) return { code: "group_not_found", ok: false };
          if (group.archivedAt) return { code: "group_archived", ok: false };
          const count = await tx.groupExternalName.count({ where: { groupId: input.groupId, source } });
          if (count >= EXTERNAL_GROUP_LIST_MAX) return { code: "external_name_limit", ok: false };
          await tx.groupExternalName.create({ data: { groupId: input.groupId, source, value: value.data } });
          const projection = await groupProjection(tx, input.groupId);
          return projection ? { ok: true, value: projection } : { code: "group_not_found", ok: false };
        }).then((result) => {
          if (result.ok) audit("external_group_name_added");
          return result;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return { code: "external_name_duplicate", ok: false };
        }
        return retainDatabaseFailure(error);
      }
    },

    async removeExternalName(input) {
      return prisma.$transaction<SignInManagementResult<AdminGroupSignIn>>(async (tx) => {
        const removed = await tx.groupExternalName.deleteMany({ where: { groupId: input.groupId, id: input.externalNameId } });
        if (removed.count !== 1) return { code: "external_name_not_found", ok: false };
        const projection = await groupProjection(tx, input.groupId);
        return projection ? { ok: true, value: projection } : { code: "group_not_found", ok: false };
      }).then((result) => {
        if (result.ok) audit("external_group_name_removed");
        return result;
      }).catch(retainDatabaseFailure);
    },

    async readUser(userId, currentSources) {
      return userProjection(prisma, userId, currentSources).catch(retainDatabaseFailure);
    },

    async unlinkIdentity(input) {
      return prisma.$transaction<SignInManagementResult<AdminUserSignIn>>(async (tx) => {
        await lockAuthUser(tx, input.userId);
        const identities = await tx.authIdentity.findMany({
          select: { id: true, passwordHash: true, provider: true },
          where: { userId: input.userId }
        });
        const identity = identities.find((candidate) => candidate.id === input.identityId);
        if (!identity) {
          const user = await tx.user.findUnique({ select: { id: true }, where: { id: input.userId } });
          return { code: user ? "identity_not_found" : "user_not_found", ok: false };
        }
        if (identity.provider === "password") return { code: "identity_unlink_forbidden", ok: false };
        // A local password or another identity keeps the account reachable; without one the
        // administrator confirms that the user cannot sign in until they re-link or get an invite.
        const remainingWayIn = identities.some((candidate) =>
          candidate.id !== identity.id && (candidate.provider !== "password" || Boolean(candidate.passwordHash))
        );
        if (!remainingWayIn && !input.confirmLastSignInMethod) return { code: "identity_last_sign_in_method", ok: false };
        await tx.authIdentity.delete({ where: { id: identity.id } });
        const projection = await userProjection(tx, input.userId, input.currentSources);
        return projection ? { ok: true, value: projection } : { code: "user_not_found", ok: false };
      }).then((result) => {
        if (result.ok) audit("identity_unlinked");
        return result;
      }).catch(retainDatabaseFailure);
    }
  };
}
