import type { Prisma } from "@prisma/client";
import type { ExternalGroupSource } from "@/lib/contracts/authSignInMethods";

type MembershipTransaction = Pick<Prisma.TransactionClient, "mcpGrant" | "mcpUserServer" | "userGroup">;

type ExternalGroupSyncTransaction = MembershipTransaction &
  Pick<Prisma.TransactionClient, "groupExternalName">;

export type MembershipChangeInput = {
  /** Active groups to join. */
  add: readonly string[];
  /** Groups to leave. */
  remove: readonly string[];
  userId: string;
};

export type MembershipChangeResult = {
  added: number;
  removed: number;
};

export type ExternalGroupSyncWarning = "groups_claim_missing";

export type ExternalGroupSyncResult = MembershipChangeResult & {
  warning?: ExternalGroupSyncWarning;
};

/**
 * Changes one user's group memberships with the side effects every membership writer shares:
 * new memberships get the `member` role, and each MCP server any of the user's active groups
 * grants before or after the change drops its desired runtime generation, so the runtime
 * re-resolves the user's access; a server the user can no longer use is switched off for them.
 * Memberships of archived groups are never touched. Callers own authorization, locking and
 * stale detection, and pass only active groups to add.
 */
export async function applyMembershipChange(
  tx: MembershipTransaction,
  input: MembershipChangeInput
): Promise<MembershipChangeResult> {
  const memberships = await tx.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  const currentGroupIds = new Set(memberships.map((membership) => membership.groupId));
  const leaving = new Set(input.remove);
  const nextGroupIds = new Set([...currentGroupIds].filter((groupId) => !leaving.has(groupId)));
  for (const groupId of input.add) {
    nextGroupIds.add(groupId);
  }
  const removedGroupIds = [...currentGroupIds].filter((groupId) => !nextGroupIds.has(groupId));
  const addedGroupIds = [...nextGroupIds].filter((groupId) => !currentGroupIds.has(groupId));
  const affectedGroupIds = [...new Set([...currentGroupIds, ...nextGroupIds])];
  const affectedMcpServers = affectedGroupIds.length
    ? await tx.mcpGrant.findMany({
        distinct: ["serverId"],
        select: { serverId: true },
        where: { canUse: true, groupId: { in: affectedGroupIds } }
      })
    : [];

  if (removedGroupIds.length) {
    await tx.userGroup.deleteMany({
      where: {
        groupId: { in: removedGroupIds },
        userId: input.userId
      }
    });
  }

  for (const groupId of addedGroupIds) {
    await tx.userGroup.create({
      data: {
        groupId,
        role: "member",
        userId: input.userId
      }
    });
  }

  const affectedServerIds = affectedMcpServers.map((grant) => grant.serverId);
  if (affectedServerIds.length) {
    await tx.mcpUserServer.updateMany({
      data: { desiredRuntimeGenerationId: null },
      where: { serverId: { in: affectedServerIds }, userId: input.userId }
    });
    for (const serverId of affectedServerIds) {
      const canStillUse = await tx.mcpGrant.count({
        where: {
          canUse: true,
          serverId,
          OR: [
            { userId: input.userId },
            ...(nextGroupIds.size ? [{ groupId: { in: [...nextGroupIds] } }] : [])
          ]
        }
      });
      if (!canStillUse) {
        await tx.mcpUserServer.updateMany({
          data: { enabled: false },
          where: { serverId, userId: input.userId }
        });
      }
    }
  }

  return { added: addedGroupIds.length, removed: removedGroupIds.length };
}

/**
 * Makes the user's memberships in the groups a source manages (active groups with an external
 * name for it) match the values the source asserted. Groups without a name for the source are
 * never touched and none is ever created; `null` values (the claim or attribute was missing)
 * change nothing.
 */
export async function syncExternalGroups(
  tx: ExternalGroupSyncTransaction,
  input: { source: ExternalGroupSource; userId: string; values: readonly string[] | null }
): Promise<ExternalGroupSyncResult> {
  if (input.values === null) {
    return { added: 0, removed: 0, warning: "groups_claim_missing" };
  }

  const values = new Set(input.values);
  const externalNames = await tx.groupExternalName.findMany({
    select: { groupId: true, value: true },
    where: { group: { archivedAt: null }, source: input.source }
  });
  const managedGroupIds = new Set(externalNames.map((name) => name.groupId));

  if (!managedGroupIds.size) {
    return { added: 0, removed: 0 };
  }

  const mappedGroupIds = new Set(
    externalNames.filter((name) => values.has(name.value)).map((name) => name.groupId)
  );
  const memberships = await tx.userGroup.findMany({
    select: { groupId: true },
    where: { groupId: { in: [...managedGroupIds] }, userId: input.userId }
  });
  const managedMemberships = new Set(memberships.map((membership) => membership.groupId));
  const add = [...mappedGroupIds].filter((groupId) => !managedMemberships.has(groupId)).sort();
  const remove = [...managedMemberships].filter((groupId) => !mappedGroupIds.has(groupId)).sort();

  if (!add.length && !remove.length) {
    return { added: 0, removed: 0 };
  }

  return applyMembershipChange(tx, { add, remove, userId: input.userId });
}
