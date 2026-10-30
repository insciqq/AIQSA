// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory, workspaceSandboxName } from "../../domain/workspace";
import { createNativeRunStore, SUBAGENT_RUN_NO_ANSWER } from "../engine/runStore";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { reserveAcceptedWorkspaceSession } from "../runs/prismaRepositoryPreparation";
import type { WorkspaceRunAdmissionPlan } from "../workspace/admission";
import { createSubagentCallbacks } from "../runs/subagentBackground/callbacks";
import { createSubagentBackgroundControl } from "../runs/subagentBackground/control";
import { reconcileSubagentRuns } from "../runs/subagentBackground/recovery";
import { createPrismaSubagentBackgroundStore } from "../runs/subagentBackground/store";
import type { CreateRunInput, CreatedRun } from "../runs/runRepositoryContract";
import { createUsageLimitsRepository } from "../usageLimits/repository";
import { createPrismaWorkspaceAttachments, currentWorkspaceAttachments } from "../workspace/attachments";
import { getWorkspaceConfig } from "../workspace/config";
import { createPrismaWorkspaceCoordinatorRepository } from "../workspace/coordinator";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { FakeSubagentCallbackSink, FakeSubagentRunner, endedSubagentResult } from "../../../tests/support/subagentPorts";
import type { SubagentBinding, SubagentCallbackSink, WorkspaceDetachInput, WorkspaceDetachResult } from "./ports";

/**
 * Cross-slice suites of the sub-agent integration on a disposable database:
 * the background runs' control and store over the shared Workspace's real
 * attachments (per-thread active runs, each with its own Workspace binding),
 * deletion and recovery while sub-agents browse, and callbacks and admission
 * under the user's usage limits, with sub-agent usage counting toward them.
 */

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const TOOLS = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => ({ description: `Fixture ${originalName}`, inputSchema: { type: "object" },
  namespacedName: namespacedWorkspaceToolName(originalName), originalName }));
const repository = createPrismaRunRepository(prisma);
const store = createPrismaSubagentBackgroundStore(prisma);
const coordinatorRepository = createPrismaWorkspaceCoordinatorRepository(prisma);
const usageLimits = createUsageLimitsRepository(prisma);
const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "fake",
  providerModelId: providerTemplateIds.fakeModel, reasoningEffort: null };

/**
 * The coordinator's retirement (`WorkspaceCoordinator.detach` → `settle`) as the session rows see it, its runtime
 * left out: a run with other active runs attached leaves only its own attachment (`detachRun`, its processes proven
 * stopped), and the last one settles the session, which ends the operation for every run under it (`settleSession`).
 */
function retirement() {
  const retired: WorkspaceDetachInput[] = [];
  const retire = async (input: WorkspaceDetachInput): Promise<WorkspaceDetachResult> => {
    retired.push(input);
    const current = await coordinatorRepository.binding({ runId: input.modelRunId, userId: input.userId });
    const detachRun = coordinatorRepository.detachRun;
    if (!detachRun) throw new Error("coordinator_repository_without_detach");
    if (!current?.operationOwner) return { interruptedRunIds: [], kind: "detached", remainingRuns: 0 };
    const others = (await currentWorkspaceAttachments(prisma, { chatId: current.chatId, operationOwner: current.operationOwner,
      version: current.operationGeneration })).filter((run) => run.active && run.modelRunId !== input.modelRunId);
    const settleSession = () => coordinatorRepository.settleSession({ operation: { generation: current.operationGeneration,
      owner: current.operationOwner! }, outcome: "pending", runtimeSandboxId: current.runtimeSandboxId, sessionId: current.sessionId });
    if (others.length > 0) {
      // As the coordinator's `settle`: runs that end together each see the others attached, and the one whose detach
      // leaves no attachment closes the operation and settles the session.
      await detachRun({ binding: current, stopProven: input.execution === "settled" });
      if (await coordinatorRepository.closeRunOperationIfLast!(current)) await settleSession();
    } else {
      await settleSession();
    }
    return { interruptedRunIds: [], kind: "detached", remainingRuns: others.length };
  };
  return { retired, workspace: createPrismaWorkspaceAttachments({ prisma, retire, waitMs: 4_000 }) };
}

type Fixture = Readonly<{
  chatId: string;
  main: CreatedRun;
  /** The user's next message on the chat's active leaf, through the send admission's own `createRun`. */
  send(text: string): Promise<CreatedRun>;
  sessionId: string;
  thread(name: string): Promise<Readonly<{ callId: string; threadId: string }>>;
  userId: string;
}>;

/** An owner's chat with an active main-agent run bound to the chat's idle Workspace session. */
async function fixture<T>(execute: (fixture: Fixture) => Promise<T>): Promise<T> {
  const userId = `subagent-integration-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic owner", id: userId, status: "active" } });
  try {
    await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled", userId } });
    await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Sub-agent integration", userId, workspaceEnabled: true } });
    const content = textMessageContent("Find the five best laptops");
    const input: CreateRunInput = { chatId: chat.id, content, expectedActiveLeafId: null, userId, modelId: "fake-qsa", provider: "fake",
      providerRequestPreview: {},
      defaults: { userId, controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
        searchPlan: { mode: "all_selected", optionIds: [] } },
      providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { userId, providerConnectionId: providerTemplateIds.fakeConnection,
        providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] } }),
      followupAdmission: { budgetTokens: 4_096 },
      normalizedRequest: { attachmentIds: [], chatId: chat.id, content, toolMode: "auto",
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake", followupContextReserveTokens: 4_096,
        searchPlan: { mode: "all_selected", options: [] } } };
    const main = await repository.createRun(input);
    await prisma.modelRun.update({ data: { status: "streaming" }, where: { id: main.runId } });
    const sessionId = `ws_${randomBytes(20).toString("hex")}`;
    await prisma.workspaceSession.create({ data: { chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000), id: sessionId,
      imageRef: config.imageRef, internetEnabled: false, policyRevision: 1, sandboxName: workspaceSandboxName(sessionId), state: "READY" } });
    await prisma.workspaceRunBinding.create({ data: { guestUsedAt: null, imageRef: config.imageRef, internetEnabled: false,
      mcpVersion: "0.6.16", modelRunId: main.runId, outputDirectory: workspaceRunOutputDirectory(main.runId), policyRevision: 1,
      runtimeVersion: "0.6.16", toolCatalogHash: hashCanonicalMcpValue(TOOLS), toolDefinitions: TOOLS, workspaceSessionId: sessionId } });
    let ordinal = 0;
    const thread = async (name: string) => {
      ordinal += 1;
      const call = await prisma.modelRunToolCall.create({ data: { arguments: { background: true, message: `Brief for ${name}`, name },
        modelRunId: main.runId, ordinal, providerCallId: `call-${ordinal}`, roundIndex: 1, state: "running", toolName: "call_subagent" } });
      const row = await prisma.subagentThread.create({ data: { anchorRunId: main.runId, chatId: chat.id, name, userId } });
      return { callId: call.id, threadId: row.id };
    };
    const send = async (text: string) => {
      const leaf = await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chat.id } });
      const next = textMessageContent(text);
      const created = await repository.createRun({ ...input, content: next, expectedActiveLeafId: leaf.activeLeafMessageId,
        normalizedRequest: { ...input.normalizedRequest, content: next } });
      await prisma.modelRun.update({ data: { status: "streaming" }, where: { id: created.runId } });
      return created;
    };
    return await execute({ chatId: chat.id, main, send, sessionId, thread, userId });
  } finally {
    // Runs first: their Workspace bindings restrict the session, and the session restricts its chat.
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.workspaceSession.deleteMany({ where: { chat: { userId } } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.usageLimit.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

/**
 * The user's next answer, admitted by the send's own `createRun` (its active-run guard included), then given the
 * chat's Workspace binding its admission plan carries.
 */
async function mainRun(f: Fixture, text: string) {
  const created = await f.send(text);
  await prisma.workspaceRunBinding.create({ data: { guestUsedAt: null, imageRef: config.imageRef, internetEnabled: false,
    mcpVersion: "0.6.16", modelRunId: created.runId, outputDirectory: workspaceRunOutputDirectory(created.runId), policyRevision: 1,
    runtimeVersion: "0.6.16", toolCatalogHash: hashCanonicalMcpValue(TOOLS), toolDefinitions: TOOLS, workspaceSessionId: f.sessionId } });
  return { answerId: created.assistantMessageId, id: created.runId, questionId: created.userMessageId };
}

/** The Workspace admission plan the send's admission reserves, as `workspaceAdmissionService` builds it for this chat. */
function plan(f: Fixture, run: Readonly<{ answerId: string; id: string; questionId: string }>): WorkspaceRunAdmissionPlan {
  const sandboxName = workspaceSandboxName(f.sessionId);
  return { assistantMessageId: run.answerId, chatId: f.chatId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    normalized: { enabled: true, imageRef: config.imageRef, internetEnabled: false, outputDirectory: workspaceRunOutputDirectory(run.id),
      sessionId: f.sessionId } as WorkspaceRunAdmissionPlan["normalized"], policyRevision: 1, runId: run.id, sandboxName,
  sessionId: f.sessionId, toolDefinitions: TOOLS, userMessageId: run.questionId };
}

const startInput = (f: Fixture, name: string, thread: Readonly<{ callId: string; threadId: string }>) => ({
  binding, brief: `Brief for ${name}`, chatId: f.chatId, kind: "start" as const, name, parentRunId: f.main.runId,
  parentToolCallId: thread.callId, threadId: thread.threadId, type: null, userId: f.userId, userMessage: "Find the five best laptops"
});

function control(input: Readonly<{ callbacks?: SubagentCallbackSink; limits?: typeof usageLimits }> = {}) {
  const runner = new FakeSubagentRunner();
  const { retired, workspace } = retirement();
  const background = createSubagentBackgroundControl({ callbacks: input.callbacks ?? new FakeSubagentCallbackSink("pending"), runner,
    stopWaitMs: 5_000, store, usageLimits: input.limits ?? usageLimits, workspace });
  return { background, retired, runner, workspace };
}

async function started(result: Awaited<ReturnType<ReturnType<typeof control>["background"]["start"]>>, runner: FakeSubagentRunner) {
  if (result.kind !== "started") throw new Error(`not started: ${result.code}`);
  await expect.poll(() => runner.turns.has(result.turnId), { timeout: 10_000 }).toBe(true);
  return runner.turns.get(result.turnId)!.input;
}

describe("sub-agents across slices on PostgreSQL", () => {
  afterAll(() => prisma.$disconnect());

  it("runs one active run per thread, each attached to the chat's one Workspace under its own binding", async () => fixture(async (f) => {
    const { background, retired, runner, workspace } = control();
    const alpha = await f.thread("alpha");
    const beta = await f.thread("beta");
    const first = await started(await background.start(startInput(f, "alpha", alpha)), runner);
    const second = await started(await background.start(startInput(f, "beta", beta)), runner);
    // A second turn of a running thread is refused; the thread keeps its one run.
    expect(await background.start({ ...startInput(f, "alpha", alpha), parentToolCallId: (await f.thread("alpha-again")).callId }))
      .toEqual({ code: "subagent_busy", kind: "refused" });
    // Each background run has its parent's Workspace binding with its own output folder, on the chat's one session.
    const bindings = await prisma.workspaceRunBinding.findMany({ where: { modelRunId: { in: [first.hostRunId, second.hostRunId] } } });
    expect(bindings.map((row) => row.workspaceSessionId)).toEqual([f.sessionId, f.sessionId]);
    expect(bindings.map((row) => row.outputDirectory).sort())
      .toEqual([workspaceRunOutputDirectory(first.hostRunId), workspaceRunOutputDirectory(second.hostRunId)].sort());
    const attached = await workspace.attached({ chatId: f.chatId, userId: f.userId });
    expect(attached.map((entry) => entry.agent).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { kind: "subagent", name: "alpha", threadId: alpha.threadId }, { kind: "subagent", name: "beta", threadId: beta.threadId }]);
    const session = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.sessionId } });
    expect(session.operationOwner).toMatch(/^run:/u);
    // One ends: only its attachment goes, with its processes proven stopped; the other keeps the VM.
    runner.finish(first.turnId, endedSubagentResult("alpha", { report: "Three laptops" }));
    await expect.poll(async () => (await workspace.attached({ chatId: f.chatId, userId: f.userId })).length, { timeout: 10_000 }).toBe(1);
    expect(retired).toEqual([{ chatId: f.chatId, execution: "settled", modelRunId: first.hostRunId, userId: f.userId }]);
    // The control retires the Workspace authority first, then settles the turn and its run (`control.ts` `launch`).
    await expect.poll(async () => (await prisma.modelRun.findUniqueOrThrow({ select: { status: true },
      where: { id: first.hostRunId } })).status, { timeout: 10_000 }).toBe("complete");
    await background.stopAll({ chatId: f.chatId, userId: f.userId });
    expect(await workspace.attached({ chatId: f.chatId, userId: f.userId })).toEqual([]);
  }));

  it("stops browsing sub-agents before the chat's deletion and leaves no rows", async () => fixture(async (f) => {
    const { background, retired, runner } = control();
    const turns = await Promise.all(["shop-a", "shop-b"].map(async (name) =>
      started(await background.start(startInput(f, name, await f.thread(name))), runner)));
    expect(await background.stopChat({ chatId: f.chatId, userId: f.userId })).toBe(2);
    expect((await prisma.subagentTurn.findMany({ where: { chatId: f.chatId } })).map((turn) => turn.reasonCode))
      .toEqual(["chat_deleted", "chat_deleted"]);
    expect(retired.map((entry) => entry.modelRunId).sort()).toEqual(turns.map((turn) => turn.hostRunId).sort());
    expect(await prisma.workspaceRunAttachment.count({ where: { chatId: f.chatId } })).toBe(0);
    // The deletion's own order: the stopped runs (their bindings and turns go with them), the session, the chat.
    await prisma.modelRun.deleteMany({ where: { chatId: f.chatId } });
    await prisma.workspaceSession.deleteMany({ where: { chatId: f.chatId } });
    await prisma.chat.delete({ where: { id: f.chatId } });
    expect(await prisma.subagentThread.count({ where: { chatId: f.chatId } })).toBe(0);
    expect(await prisma.workspaceRunBinding.count({ where: { modelRunId: { in: turns.map((turn) => turn.hostRunId) } } })).toBe(0);
  }));

  it("ends browsing runs a restart cut interrupted, retires their Workspace authority as unknown and owes their callbacks", async () =>
    fixture(async (f) => {
      const { background, runner, workspace } = control();
      const turn = await started(await background.start(startInput(f, "browser", await f.thread("browser"))), runner);
      // The restart: no execution of the new process owns the run.
      const { retired, workspace: recovered } = retirement();
      const settled = await reconcileSubagentRuns({ backoff: new Map(), bootedAt: new Date(Date.now() + 60_000), deferred: new Map(),
        flush: async () => ({ chatGone: false, dispositions: new Map(), retryable: new Set() }), liveRunIds: () => [],
        staleMs: 600_000, store, workspace: recovered }, { chatId: f.chatId });
      expect(settled).toBeGreaterThanOrEqual(1);
      expect(retired).toEqual([expect.objectContaining({ execution: "unknown", modelRunId: turn.hostRunId })]);
      expect(await prisma.subagentTurn.findUniqueOrThrow({ select: { callbackRunId: true, reasonCode: true, state: true },
        where: { id: turn.turnId } })).toEqual({ callbackRunId: null, reasonCode: "restart", state: "interrupted" });
      expect(await workspace.attached({ chatId: f.chatId, userId: f.userId })).toEqual([]);
      // The old process's execution ends later and changes nothing on record.
      runner.finish(turn.turnId, endedSubagentResult("browser"));
      await background.stopAll({ chatId: f.chatId, userId: f.userId });
      expect((await prisma.subagentTurn.findUniqueOrThrow({ where: { id: turn.turnId } })).state).toBe("interrupted");
    }));

  it("admits the user's message beside running background sub-agents, then a wake-up once they ended", async () => fixture(async (f) => {
    const { background, runner, workspace } = control();
    // The answer that starts them holds the chat's Workspace operation, as its admission does.
    expect(await workspace.attach({ agent: { kind: "main" }, chatId: f.chatId, modelRunId: f.main.runId, userId: f.userId }))
      .toMatchObject({ kind: "attached" });
    const turns = await Promise.all(["alpha", "beta", "gamma"].map(async (name) =>
      started(await background.start(startInput(f, name, await f.thread(name))), runner)));
    // That answer ends at once: its run, which never used the guest, leaves only its own attachment.
    const mainBinding = (await coordinatorRepository.binding({ runId: f.main.runId, userId: f.userId }))!;
    expect(await coordinatorRepository.retireUnusedRun(mainBinding)).toBe(true);
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: f.main.runId } });
    expect((await workspace.attached({ chatId: f.chatId, userId: f.userId })).map((entry) => entry.modelRunId).sort())
      .toEqual(turns.map((turn) => turn.hostRunId).sort());
    // The user writes while the three run: the new answer joins their operation as one more attached run.
    const user = await mainRun(f, "Meanwhile, the budget is 900 EUR.");
    await prisma.$transaction((tx) => reserveAcceptedWorkspaceSession(tx, plan(f, user)));
    const joined = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.sessionId } });
    expect(joined.operationOwner).toBe(`run:${f.main.runId}`);
    expect(await prisma.workspaceRunAttachment.count({ where: { chatId: f.chatId, modelRunId: user.id,
      operationGeneration: joined.version } })).toBe(1);
    // A second main-agent answer at the same time is still refused, by the same guard that let this one in.
    await expect(f.send("And another one.")).rejects.toThrow("active_run_in_progress");
    // That answer ends, then the three sub-agents: the last one settles the session.
    expect(await coordinatorRepository.retireUnusedRun((await coordinatorRepository.binding({ runId: user.id, userId: f.userId }))!))
      .toBe(true);
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: user.id } });
    for (const turn of turns) runner.finish(turn.turnId, endedSubagentResult("done"));
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.sessionId } })).operationOwner,
      { timeout: 10_000 }).toBeNull();
    expect(await workspace.attached({ chatId: f.chatId, userId: f.userId })).toEqual([]);
    // The wake-up's answer then claims the idle session as its own operation.
    const wakeUp = await mainRun(f, "[Sub-agent callbacks, written by the server, not by the user]");
    await prisma.$transaction((tx) => reserveAcceptedWorkspaceSession(tx, plan(f, wakeUp)));
    expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.sessionId } })).operationOwner).toBe(`run:${wakeUp.id}`);
  }));

  it("counts sub-agent usage toward the allowance, refuses a turn past it and keeps the callback owed when a wake-up is refused", async () =>
    fixture(async (f) => {
      const owed: string[] = [];
      const callbacks = createSubagentCallbacks({ coalesceMs: 10, store, admitWakeUp: async (input) => {
        owed.push(...input.turnIds);
        return "usage_limited";
      } });
      const { background, runner } = control({ callbacks: callbacks.sink });
      const turn = await started(await background.start(startInput(f, "spender", await f.thread("spender"))), runner);
      // Its model calls are its own run's usage, of purpose `subagent`.
      await createNativeRunStore(prisma).writeUsageRows({ assistantMessageId: SUBAGENT_RUN_NO_ANSWER, chatId: f.chatId, runId: turn.hostRunId,
        userId: f.userId }, [{ attribution: { estimatedCostMicros: 50_000, modelId: "fake-qsa", operationCount: 1, provider: "fake",
        providerModelId: providerTemplateIds.fakeModel, purpose: "subagent",
        usage: { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 1_000, outputTokens: 100, reasoningTokens: 0, totalTokens: 1_100 } },
      key: "0" }]);
      await prisma.usageLimit.create({ data: { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: 10_000, userId: f.userId } });
      expect((await usageLimits.loadUsageLimitStatus(f.userId, new Date())).userSpentMicros).toBeGreaterThanOrEqual(50_000);
      // Past the budget no further background turn is admitted, and nothing is left behind.
      const runsBefore = await prisma.modelRun.count({ where: { chatId: f.chatId } });
      expect(await background.start(startInput(f, "another", await f.thread("another"))))
        .toEqual({ code: "subagent_usage_limited", kind: "refused" });
      expect(await prisma.modelRun.count({ where: { chatId: f.chatId } })).toBe(runsBefore);
      // The main answer ends; the sub-agent's end then finds no running answer, and usage limits refuse the wake-up.
      await prisma.modelRun.update({ data: { status: "complete" }, where: { id: f.main.runId } });
      runner.finish(turn.turnId, endedSubagentResult("spender", { report: "Spent." }));
      await expect.poll(() => owed, { timeout: 10_000 }).toEqual([turn.turnId]);
      expect(await prisma.subagentTurn.findUniqueOrThrow({ select: { callbackRunId: true, state: true }, where: { id: turn.turnId } }))
        .toEqual({ callbackRunId: null, state: "done" });
      const status = await store.owedCallbacks({ chatId: f.chatId, userId: f.userId });
      expect(status?.activeBranch.map((callback) => callback.turnId)).toEqual([turn.turnId]);
    }));
});
