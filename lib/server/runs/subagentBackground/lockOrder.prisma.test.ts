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
import { namespacedMcpToolName } from "../../mcp/runPlan";
import { requireMemoryCommandSource } from "../../memory/commands/sourceAuthority";
import { memorySha256 } from "../../memory/persistence/lexical";
import { withLockedMemoryTransaction } from "../../memory/persistence/transaction";
import { prisma } from "../../prisma";
import type { SubagentBinding } from "../../subagents/ports";
import { getWorkspaceConfig } from "../../workspace/config";
import { createPrismaWorkspaceExecutionRegistry, workspaceSyncCleanupId } from "../../workspace/executionRegistry";
import { namespacedWorkspaceToolName } from "../../workspace/toolCatalog";
import { createPrismaMcpDiscoveryOperations } from "../prismaRepositoryMcpDiscovery";
import type { RunUsageAttribution } from "../runRepositoryContract";
import { createPrismaSubagentBackgroundStore } from "./store";

/**
 * The row-lock order of the transactions that met in production deadlocks, on a disposable database: a background
 * sub-agent's admission against a Workspace registration of its parent run, a sub-agent's settlement against its
 * usage totals, Memory's source check against usage totals, a chat title's usage against its answer's totals, and MCP
 * discovery of a main-agent run against its background sub-agent's (a design reviewers deadlocked before it shipped). Each
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
/** Installation MCP servers a test created, removed after their users. */
const mcpServers: string[] = [];

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

type ServerKey = "tracker" | "wiki";

/**
 * Two installation MCP servers `userId` may use, each with the ready runtime generation its preference desires, as an
 * epoch's guarded insert reads them (`insertAcceptedMcpRunBindings`): what one server adds to a snapshot and binds.
 */
async function readyServers(userId: string): Promise<Record<ServerKey, Awaited<ReturnType<typeof readyServer>>>> {
  return { tracker: await readyServer(userId, "tracker"), wiki: await readyServer(userId, "wiki") };
}

async function readyServer(userId: string, key: ServerKey) {
  const suffix = randomUUID().replaceAll("-", "");
  const server = await prisma.mcpServer.create({ data: { description: `Synthetic ${key}`, displayName: `Synthetic ${key}`, enabled: true,
    namespace: `lock_${key}_${suffix.slice(0, 12)}` } });
  mcpServers.push(server.id);
  const revision = await prisma.mcpRevision.create({ data: { configuration: {}, draftHash: `draft-${suffix}`, identityHash: `identity-${suffix}`,
    revisionNumber: 1, serverId: server.id, validationEvidence: {} } });
  await prisma.mcpServer.update({ data: { activeRevisionId: revision.id }, where: { id: server.id } });
  await prisma.mcpGrant.create({ data: { canUse: true, serverId: server.id, userId } });
  const preference = await prisma.mcpUserServer.create({ data: { enabled: true, serverId: server.id, userId } });
  const generation = await prisma.mcpRuntimeGeneration.create({ data: { fingerprint: suffix.repeat(2), inventory: { tools: [{
    definitionHash: "a".repeat(64), description: "Read", inputSchema: { type: "object" }, name: "read" }], version: 1 },
  inventoryUpdatedAt: new Date(), revisionId: revision.id, state: "ready", userServerId: preference.id } });
  await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
  const namespacedName = namespacedMcpToolName(server.namespace, "read");
  return {
    binding: { fingerprint: generation.fingerprint, runtimeGenerationId: generation.id, serverId: server.id },
    catalog: { description: server.description, namespace: server.namespace, revisionId: revision.id, serverId: server.id,
      serverName: server.displayName, tools: [{ description: "Read", namespacedName, originalName: "read" }] },
    server: { fingerprint: generation.fingerprint, revisionId: revision.id, serverId: server.id, serverName: server.displayName },
    tool: { definitionHash: "a".repeat(64), description: "Read", inputSchema: { type: "object" }, name: "read", namespacedName,
      originalName: "read", serverId: server.id, serverName: server.displayName }
  };
}

/**
 * A chat whose main-agent run offers both servers under Auto and has admitted a background sub-agent, which copied that
 * request, with `find_tools` call rows of any agent and the epochs they append through a client a test observes.
 */
async function discoveringAgents() {
  const f = await chatWithMainRun({ workspace: false });
  const servers = await readyServers(f.userId);
  await prisma.modelRun.update({ data: { normalizedRequest: { mcpDiscovery: { catalog: { servers: [servers.tracker.catalog, servers.wiki.catalog],
    version: 1 }, epochs: [], version: 2 } } }, where: { id: f.mainRunId } });
  const admitted = await createPrismaSubagentBackgroundStore(prisma).admit(f.admission());
  if (admitted.kind !== "admitted") throw new Error("subagent_fixture_not_admitted");
  const { threadId } = await prisma.subagentTurn.findUniqueOrThrow({ select: { threadId: true }, where: { id: admitted.turnId } });
  const backgroundAgent = { threadId, turnId: admitted.turnId };
  let ordinal = 10;
  /** A `find_tools` call row on `runId` of the sub-agent `agent` names; absent, the main agent's. */
  const findTools = async (runId: string, agent?: Readonly<{ threadId: string; turnId: string }>) => {
    ordinal += 1;
    return (await prisma.modelRunToolCall.create({ data: { arguments: { query: "records" }, modelRunId: runId, ordinal,
      providerCallId: `find-${ordinal}`, roundIndex: 1, startedAt: new Date(), state: "running", toolName: "find_tools",
      ...(agent ? { subagentThreadId: agent.threadId, subagentTurnId: agent.turnId } : {}) } })).id;
  };
  /** A foreground child of the background sub-agent: its turn runs in the sub-agent's own run. */
  const foregroundChild = async (name: string) => {
    ordinal += 1;
    const call = await prisma.modelRunToolCall.create({ data: { arguments: { message: "Brief", name }, modelRunId: admitted.runId, ordinal,
      providerCallId: `agent-${ordinal}`, roundIndex: 1, state: "running", subagentThreadId: threadId, subagentTurnId: admitted.turnId,
      toolName: "call_subagent" } });
    const thread = await prisma.subagentThread.create({ data: { anchorRunId: f.mainRunId, chatId: f.chatId, name, parentThreadId: threadId,
      userId: f.userId } });
    const turn = await prisma.subagentTurn.create({ data: { chatId: f.chatId, mode: "foreground", modelId: "fake-qsa", parentRunId: admitted.runId,
      parentToolCallId: call.id, provider: "fake", threadId: thread.id, userId: f.userId } });
    return { threadId: thread.id, turnId: turn.id };
  };
  /** The epoch of the `find_tools` call `callId` on `runId`, loading `keys`, as that agent's registry asks for it. */
  const append = (client: PrismaClient, runId: string, callId: string, keys: readonly ServerKey[]) =>
    createPrismaMcpDiscoveryOperations(client).appendMcpDiscoveryEpoch({ bindings: keys.map((key) => servers[key].binding), goal: "records",
      modelRunToolCallId: callId, roundIndex: 1, runId, snapshot: { servers: keys.map((key) => servers[key].server),
        tools: keys.map((key) => servers[key].tool), version: 1 }, toolIds: keys.map((key) => servers[key].tool.namespacedName), userId: f.userId });
  const byFingerprint = (left: Readonly<{ runtimeGenerationFingerprint: string }>, right: Readonly<{ runtimeGenerationFingerprint: string }>) =>
    left.runtimeGenerationFingerprint < right.runtimeGenerationFingerprint ? -1 : 1;
  /** A run's binding rows, by fingerprint. */
  const rows = async (runId: string) => (await prisma.mcpRunBinding.findMany({ select: { runtimeGenerationFingerprint: true,
    runtimeGenerationId: true }, where: { modelRunId: runId } })).sort(byFingerprint);
  /** The rows of `keys`' servers, as `rows` lists them. */
  const bound = (...keys: ServerKey[]) => keys.map((key) => ({ runtimeGenerationFingerprint: servers[key].binding.fingerprint,
    runtimeGenerationId: servers[key].binding.runtimeGenerationId })).sort(byFingerprint);
  return { ...f, append, backgroundAgent, backgroundRunId: admitted.runId, bound, findTools, foregroundChild, rows, servers };
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
    // The user's MCP preferences and their runtime generations go with it; the servers and revisions are the installation's.
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  for (const serverId of mcpServers.splice(0)) {
    await prisma.mcpServer.update({ data: { activeRevisionId: null }, where: { id: serverId } });
    await prisma.mcpUserServer.deleteMany({ where: { serverId } });
    await prisma.mcpGrant.deleteMany({ where: { serverId } });
    await prisma.mcpRevision.deleteMany({ where: { serverId } });
    await prisma.mcpServer.delete({ where: { id: serverId } });
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

/**
 * MCP discovery of a main-agent run and its background sub-agents (2026-11-20). An epoch locks and writes only the run
 * whose agent called `find_tools` (`prismaRepositoryMcpDiscovery.ts`): a background sub-agent's run binds on itself.
 * Binding on the main-agent run instead deadlocked with the main agent's own discovery of the same server and with an
 * image the main agent published. Each test holds one epoch's transaction after it wrote its rows, just before it records
 * the epoch, and runs the other discovery into it.
 */
describe("MCP discovery of a main-agent run and its background sub-agent", () => {
  type Discovery = Readonly<{ holder: "background" | "main"; keys: Readonly<Record<"background" | "main", readonly ServerKey[]>> }>;
  const cases: Array<[string, Discovery]> = [
    ["the same server, the main agent's held", { holder: "main", keys: { background: ["tracker"], main: ["tracker"] } }],
    ["the same server, the sub-agent's held", { holder: "background", keys: { background: ["tracker"], main: ["tracker"] } }],
    ["two servers in either order, the main agent's held", { holder: "main", keys: { background: ["wiki", "tracker"], main: ["tracker", "wiki"] } }],
    ["two servers in either order, the sub-agent's held", { holder: "background", keys: { background: ["wiki", "tracker"], main: ["tracker", "wiki"] } }],
    ["one server each, the main agent's held", { holder: "main", keys: { background: ["wiki"], main: ["tracker"] } }]
  ];

  it.each(cases)("never makes one wait for the other: %s", async (_name, discovery) => {
    const f = await discoveringAgents();
    const runs = { background: f.backgroundRunId, main: f.mainRunId };
    const calls = { background: await f.findTools(f.backgroundRunId, f.backgroundAgent), main: await f.findTools(f.mainRunId) };
    const other = discovery.holder === "main" ? "background" : "main";
    const holderPid = barrier<number>();
    const written = barrier();
    const resume = barrier();
    const failures: unknown[] = [];
    // Paused once its rows are written and before it records its epoch: it holds its run and its rows' index entries.
    const holderClient = observed(holderPid.release, { failed: (error) => failures.push(error),
      pause: { method: "update", model: "modelRun", reached: () => written.release(), resume: resume.wait } });
    const otherPid = barrier<number>();
    let holding: Promise<unknown> | undefined;
    let running: Promise<unknown> | undefined;
    try {
      holding = f.append(holderClient, runs[discovery.holder], calls[discovery.holder], discovery.keys[discovery.holder])
        .catch((error: unknown) => ({ error }));
      await Promise.race([written.wait, holding.then((value) => { throw new Error("holder_ended_before_its_epoch", { cause: value }); })]);
      const settled: unknown[] = [];
      running = f.append(observed(otherPid.release, { failed: (error) => failures.push(error) }), runs[other], calls[other],
        discovery.keys[other]).then((value) => { settled.push(value); }, (error: unknown) => { settled.push({ error }); });
      const [holder, waiter] = [await holderPid.wait, await otherPid.wait];
      while (settled.length === 0 && !(await blockedBy(waiter, holder))) await delay(20);
      // It finished while the other held its run and rows: nothing of the one is the other's.
      expect(settled).toEqual([expect.objectContaining({ discovery: expect.objectContaining({ epochs: [expect.objectContaining({
        epoch: 1, modelRunToolCallId: calls[other] })] }) })]);
      resume.release();
      expect(await holding).toMatchObject({ discovery: { epochs: [{ epoch: 1, modelRunToolCallId: calls[discovery.holder] }] } });
      expect(failures).toEqual([]);
      // Each run binds what its own agent loaded, once, and the sub-agent's rows are its run's, where its registry reads them.
      expect(await f.rows(f.mainRunId)).toEqual(f.bound(...discovery.keys.main));
      expect(await f.rows(f.backgroundRunId)).toEqual(f.bound(...discovery.keys.background));
    } finally {
      resume.release();
      await Promise.allSettled([holding, running]);
    }
  }, 60_000);

  it("binds a sub-agent's load while an image the main agent publishes holds the main-agent run", async () => {
    const f = await discoveringAgents();
    const call = await f.findTools(f.backgroundRunId, f.backgroundAgent);
    const publisherPid = barrier<number>();
    const held = barrier();
    const resume = barrier();
    // As `lib/server/images/service.ts` publishes: the run `FOR UPDATE`, then the chat, which a sub-agent's settlement may hold.
    const publishing = observed(publisherPid.release).$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${f.mainRunId} FOR UPDATE`;
      held.release();
      await resume.wait;
    });
    try {
      await held.wait;
      const discoveryPid = barrier<number>();
      const settled: unknown[] = [];
      const discovering = f.append(observed(discoveryPid.release), f.backgroundRunId, call, ["tracker"])
        .then((value) => { settled.push(value); }, (error: unknown) => { settled.push({ error }); });
      const [holder, waiter] = [await publisherPid.wait, await discoveryPid.wait];
      while (settled.length === 0 && !(await blockedBy(waiter, holder))) await delay(20);
      expect(settled).toEqual([expect.objectContaining({ discovery: expect.anything() })]);
      expect(await f.rows(f.backgroundRunId)).toEqual(f.bound("tracker"));
      resume.release();
      await discovering;
    } finally {
      resume.release();
      await publishing.catch(() => undefined);
    }
  }, 60_000);

  it("loads the tools of two foreground children of the background sub-agent that discover at once, each epoch on the last", async () => {
    const f = await discoveringAgents();
    const [one, two] = [await f.foregroundChild("one"), await f.foregroundChild("two")];
    const calls = [await f.findTools(f.backgroundRunId, one), await f.findTools(f.backgroundRunId, two)];
    const firstPid = barrier<number>();
    const written = barrier();
    const resume = barrier();
    const failures: unknown[] = [];
    const firstClient = observed(firstPid.release, { failed: (error) => failures.push(error),
      pause: { method: "update", model: "modelRun", reached: () => written.release(), resume: resume.wait } });
    const secondPid = barrier<number>();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      first = f.append(firstClient, f.backgroundRunId, calls[0]!, ["tracker"]).catch((error: unknown) => ({ error }));
      await Promise.race([written.wait, first.then((value) => { throw new Error("first_ended_before_its_epoch", { cause: value }); })]);
      second = f.append(observed(secondPid.release, { failed: (error) => failures.push(error) }), f.backgroundRunId, calls[1]!,
        ["tracker", "wiki"]).catch((error: unknown) => ({ error }));
      const waiter = await secondPid.wait;
      // The second waits for the run's lock, before it reads anything the first is still writing...
      await waitForBlock(waiter, await firstPid.wait);
      expect(await statementOf(waiter)).toContain("FOR NO KEY UPDATE OF run");
      resume.release();
      // ...then plans on the first's epoch and row: it binds only what the first did not, and both have their tools.
      expect(await first).toMatchObject({ discovery: { epochs: [{ epoch: 1, modelRunToolCallId: calls[0] }] } });
      expect(await second).toMatchObject({ discovery: { epochs: [{ epoch: 1 }, { epoch: 2, modelRunToolCallId: calls[1],
        toolIds: [f.servers.tracker.tool.namespacedName, f.servers.wiki.tool.namespacedName] }] },
      snapshot: { servers: expect.arrayContaining([expect.objectContaining({ serverId: f.servers.wiki.binding.serverId })]) } });
      expect(failures).toEqual([]);
      expect(await f.rows(f.backgroundRunId)).toEqual(f.bound("tracker", "wiki"));
      expect(await f.rows(f.mainRunId)).toEqual([]);
    } finally {
      resume.release();
      await Promise.allSettled([first, second]);
    }
  }, 60_000);
});
