import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { textMessageContent } from "@/lib/domain/content";
import { agentLimits } from "./config";
import { createAgentRunStore, interruptExpiredAgentRun } from "./store";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { createOptionalDecisionRepository } from "../providerRuntime/optionalDecisionRepository";
import { lockRunSettlementScope } from "../runs/prismaRepositoryShared";

const configuration = { ...agentLimits({ ...DEFAULT_AGENT_POLICY, limitsEnabled: true }, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
  compatibilityHash: "a".repeat(64), mcpMode: "auto" as const, maxModelCalls: 2 };

async function fixture(runConfiguration = configuration) {
  const userId = `agent-store-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, displayName: "Agent store fixture", status: "active" } });
  const chat = await prisma.chat.create({ data: { userId, title: "Agent fixture" } });
  const session = await prisma.workspaceSession.create({ data: { chatId: chat.id, sandboxName: `agent-${randomUUID()}`,
    imageRef: "aiqsa-workspace:0.1.27", internetEnabled: true, policyRevision: 1,
    runtimeSandboxId: "fixture-runtime", state: "RUNNING", expiresAt: new Date(Date.now() + 600000) } });
  async function run() {
    await prisma.modelRun.updateMany({ where: { chatId: chat.id, status: "in_progress" }, data: { status: "error" } });
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: textMessageContent("synthetic task") } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", content: textMessageContent("synthetic answer") } });
    const accepted = await prisma.modelRun.create({ data: { chatId: chat.id, userId, userMessageId: message.id,
      assistantMessageId: answer.id, provider: "fake", modelId: "fixture", status: "in_progress", normalizedRequest: {} } });
    await prisma.workspaceRunBinding.create({ data: { modelRunId: accepted.id, workspaceSessionId: session.id,
      imageRef: session.imageRef, internetEnabled: true, policyRevision: 1, runtimeVersion: "0.6.16", mcpVersion: "0.6.16",
      toolCatalogHash: "a".repeat(64), toolDefinitions: [{ originalName: "sandbox_exec_start", namespacedName: "workspace__sandbox_exec_start",
        description: "Fixture", inputSchema: { type: "object" } }], outputDirectory: `/workspace/output/${accepted.id}` } });
    await prisma.agentRunBinding.create({ data: { modelRunId: accepted.id, configuration: runConfiguration, compatibilityHash: runConfiguration.compatibilityHash } });
    await prisma.providerRunBinding.create({ data: { modelRunId: accepted.id, role: "answer", credentialSource: "default",
      executionSnapshot: { version: 1, providerFamily: "fake", connectionId: "fixture", providerModelId: "fixture",
        connectionDisplayName: "Fixture", modelDisplayName: "Fixture", credentialId: null, credentialVersionId: null,
        connection: { apiRoot: "http://fixture.invalid", allowPrivateNetwork: true, authenticationMode: "none", responseTimeoutMs: 300000 },
        model: { adapterKind: "fake", upstreamModelId: "fixture", defaultParams: {}, capabilities: {
          nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: false
        } } } } });
    const store = createAgentRunStore(prisma, { runId: accepted.id, userId, configuration: runConfiguration });
    return { ...accepted, store };
  }
  return { userId, session, run, async dispose() {
    // Also proves whole-run deletion removes receipt rows without a FK deadlock.
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.workspaceSession.delete({ where: { id: session.id } });
    await prisma.user.delete({ where: { id: userId } });
  } };
}

describe("durable Agent authority and accounting", () => {
  afterAll(() => prisma.$disconnect());

  it("disables budgets and the deadline without disabling accounting, lease recovery or Stop", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null,
      maxModelCalls: 1, maxToolCalls: 1, tokenBudget: 1 });
    try {
      const run = await f.run();
      await run.store.arm(null);
      for (let i = 0; i < 3; i++) {
        const attempt = await run.store.reserveProvider(200);
        await run.store.settleProvider(attempt, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
        const call = await run.store.toolCall("find_tools", {}, false, `delivery-${i}`);
        await run.store.settleTool(call, "complete", {});
      }
      const binding = await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } });
      expect(binding).toMatchObject({ expiresAt: null, modelCalls: 3, toolCalls: 3, reservedTokens: 36n });
      expect((await run.store.usage()).reduce((sum, value) => sum + value.usage.totalTokens!, 0)).toBe(36);
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() })).toEqual({ kind: "active" });
      await run.store.revoke(false);
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_authority_expired");
    } finally { await f.dispose(); }
  });

  it("counts optional decision work without duplicating independently persisted charges", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null });
    try {
      const run = await f.run(); await run.store.arm(null);
      const answer = await prisma.providerRunBinding.findUniqueOrThrow({ where: {
        modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" }
      } });
      const snapshot = { ...normalizeProviderExecutionSnapshot(answer.executionSnapshot),
        connectionId: providerTemplateIds.fakeConnection, providerModelId: providerTemplateIds.fakeModel };
      const decisions = createOptionalDecisionRepository(prisma);
      const owner = { userId: f.userId, runId: run.id, purpose: "mcp_discovery" as const, operationKey: "call" };
      const claim = await decisions.start(owner, "b".repeat(64), snapshot);
      if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      const attempt = await run.store.reserveProvider(32_000, { kind: "decision", snapshot });
      await run.store.settleProvider(attempt, "COMPLETE", { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
      await decisions.settle(owner, claim.id, { receipt: { model: "fixture", provider: "fake", requestId: null,
        usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.00001 } }, answers: {}, failureCode: null, dispatched: true });
      expect(await run.store.usage()).toEqual([]);
      expect(await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } }))
        .toMatchObject({ modelCalls: 1, reservedTokens: 24n });
      expect(await prisma.usageEvent.findMany({ where: { modelRunId: run.id } }))
        .toEqual([expect.objectContaining({ optionalDecision: true, totalTokens: 24, estimatedCostMicros: 10 })]);
    } finally { await f.dispose(); }
  });

  it("keeps the first terminal budget cause through revocation and recovery", async () => {
    const f = await fixture({ ...configuration, tokenBudget: 10 });
    try {
      const run = await f.run(); await run.store.arm(null);
      await expect(run.store.reserveProvider(11)).rejects.toThrow("agent_token_limit");
      await run.store.fail("agent_provider_failed");
      await run.store.revoke(false);
      expect(await run.store.failure()).toBe("agent_token_limit");
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() }))
        .toMatchObject({ kind: "interrupted", failureCode: "agent_token_limit" });
    } finally { await f.dispose(); }
  });

  it("treats MCP exhaustion as a tool error while leaving the remaining model budget available", async () => {
    const f = await fixture({ ...configuration, maxToolCalls: 1 });
    try {
      const run = await f.run(); await run.store.arm(null);
      await run.store.toolCall("find_tools", {});
      await expect(run.store.toolCall("find_tools", {})).rejects.toThrow("agent_mcp_call_limit");
      expect(await run.store.failure()).toBeNull();
      await expect(run.store.reserveProvider(10)).resolves.toEqual(expect.any(String));
    } finally { await f.dispose(); }
  });

  it("keeps an expired time budget when transport cancellation wins the executor race", async () => {
    const f = await fixture();
    try {
      const run = await f.run(); await run.store.arm(null);
      await prisma.agentRunBinding.update({ where: { modelRunId: run.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await run.store.fail("agent_provider_interrupted");
      expect(await run.store.failure()).toBe("agent_time_limit");
    } finally { await f.dispose(); }
  });

  it("reserves source quotas across concurrent bridge instances and separates exact search billing", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null });
    try {
      const run = await f.run(); await run.store.arm(null);
      const answer = await prisma.providerRunBinding.findUniqueOrThrow({ where: { modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" } } });
      const snapshot = answer.executionSnapshot as Record<string, unknown>;
      await prisma.providerRunBinding.create({ data: { modelRunId: run.id, role: "search", bindingKey: "search:source", credentialSource: "default",
        executionSnapshot: { ...snapshot, model: { ...(snapshot.model as object), upstreamModelId: "search-fixture" } } } });
      const results = await Promise.allSettled(["a", "b"].map((invocationId) => run.store.reserveProvider(100,
        { kind: "aiqsa_search", optionId: "source", invocationId, maxCalls: 1 })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const admitted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<string>;
      await run.store.settleProvider(admitted.value, "COMPLETE", { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
      expect((await run.store.usage())[0]).toMatchObject({ modelId: "search-fixture", operationCount: 1, usage: { totalTokens: 9 } });
      const continuation = await run.store.reserveProvider(100, { kind: "aiqsa_search", optionId: "source",
        invocationId: results[0]!.status === "fulfilled" ? "a" : "b", maxCalls: 1 });
      await run.store.revoke(false);
      expect((await run.store.usage())[1]!.usage.totalTokens).toBeNull();
      await run.store.settleProvider(continuation, "COMPLETE", { inputTokens: 2, outputTokens: 2, totalTokens: 4 });
      expect((await run.store.usage())[1]).toMatchObject({ modelId: "search-fixture", operationCount: 1, usage: { totalTokens: 4 } });
      expect(await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: continuation } })).toMatchObject({ state: "UNKNOWN" });
      expect(await run.store.failure()).toBeNull();
    } finally { await f.dispose(); }
  });

  it("allows native search during a generation stream without releasing its slot or changing its provider tuple", async () => {
    const f = await fixture({ ...configuration, maxModelCalls: 4 });
    try {
      const run = await f.run();
      await run.store.arm(null);
      const generation = await run.store.reserveProvider(200);
      const search = await run.store.reserveProvider(200, { kind: "native_search" });
      await run.store.settleProvider(search, "COMPLETE", null);
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_provider_busy");
      const receipts = await prisma.agentProviderAttempt.findMany({ where: { modelRunId: run.id },
        include: { providerBinding: true }, orderBy: { createdAt: "asc" } });
      expect(receipts[1]!.providerBinding.executionSnapshot).toEqual(receipts[0]!.providerBinding.executionSnapshot);
      expect(receipts[1]!.providerBinding.credentialSource).toBe(receipts[0]!.providerBinding.credentialSource);
      expect(receipts[1]!.usage).toMatchObject({ completeness: "unavailable", totalTokens: null });
      await run.store.settleProvider(generation, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
      await expect(run.store.reserveProvider(200)).resolves.toEqual(expect.any(String));
      expect((await run.store.usage()).reduce((sum, item) => sum + (item.operationCount ?? 0), 0)).toBe(3);
    } finally { await f.dispose(); }
  });

  it("can append discovery bindings while an independent usage writer checkpoints the run", async () => {
    const f = await fixture();
    let checkpoint: Promise<boolean> | undefined;
    try {
      const run = await f.run();
      const repository = createPrismaRunRepository(prisma);
      await prisma.$transaction(async (tx) => {
        await lockRunSettlementScope(tx, run.id);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        checkpoint = repository.recordRunUsageEvents({ runId: run.id, chatId: run.chatId, userId: f.userId,
          usageAttributions: [{ provider: "fake", modelId: "fixture", operationCount: 1,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }] });
        void checkpoint.catch(() => undefined);
        // Wait for the real competing writer to reach this transaction's lock,
        // so the test covers the FK/row-lock cycle instead of relying on timing.
        const deadline = Date.now() + 3000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
          waiting = rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        const answer = await tx.providerRunBinding.findUniqueOrThrow({ where: {
          modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" }
        } });
        await tx.providerRunBinding.create({ data: { modelRunId: run.id, bindingKey: "agent-discovery:fixture",
          role: "search", credentialSource: "default", executionSnapshot: answer.executionSnapshot! } });
      });
      expect(await checkpoint).toBe(true);
      expect(await prisma.usageEvent.count({ where: { modelRunId: run.id } })).toBe(1);
    } finally { await checkpoint?.catch(() => undefined); await f.dispose(); }
  });

  it("serializes dispatch, records only trusted usage, and fences revoked or foreign authority", async () => {
    const f = await fixture();
    try {
      const run = await f.run();
      const grant = await run.store.arm(null);
      expect(grant.token).toHaveLength(43);
      const results = await Promise.allSettled([run.store.reserveProvider(200), run.store.reserveProvider(200)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const admitted = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>;
      await run.store.settleProvider(admitted.value, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
      expect((await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } })).reservedTokens).toBe(12n);
      await run.store.reserveProvider(200);
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_model_call_limit");
      await expect(createAgentRunStore(prisma, { runId: run.id, userId: "foreign", configuration }).assertActive()).rejects.toThrow();
      await run.store.revoke(false);
      await expect(run.store.assertActive()).rejects.toThrow("agent_authority_expired");
      expect(await prisma.agentProviderAttempt.count({ where: { modelRunId: run.id, state: "UNKNOWN" } })).toBe(1);
      expect((await run.store.usage())[0]).toMatchObject({ operationCount: 1, usage: { totalTokens: 12 } });
    } finally { await f.dispose(); }
  });

  it("resumes only a completed predecessor in the same surviving Workspace", async () => {
    const f = await fixture();
    try {
      const first = await f.run();
      await first.store.arm(null);
      const threadId = randomUUID();
      await first.store.setThread(threadId);
      await first.store.revoke(true);
      await prisma.modelRun.update({ where: { id: first.id }, data: { status: "complete" } });
      expect((await (await f.run()).store.arm(first.assistantMessageId)).threadId).toBe(threadId);
      expect((await (await f.run()).store.arm(randomUUID())).threadId).toBeUndefined();
      await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { runtimeSandboxId: null } });
      expect((await (await f.run()).store.arm(first.assistantMessageId)).threadId).toBeUndefined();
    } finally { await f.dispose(); }
  });

  it("never replays a lost executor and preserves ambiguous tool/provider outcomes", async () => {
    const f = await fixture();
    try {
      const run = await f.run();
      await run.store.arm(null);
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() })).toEqual({ kind: "active" });
      const call = await run.store.toolCall("find_tools", {}, false, "delivery-1");
      await expect(run.store.toolCall("find_tools", {}, false, "delivery-1")).rejects.toThrow();
      await prisma.agentRunBinding.update({ where: { modelRunId: run.id }, data: { leaseExpiresAt: new Date(0) } });
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() })).toEqual({ kind: "interrupted", failureCode: "agent_execution_interrupted", usage: [] });
      expect(await prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: call } })).toMatchObject({ state: "error", result: { outcome: "unknown" } });
      await expect(run.store.arm(null)).rejects.toThrow("agent_binding_invalid");
    } finally { await f.dispose(); }
  });
});
