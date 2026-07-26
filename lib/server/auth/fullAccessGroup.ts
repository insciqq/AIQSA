import type { Prisma } from "@prisma/client";

export const FULL_ACCESS_GROUP_NAME = "Full access";
export const FULL_ACCESS_GROUP_SYSTEM_ROLE = "full_access" as const;

type FullAccessGroupPersistence = Pick<
  Prisma.TransactionClient,
  "group" | "mcpGrant" | "mcpServer" | "userGroup"
>;

async function availableCustomGroupName(
  persistence: FullAccessGroupPersistence
): Promise<string> {
  let suffix = 1;

  while (true) {
    const name = suffix === 1
      ? `${FULL_ACCESS_GROUP_NAME} (custom)`
      : `${FULL_ACCESS_GROUP_NAME} (custom ${suffix})`;
    const collision = await persistence.group.findUnique({
      select: { id: true },
      where: { name }
    });

    if (!collision) return name;
    suffix += 1;
  }
}

export async function ensureFullAccessGroup(
  persistence: FullAccessGroupPersistence,
  initialAdminUserId: string
): Promise<{ id: string }> {
  const systemGroup = await persistence.group.findUnique({
    select: { id: true },
    where: { systemRole: FULL_ACCESS_GROUP_SYSTEM_ROLE }
  });
  const namedGroup = await persistence.group.findUnique({
    select: { id: true },
    where: { name: FULL_ACCESS_GROUP_NAME }
  });

  if (namedGroup && namedGroup.id !== systemGroup?.id) {
    await persistence.group.update({
      data: { name: await availableCustomGroupName(persistence) },
      select: { id: true },
      where: { id: namedGroup.id }
    });
  }

  const group = systemGroup
    ? await persistence.group.update({
        data: {
          archivedAt: null,
          name: FULL_ACCESS_GROUP_NAME
        },
        select: { id: true },
        where: { id: systemGroup.id }
      })
    : await persistence.group.create({
        data: {
          name: FULL_ACCESS_GROUP_NAME,
          systemRole: FULL_ACCESS_GROUP_SYSTEM_ROLE
        },
        select: { id: true }
      });

  await persistence.userGroup.upsert({
    create: {
      groupId: group.id,
      role: "owner",
      userId: initialAdminUserId
    },
    update: {
      role: "owner"
    },
    where: {
      userId_groupId: {
        groupId: group.id,
        userId: initialAdminUserId
      }
    }
  });

  const servers = await persistence.mcpServer.findMany({
    orderBy: { id: "asc" },
    select: { id: true }
  });

  for (const server of servers) {
    await persistence.mcpGrant.upsert({
      create: {
        canUse: true,
        groupId: group.id,
        personalSlotKeys: [],
        serverId: server.id,
        userId: null
      },
      update: {
        canUse: true,
        personalSlotKeys: []
      },
      where: {
        serverId_groupId: {
          groupId: group.id,
          serverId: server.id
        }
      }
    });
  }

  return group;
}
