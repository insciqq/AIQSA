import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createMcpHubOperationStore } from "./hubOperations";

async function fixture(run: (input: {
  authority: { userId: string; clientId: string; grantId: string; assertActive(): Promise<void> };
  store: ReturnType<typeof createMcpHubOperationStore>;
}) => Promise<void>) {
  const user = await prisma.user.create({ data: { displayName: "Hub fixture", email: `hub-${randomUUID()}@example.test`, status: "active" } });
  try {
    await run({ authority: { userId: user.id, clientId: "fixture-client", grantId: "fixture-grant", async assertActive() {} }, store: createMcpHubOperationStore(prisma) });
  } finally { await prisma.user.deleteMany({ where: { id: user.id } }); }
}

afterAll(() => prisma.$disconnect());

describe("durable external MCP operations", () => {
  it("admits dispatch before I/O and permits only one terminal writer", async () => {
    await fixture(async ({ authority, store }) => {
      const receipt = await store.recordDispatch({ ...authority, resourcePath: "/mcp/hub", toolId: "fixture-tool", timeoutMs: 300_000, toolVersion: "a".repeat(64) });
      const accepted = await prisma.mcpHubDispatch.findFirstOrThrow({ where: { userId: authority.userId } });
      expect(accepted).toMatchObject({ state: "DISPATCHED", completedAt: null, revision: 0 });
      const results = await Promise.allSettled([receipt.settle("COMPLETE"), receipt.settle("ERROR", "tool_unavailable")]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: accepted.id } })).toMatchObject({ revision: 1, completedAt: expect.any(Date) });
    });
  });

  it("expires a dispatch past its deadline as unknown and retires old receipts, never a live one", async () => {
    await fixture(async ({ authority, store }) => {
      const now = new Date();
      const dispatch = (data: Readonly<{ createdAt?: Date; expiresAt: Date }>) => prisma.mcpHubDispatch.create({ data: {
        userId: authority.userId, clientId: authority.clientId, grantId: authority.grantId, resourcePath: "/mcp/hub",
        toolId: "fixture-tool", toolVersion: "a".repeat(64), ...data } });
      const old = new Date("2000-01-01T00:00:00Z");
      const expired = await dispatch({ createdAt: old, expiresAt: old });
      const live = await dispatch({ expiresAt: new Date(now.getTime() + 60_000) });
      expect((await store.maintain({ now, dryRun: true })).dispatches.expired).toBeGreaterThanOrEqual(1);
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ state: "DISPATCHED" });
      await store.maintain({ now });
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: expired.id } }))
        .toMatchObject({ state: "UNKNOWN", revision: 1, resultCode: "execution_outcome_unknown" });
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ state: "DISPATCHED", revision: 0 });
      await store.maintain({ cutoff: new Date("2000-02-01T00:00:00Z"), now });
      await expect(prisma.mcpHubDispatch.findUnique({ where: { id: expired.id } })).resolves.toBeNull();
      await expect(prisma.mcpHubDispatch.findUnique({ where: { id: live.id } })).resolves.not.toBeNull();
    });
  });

  it("rejects a Memory resource in the Hub receipt at the database boundary", async () => {
    await fixture(async ({ authority }) => {
      await expect(prisma.mcpHubDispatch.create({ data: { userId: authority.userId, clientId: authority.clientId, grantId: authority.grantId, resourcePath: "/mcp", toolId: "fixture-tool", toolVersion: "a".repeat(64) } })).rejects.toThrow();
      expect(await prisma.mcpHubDispatch.count({ where: { userId: authority.userId } })).toBe(0);
    });
  });
});
