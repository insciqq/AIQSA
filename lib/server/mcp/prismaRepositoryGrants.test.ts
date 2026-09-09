import type { PrismaClient } from "@prisma/client";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { createPrismaMcpRepository } from "./prismaRepository";

vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));

const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};

function fixture(group: { archivedAt: Date | null; id: string; systemRole: "full_access" | null } | null) {
  const tx = {
    group: { findUnique: vi.fn().mockResolvedValue(group) },
    mcpGrant: { deleteMany: vi.fn(), upsert: vi.fn() },
    mcpServer: { findFirst: vi.fn().mockResolvedValue({ activeRevision: null, draft, id: "server" }) },
    mcpUserServer: { updateMany: vi.fn() },
    userGroup: { findMany: vi.fn() }
  };
  const repository = createPrismaMcpRepository({
    encryptionKey: () => Buffer.alloc(32, 1),
    prisma: { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient
  });
  return { repository, tx };
}

describe("MCP group grant mutation guards", () => {
  it.each([true, false])("rejects archived group changes before persistence (canUse %s)", async (canUse) => {
    const { repository, tx } = fixture({ archivedAt: new Date("2026-09-01T00:00:00Z"), id: "group", systemRole: null });
    expect(await repository.setGrant({ canUse, groupId: "group", personalSlotKeys: [], serverId: "server", userId: null })).toEqual({
      issues: [{ code: "group_archived", path: "groupId" }], kind: "invalid_grant"
    });
    expect(tx.group.findUnique).toHaveBeenCalledWith({ select: { archivedAt: true, id: true, systemRole: true }, where: { id: "group" } });
    expect(tx.mcpGrant.upsert).not.toHaveBeenCalled();
    expect(tx.mcpGrant.deleteMany).not.toHaveBeenCalled();
    expect(tx.mcpUserServer.updateMany).not.toHaveBeenCalled();
    expect(tx.userGroup.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { group: null, issue: "group_not_found" },
    { group: { archivedAt: null, id: "group", systemRole: "full_access" as const }, issue: "system_group_grant_immutable" }
  ])("preserves $issue at the mutation boundary", async ({ group, issue }) => {
    const { repository, tx } = fixture(group);
    expect(await repository.setGrant({ canUse: true, groupId: "group", personalSlotKeys: [], serverId: "server", userId: null })).toEqual({
      issues: [{ code: issue, path: "groupId" }], kind: "invalid_grant"
    });
    expect(tx.mcpGrant.upsert).not.toHaveBeenCalled();
    expect(tx.mcpGrant.deleteMany).not.toHaveBeenCalled();
  });

  it("never grants personal fields through a group", async () => {
    const { repository, tx } = fixture({ archivedAt: null, id: "group", systemRole: null });
    expect(await repository.setGrant({ canUse: true, groupId: "group", personalSlotKeys: ["personal"], serverId: "server", userId: null })).toEqual({
      issues: [{ code: "personal_slot_not_permitted", path: "personalSlotKeys" }], kind: "invalid_grant"
    });
    expect(tx.mcpGrant.upsert).not.toHaveBeenCalled();
  });

  it("rejects a deleted or archived server before changing any grant", async () => {
    const { repository, tx } = fixture({ archivedAt: null, id: "group", systemRole: null });
    tx.mcpServer.findFirst.mockResolvedValueOnce(null);
    expect(await repository.setGrant({ canUse: true, groupId: "group", personalSlotKeys: [], serverId: "server", userId: null })).toEqual({ kind: "not_found" });
    expect(tx.mcpServer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { archivedAt: null, id: "server" } }));
    expect(tx.mcpGrant.upsert).not.toHaveBeenCalled();
  });
});
