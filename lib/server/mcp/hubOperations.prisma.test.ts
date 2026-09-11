import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { createMcpHubOperationStore } from "./hubOperations";

const capabilities = { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, structuredOutput: true };
const role: ProviderAdmissionRole = {
  authority: { connectionId: "fixture-connection", connectionVersion: 1, credentialId: "fixture-credential", credentialVersionId: "fixture-credential-version", modelVersion: 1, providerModelId: "fixture-model" },
  credentialSource: "default",
  modelConfiguration: { adapterKind: "openai_responses_native", capabilities, defaultParams: {} },
  snapshot: {
    connection: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
    connectionDisplayName: "Fixture provider", connectionId: "fixture-connection", credentialId: "fixture-credential", credentialVersionId: "fixture-credential-version",
    model: { adapterKind: "openai_responses_native", answerSelectable: true, capabilities, defaultParams: {}, modelClass: "answer", upstreamModelId: "fixture-router" },
    modelDisplayName: "Fixture router", providerFamily: "openai", providerModelId: "fixture-model", version: 1
  }
};

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
      const receipt = await store.recordDispatch({ ...authority, resourcePath: "/mcp/hub", toolId: "fixture-tool", toolVersion: "a".repeat(64) });
      const accepted = await prisma.mcpHubDispatch.findFirstOrThrow({ where: { userId: authority.userId } });
      expect(accepted).toMatchObject({ state: "DISPATCHED", completedAt: null, revision: 0 });
      const results = await Promise.allSettled([receipt.settle("COMPLETE"), receipt.settle("ERROR", "tool_unavailable")]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: accepted.id } })).toMatchObject({ revision: 1, completedAt: expect.any(Date) });
    });
  });

  it("creates exactly one accounting event with unknown fields and no conversation artifacts", async () => {
    await fixture(async ({ authority, store }) => {
      const receipt = await store.recordDiscoveryAttempt(authority, role);
      const where = { userId: authority.userId };
      expect(await prisma.usageEvent.findFirstOrThrow({ where })).toMatchObject({
        mcpHubDiscovery: true, usageCompleteness: "UNAVAILABLE", inputTokens: null, totalTokens: null, estimatedCostMicros: null,
        modelId: "fixture-router", provider: "openai", providerModelId: "fixture-model", chatId: null, modelRunId: null
      });
      const usage = { inputTokens: 10, outputTokens: 4, reasoningTokens: 1, totalTokens: 14, completeness: "partial" as const };
      await receipt.settle({ state: "ERROR", usage });
      await receipt.settle({ state: "COMPLETE", usage });
      expect(await prisma.usageEvent.count({ where })).toBe(1);
      expect(await prisma.usageEvent.findFirstOrThrow({ where })).toMatchObject({
        inputTokens: 10, outputTokens: 4, reasoningTokens: 1, totalTokens: 14, cachedInputTokens: null, usageCompleteness: "PARTIAL", estimatedCostMicros: null
      });
      expect(await prisma.mcpHubDiscoveryAttempt.findFirstOrThrow({ where })).toMatchObject({ state: "ERROR", revision: 1 });
      expect(await prisma.chat.count({ where })).toBe(0);
      expect(await prisma.modelRun.count({ where })).toBe(0);
    });
  });

  it("recovers expired dispatch as unknown while preserving live work and late reported usage", async () => {
    await fixture(async ({ authority, store }) => {
      const receipt = await store.recordDiscoveryAttempt(authority, role);
      const now = new Date();
      const discovery = await prisma.mcpHubDiscoveryAttempt.findFirstOrThrow({ where: { userId: authority.userId } });
      await prisma.mcpHubDiscoveryAttempt.update({ where: { id: discovery.id }, data: { expiresAt: new Date(now.getTime() - 1_000) } });
      const live = await prisma.mcpHubDispatch.create({ data: { userId: authority.userId, clientId: authority.clientId, grantId: authority.grantId, resourcePath: "/mcp/hub", toolId: "fixture-tool", toolVersion: "a".repeat(64), expiresAt: new Date(now.getTime() + 60_000) } });
      const dry = await store.maintain({ now, dryRun: true });
      expect(dry.discoveryAttempts.expired).toBe(1);
      expect(await prisma.mcpHubDiscoveryAttempt.findUniqueOrThrow({ where: { id: discovery.id } })).toMatchObject({ state: "DISPATCHED" });
      await store.maintain({ now });
      await receipt.settle({ state: "COMPLETE", usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0, totalTokens: 10 } });
      expect(await prisma.mcpHubDiscoveryAttempt.findUniqueOrThrow({ where: { id: discovery.id } })).toMatchObject({ state: "UNKNOWN", revision: 1 });
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { userId: authority.userId } })).toMatchObject({ totalTokens: 10 });
      expect(await prisma.mcpHubDispatch.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ state: "DISPATCHED", revision: 0 });
      expect((await store.maintain({ now })).discoveryAttempts.expired).toBe(0);
    });
  });

  it("retires old receipts without erasing accounted cost, then cascades owner deletion", async () => {
    await fixture(async ({ authority, store }) => {
      const receipt = await store.recordDiscoveryAttempt(authority, role);
      await receipt.settle({ state: "COMPLETE", usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0, totalTokens: 10 } });
      const old = new Date("2000-01-01T00:00:00Z");
      await prisma.mcpHubDiscoveryAttempt.updateMany({ where: { userId: authority.userId }, data: { createdAt: old } });
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
