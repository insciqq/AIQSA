import { createMeHandler } from "@/lib/server/auth/handlers";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const GET = createMeHandler({
  findUserWithGroups: async (userId) => {
    const user = await prisma.user.findUnique({
      include: {
        groups: {
          include: {
            group: true
          }
        }
      },
      where: {
        id: userId
      }
    });

    if (!user) {
      return null;
    }

    return {
      displayName: user.displayName,
      email: user.email,
      groups: user.groups.map((membership) => ({
        groupId: membership.groupId,
        name: membership.group.name,
        role: membership.role
      })),
      id: user.id,
      role: user.role,
      status: user.status
    };
  },
  resolveAuth: resolveRequestAuth
});
