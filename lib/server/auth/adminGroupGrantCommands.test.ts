import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createAdminGroupGrantCommands } from "./adminGroupGrantCommands";

function transactionalClient(transaction: object): PrismaClient {
  return {
    $transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) => operation(transaction))
  } as unknown as PrismaClient;
}

describe("Full access admin group guards", () => {
  it("reserves the built-in name case-insensitively for create and rename", async () => {
    const create = vi.fn();
    const findFirst = vi.fn();
    const update = vi.fn();
    const commands = createAdminGroupGrantCommands({
      group: { create, findFirst, update }
    } as unknown as PrismaClient);

    await expect(commands.createGroup({ name: " FULL ACCESS " })).resolves.toBeNull();
    await expect(commands.renameGroup({ groupId: "ordinary", name: "full access" })).resolves.toBeNull();

    expect(create).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects archive before changing the built-in group or MCP runtime state", async () => {
    const update = vi.fn();
    const updateMany = vi.fn();
    const transaction = {
      group: {
        findFirst: vi.fn(async () => ({
          mcpGrants: [],
          systemRole: "full_access",
          users: []
        })),
        update
      },
      mcpUserServer: { updateMany }
    };
    const commands = createAdminGroupGrantCommands(transactionalClient(transaction));

    await expect(commands.archiveGroup("full-access")).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects delete before considering ordinary members and grants", async () => {
    const remove = vi.fn();
    const transaction = {
      group: {
        delete: remove,
        findUnique: vi.fn(async () => ({
          _count: { providerCredentialAssignments: 0, users: 0 },
          accessGrants: [],
          mcpGrants: [],
          systemRole: "full_access"
        }))
      }
    };
    const commands = createAdminGroupGrantCommands(transactionalClient(transaction));

    await expect(commands.deleteEmptyGroup("full-access")).resolves.toBe("system_group_forbidden");
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects rename and ordinary AccessGrant mutation without a write", async () => {
    const update = vi.fn();
    const accessGrantDeleteMany = vi.fn();
    const accessGrantCreate = vi.fn();
    const groupFindFirst = vi.fn(async () => null);
    const groupFindUnique = vi.fn(async () => ({
      archivedAt: null,
      id: "full-access",
      systemRole: "full_access"
    }));
    const client = {
      accessGrant: {
        create: accessGrantCreate,
        deleteMany: accessGrantDeleteMany
      },
      group: {
        findFirst: groupFindFirst,
        findUnique: groupFindUnique,
        update
      }
    } as unknown as PrismaClient;
    const commands = createAdminGroupGrantCommands(client);

    await expect(commands.renameGroup({ groupId: "full-access", name: "Renamed" })).resolves.toBeNull();
    await expect(commands.setGroupGrant({
      enabled: true,
      groupId: "full-access",
      provider: "openai"
    })).resolves.toBe(false);

    expect(groupFindFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: "full-access", systemRole: null }
    });
    expect(update).not.toHaveBeenCalled();
    expect(accessGrantDeleteMany).not.toHaveBeenCalled();
    expect(accessGrantCreate).not.toHaveBeenCalled();
  });

  it("keeps the existing Full access owner row untouched on a no-op membership save", async () => {
    const create = vi.fn();
    const deleteMany = vi.fn();
    const ownerMembership = {
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      groupId: "full-access",
      role: "owner",
      userId: "admin-1"
    };
    const transaction = {
      group: {
        findMany: vi.fn(async () => [{ id: ownerMembership.groupId }])
      },
      mcpGrant: {
        findMany: vi.fn(async () => [])
      },
      user: {
        findUnique: vi.fn(async () => ({ id: ownerMembership.userId }))
      },
      userGroup: {
        create,
        deleteMany,
        findMany: vi.fn(async () => [{ groupId: ownerMembership.groupId }])
      }
    };
    const commands = createAdminGroupGrantCommands(transactionalClient(transaction));

    await expect(
      commands.setUserGroups({
        groupIds: [ownerMembership.groupId, ownerMembership.groupId],
        userId: ownerMembership.userId
      })
    ).resolves.toBe(true);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(ownerMembership).toMatchObject({
      groupId: "full-access",
      role: "owner",
      userId: "admin-1"
    });
  });

  it("adds and removes only unrelated active groups while preserving owner and archived rows", async () => {
    const userId = "admin-1";
    const memberships = new Map([
      ["full-access", "owner"],
      ["remove-group", "member"],
      ["archived-group", "auditor"]
    ]);
    const deleteMany = vi.fn(async (input: {
      where: { groupId: { in: string[] }; userId: string };
    }) => {
      for (const groupId of input.where.groupId.in) {
        memberships.delete(groupId);
      }
      return { count: input.where.groupId.in.length };
    });
    const create = vi.fn(async (input: {
      data: { groupId: string; role: string; userId: string };
    }) => {
      memberships.set(input.data.groupId, input.data.role);
      return input.data;
    });
    const transaction = {
      group: {
        findMany: vi.fn(async () => [{ id: "full-access" }, { id: "add-group" }])
      },
      mcpGrant: {
        findMany: vi.fn(async () => [])
      },
      user: {
        findUnique: vi.fn(async () => ({ id: userId }))
      },
      userGroup: {
        create,
        deleteMany,
        findMany: vi.fn(async () => [
          { groupId: "full-access" },
          { groupId: "remove-group" }
        ])
      }
    };
    const commands = createAdminGroupGrantCommands(transactionalClient(transaction));

    await expect(
      commands.setUserGroups({
        groupIds: ["full-access", "add-group", "archived-group"],
        userId
      })
    ).resolves.toBe(true);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        groupId: { in: ["remove-group"] },
        userId
      }
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        groupId: "add-group",
        role: "member",
        userId
      }
    });
    expect(memberships).toEqual(new Map([
      ["full-access", "owner"],
      ["archived-group", "auditor"],
      ["add-group", "member"]
    ]));
  });
});
