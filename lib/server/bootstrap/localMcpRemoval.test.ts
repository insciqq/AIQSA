import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { applyLocalMcpRemovalGate, type LocalMcpLeftovers } from "./localMcpRemoval";

function transaction(leftovers: LocalMcpLeftovers) {
  const calls: Array<[string, unknown]> = [];
  const deleteMany = (name: string) => vi.fn(async (args: unknown) => {
    calls.push([name, args]);
    return { count: 0 };
  });
  const tx = {
    $executeRaw: vi.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(["resetDrafts", values]);
      return 0;
    }),
    $queryRaw: vi.fn(async () => [leftovers]),
    mcpActivationJob: { deleteMany: deleteMany("mcpActivationJob") },
    mcpOAuthClient: { deleteMany: deleteMany("mcpOAuthClient") },
    mcpOAuthConnection: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push(["mcpOAuthConnection.findMany", args]);
        return [{ oauthClientId: "client" }, { oauthClientId: "client" }];
      })
    },
    mcpRevision: { deleteMany: deleteMany("mcpRevision") },
    mcpRuntimeGeneration: { deleteMany: deleteMany("mcpRuntimeGeneration") },
    mcpServer: { deleteMany: deleteMany("mcpServer") },
    projectMcpBinding: { deleteMany: deleteMany("projectMcpBinding") }
  };
  return { calls, tx: tx as unknown as Prisma.TransactionClient };
}

const refuse = (count: number) => new Error(`refused:${count}`);

describe("local MCP removal gate", () => {
  it("changes nothing and ignores the acknowledgement when nothing is left", async () => {
    for (const acknowledged of [false, true]) {
      const { calls, tx } = transaction({ localDraftServerIds: [], localServerIds: [], otherLocalRevisionIds: [] });
      await expect(applyLocalMcpRemovalGate(tx, { acknowledged, refuse })).resolves.toEqual({ removedCount: 0 });
      expect(calls).toEqual([]);
    }
  });

  it("refuses with the leftover count and deletes nothing without the acknowledgement", async () => {
    const { calls, tx } = transaction({
      localDraftServerIds: ["draft"],
      localServerIds: ["local"],
      otherLocalRevisionIds: ["revision-a", "revision-b"]
    });

    await expect(applyLocalMcpRemovalGate(tx, { acknowledged: false, refuse })).rejects.toThrow("refused:4");
    expect(calls).toEqual([]);
  });

  it("deletes exactly the inspected rows in foreign-key order", async () => {
    const { calls, tx } = transaction({
      localDraftServerIds: ["draft"],
      localServerIds: ["local"],
      otherLocalRevisionIds: ["revision"]
    });

    await expect(applyLocalMcpRemovalGate(tx, { acknowledged: true, refuse })).resolves.toEqual({ removedCount: 3 });
    expect(calls).toEqual([
      ["mcpOAuthConnection.findMany", {
        select: { oauthClientId: true },
        where: { oauthClientId: { not: null }, serverId: { in: ["local"] } }
      }],
      ["projectMcpBinding", { where: { serverId: { in: ["local"] } } }],
      ["mcpRuntimeGeneration", { where: { OR: [
        { revision: { serverId: { in: ["local"] } } },
        { revisionId: { in: ["revision"] } },
        { userServer: { serverId: { in: ["local"] } } },
        { sharedServerId: { in: ["local"] } },
        { oauthConnection: { serverId: { in: ["local"] } } }
      ] } }],
      ["mcpRevision", { where: { OR: [{ serverId: { in: ["local"] } }, { id: { in: ["revision"] } }] } }],
      ["resetDrafts", [["draft"]]],
      ["mcpActivationJob", { where: { serverId: { in: ["draft"] } } }],
      ["mcpServer", { where: { id: { in: ["local"] } } }],
      ["mcpOAuthClient", { where: { connections: { none: {} }, id: { in: ["client"] } } }]
    ]);
  });

  it("keeps drafts and activation jobs of other servers when no local draft is left", async () => {
    const { calls, tx } = transaction({ localDraftServerIds: [], localServerIds: [], otherLocalRevisionIds: ["revision"] });

    await expect(applyLocalMcpRemovalGate(tx, { acknowledged: true, refuse })).resolves.toEqual({ removedCount: 1 });
    expect(calls.map(([name]) => name)).toEqual([
      "projectMcpBinding",
      "mcpRuntimeGeneration",
      "mcpRevision",
      "mcpServer"
    ]);
  });
});
