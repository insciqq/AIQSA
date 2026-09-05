// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import {
  WORKSPACE_MCP_TOOL_ALLOWLIST, WORKSPACE_POLICY_ID,
  workspaceMessageManifestPath, workspaceRunOutputDirectory, workspaceSandboxName
} from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { prisma } from "@/lib/server/prisma";
import { admitPreparingRunWithClient } from "@/lib/server/runs/prismaRepositoryPreparation";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import type { PreparingRunAdmissionInput } from "@/lib/server/runs/runRepositoryContract";
import { getWorkspaceConfig } from "./config";
import { namespacedWorkspaceToolName } from "./toolCatalog";
import { createPrismaWorkspaceCoordinatorRepository, createWorkspaceCoordinator } from "./coordinator";
import { createPrismaWorkspaceExecutionRegistry } from "./executionRegistry";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { reconcileWorkspaceAfterRestore, runWorkspaceMaintenance } from "./cleanup";
import type { WorkspaceRuntime } from "./runtime";
import { createWorkspaceRunnerServer } from "./runnerServer";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

async function receiverFixture(local: WorkspaceRuntime) {
  const directory = await mkdtemp(join(tmpdir(), "aiqsa-pg-receiver-fence-"));
  const token = randomBytes(32).toString("hex");
  const create = () => createWorkspaceRunnerServer({ runtime: local, token, operationDirectory: directory });
  let server = create();
  const listen = (port: number) => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await listen(0);
  const port = (server.address() as AddressInfo).port;
  const runtime = new RemoteWorkspaceRuntime({ ...config, runnerToken: token,
    runnerUrl: new URL(`http://127.0.0.1:${port}`), runtimeMode: "remote" });
  return {
    runtime,
    async restart() { await close(); server = create(); await listen(port); },
    async dispose() { await close(); await rm(directory, { recursive: true, force: true }); }
  };
}

const prefix = "workspace-operation-test-";
const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const definitions = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => ({
  description: `Fixture ${originalName}`, inputSchema: { type: "object" },
  namespacedName: namespacedWorkspaceToolName(originalName), originalName
}));

async function fixture() {
  const userId = prefix + randomUUID();
  await prisma.user.create({ data: { id: userId, displayName: "Workspace Operation Test" } });
  await prisma.userMemorySettings.update({ data: {
    learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false
  }, where: { userId } });
  const chat = await prisma.chat.create({ data: { title: "Workspace operation", userId, workspaceEnabled: true } });
  const sessionId = `ws_${randomBytes(20).toString("hex")}`;
  const session = await prisma.workspaceSession.create({ data: {
    id: sessionId, chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000),
    imageRef: config.imageRef, internetEnabled: false, policyRevision: 1,
    runtimeSandboxId: "runtime_fixture", sandboxName: workspaceSandboxName(sessionId), state: "RUNNING"
  } });
  const plan = async (): Promise<PreparingRunAdmissionInput> => {
    const runId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: WORKSPACE_POLICY_ID } });
    const leaf = await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chat.id } });
    const normalized = {
      enabled: true as const, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json",
      internetEnabled: false, maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds,
      mcpVersion: "0.6.16", messageManifestPath: workspaceMessageManifestPath(userMessageId),
      outputDirectory: workspaceRunOutputDirectory(runId), projectDirectory: "/workspace/project",
      runtimeVersion: "0.6.16", sessionId, syncToolTimeoutSeconds: config.syncToolTimeoutSeconds,
      toolCatalogHash: hashCanonicalMcpValue(definitions), turnTimeoutSeconds: config.turnTimeoutSeconds
    };
    const content = textMessageContent("Synthetic follow-up");
    return {
      admissionKind: "NORMAL_SEND", chatId: chat.id, content, expectedActiveLeafId: leaf.activeLeafMessageId,
      modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId, workspaceEnabled: true,
      normalizedRequest: {
        attachmentIds: [], chatId: chat.id, content, knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 },
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
        searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", workspace: normalized
      },
      workspaceAdmissionPlan: {
        assistantMessageId, chatId: chat.id, expiresAt: session.expiresAt.toISOString(), normalized,
        policyRevision: policy.version, runId, sandboxName: session.sandboxName, sessionId,
        toolDefinitions: definitions, userMessageId
      }
    };
  };
  return { chatId: chat.id, plan, session, userId };
}

describe("Prisma Workspace operation admission", () => {
  let originalPolicy: Awaited<ReturnType<typeof prisma.workspacePolicy.findUnique>>;
  beforeAll(async () => {
    originalPolicy = await prisma.workspacePolicy.findUnique({ where: { id: WORKSPACE_POLICY_ID } });
    await prisma.workspacePolicy.upsert({
      create: { id: WORKSPACE_POLICY_ID, enabled: true, internetEnabled: false },
      update: { enabled: true }, where: { id: WORKSPACE_POLICY_ID }
    });
  });
  afterEach(async () => {
    const users = await prisma.user.findMany({ select: { id: true }, where: { id: { startsWith: prefix } } });
    const userIds = users.map(({ id }) => id);
    if (userIds.length === 0) return;
    const chats = await prisma.chat.findMany({ select: { id: true }, where: { userId: { in: userIds } } });
    const chatIds = chats.map(({ id }) => id);
    await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.chat.updateMany({ data: { activeLeafMessageId: null }, where: { id: { in: chatIds } } });
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  afterAll(async () => {
    if (originalPolicy) await prisma.workspacePolicy.update({ data: {
      enabled: originalPolicy.enabled, internetEnabled: originalPolicy.internetEnabled, version: originalPolicy.version
    }, where: { id: WORKSPACE_POLICY_ID } });
    else await prisma.workspacePolicy.deleteMany({ where: { id: WORKSPACE_POLICY_ID } });
    await prisma.$disconnect();
  });

  it.each(["RUNNING", "FAILED"] as const)("refuses an unproven %s session although no ModelRun is active", async (state) => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { lastErrorCode: "workspace_execution_cleanup_failed", state }, where: { id: value.session.id } });
    await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
    expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(0);
    expect(await prisma.message.count({ where: { chatId: value.chatId } })).toBe(0);
  });

  it("admits once the same session has a proven idle state", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: value.session.id } });
    const request = await value.plan();
    await expect(admitPreparingRunWithClient(prisma, request)).resolves.toMatchObject({ runId: request.workspaceAdmissionPlan!.runId });
    expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(1);
  });

  it("releases confirmed disk-loss ownership only after receiver retirement, then admits a new turn", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: value.session.id } });
    const accepted = await admitPreparingRunWithClient(prisma, await value.plan());
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: accepted.runId } });
    await prisma.$transaction(async (tx) => {
      await tx.memoryRetrievalAttempt.updateMany({ data: { errorCode: "fixture_preparation_cancelled", state: "CANCELLED" }, where: { modelRunId: run.id } });
      await tx.message.update({ data: { content: textMessageContent("Completed answer"), status: "complete" }, where: { id: run.assistantMessageId! } });
      await tx.modelRun.update({ data: { normalizedRequest: {}, status: "complete" }, where: { id: run.id } });
    });
    const connection = await receiverFixture(new DeterministicWorkspaceRuntime(config));
    const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
    const before = (await repository.binding({ runId: run.id, userId: value.userId }))!;
    const entered = barrier();
    const release = barrier();
    const retire = connection.runtime.retireSessionOperation!.bind(connection.runtime);
    vi.spyOn(connection.runtime, "retireSessionOperation").mockImplementation(async (input) => {
      entered.release(); await release.wait; await retire(input);
    });
    const coordinator = createWorkspaceCoordinator({ config, repository, runtime: connection.runtime,
      registry: createPrismaWorkspaceExecutionRegistry(prisma), storage: createMemoryStorageAdapter() });
    const work = coordinator.finalize({ handoff: true, runId: run.id, userId: value.userId });
    try {
      await Promise.race([entered.wait, work.then(() => { throw new Error("retirement_barrier_not_reached"); })]);
      const held = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } });
      expect(held).toMatchObject({ runtimeSandboxId: null, version: before.operationGeneration + 2 });
      expect(held.operationOwner).toMatch(/^export:/u);
      await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
      release.release();
      await expect(work).resolves.toMatchObject({ code: "workspace_session_lost", status: "failed" });
      expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } }))
        .toMatchObject({ operationOwner: null, runtimeSandboxId: null, state: "PENDING" });
      expect(await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } }))
        .toMatchObject({ exportState: "FAILED", lastExportErrorCode: "workspace_session_lost" });
      await expect(admitPreparingRunWithClient(prisma, await value.plan())).resolves.toMatchObject({ chatMemoryMode: "NORMAL" });
      expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(2);
    } finally {
      release.release(); await work; await connection.dispose();
    }
  });

  it("keeps admission fenced after export publication until receiver retirement releases the operation", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: value.session.id } });
    const accepted = await admitPreparingRunWithClient(prisma, await value.plan());
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: accepted.runId } });
    await prisma.$transaction(async (tx) => {
      // This fixture isolates post-answer admission from Memory preparation.
      await tx.memoryRetrievalAttempt.updateMany({ data: { errorCode: "fixture_preparation_cancelled", state: "CANCELLED" }, where: { modelRunId: run.id } });
      await tx.message.update({ data: { content: textMessageContent("Completed answer"), status: "complete" }, where: { id: run.assistantMessageId! } });
      await tx.modelRun.update({ data: { normalizedRequest: {}, status: "complete" }, where: { id: run.id } });
    });
    const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
    const binding = (await repository.binding({ runId: run.id, userId: value.userId }))!;
    const claim = await repository.claimExport({ leaseMs: 60_000, operation: { generation: binding.operationGeneration, owner: binding.operationOwner! },
      runId: run.id, runtimeSandboxId: binding.runtimeSandboxId, sessionId: binding.sessionId });
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const lease = { operation: claim.operation, runId: run.id, runtimeSandboxId: binding.runtimeSandboxId, sessionId: binding.sessionId, token: claim.token };
    await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
    const capture = await repository.reserveOutputCapture(lease);
    if (!capture) throw new Error("fixture_capture_failed");
    expect(await repository.sealOutputCapture({ ...lease, capture: { id: capture.id, outputs: [] } })).toBe(true);
    expect(await repository.markExportComplete(lease)).toBe(true);
    await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
    const connection = await receiverFixture(new DeterministicWorkspaceRuntime(config));
    try {
      const coordinator = createWorkspaceCoordinator({ config, repository, runtime: connection.runtime,
        registry: createPrismaWorkspaceExecutionRegistry(prisma), storage: createMemoryStorageAdapter() });
      await expect(coordinator.settle({ operation: lease.operation, outcome: "completed", runId: run.id, userId: value.userId }))
        .resolves.toMatchObject({ quiesced: true, sessionSettled: true });
      await expect(admitPreparingRunWithClient(prisma, await value.plan())).resolves.toMatchObject({ chatMemoryMode: "NORMAL" });
      expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(2);
      expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("complete");
    } finally { await connection.dispose(); }
  });

  it.each([null, "", "owner\ncontrol", "я".repeat(81)])("rejects a malformed durable lease owner %j", async (operationOwner) => {
    const value = await fixture();
    await expect(prisma.workspaceSession.update({ data: {
      operationOwner, operationExpiresAt: new Date(Date.now() + 60_000)
    }, where: { id: value.session.id } })).rejects.toThrow(/WorkspaceSession_operation/u);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } })).toEqual(value.session);
  });

  it("retires restored process obligations when the backup contains no guest disk", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: value.session.id } });
    const admitted = await admitPreparingRunWithClient(prisma, await value.plan());
    for (const ordinal of [0, 1]) {
      const call = await prisma.modelRunToolCall.create({ data: {
        arguments: {}, modelRunId: admitted.runId, ordinal, providerCallId: `restore_${ordinal}`, roundIndex: 1,
        state: "running", toolName: namespacedWorkspaceToolName("sandbox_exec_start"), workspaceRunBindingId: admitted.runId
      } });
      if (ordinal === 0) await prisma.workspaceExecution.create({ data: {
        modelRunId: admitted.runId, modelRunToolCallId: call.id, runtimeExecSessionId: "restored_execution", workspaceSessionId: value.session.id
      } });
    }
    await createPrismaRunRepository(prisma).cancelRun({
      payload: { code: "model_run_cancelled", message: "Cancelled" }, runId: admitted.runId, userId: value.userId
    });
    await reconcileWorkspaceAfterRestore(prisma);
    expect(await prisma.workspaceExecution.count({ where: {
      workspaceSessionId: value.session.id, state: { in: ["ACTIVE", "TERMINATING"] }
    } })).toBe(0);
    expect(await prisma.workspaceExecution.count({ where: { workspaceSessionId: value.session.id, state: "LOST" } })).toBe(2);
    await expect(admitPreparingRunWithClient(prisma, await value.plan())).resolves.toMatchObject({ chatMemoryMode: "NORMAL" });
  });

  it("keeps cancellation fenced through receiver retirement, then rejects the old terminal writer", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: value.session.id } });
    const admitted = await admitPreparingRunWithClient(prisma, await value.plan());
    const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
    const binding = (await repository.binding({ runId: admitted.runId, userId: value.userId }))!;
    const oldOperation = { generation: binding.operationGeneration, owner: binding.operationOwner! };
    const runRepository = createPrismaRunRepository(prisma);
    await expect(runRepository.cancelRun({
      payload: { code: "model_run_cancelled", message: "Cancelled" }, runId: admitted.runId, userId: value.userId
    })).resolves.toMatchObject({ kind: "cancelled" });
    // Real cancellation has committed; simulate another app process owning
    // cleanup and pause at its receiver boundary without holding a DB lock.
    const runtime = fenceDeterministicWorkspaceRuntime(new DeterministicWorkspaceRuntime(config));
    const entered = barrier();
    const release = barrier();
    const retire = runtime.retireSessionOperation!;
    vi.spyOn(runtime, "retireSessionOperation").mockImplementationOnce(async (input) => {
      entered.release();
      await release.wait;
      return retire(input);
    });
    const coordinator = createWorkspaceCoordinator({ config, repository, runtime,
      registry: createPrismaWorkspaceExecutionRegistry(prisma), storage: createMemoryStorageAdapter() });
    const settlement = coordinator.settle({ outcome: "cancelled", runId: admitted.runId, userId: value.userId });
    try {
      await entered.wait;
      await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
      expect(await prisma.chat.findUnique({ where: { id: value.chatId }, select: { id: true } })).not.toBeNull();
      const independent = await fixture();
      await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: independent.session.id } });
      await expect(admitPreparingRunWithClient(prisma, await independent.plan())).resolves.toMatchObject({ chatMemoryMode: "NORMAL" });
    } finally { release.release(); }
    await expect(settlement).resolves.toMatchObject({ quiesced: true, sessionSettled: true });
    const next = await admitPreparingRunWithClient(prisma, await value.plan());
    const before = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } });
    expect(before.operationOwner).toBe(`run:${next.runId}`);
    await expect(repository.settleSession({
      operation: oldOperation, outcome: "stopped", runtimeSandboxId: binding.runtimeSandboxId, sessionId: binding.sessionId
    })).resolves.toBe(false);
    const after = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } });
    expect(after).toEqual(before);
    await expect(createPrismaWorkspaceExecutionRegistry(prisma).closeAll({
      operation: oldOperation, sessionId: binding.sessionId, to: "LOST"
    })).rejects.toMatchObject({ code: "workspace_operation_stale" });
  });

  it("revalidates a stale maintenance candidate before touching a newly admitted run", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ data: { updatedAt: new Date(Date.now() - 60_000) }, where: { id: value.session.id } });
    const selected = barrier();
    const release = barrier();
    let paused = false;
    const client = new Proxy(prisma, {
      get(target, key) {
        if (key === "$queryRaw") return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.$queryRaw, target, args);
          const query = args[0] as { strings?: readonly string[] };
          if (!paused && query.strings?.join("").includes('ORDER BY ws."updatedAt"')) {
            paused = true;
            selected.release();
            await release.wait;
          }
          return result;
        };
        const member = Reflect.get(target, key);
        return typeof member === "function" ? member.bind(target) : member;
      }
    });
    const local = new DeterministicWorkspaceRuntime(config);
    const runtime: WorkspaceRuntime = Object.assign(local, {
      claimSessionOperation: vi.fn(async () => undefined),
      retireSessionOperation: vi.fn(async (input: Parameters<NonNullable<WorkspaceRuntime["retireSessionOperation"]>>[0]) => local.stopSession(input))
    });
    const stop = vi.spyOn(runtime, "stopSession");
    const maintenance = runWorkspaceMaintenance({ config, prisma: client, runtime });
    try {
      await selected.wait;
      // Another legitimate settlement won after candidate selection. Its
      // idle result allows a later admission to claim this exact session.
      await prisma.workspaceSession.update({ data: { state: "READY" }, where: { id: value.session.id } });
      const next = await admitPreparingRunWithClient(prisma, await value.plan());
      const call = await prisma.modelRunToolCall.create({ data: {
        arguments: {}, modelRunId: next.runId, ordinal: 0, providerCallId: "new_call", roundIndex: 1,
        state: "running", toolName: namespacedWorkspaceToolName("sandbox_exec_start"), workspaceRunBindingId: next.runId
      } });
      await prisma.workspaceExecution.create({ data: {
        modelRunId: next.runId, modelRunToolCallId: call.id, runtimeExecSessionId: "new_execution", workspaceSessionId: value.session.id
      } });
    } finally { release.release(); }
    await maintenance;
    expect(stop).not.toHaveBeenCalled();
    expect(await prisma.workspaceExecution.count({ where: { workspaceSessionId: value.session.id, state: "ACTIVE" } })).toBe(1);
  });

  it.each([
    { takeover: false, restart: false }, { takeover: true, restart: false }, { takeover: true, restart: true }
  ])("holds maintenance through admission and fences expired work (takeover=$takeover, restart=$restart)", async ({ takeover, restart }) => {
    const value = await fixture();
    const now = new Date();
    await prisma.workspaceSession.update({ data: { updatedAt: new Date(now.getTime() - 60_000) }, where: { id: value.session.id } });
    const local = new DeterministicWorkspaceRuntime(config);
    const connection = await receiverFixture(local);
    const receiver = connection.runtime;
    const claimed = barrier();
    const release = barrier();
    const firstWorker: WorkspaceRuntime = new Proxy(receiver, {
      get(target, key) {
        if (key === "claimSessionOperation") return async (input: Parameters<RemoteWorkspaceRuntime["claimSessionOperation"]>[0]) => {
          claimed.release();
          await release.wait;
          return receiver.claimSessionOperation(input);
        };
        const member = Reflect.get(target, key);
        return typeof member === "function" ? member.bind(target) : member;
      }
    });
    const first = runWorkspaceMaintenance({ config, now, prisma, runtime: firstWorker });
    try {
      await claimed.wait;
      const owner = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } });
      expect(owner.operationOwner).toMatch(/^maintenance:/u);
      expect(owner.operationExpiresAt).not.toBeNull();
      await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
      if (takeover) {
        // Fresh worker after lease expiry must claim a higher generation and
        // prove stop/retirement; expiring a timestamp never opens admission.
        const future = new Date(owner.operationExpiresAt!.getTime() + 1);
        const second = await runWorkspaceMaintenance({ config, now: future, prisma, runtime: receiver });
        expect(second.staleSessionsSettled).toBe(1);
        const next = await admitPreparingRunWithClient(prisma, await value.plan());
        const newOwner = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } });
        expect(newOwner.operationOwner).toBe(`run:${next.runId}`);
        await receiver.claimSessionOperation!({
          operation: { generation: newOwner.version, owner: newOwner.operationOwner! },
          runtimeSandboxId: newOwner.runtimeSandboxId, sessionId: newOwner.id
        });
        if (restart) await connection.restart();
        const stop = vi.spyOn(local, "stopSession");
        release.release();
        await first;
        expect(stop).not.toHaveBeenCalled();
        expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } })).toEqual(newOwner);
      }
    } finally {
      release.release();
      await first;
      await connection.dispose();
    }
    await first;
    if (!takeover) {
      expect(await prisma.workspaceSession.findUniqueOrThrow({
        select: { operationOwner: true, operationExpiresAt: true, state: true }, where: { id: value.session.id }
      })).toEqual({ operationOwner: null, operationExpiresAt: null, state: "STOPPED" });
      await expect(admitPreparingRunWithClient(prisma, await value.plan())).resolves.toMatchObject({ chatMemoryMode: "NORMAL" });
    }
  });
});
