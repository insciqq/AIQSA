import type { Prisma } from "@prisma/client";

export const adminGroupRecordInclude = {
  _count: {
    select: {
      assistantPublications: true,
      knowledgeBasePublications: true,
      providerCredentialAssignments: true,
      users: true
    }
  },
  accessGrants: {
    orderBy: [
      {
        providerConnectionId: "asc"
      },
      {
        providerModelId: "asc"
      },
      {
        searchStrategy: "asc"
      }
    ],
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
