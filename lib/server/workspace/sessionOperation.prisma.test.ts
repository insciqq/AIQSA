// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { normalizeTokenUsage } from "@/lib/domain/usage";
import {
  WORKSPACE_MCP_TOOL_ALLOWLIST, WORKSPACE_POLICY_ID,
  workspaceMessageManifestPath, workspaceRunOutputDirectory, workspaceSandboxName
} from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { prisma } from "@/lib/server/prisma";
import { activateWorkspaceFollowupWithClient, admitPreparingRunWithClient } from "@/lib/server/runs/prismaRepositoryPreparation";
import { createWorkspaceFollowupRepository } from "@/lib/server/runs/workspaceFollowupPersistence";
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
import { createChatContinuationRepository } from "../chats/continuationRepository";
import { createWorkspaceLifecycleService } from "./lifecycle";

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
  await prisma.user.create({ data: { id: userId, displayName: "Workspace Operation Test", status: "active" } });
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
  const plan = async (): Promise<Extract<PreparingRunAdmissionInput, { admissionKind: "NORMAL_SEND" }>> => {
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

async function publishedPredecessor() {
  const value = await fixture();
  await prisma.workspaceSession.update({ where: { id: value.session.id }, data: { state: "READY", runtimeSandboxId: null } });
  const repository = createPrismaRunRepository(prisma);
  const request = await value.plan();
  const previous = await repository.createRun(request);
  const completion = { ...previous, chatId: value.chatId, userId: value.userId, finalText: "File saved.",
    provider: request.provider, modelId: request.modelId, estimatedCostMicros: null,
    usage: normalizeTokenUsage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }) };
  expect(await repository.publishRunAnswer!(completion)).toBe(true);
  const nextRequest = async () => ({ ...await value.plan(), workspaceFollowup: {
    admissionKey: randomBytes(32).toString("hex"), predecessorRunId: previous.runId, snapshot: { version: 1 }
  } });
  const releasePrevious = async () => {
    // This fixture proves database transfer, not runtime quiescence. Runtime
    // and real-file handoff remain separate coordinator/KVM evidence.
    await prisma.workspaceSession.update({ where: { id: value.session.id }, data: { operationOwner: null, state: "STOPPED" } });
    expect(await repository.completeRun(completion)).toBe(true);
  };
  return { ...value, completion, nextRequest, previous, releasePrevious, repository };
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

  it("keeps a waiting successor durable without acquiring the predecessor's Workspace", async () => {
    const value = await publishedPredecessor();
    const before = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } });
    const admission = await value.nextRequest();
    const created = await admitPreparingRunWithClient(prisma, admission);
    expect(created.deferredWorkspace).toBe(true);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } })).toEqual(before);
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: created.runId } })).toBe(0);
    expect(await value.repository.getRunOutcomeForUser(created.runId, value.userId)).toEqual({
      id: created.runId, status: "queued", workspacePreparation: true
    });
    expect(await createWorkspaceFollowupRepository(prisma).claim()).toBeNull();
    await expect(value.repository.getRunOutcomeForUser(created.runId, "another-user")).resolves.toBeNull();
    await value.releasePrevious();
    const claim = await createWorkspaceFollowupRepository(prisma).claim();
    expect(claim?.runId).toBe(created.runId);
    const activated = await activateWorkspaceFollowupWithClient(prisma, { admission, created, claimToken: claim!.claimToken });
    expect(activated.deferredWorkspace).toBeUndefined();
    expect(activated.workspaceMemorySource!.memorySourceRevision).toBe(created.workspaceMemorySource!.memorySourceRevision + 1);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } })).toMatchObject({
      operationOwner: `run:${created.runId}`, version: before.version + 1
    });
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } })).toMatchObject({ status: "preparing", workspaceWaitPending: false });
    await expect(activateWorkspaceFollowupWithClient(prisma, { admission, created, claimToken: "lost-token" }))
      .rejects.toMatchObject({ code: "workspace_followup_unavailable" });
  });

  it("admits only one waiting successor under concurrent submissions", async () => {
    const value = await publishedPredecessor();
    const attempts = await Promise.all([value.nextRequest(), value.nextRequest()]);
    const results = await Promise.allSettled(attempts.map((request) => admitPreparingRunWithClient(prisma, request)));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await prisma.workspaceFollowup.count({ where: { chatId: value.chatId } })).toBe(1);
    expect(await prisma.message.count({ where: { chatId: value.chatId } })).toBe(4);
  });

  it("prepares a waiting successor once after handoff and clears its private dispatch snapshot", async () => {
    const value = await publishedPredecessor();
    const admission = await value.nextRequest();
    const created = await admitPreparingRunWithClient(prisma, admission);
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: created.runId } })).toBe(0);
    await value.releasePrevious();
    const followups = createWorkspaceFollowupRepository(prisma);
    const claim = await followups.claim();
    expect(claim?.runId).toBe(created.runId);
    await value.repository.continueWorkspacePreparedRun!({ admission, created, claimToken: claim!.claimToken });
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: created.runId } }))
      .toMatchObject({ status: "streaming", workspaceWaitPending: false });
    expect(await prisma.memoryRetrievalAttempt.findMany({ where: { modelRunId: created.runId } }))
      .toEqual([expect.objectContaining({ state: "CONSUMED" })]);
    expect(await followups.markAnswerDispatched(claim!)).toBe(true);
    expect(await prisma.workspaceFollowup.findUniqueOrThrow({ where: { modelRunId: created.runId } }))
      .toMatchObject({ state: "dispatched", snapshot: null, admissionResult: null, claimToken: null, leaseExpiresAt: null });
    expect(await followups.claim()).toBeNull();
    await expect(followups.markAnswerDispatched(claim!)).rejects.toMatchObject({ code: "workspace_followup_unavailable" });
  });

  it("fences an expired waiting successor claim after another worker reclaims it", async () => {
    const value = await publishedPredecessor();
    const admission = await value.nextRequest();
    const created = await admitPreparingRunWithClient(prisma, admission);
    await value.releasePrevious();
    const followups = createWorkspaceFollowupRepository(prisma);
    const oldClaim = await followups.claim();
    await prisma.workspaceFollowup.update({ where: { modelRunId: created.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
    const currentClaim = await followups.claim();
    expect(currentClaim?.runId).toBe(created.runId);
    expect(currentClaim?.claimToken).not.toBe(oldClaim?.claimToken);
    expect(await followups.heartbeat(oldClaim!)).toBe(false);
    await expect(activateWorkspaceFollowupWithClient(prisma, { admission, created, claimToken: oldClaim!.claimToken }))
      .rejects.toMatchObject({ code: "workspace_followup_unavailable" });
    await expect(value.repository.settlePreparingRunFailure({ workspaceClaimToken: oldClaim!.claimToken,
      runId: created.runId, userId: value.userId, errorCode: "workspace_followup_interrupted",
      message: "Interrupted.", state: "FAILED" })).rejects.toMatchObject({ code: "workspace_followup_unavailable" });
    await followups.release(oldClaim!);
    expect(await followups.load(currentClaim!)).not.toBeNull();
    await value.repository.continueWorkspacePreparedRun!({ admission, created, claimToken: currentClaim!.claimToken });
    expect(await followups.markAnswerDispatched(currentClaim!)).toBe(true);
  });

  it("refuses a waiting successor whose accepted branch changed before handoff", async () => {
    const value = await publishedPredecessor();
    const admission = await value.nextRequest();
    const created = await admitPreparingRunWithClient(prisma, admission);
    await value.releasePrevious();
    await prisma.chat.update({ where: { id: value.chatId }, data: { activeLeafMessageId: value.previous.assistantMessageId } });
    const claim = await createWorkspaceFollowupRepository(prisma).claim();
    await expect(value.repository.continueWorkspacePreparedRun!({ admission, created, claimToken: claim!.claimToken }))
      .rejects.toMatchObject({ code: "workspace_followup_unavailable" });
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } }))
      .toMatchObject({ operationOwner: null });
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: created.runId } })).toBe(0);
    expect(await value.repository.settlePreparingRunFailure({ workspaceClaimToken: claim!.claimToken,
      runId: created.runId, userId: value.userId, errorCode: "workspace_followup_unavailable",
      message: "Preparation unavailable.", state: "FAILED" })).toBe(true);
    expect(await prisma.workspaceFollowup.findUniqueOrThrow({ where: { modelRunId: created.runId } }))
      .toMatchObject({ state: "failed", snapshot: null, admissionResult: null });
  });

  it("cancels a waiting successor without changing the published answer or its Workspace owner", async () => {
    const value = await publishedPredecessor();
    const created = await admitPreparingRunWithClient(prisma, await value.nextRequest());
    const cancelled = await value.repository.cancelRun({ runId: created.runId, userId: value.userId,
      payload: { code: "cancelled", message: "Cancelled." } });
    expect(cancelled.kind).toBe("cancelled");
    expect(await prisma.workspaceFollowup.findUniqueOrThrow({ where: { modelRunId: created.runId } }))
      .toMatchObject({ state: "cancelled", snapshot: null, admissionResult: null });
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } }))
      .toMatchObject({ operationOwner: `run:${value.previous.runId}` });
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: value.previous.runId } })).toMatchObject({ status: "streaming" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: value.previous.assistantMessageId } }))
      .toMatchObject({ status: "complete", content: textMessageContent("File saved.") });
    expect(await createWorkspaceFollowupRepository(prisma).claim()).toBeNull();
  });

  it.each(["account disabled", "chat archived"] as const)("settles a waiting successor without dispatch after %s", async (change) => {
    const value = await publishedPredecessor();
    const admission = await value.nextRequest();
    const created = await admitPreparingRunWithClient(prisma, admission);
    await value.releasePrevious();
    if (change === "account disabled") await prisma.user.update({ where: { id: value.userId }, data: { status: "disabled" } });
    else await prisma.chat.update({ where: { id: value.chatId }, data: { archived: true } });
    const followups = createWorkspaceFollowupRepository(prisma);
    const claim = await followups.claim();
    expect(claim?.runId).toBe(created.runId);
    await expect(value.repository.continueWorkspacePreparedRun!({ admission, created, claimToken: claim!.claimToken }))
      .rejects.toMatchObject({ code: "workspace_followup_unavailable" });
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: value.session.id } })).toMatchObject({ operationOwner: null });
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: created.runId } })).toBe(0);
    expect(await value.repository.settlePreparingRunFailure({ workspaceClaimToken: claim!.claimToken,
      runId: created.runId, userId: value.userId, errorCode: "workspace_followup_unavailable",
      message: "Preparation unavailable.", state: "FAILED" })).toBe(true);
    expect(await prisma.workspaceFollowup.findUniqueOrThrow({ where: { modelRunId: created.runId } }))
      .toMatchObject({ state: "failed", snapshot: null, admissionResult: null });
    expect(await followups.hasPending()).toBe(false);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: value.previous.assistantMessageId } }))
      .toMatchObject({ status: "complete" });
  });

  it("rejects an unrelated executor while a waiting successor owns the next turn", async () => {
    const value = await publishedPredecessor();
    const created = await admitPreparingRunWithClient(prisma, await value.nextRequest());
    await value.releasePrevious();
    const previous = await prisma.modelRun.findUniqueOrThrow({ where: { id: value.previous.runId } });
    await expect(prisma.modelRun.create({ data: { chatId: value.chatId, userId: value.userId,
      userMessageId: created.userMessageId, provider: "fake", modelId: "fake-qsa", status: "streaming",
      normalizedRequest: previous.normalizedRequest ?? {} } }))
      .rejects.toThrow(/workspace_followup_ownership_conflict/u);
    expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(2);
  });

  it("does not deadlock admission of a waiting successor against predecessor completion", async () => {
    const value = await publishedPredecessor();
    const request = await value.nextRequest();
    await prisma.workspaceSession.update({ where: { id: value.session.id }, data: { operationOwner: null, state: "STOPPED" } });
    const results = await Promise.allSettled([
      admitPreparingRunWithClient(prisma, request), value.repository.completeRun(value.completion)
    ]);
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(2);
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

  it("blocks reset, Download and run admission while a continuation owns the source disk", async () => {
    const value = await fixture();
    await prisma.workspaceSession.update({ where: { id: value.session.id }, data: { state: "STOPPED", stoppedAt: new Date() } });
    const root = await prisma.message.create({ data: { chatId: value.chatId, role: "user", status: "complete", content: textMessageContent("Continue this work") } });
    const leaf = await prisma.message.create({ data: { chatId: value.chatId, parentMessageId: root.id, role: "assistant", status: "complete", content: textMessageContent("Ready") } });
    await prisma.chat.update({ where: { id: value.chatId }, data: { activeLeafMessageId: leaf.id } });
    const repository = createChatContinuationRepository(prisma);
    const request = { chatId: value.chatId, userId: value.userId };
    const source = await repository.loadSource({ ...request, expectedLeafMessageId: leaf.id, requestId: randomUUID() });
    expect((await repository.claim(source, randomUUID())).kind).toBe("claimed");
    const lifecycle = createWorkspaceLifecycleService({ config, prisma, storage: createMemoryStorageAdapter(),
      runtime: new DeterministicWorkspaceRuntime(config),
      policy: { async read() { return { enabled: true, internetEnabled: false, version: 1 }; }, async update() { throw new Error("unused"); } },
      availability: { invalidate() {}, project() { throw new Error("unused"); }, async snapshot() { throw new Error("unused"); } }
    });
    await expect(lifecycle.reset(request)).rejects.toMatchObject({ code: "workspace_reset_conflict" });
    await expect(lifecycle.archive(request)).rejects.toMatchObject({ code: "workspace_busy" });
    await expect(admitPreparingRunWithClient(prisma, await value.plan())).rejects.toMatchObject({ code: "workspace_busy" });
    expect(await prisma.modelRun.count({ where: { chatId: value.chatId } })).toBe(0);
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
