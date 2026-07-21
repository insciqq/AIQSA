import { prisma } from "../prisma";
import { resolveEntitlements } from "./entitlements";

export async function loadEntitlementsForUser(userId: string) {
  const memberships = await prisma.userGroup.findMany({
    select: {
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
  const grants = await prisma.accessGrant.findMany({
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

  return resolveEntitlements(userId, groupIds, grants);
}
