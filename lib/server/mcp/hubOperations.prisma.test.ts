import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createMcpHubOperationStore } from "./hubOperations";

/** Discovery no longer calls a model; rows written before local search remain retired storage.
 * A settled legacy receipt carries completedAt and one revision, as the retired settle wrote it. */
async function legacyDiscoveryAttempt(authority: { userId: string; clientId: string; grantId: string }, data: Readonly<{
  createdAt?: Date; expiresAt: Date; state?: "DISPATCHED" | "COMPLETE"; totalTokens?: number;
}>) {
  return prisma.mcpHubDiscoveryAttempt.create({ data: {
    userId: authority.userId, clientId: authority.clientId, grantId: authority.grantId,
    connectionId: "fixture-connection", providerModelId: "fixture-model", credentialVersionId: "fixture-credential-version",
    expiresAt: data.expiresAt, ...(data.state ? { state: data.state } : {}), ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    ...(data.state === "COMPLETE" ? { completedAt: data.createdAt ?? new Date(), revision: 1 } : {}),
    usageEvent: { create: { mcpHubDiscovery: true, purpose: "other", userId: authority.userId, modelId: "fixture-router", provider: "openai",
      providerModelId: "fixture-model", ...(data.totalTokens ? { inputTokens: data.totalTokens - 2, outputTokens: 2, reasoningTokens: 0,
        totalTokens: data.totalTokens, usageCompleteness: "COMPLETE" as const } : {}) } }
  } });
}

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

  it("writes no discovery receipt and expires legacy ones as unknown while preserving live dispatch", async () => {
    await fixture(async ({ authority, store }) => {
      expect(store).not.toHaveProperty("recordDiscoveryAttempt");
      const now = new Date();
      const discovery = await legacyDiscoveryAttempt(authority, { expiresAt: new Date(now.getTime() - 1_000) });
      const live = await prisma.mcpHubDispatch.create({ data: { userId: authority.userId, clientId: authority.clientId, grantId: authority.grantId, resourcePath: "/mcp/hub", toolId: "fixture-tool", toolVersion: "a".repeat(64), expiresAt: new Date(now.getTime() + 60_000) } });
      const dry = await store.maintain({ now, dryRun: true });
      expect(dry.discoveryAttempts.expired).toBe(1);
      expect(await prisma.mcpHubDiscoveryAttempt.findUniqueOrThrow({ where: { id: discovery.id } })).toMatchObject({ state: "DISPATCHED" });
      await store.maintain({ now });
      expect(await prisma.mcpHubDiscoveryAttempt.findUniqueOrThrow({ where: { id: discovery.id } })).toMatchObject({ state: "UNKNOWN", revision: 1 });
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ state: "DISPATCHED", revision: 0 });
      expect((await store.maintain({ now })).discoveryAttempts.expired).toBe(0);
    });
  });

  it("retires old legacy receipts without erasing accounted cost, then cascades owner deletion", async () => {
    await fixture(async ({ authority, store }) => {
      const old = new Date("2000-01-01T00:00:00Z");
      await legacyDiscoveryAttempt(authority, { createdAt: old, expiresAt: old, state: "COMPLETE", totalTokens: 10 });
      const cutoff = new Date("2000-02-01T00:00:00Z");
      expect((await store.maintain({ cutoff, dryRun: true })).discoveryAttempts.removed).toBe(1);
      await store.maintain({ cutoff });
      expect(await prisma.mcpHubDiscoveryAttempt.count({ where: { userId: authority.userId } })).toBe(0);
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { userId: authority.userId } })).toMatchObject({ mcpHubDiscovery: true, mcpHubDiscoveryAttemptId: null, totalTokens: 10 });
      await prisma.user.delete({ where: { id: authority.userId } });
      expect(await prisma.usageEvent.count({ where: { userId: authority.userId } })).toBe(0);
    });
  });

  it("rejects a Memory resource in the Hub receipt at the database boundary", async () => {
    await fixture(async ({ authority }) => {
      await expect(prisma.mcpHubDispatch.create({ data: { userId: authority.userId, clientId: authority.clientId, grantId: authority.grantId, resourcePath: "/mcp", toolId: "fixture-tool", toolVersion: "a".repeat(64) } })).rejects.toThrow();
      expect(await prisma.mcpHubDispatch.count({ where: { userId: authority.userId } })).toBe(0);
    });
  });
});
