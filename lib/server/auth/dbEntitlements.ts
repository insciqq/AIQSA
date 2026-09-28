import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { resolveEntitlements } from "./entitlements";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "./fullAccessGroup";

type EntitlementPrisma = Pick<PrismaClient, "accessGrant" | "userGroup">;

/** A membership of a group that is not archived, the only kind any access rule counts. */
export type ActiveGroupMembership = Readonly<{
  groupId: string;
  systemRole: string | null;
}>;

/**
 * The user's memberships of groups that are not archived. A caller that
 * checks several kinds of access reads them once and passes them on.
 */
export async function loadActiveGroupMemberships(
  db: Pick<PrismaClient, "userGroup">,
  userId: string
): Promise<ActiveGroupMembership[]> {
  const memberships = await db.userGroup.findMany({
    select: {
      group: {
        select: {
          systemRole: true
        }
      },
      groupId: true
    },
    where: {
      group: {
        archivedAt: null
      },
      userId
    }
  });
  return memberships.map((membership) => ({
    groupId: membership.groupId,
    systemRole: membership.group.systemRole
  }));
}

/** The user's entitlements from memberships already read with `loadActiveGroupMemberships`. */
export async function loadEntitlementsForMemberships(
  db: Pick<PrismaClient, "accessGrant">,
  userId: string,
  memberships: readonly ActiveGroupMembership[]
) {
  const groupIds = memberships.map((membership) => membership.groupId);
  const grants = await db.accessGrant.findMany({
    include: {
      providerModel: {
        select: {
          connectionId: true
        }
      }
    },
    where: {
      OR: [
        {
          userId
        },
        {
          groupId: {
            in: groupIds
          }
        }
      ]
    }
  });

  return resolveEntitlements(
    userId,
    groupIds,
    grants.map((grant) => ({
      ...grant,
      providerModelConnectionId: grant.providerModel?.connectionId ?? null
    })),
    {
      fullAccess: memberships.some(
        (membership) => membership.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
      )
    }
  );
}

export async function loadEntitlementsForUser(
  userId: string,
  db: EntitlementPrisma = prisma
) {
  return loadEntitlementsForMemberships(db, userId, await loadActiveGroupMemberships(db, userId));
}
