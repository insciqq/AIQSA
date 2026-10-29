import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { bindCodeMcpEffect, codeMcpEffectDigest } from "./codeMcpUnknownEffects";
import type { WorkspaceCodeGatewayGrant } from "./codeMcpStore";

const key = { argumentsDigest: "a".repeat(64), definitionHash: "b".repeat(64), serverId: "server", toolName: "tool" };
const grant = { runId: "run", userId: "owner", chatId: "chat" } as WorkspaceCodeGatewayGrant;

describe("durable code MCP effect identity", () => {
  it("pins the definition and arguments under the grant lock, and reads only owned branch ancestors", async () => {
    const after = new Date("2026-10-29T12:00:00Z");
    const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ scopeValid: true, unknownAfter: after }]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = { $queryRaw: query, workspaceCodeCall: { updateMany } };
    const db = { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
    expect(await bindCodeMcpEffect(db, { callId: "current", grant, key })).toEqual(after);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "current", modelRunId: "run", state: "dispatching", serverId: "server", toolName: "tool" },
      data: { argumentHash: codeMcpEffectDigest(key) } });
    const sql = query.mock.calls[1][0] as Prisma.Sql;
    expect(sql.text).toContain('r."assistantMessageId" = b."id" OR r."id" = b."branchSourceModelRunId"');
    expect(sql.text).toContain('prior."sequence" < current."sequence"');
    expect(sql.text).toContain('r."userId" =');
    expect(sql.text).toContain('c."userId" =');
    expect(sql.values).toContain(key.argumentsDigest); // Legacy unknown receipts also fail closed.
    expect(sql.values).toContain(codeMcpEffectDigest(key));
    expect(codeMcpEffectDigest({ ...key, definitionHash: "c".repeat(64) })).not.toBe(codeMcpEffectDigest(key));
  });
  it("refuses dispatch if the receipt was closed while the call was prepared", async () => {
    const tx = { $queryRaw: vi.fn(async () => []), workspaceCodeCall: { updateMany: async () => ({ count: 0 }) } };
    const db = { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
    await expect(bindCodeMcpEffect(db, { callId: "closed", grant, key })).rejects.toThrow("code_mcp_receipt_closed");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
