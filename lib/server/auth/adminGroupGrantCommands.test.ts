import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createAdminGroupGrantCommands } from "./adminGroupGrantCommands";

function transactionalClient(transaction: object): PrismaClient {
  return {
    $transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) => operation(transaction))
  } as unknown as PrismaClient;
}

/** A transaction fake that records whether the callback threw, which is what makes Prisma roll back. */
function observedTransactionClient(transaction: object) {
  const outcomes: ("committed" | "rolled_back")[] = [];
  const client = {
    $transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) => {
      try {
        const value = await operation(transaction);
        outcomes.push("committed");
        return value;
      } catch (error) {
        outcomes.push("rolled_back");
        throw error;
      }
    })
  } as unknown as PrismaClient;
  return { client, outcomes };
}

function grantTransaction(overrides: {
  group?: { archivedAt: string | null; id: string; systemRole: string | null } | null;
  modelLookup?: (where: { id: string }) => unknown;
  providerModelCount?: number;
  searchLookup?: (where: { optionId: string }) => unknown;
} = {}) {
  const create = vi.fn(async (input: { data: object }) => input.data);
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    create,
    deleteMany,
    transaction: {
      accessGrant: { create, deleteMany },
      group: {
        findUnique: vi.fn(async () =>
          overrides.group === undefined
            ? { archivedAt: null, id: "group-1", systemRole: null }
            : overrides.group
        )
      },
      providerModel: {
        count: vi.fn(async () => overrides.providerModelCount ?? 2),
        findFirst: vi.fn(async (input: { where: { id: string } }) =>
          overrides.modelLookup ? overrides.modelLookup(input.where) : { id: input.where.id })
      },
      searchOption: {
        findFirst: vi.fn(async (input: { where: { optionId: string } }) =>
          overrides.searchLookup ? overrides.searchLookup(input.where) : { id: "option-row" })
      }
    }
  };
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
    const groupFindFirst = vi.fn(async () => null);
    const grants = grantTransaction({
      group: { archivedAt: null, id: "full-access", systemRole: "full_access" }
    });
    const client = {
      $transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) => operation(grants.transaction)),
      group: {
        findFirst: groupFindFirst,
        update
      }
    } as unknown as PrismaClient;
    const commands = createAdminGroupGrantCommands(client);

    await expect(commands.renameGroup({ groupId: "full-access", name: "Renamed" })).resolves.toBeNull();
    await expect(commands.setGroupGrants({
      changes: [{ enabled: true, provider: "openai" }],
      groupId: "full-access"
    })).resolves.toEqual({ kind: "system_group_forbidden" });

    expect(groupFindFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: "full-access", systemRole: null }
    });
    expect(update).not.toHaveBeenCalled();
    expect(grants.deleteMany).not.toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
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

describe("Logical Search grants", () => {
  it("grants an enabled connection-scoped logical Search option", async () => {
    const optionId = "custom-web-search:connection-custom";
    const grants = grantTransaction();
    const { client, outcomes } = observedTransactionClient(grants.transaction);

    await expect(createAdminGroupGrantCommands(client).setGroupGrants({
      changes: [{ enabled: true, searchStrategy: optionId }],
      groupId: "group-1"
    })).resolves.toEqual({ kind: "applied" });

    expect(outcomes).toEqual(["committed"]);
    expect(grants.transaction.searchOption.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        archivedAt: null,
        enabled: true,
        optionId
      }
    });
    expect(grants.deleteMany).toHaveBeenCalledWith({
      where: {
        groupId: "group-1",
        providerConnectionId: null,
        providerModelId: null,
        searchStrategy: optionId,
        userId: null
      }
    });
    expect(grants.create).toHaveBeenCalledWith({
      data: {
        enabled: true,
        groupId: "group-1",
        providerConnectionId: null,
        providerModelId: null,
        searchStrategy: optionId,
        userId: null
      }
    });
  });
});

describe("Batched group grants", () => {
  it("applies provider-wide, model and Search changes in order inside one transaction", async () => {
    const grants = grantTransaction();
    const { client, outcomes } = observedTransactionClient(grants.transaction);

    await expect(createAdminGroupGrantCommands(client).setGroupGrants({
      changes: [
        { enabled: true, provider: "conn-openai" },
        { enabled: false, modelId: "model-mini", provider: "conn-openai" },
        { enabled: true, searchStrategy: "web" }
      ],
      groupId: "group-1"
    })).resolves.toEqual({ kind: "applied" });

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["committed"]);
    const providerWide = { groupId: "group-1", providerConnectionId: "conn-openai", providerModelId: null, searchStrategy: null, userId: null };
    const model = { groupId: "group-1", providerConnectionId: null, providerModelId: "model-mini", searchStrategy: null, userId: null };
    const search = { groupId: "group-1", providerConnectionId: null, providerModelId: null, searchStrategy: "web", userId: null };
    expect(grants.deleteMany.mock.calls.map(([input]) => input)).toEqual([
      { where: providerWide },
      { where: model },
      { where: search }
    ]);
    expect(grants.create.mock.calls.map(([input]) => input)).toEqual([
      { data: { enabled: true, ...providerWide } },
      { data: { enabled: true, ...search } }
    ]);
    expect(grants.transaction.providerModel.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ connectionId: "conn-openai", enabled: true, id: "model-mini" })
    }));
  });

  it("rolls the whole batch back and names the first change that is not grantable", async () => {
    const grants = grantTransaction({
      modelLookup: (where) => (where.id === "model-retired" ? null : { id: where.id })
    });
    const { client, outcomes } = observedTransactionClient(grants.transaction);

    await expect(createAdminGroupGrantCommands(client).setGroupGrants({
      changes: [
        { enabled: true, modelId: "model-a", provider: "conn-openai" },
        { enabled: true, modelId: "model-retired", provider: "conn-openai" },
        { enabled: true, modelId: "model-b", provider: "conn-openai" }
      ],
      groupId: "group-1"
    })).resolves.toEqual({ change: 1, kind: "invalid_change" });

    // The first change was written inside the transaction; the thrown rejection is what discards it.
    expect(grants.create).toHaveBeenCalledTimes(1);
    expect(grants.create).toHaveBeenCalledWith({
      data: { enabled: true, groupId: "group-1", providerConnectionId: null, providerModelId: "model-a", searchStrategy: null, userId: null }
    });
    expect(outcomes).toEqual(["rolled_back"]);
    expect(grants.transaction.providerModel.findFirst).toHaveBeenCalledTimes(2);
  });

  it("rejects a provider without active models, a disabled Search option and a missing or archived group before any write", async () => {
    const noModels = grantTransaction({ providerModelCount: 0, searchLookup: () => null });
    await expect(createAdminGroupGrantCommands(transactionalClient(noModels.transaction)).setGroupGrants({
      changes: [{ enabled: true, searchStrategy: "web" }, { enabled: true, provider: "conn-empty" }],
      groupId: "group-1"
    })).resolves.toEqual({ change: 0, kind: "invalid_change" });
    await expect(createAdminGroupGrantCommands(transactionalClient(noModels.transaction)).setGroupGrants({
      changes: [{ enabled: true, provider: "conn-empty" }],
      groupId: "group-1"
    })).resolves.toEqual({ change: 0, kind: "invalid_change" });
    expect(noModels.deleteMany).not.toHaveBeenCalled();
    expect(noModels.create).not.toHaveBeenCalled();

    const missing = grantTransaction({ group: null });
    await expect(createAdminGroupGrantCommands(transactionalClient(missing.transaction)).setGroupGrants({
      changes: [{ enabled: true, provider: "conn-openai" }],
      groupId: "group-missing"
    })).resolves.toEqual({ kind: "group_not_found" });

    const archived = grantTransaction({ group: { archivedAt: "2026-07-01T00:00:00.000Z", id: "group-old", systemRole: null } });
    await expect(createAdminGroupGrantCommands(transactionalClient(archived.transaction)).setGroupGrants({
      changes: [{ enabled: false, provider: "conn-openai" }],
      groupId: "group-old"
    })).resolves.toEqual({ kind: "group_archived" });
    expect(missing.deleteMany).not.toHaveBeenCalled();
    expect(archived.deleteMany).not.toHaveBeenCalled();
  });
});
