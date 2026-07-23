import type { Prisma } from "@prisma/client";

export const adminGroupRecordInclude = {
  _count: {
    select: {
      users: true
    }
  },
  accessGrants: {
    orderBy: [
      {
        provider: "asc"
      },
      {
        modelId: "asc"
      },
      {
        searchStrategy: "asc"
      }
    ],
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
      userId: null
    }
  },
  mcpGrants: {
    select: {
      canUse: true
    },
    where: {
      userId: null
    }
  }
} satisfies Prisma.GroupInclude;

export type AdminGroupRecordRow = Prisma.GroupGetPayload<{
  include: typeof adminGroupRecordInclude;
}>;
