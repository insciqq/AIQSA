// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory, workspaceSandboxName } from "../../../domain/workspace";
import { chatTitleWork } from "../../../../tests/support/chatTitles";
import { endedSubagentResult } from "../../../../tests/support/subagentPorts";
import { createChatTitleRepository } from "../../chats/titleGenerationRepository";
import { SUBAGENT_RUN_NO_ANSWER, createNativeRunStore } from "../../engine/runStore";
import { hashCanonicalMcpValue } from "../../mcp/definitions";
import { requireMemoryCommandSource } from "../../memory/commands/sourceAuthority";
import { memorySha256 } from "../../memory/persistence/lexical";
import { withLockedMemoryTransaction } from "../../memory/persistence/transaction";
import { prisma } from "../../prisma";
import type { SubagentBinding } from "../../subagents/ports";
import { getWorkspaceConfig } from "../../workspace/config";
import { createPrismaWorkspaceExecutionRegistry, workspaceSyncCleanupId } from "../../workspace/executionRegistry";
import { namespacedWorkspaceToolName } from "../../workspace/toolCatalog";
import type { RunUsageAttribution } from "../runRepositoryContract";
import { createPrismaSubagentBackgroundStore } from "./store";

/**
 * The row-lock order of the transactions that met in production deadlocks, on a disposable database: a background
 * sub-agent's admission against a Workspace registration of its parent run, a sub-agent's settlement against its
 * usage totals, Memory's source check against usage totals, and a chat title's usage against its answer's totals. Each
 * test holds one transaction at the point where the old order deadlocked, lets the other one run into it, and checks
 * what the waiting one holds before it lets the first go on: with the order fixed, the waiter holds nothing the holder
 * needs next, so both finish and none is a deadlock victim. No timing decides a test: every wait is observed through
 * `pg_blocking_pids`, the waiter's statement in `pg_stat_activity` or a `NOWAIT` lock.
 */

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const TOOLS = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => ({ description: `Fixture ${originalName}`,
  inputSchema: { type: "object" }, namespacedName: namespacedWorkspaceToolName(originalName), originalName }));
const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "fake",
  providerModelId: providerTemplateIds.fakeModel, reasoningEffort: null };
const usage = (inputTokens: number): RunUsageAttribution => ({ estimatedCostMicros: 5, modelId: "fake-qsa", operationCount: 1,
  provider: "fake", purpose: "chat_answer", usage: { inputTokens, outputTokens: 2 } });
/** What the title model reported, as the title worker hands it over. */
const titleUsage = { inputTokens: 10, outputTokens: 5 };
const owners: string[] = [];

function barrier<T = void>() {
  let release!: (value: T) => void;
  const wait = new Promise<T>((resolve) => { release = resolve; });
  return { release, wait };
}

/** The first call of `model.method` inside a transaction waits for `resume`, holding every lock taken before it. */
type Pause = Readonly<{ method: string; model: string; reached: () => void; resume: Promise<void> }>;
type TransactionOptions = Readonly<{ isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }>;

/**
 * `prisma` whose interactive transactions report their connection's backend pid as they start, record how they
 * failed, and with `pause` stop once where it says. Everything else is `prisma` itself.
 */
function observed(started: (pid: number) => void, options: Readonly<{ failed?: (error: unknown) => void; pause?: Pause }> = {}): PrismaClient {
  const { failed, pause } = options;
  let paused = false;
  const own = (target: object, key: string | symbol) => {
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const pausing = (tx: Prisma.TransactionClient): Prisma.TransactionClient => {
    if (!pause) return tx;
    const at: Pause = pause;
    return new Proxy(tx, {
      get(target, key) {
        const model: unknown = Reflect.get(target, key);
        if (key !== at.model || typeof model !== "object" || model === null) return own(target, key);
        return new Proxy(model, { get(delegate, name) {
          const value: unknown = Reflect.get(delegate, name);
          if (typeof value !== "function") return value;
          const method = value as (...args: unknown[]) => unknown;
          return async (...args: unknown[]) => {
            if (name === at.method && !paused) {
              paused = true;
              at.reached();
              await at.resume;
            }
            return method.apply(delegate, args);
          };
        } });
      }
    });
  };
  return new Proxy(prisma, { get(target, key) {
    if (key !== "$transaction") return own(target, key);
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, transaction: TransactionOptions = {}) =>
      prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        started(row!.pid);
        return work(pausing(tx));
      }, { maxWait: 10_000, timeout: 20_000, ...transaction }).catch((error: unknown) => {
        failed?.(error);
        throw error;
      });
  } });
}

async function blockedBy(waiter: number, blocker: number): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${blocker}::int = ANY(pg_blocking_pids(${waiter}::int)) AS "blocked"`;
  return row?.blocked === true;
}

async function waitForBlock(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await blockedBy(waiter, blocker))) {
    if (Date.now() > deadline) throw new Error("lock_wait_not_observed");
    await delay(20);
  }
}

function sqlState(error: unknown): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010"
    ? (error.meta as { code?: unknown } | undefined)?.code : undefined;
}

/** The statement a backend runs now, so a test can tell which of its locks it waits for. */
async function statementOf(pid: number): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ query: string }>>`SELECT "query" FROM pg_stat_activity WHERE "pid" = ${pid}::int`;
  return row?.query ?? "";
}

/** The chat-row lock `applyUsageTotals` and the title's `recordUsage` take first, as Prisma sends it. */
const CHAT_LOCK_STATEMENT = 'SELECT "id" FROM "Chat" WHERE "id" = $1 FOR NO KEY UPDATE';

/** Whether a `NOWAIT` row lock gets its rows at once, so no transaction holds a lock on them that conflicts with it. */
async function lockableNow(query: Prisma.Sql): Promise<boolean> {
  try {
    await prisma.$queryRaw(query);
    return true;
  } catch (error) {
    if (sqlState(error) === "55P03") return false;
    throw error;
  }
}

/** A chat with an active main-agent run, its `call_subagent` and Workspace command calls and a thread to start. */
async function chatWithMainRun(input: Readonly<{ workspace: boolean }>) {
  const userId = `lock-order-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic lock order", id: userId, status: "active" } });
  const chat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Lock order", userId,
    workspaceEnabled: input.workspace } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic question"), role: "user" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id,
    role: "assistant", status: "streaming" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  const mainRunId = randomUUID();
  const sessionId = `ws_${randomBytes(20).toString("hex")}`;
  // The main run's own operation holds the session, as while its command runs.
  if (input.workspace) {
    await prisma.workspaceSession.create({ data: { chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000), id: sessionId,
      imageRef: config.imageRef, internetEnabled: false, operationOwner: `run:${mainRunId}`, policyRevision: 1,
      sandboxName: workspaceSandboxName(sessionId), state: "READY" } });
  }
  await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine: "native", id: mainRunId,
    modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "streaming", userId, userMessageId: question.id } });
  if (input.workspace) {
    await prisma.workspaceRunBinding.create({ data: { guestUsedAt: null, imageRef: config.imageRef, internetEnabled: false,
      mcpVersion: "0.6.16", modelRunId: mainRunId, outputDirectory: workspaceRunOutputDirectory(mainRunId), policyRevision: 1,
      runtimeVersion: "0.6.16", toolCatalogHash: hashCanonicalMcpValue(TOOLS), toolDefinitions: TOOLS, workspaceSessionId: sessionId } });
  }
  const agentCall = await prisma.modelRunToolCall.create({ data: { arguments: { background: true, message: "Brief", name: "researcher" },
    modelRunId: mainRunId, ordinal: 0, providerCallId: "call-agent", roundIndex: 1, state: "running", toolName: "call_subagent" } });
  const shellCall = await prisma.modelRunToolCall.create({ data: { arguments: { command: "ls" }, modelRunId: mainRunId, ordinal: 1,
    providerCallId: "call-shell", roundIndex: 1, startedAt: new Date(), state: "running",
    toolName: namespacedWorkspaceToolName("sandbox_shell"), ...(input.workspace ? { workspaceRunBindingId: mainRunId } : {}) } });
  const thread = await prisma.subagentThread.create({ data: { anchorRunId: mainRunId, chatId: chat.id, name: "researcher", userId } });
  return {
    chatId: chat.id, mainRunId, sessionId, shellCallId: shellCall.id, userId,
    admission: () => ({ binding, chatId: chat.id, definitionRevisionId: null, parentRunId: mainRunId, parentToolCallId: agentCall.id,
      runId: randomUUID(), threadId: thread.id, turnId: randomUUID(), userId }),
    /** The command's cleanup obligation, as the coordinator registers it before sending the command. */
    registration: () => ({ modelRunId: mainRunId, modelRunToolCallId: shellCall.id, operation: { generation: 1, owner: `run:${mainRunId}` },
      runtimeExecSessionId: workspaceSyncCleanupId(shellCall.id), sessionId })
  };
}

/** A chat with a background sub-agent admitted and running. */
async function runningSubagent() {
  const f = await chatWithMainRun({ workspace: false });
  const admitted = await createPrismaSubagentBackgroundStore(prisma).admit(f.admission());
  if (admitted.kind !== "admitted") throw new Error("subagent_fixture_not_admitted");
  return { ...f, runId: admitted.runId, turnId: admitted.turnId,
    usageScope: { assistantMessageId: SUBAGENT_RUN_NO_ANSWER, chatId: f.chatId, runId: admitted.runId, userId: f.userId } };
}

/** A finished native answer whose user message holds a claimed Memory command, as `sourceAuthority.prisma.test.ts` builds it. */
async function memoryCommand() {
  const userId = `lock-order-memory-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic lock order", id: userId, status: "active" } });
  const chat = await prisma.chat.create({ data: { title: "Lock order Memory", userId } });
  const message = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Remember that my synthetic preference is green"),
    role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Noted"), parentMessageId: message.id,
    role: "assistant", status: "complete" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine: "native", modelId: "fake-qsa",
    normalizedRequest: {}, provider: "fake", status: "complete", userId, userMessageId: message.id } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const claimToken = randomUUID();
  const job = await prisma.memoryJob.create({ data: {
    activeLeafMessageId: answer.id, branchGeneration: 0, chatId: chat.id, commandOperation: "UNKNOWN",
    commandSequence: 1, commandStatus: "RUNNING", idempotencyFingerprint: randomUUID(), kind: "MEMORY_COMMAND",
    leaseExpiresAt: new Date(Date.now() + 120_000), leaseToken: claimToken, memoryGenerationSnapshot: settings.memoryGeneration,
    memoryRevisionSnapshot: settings.memoryRevision, pipelineVersion: "memory-command-v1", sourceHash: memorySha256(message.content),
    sourceMessageId: message.id, sourceRevision: 0, state: "CLAIMED", userId
  } });
  return { chatId: chat.id, claimToken, jobId: job.id, messageId: message.id, runId: run.id, userId,
    usageScope: { assistantMessageId: answer.id, chatId: chat.id, runId: run.id, userId } };
}

/**
 * A finished native answer with its usage totals still unwritten, whose automatic title was dispatched: the title's
 * usage receipt is still unknown, as `createChatTitleRepository(...).take` leaves it.
 */
async function titledAnswer() {
  const userId = `lock-order-title-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic lock order", id: userId, status: "active" } });
  const chat = await prisma.chat.create({ data: { title: "Lock order title", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic question"),
    role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic answer"),
    parentMessageId: question.id, role: "assistant", status: "complete" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine: "native",
    modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "complete", userId, userMessageId: question.id } });
  const work = chatTitleWork({ chatId: chat.id, expectedTitle: chat.title, runId: run.id, userId });
  const snapshot = work.providerSnapshot;
  await prisma.chatTitleGeneration.create({ data: { answerText: work.answerText, chatId: chat.id, dispatchedAt: new Date(),
    expectedTitle: work.expectedTitle, expiresAt: new Date(Date.now() + 300_000),
    providerSnapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue, questionText: work.questionText, runId: run.id,
    status: "dispatched", titleRevision: work.titleRevision, userId } });
  await prisma.usageEvent.create({ data: { chatId: chat.id, chatTitleGeneration: true, chatTitleGenerationId: run.id,
    modelId: snapshot.model.upstreamModelId, modelRunId: run.id, provider: snapshot.providerFamily,
    providerModelId: snapshot.providerModelId, purpose: "chat_title", userId } });
  return { chatId: chat.id, runId: run.id, work,
    usageScope: { assistantMessageId: answer.id, chatId: chat.id, runId: run.id, userId } };
}

afterEach(async () => {
  for (const userId of owners.splice(0)) {
    await prisma.memoryOperationReceipt.deleteMany({ where: { userId } });
    await prisma.memoryMutationAuthorization.deleteMany({ where: { userId } });
    await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
    await prisma.memoryJob.deleteMany({ where: { userId } });
    // Runs first: their Workspace bindings restrict the session, and the session restricts its chat.
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.workspaceSession.deleteMany({ where: { chat: { userId } } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
afterAll(() => prisma.$disconnect());

describe("a background sub-agent's admission and a Workspace registration of its parent run", () => {
  it("registers while the admission holds the parent run, and the admission then binds the sub-agent to the session", async () => {
    const f = await chatWithMainRun({ workspace: true });
    const admissionPid = barrier<number>();
    const parentHeld = barrier();
    const resume = barrier();
    // Paused right after it locked the user, the chat and the parent run, before its turn, run and Workspace binding.
    const store = createPrismaSubagentBackgroundStore(observed(admissionPid.release,
      { pause: { method: "findFirst", model: "subagentThread", reached: () => parentHeld.release(), resume: resume.wait } }));
    const registrationPid = barrier<number>();
    const registry = createPrismaWorkspaceExecutionRegistry(observed(registrationPid.release));
    let admitting: Promise<unknown> | undefined;
    let registering: Promise<unknown> | undefined;
    try {
      admitting = store.admit(f.admission()).catch((error: unknown) => ({ error }));
      await Promise.race([parentHeld.wait, admitting.then((value) => { throw new Error("admission_ended_before_parent_lock", { cause: value }); })]);
      // The registration locks the session, then its execution row's foreign key takes a key share on the parent run.
      const settled: unknown[] = [];
      registering = registry.register(f.registration()).then((value) => { settled.push(value); }, (error: unknown) => { settled.push({ error }); });
      const [holder, waiter] = [await admissionPid.wait, await registrationPid.wait];
      while (settled.length === 0 && !(await blockedBy(waiter, holder))) await delay(20);
      // It finished without waiting for the admission's lock on that run.
      expect(settled).toEqual(["registered"]);
      resume.release();
      const admitted = await admitting;
      expect(admitted).toMatchObject({ kind: "admitted" });
      const runId = (admitted as { runId: string }).runId;
      expect(await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: runId } }))
        .toMatchObject({ workspaceSessionId: f.sessionId });
      expect(await prisma.workspaceExecution.findUniqueOrThrow({ where: { modelRunToolCallId: f.shellCallId } }))
        .toMatchObject({ modelRunId: f.mainRunId, state: "ACTIVE", workspaceSessionId: f.sessionId });
    } finally {
      resume.release();
      await Promise.allSettled([admitting, registering]);
    }
  }, 60_000);

  it("lets the admission wait for a registration holding the session without holding the parent run against it", async () => {
    const f = await chatWithMainRun({ workspace: true });
    const registrationPid = barrier<number>();
    const sessionHeld = barrier();
    const resume = barrier();
    // Paused right after it locked the session, before its execution row.
    const registry = createPrismaWorkspaceExecutionRegistry(observed(registrationPid.release,
      { pause: { method: "findFirst", model: "workspaceSession", reached: () => sessionHeld.release(), resume: resume.wait } }));
    const admissionPid = barrier<number>();
    const store = createPrismaSubagentBackgroundStore(observed(admissionPid.release));
    let admitting: Promise<unknown> | undefined;
    let registering: Promise<unknown> | undefined;
    try {
      registering = registry.register(f.registration()).catch((error: unknown) => ({ error }));
      await Promise.race([sessionHeld.wait, registering.then((value) => { throw new Error("registration_ended_before_session_lock", { cause: value }); })]);
      admitting = store.admit(f.admission()).catch((error: unknown) => ({ error }));
      // The admission reaches its Workspace binding, whose foreign key waits for the session the registration holds...
      await waitForBlock(await admissionPid.wait, await registrationPid.wait);
      // ...while it holds the parent run only against that run's other writers: a key share on it is free.
      expect(await lockableNow(Prisma.sql`SELECT "id" FROM "ModelRun" WHERE "id" = ${f.mainRunId} FOR KEY SHARE NOWAIT`)).toBe(true);
      expect(await lockableNow(Prisma.sql`SELECT "id" FROM "ModelRun" WHERE "id" = ${f.mainRunId} FOR NO KEY UPDATE NOWAIT`)).toBe(false);
      resume.release();
      expect(await registering).toBe("registered");
      const admitted = await admitting;
      expect(admitted).toMatchObject({ kind: "admitted" });
      expect(await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: (admitted as { runId: string }).runId } }))
        .toMatchObject({ workspaceSessionId: f.sessionId });
    } finally {
      resume.release();
      await Promise.allSettled([admitting, registering]);
    }
  }, 60_000);
});

describe("a background sub-agent's settlement and its usage totals", () => {
  it("lets the totals wait for a settlement holding the chat without holding the run against it", async () => {
    const f = await runningSubagent();
    const settlementPid = barrier<number>();
    const chatHeld = barrier();
    const resume = barrier();
    // Paused right after it locked the user, the chat and the turn, before it ends the turn's run.
    const store = createPrismaSubagentBackgroundStore(observed(settlementPid.release,
      { pause: { method: "findUniqueOrThrow", model: "subagentThread", reached: () => chatHeld.release(), resume: resume.wait } }));
    const usagePid = barrier<number>();
    const failures: unknown[] = [];
    const runs = createNativeRunStore(observed(usagePid.release, { failed: (error) => failures.push(error) }));
    let settling: Promise<unknown> | undefined;
    let totals: Promise<unknown> | undefined;
    try {
      settling = store.settle({ chatId: f.chatId, result: endedSubagentResult("researcher"), turnId: f.turnId, userId: f.userId })
        .catch((error: unknown) => ({ error }));
      await Promise.race([chatHeld.wait, settling.then((value) => { throw new Error("settlement_ended_before_chat_lock", { cause: value }); })]);
      totals = runs.applyUsageTotals(f.usageScope, [usage(10)]).catch((error: unknown) => ({ error }));
      await waitForBlock(await usagePid.wait, await settlementPid.wait);
      // The totals wait for the chat first, holding nothing of the run the settlement ends next.
      expect(await lockableNow(Prisma.sql`SELECT "id" FROM "ModelRun" WHERE "id" = ${f.runId} FOR NO KEY UPDATE NOWAIT`)).toBe(true);
      resume.release();
      expect(await settling).toMatchObject({ settled: true });
      expect(await totals).toBeUndefined();
      expect(failures).toEqual([]);
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: f.runId } })).toMatchObject({ inputTokens: 10, status: "complete" });
      expect(await prisma.chat.findUniqueOrThrow({ where: { id: f.chatId } })).toMatchObject({ totalInputTokens: 10 });
    } finally {
      resume.release();
      await Promise.allSettled([settling, totals]);
    }
  }, 60_000);

  it("lets a settlement wait for totals holding the chat and the run without holding the turn against them", async () => {
    const f = await runningSubagent();
    const usagePid = barrier<number>();
    const runHeld = barrier();
    const resume = barrier();
    // Paused after it locked the chat and wrote the run's totals, before the chat's.
    const runs = createNativeRunStore(observed(usagePid.release,
      { pause: { method: "update", model: "chat", reached: () => runHeld.release(), resume: resume.wait } }));
    const settlementPid = barrier<number>();
    const failures: unknown[] = [];
    const store = createPrismaSubagentBackgroundStore(observed(settlementPid.release, { failed: (error) => failures.push(error) }));
    let settling: Promise<unknown> | undefined;
    let totals: Promise<unknown> | undefined;
    try {
      totals = runs.applyUsageTotals(f.usageScope, [usage(10)]).catch((error: unknown) => ({ error }));
      await Promise.race([runHeld.wait, totals.then((value) => { throw new Error("totals_ended_before_run_lock", { cause: value }); })]);
      settling = store.settle({ chatId: f.chatId, result: endedSubagentResult("researcher"), turnId: f.turnId, userId: f.userId })
        .catch((error: unknown) => ({ error }));
      await waitForBlock(await settlementPid.wait, await usagePid.wait);
      // The settlement waits for the chat, before it takes the turn or reaches the run the totals hold.
      expect(await lockableNow(Prisma.sql`SELECT "id" FROM "SubagentTurn" WHERE "id" = ${f.turnId} FOR UPDATE NOWAIT`)).toBe(true);
      resume.release();
      expect(await totals).toBeUndefined();
      expect(await settling).toMatchObject({ settled: true });
      expect(failures).toEqual([]);
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: f.runId } })).toMatchObject({ inputTokens: 10, status: "complete" });
    } finally {
      resume.release();
      await Promise.allSettled([settling, totals]);
    }
  }, 60_000);
});

describe("Memory's source check and usage totals of the same answer", () => {
  it("lets the source check wait for totals holding the chat and the run before it locks anything of the answer", async () => {
    const f = await memoryCommand();
    const usagePid = barrier<number>();
    const runHeld = barrier();
    const resume = barrier();
    const runs = createNativeRunStore(observed(usagePid.release,
      { pause: { method: "update", model: "chat", reached: () => runHeld.release(), resume: resume.wait } }));
    const memoryPid = barrier<number>();
    const memoryFailures: unknown[] = [];
    const memoryClient = observed((pid) => memoryPid.release(pid), { failed: (error) => memoryFailures.push(error) });
    let totals: Promise<unknown> | undefined;
    let checking: Promise<unknown> | undefined;
    try {
      totals = runs.applyUsageTotals(f.usageScope, [usage(10)]).catch((error: unknown) => ({ error }));
      await Promise.race([runHeld.wait, totals.then((value) => { throw new Error("totals_ended_before_run_lock", { cause: value }); })]);
      // Memory locks the chat, the source message and the run, in that order, in one statement.
      checking = withLockedMemoryTransaction(memoryClient, f.userId,
        (tx) => requireMemoryCommandSource(tx, f.userId, f.jobId, f.claimToken)).catch((error: unknown) => ({ error }));
      await waitForBlock(await memoryPid.wait, await usagePid.wait);
      // It waits at the chat, so it holds no lock on the source message yet.
      expect(await lockableNow(Prisma.sql`SELECT "id" FROM "Message" WHERE "id" = ${f.messageId} FOR UPDATE NOWAIT`)).toBe(true);
      resume.release();
      expect(await totals).toBeUndefined();
      // Serializable Memory may make its check again after the totals changed the chat row; it is never a deadlock victim.
      expect(await checking).toMatchObject({ modelRunId: f.runId });
      expect(memoryFailures.filter((error) => sqlState(error) === "40P01")).toEqual([]);
      expect(await prisma.chat.findUniqueOrThrow({ where: { id: f.chatId } })).toMatchObject({ totalInputTokens: 10 });
    } finally {
      resume.release();
      await Promise.allSettled([totals, checking]);
    }
  }, 60_000);
});

describe("a chat title's usage and its answer's usage totals", () => {
  it("lets the title's usage wait for answer totals holding the chat and the run before it locks its receipt", async () => {
    const f = await titledAnswer();
    const usagePid = barrier<number>();
    const runHeld = barrier();
    const resume = barrier();
    // Paused after it locked the chat and wrote the run's totals, before the chat's.
    const runs = createNativeRunStore(observed(usagePid.release,
      { pause: { method: "update", model: "chat", reached: () => runHeld.release(), resume: resume.wait } }));
    const titlePid = barrier<number>();
    const titleFailures: unknown[] = [];
    const titles = createChatTitleRepository(observed(titlePid.release, { failed: (error) => titleFailures.push(error) }));
    let totals: Promise<unknown> | undefined;
    let recording: Promise<unknown> | undefined;
    try {
      totals = runs.applyUsageTotals(f.usageScope, [usage(30)]).catch((error: unknown) => ({ error }));
      await Promise.race([runHeld.wait, totals.then((value) => { throw new Error("totals_ended_before_run_lock", { cause: value }); })]);
      recording = titles.recordUsage(f.work, titleUsage).catch((error: unknown) => ({ error }));
      const waiter = await titlePid.wait;
      await waitForBlock(waiter, await usagePid.wait);
      // The title waits at the chat, so it holds neither its receipt nor anything of the run the totals hold.
      expect(await statementOf(waiter)).toContain(CHAT_LOCK_STATEMENT);
      expect(await lockableNow(Prisma.sql`SELECT "id" FROM "UsageEvent" WHERE "chatTitleGenerationId" = ${f.runId} FOR UPDATE NOWAIT`))
        .toBe(true);
      resume.release();
      expect(await totals).toBeUndefined();
      expect(await recording).toBeUndefined();
      expect(titleFailures).toEqual([]);
      expect(await prisma.usageEvent.findUniqueOrThrow({ where: { chatTitleGenerationId: f.runId } }))
        .toMatchObject({ inputTokens: 10, outputTokens: 5, usageCompleteness: "COMPLETE" });
      // The title's usage adds to the answer's totals on the run and on the chat alike.
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: f.runId } })).toMatchObject({ inputTokens: 40, outputTokens: 7 });
      expect(await prisma.chat.findUniqueOrThrow({ where: { id: f.chatId } })).toMatchObject({ totalInputTokens: 40, totalOutputTokens: 7 });
    } finally {
      resume.release();
      await Promise.allSettled([totals, recording]);
    }
  }, 60_000);

  it("lets answer totals wait for the title's usage holding the chat, its receipt and the run, holding nothing it needs", async () => {
    const f = await titledAnswer();
    const titlePid = barrier<number>();
    const runHeld = barrier();
    const resume = barrier();
    // Paused after it sealed its receipt and added it to the run, before the chat's totals: where the old order (receipt,
    // run, then chat) met the totals holding the chat and waiting for the run.
    const titles = createChatTitleRepository(observed(titlePid.release,
      { pause: { method: "updateMany", model: "chat", reached: () => runHeld.release(), resume: resume.wait } }));
    const usagePid = barrier<number>();
    const usageFailures: unknown[] = [];
    const runs = createNativeRunStore(observed(usagePid.release, { failed: (error) => usageFailures.push(error) }));
    let totals: Promise<unknown> | undefined;
    let recording: Promise<unknown> | undefined;
    try {
      recording = titles.recordUsage(f.work, titleUsage).catch((error: unknown) => ({ error }));
      await Promise.race([runHeld.wait, recording.then((value) => { throw new Error("title_usage_ended_before_run_lock", { cause: value }); })]);
      totals = runs.applyUsageTotals(f.usageScope, [usage(30)]).catch((error: unknown) => ({ error }));
      const waiter = await usagePid.wait;
      await waitForBlock(waiter, await titlePid.wait);
      // The totals wait for the chat first, holding nothing of the run or the chat the title's usage writes next.
      expect(await statementOf(waiter)).toContain(CHAT_LOCK_STATEMENT);
      resume.release();
      expect(await recording).toBeUndefined();
      expect(await totals).toBeUndefined();
      expect(usageFailures).toEqual([]);
      expect(await prisma.usageEvent.findUniqueOrThrow({ where: { chatTitleGenerationId: f.runId } }))
        .toMatchObject({ inputTokens: 10, outputTokens: 5, usageCompleteness: "COMPLETE" });
      // The title's usage came first, and the answer's totals still add the answer's to it, each once.
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: f.runId } }))
        .toMatchObject({ inputTokens: 40, outputTokens: 7, totalTokens: 47, usageCompleteness: "COMPLETE" });
      expect(await prisma.chat.findUniqueOrThrow({ where: { id: f.chatId } })).toMatchObject({ totalInputTokens: 40, totalOutputTokens: 7 });
    } finally {
      resume.release();
      await Promise.allSettled([totals, recording]);
    }
  }, 60_000);
});
