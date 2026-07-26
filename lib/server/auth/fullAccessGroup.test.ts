import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ensureFullAccessGroup,
  FULL_ACCESS_GROUP_NAME,
  FULL_ACCESS_GROUP_SYSTEM_ROLE
} from "./fullAccessGroup";

function persistenceFixture(input: Readonly<{
  existingNames?: string[];
  mcpServerIds?: string[];
  namedGroupId?: string | null;
  systemGroupId?: string | null;
}> = {}) {
  const groupCreate = vi.fn(async () => ({ id: "created-full-access" }));
  const groupFindUnique = vi.fn(async (query: { where: { name?: string; systemRole?: string } }) => {
    if (query.where.systemRole) {
      return input.systemGroupId ? { id: input.systemGroupId } : null;
    }
    if (query.where.name === FULL_ACCESS_GROUP_NAME) {
      return input.namedGroupId
        ? { id: input.namedGroupId }
        : input.systemGroupId
          ? { id: input.systemGroupId }
          : null;
    }
    return input.existingNames?.includes(query.where.name ?? "")
      ? { id: `existing:${query.where.name}` }
      : null;
  });
  const groupUpdate = vi.fn(async (query: { where: { id: string } }) => ({ id: query.where.id }));
  const mcpGrantUpsert = vi.fn(async () => ({ id: "grant" }));
  const mcpServerFindMany = vi.fn(async () =>
    (input.mcpServerIds ?? []).map((id) => ({ id }))
  );
  const userGroupUpsert = vi.fn(async () => ({}));
  const persistence = {
    group: {
      create: groupCreate,
      findUnique: groupFindUnique,
      update: groupUpdate
    },
    mcpGrant: { upsert: mcpGrantUpsert },
    mcpServer: { findMany: mcpServerFindMany },
    userGroup: { upsert: userGroupUpsert }
  } as unknown as Prisma.TransactionClient;

  return {
    groupCreate,
    groupFindUnique,
    groupUpdate,
    mcpGrantUpsert,
    mcpServerFindMany,
    persistence,
    userGroupUpsert
  };
}

describe("ensureFullAccessGroup", () => {
  it("creates the system group, installs the initial admin, and grants every existing MCP server", async () => {
    const fixture = persistenceFixture({ mcpServerIds: ["mcp-b", "mcp-a"] });

    await expect(ensureFullAccessGroup(fixture.persistence, "initial-admin")).resolves.toEqual({
      id: "created-full-access"
    });

    expect(fixture.groupCreate).toHaveBeenCalledWith({
      data: {
        name: FULL_ACCESS_GROUP_NAME,
        systemRole: FULL_ACCESS_GROUP_SYSTEM_ROLE
      },
      select: { id: true }
    });
    expect(fixture.userGroupUpsert).toHaveBeenCalledWith({
      create: {
        groupId: "created-full-access",
        role: "owner",
        userId: "initial-admin"
      },
      update: { role: "owner" },
      where: {
        userId_groupId: {
          groupId: "created-full-access",
          userId: "initial-admin"
        }
      }
    });
    expect(fixture.mcpServerFindMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
      select: { id: true }
    });
    expect(fixture.mcpGrantUpsert).toHaveBeenCalledTimes(2);
    expect(fixture.mcpGrantUpsert).toHaveBeenNthCalledWith(1, {
      create: {
        canUse: true,
        groupId: "created-full-access",
        personalSlotKeys: [],
        serverId: "mcp-b",
        userId: null
      },
      update: {
        canUse: true,
        personalSlotKeys: []
      },
      where: {
        serverId_groupId: {
          groupId: "created-full-access",
          serverId: "mcp-b"
        }
      }
    });
  });

  it("isolates an exact-name custom group and repairs the system group idempotently", async () => {
    const adoption = persistenceFixture({
      existingNames: ["Full access (custom)"],
      namedGroupId: "named-group"
    });

    await ensureFullAccessGroup(adoption.persistence, "initial-admin");

    expect(adoption.groupCreate).toHaveBeenCalledWith({
      data: {
        name: FULL_ACCESS_GROUP_NAME,
        systemRole: FULL_ACCESS_GROUP_SYSTEM_ROLE
      },
      select: { id: true }
    });
    expect(adoption.groupUpdate).toHaveBeenCalledWith({
      data: { name: "Full access (custom 2)" },
      select: { id: true },
      where: { id: "named-group" }
    });

    const repair = persistenceFixture({ systemGroupId: "system-group" });
    await ensureFullAccessGroup(repair.persistence, "initial-admin");

    expect(repair.groupFindUnique).toHaveBeenCalledTimes(2);
    expect(repair.groupCreate).not.toHaveBeenCalled();
    expect(repair.groupUpdate).toHaveBeenCalledWith({
      data: {
        archivedAt: null,
        name: FULL_ACCESS_GROUP_NAME
      },
      select: { id: true },
      where: { id: "system-group" }
    });
  });
});
