import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { resolveEntitlements } from "./entitlements";
import { FULL_ACCESS_GROUP_SYSTEM_ROLE } from "./fullAccessGroup";

type EntitlementPrisma = Pick<PrismaClient, "accessGrant" | "userGroup">;

export async function loadEntitlementsForUser(
  userId: string,
  db: EntitlementPrisma = prisma
) {
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
        (membership) => membership.group.systemRole === FULL_ACCESS_GROUP_SYSTEM_ROLE
      )
    }
  );
}
