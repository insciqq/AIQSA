import { Prisma, type PrismaClient, type WorkspaceSession } from "@prisma/client";
import { WORKSPACE_SUBAGENTS_RUNNING_CODE } from "@/lib/contracts/subagents";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { WORKSPACE_AGENT_PROTOCOL, type WorkspaceAgent } from "../subagents/guestProtocol";
import {
  WORKSPACE_OPERATIONS_BLOCKED_BY_SUBAGENTS,
  type SubagentChatScope,
  type WorkspaceAttachment,
  type WorkspaceAttachments,
  type WorkspaceAttachResult,
  type WorkspaceDetachInput,
  type WorkspaceDetachResult,
  type WorkspaceExclusiveOperation,
  type WorkspaceExclusiveResult
} from "../subagents/ports";
import {
  UNREGISTERED_WORKSPACE_COMMAND_FILTER,
  WORKSPACE_EXECUTION_OPEN_STATES,
  WORKSPACE_EXECUTION_STOP_PROOF
} from "./executionRegistry";
import { WORKSPACE_OPERATION_LEASE_MS, lockWorkspaceSession, workspaceRunOperationOwner } from "./sessionOperation";

/**
 * One Workspace session per chat serves every attached run of its main agent and background sub-agents at once
 * (queue decision 5, 2026-10-29). The session's `operationOwner` and `version` stay the runner's fence token: the
 * first run claims it (`run:<id>`, one generation higher), later runs join that same operation, so their exec calls
 * reach the guest side by side and no claim drains the VM under another run. A `WorkspaceRunAttachment` row is one
 * run's guest authority under that generation. Exclusive owners (export, maintenance, reset, continuation,
 * carryover, idle stop, deletion) never coexist with attached runs: a run waits for them, they wait for the runs.
 */

const RUN_OWNER_PREFIX = "run:";
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "in_progress", "streaming"] as const;
/** How long a background attach waits for an exclusive operation (an export, a maintenance stop) to end. */
export const WORKSPACE_ATTACH_WAIT_MS = 120_000;
const WORKSPACE_ATTACH_RETRY_MS = 1_000;
export const WORKSPACE_BUSY_CODE = "workspace_busy";
export const WORKSPACE_UNAVAILABLE_CODE = "workspace_unavailable";

type SessionFence = Pick<WorkspaceSession, "chatId" | "operationOwner" | "version">;

export type WorkspaceAttachedRun = Readonly<{
  active: boolean;
  modelRunId: string;
  /** Null for the main agent's run. */
  subagentThreadId: string | null;
}>;

export function isWorkspaceRunOperation(owner: string | null | undefined): owner is string {
  return typeof owner === "string" && owner.startsWith(RUN_OWNER_PREFIX);
}

function isActive(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The runs attached under the session's current run operation, oldest first. A session that a previous release
 * claimed (an owner `run:<id>` and no row yet, as during the upgrade) has that one run attached.
 */
export async function currentWorkspaceAttachments(
  tx: Prisma.TransactionClient | PrismaClient, session: SessionFence
): Promise<readonly WorkspaceAttachedRun[]> {
  if (!isWorkspaceRunOperation(session.operationOwner)) return [];
  const rows = await tx.workspaceRunAttachment.findMany({
    orderBy: [{ attachedAt: "asc" }, { modelRunId: "asc" }],
    select: { modelRunId: true, modelRun: { select: { status: true, subagentThreadId: true } } },
    where: { chatId: session.chatId, operationGeneration: session.version }
  });
  if (rows.length > 0) {
    return rows.map((row) => ({ active: isActive(row.modelRun.status), modelRunId: row.modelRunId,
      subagentThreadId: row.modelRun.subagentThreadId }));
  }
  const legacy = await tx.modelRun.findFirst({
    select: { id: true, status: true, subagentThreadId: true },
    where: { chatId: session.chatId, id: session.operationOwner.slice(RUN_OWNER_PREFIX.length) }
  });
  return legacy ? [{ active: isActive(legacy.status), modelRunId: legacy.id, subagentThreadId: legacy.subagentThreadId }] : [];
}

/** Whether the run holds guest authority under the session's current run operation. */
export async function workspaceRunHoldsOperation(
  tx: Prisma.TransactionClient | PrismaClient, session: SessionFence, runId: string
): Promise<boolean> {
  return (await currentWorkspaceAttachments(tx, session)).some((run) => run.modelRunId === runId);
}

/** The run's attachment at the session's current generation; idempotent. Caller holds the session row lock. */
export async function recordWorkspaceAttachment(
  tx: Prisma.TransactionClient, input: Readonly<{ chatId: string; generation: number; runId: string }>
): Promise<void> {
  await tx.workspaceRunAttachment.upsert({
    create: { chatId: input.chatId, modelRunId: input.runId, operationGeneration: input.generation },
    update: { operationGeneration: input.generation },
    where: { modelRunId: input.runId }
  });
}

/**
 * Joins the session's live run operation (another active run of the chat holds it) without a new generation, so the
 * runner keeps serving every attached run. False when the session's operation is not a live run operation.
 * Caller holds the Chat -> WorkspaceSession locks.
 */
export async function joinWorkspaceRunOperation(
  tx: Prisma.TransactionClient, session: SessionFence & Pick<WorkspaceSession, "operationExpiresAt" | "state">, runId: string
): Promise<boolean> {
  // A run operation with an expiry is closing (`closeWorkspaceRunOperation`): its VM is about to stop.
  if (!isWorkspaceRunOperation(session.operationOwner) || session.operationExpiresAt !== null ||
    session.state === "DELETING" || session.state === "FAILED") return false;
  const attached = await currentWorkspaceAttachments(tx, session);
  if (!attached.some((run) => run.active)) return false;
  // A previous release's owner becomes an attachment first, so it keeps its authority beside the new run.
  for (const run of attached) {
    await recordWorkspaceAttachment(tx, { chatId: session.chatId, generation: session.version, runId: run.modelRunId });
  }
  await recordWorkspaceAttachment(tx, { chatId: session.chatId, generation: session.version, runId });
  return true;
}

/**
 * The last run of a run operation is about to stop the VM: from now on no run joins it, so none is attached to a
 * VM that stops under it. The expiry marks the closing operation, and lets maintenance take a crashed one over.
 * Without `force`, false when another active run is attached meanwhile: the caller then leaves the operation to
 * it. Caller holds no lock; this takes Chat -> WorkspaceSession.
 */
export async function closeWorkspaceRunOperation(
  tx: Prisma.TransactionClient,
  input: Readonly<{ force: boolean; generation: number; owner: string; runId: string; sessionId: string }>
): Promise<boolean> {
  const session = await lockWorkspaceSession(tx, input.sessionId);
  if (!session || session.operationOwner !== input.owner || session.version !== input.generation) return false;
  if (!input.force && (await currentWorkspaceAttachments(tx, session)).some((run) => run.active && run.modelRunId !== input.runId)) {
    return false;
  }
  if (session.operationExpiresAt === null) {
    await tx.workspaceSession.update({ data: { operationExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS) },
      where: { id: session.id } });
  }
  return true;
}

/**
 * Before a run's unknown execution stops the shared VM: in one step the operation closes to joins and every other
 * run loses its attachment (so its next call is refused, none dispatches under the stop). Returns those runs, the
 * complete set the stop ends. Empty when the run no longer holds the operation. Takes Chat -> WorkspaceSession.
 */
export async function evictOtherWorkspaceAttachments(
  tx: Prisma.TransactionClient,
  input: Readonly<{ generation: number; owner: string; runId: string; sessionId: string }>
): Promise<readonly string[]> {
  const session = await lockWorkspaceSession(tx, input.sessionId);
  if (!session || session.operationOwner !== input.owner || session.version !== input.generation ||
    !(await workspaceRunHoldsOperation(tx, session, input.runId))) return [];
  await closeWorkspaceRunOperation(tx, { ...input, force: true });
  const others = (await currentWorkspaceAttachments(tx, session)).filter((run) => run.modelRunId !== input.runId);
  await recordWorkspaceAttachment(tx, { chatId: session.chatId, generation: session.version, runId: input.runId });
  await tx.workspaceRunAttachment.deleteMany({ where: { chatId: session.chatId, modelRunId: { not: input.runId } } });
  return others.map((run) => run.modelRunId);
}

/**
 * Nothing of an earlier operation may still run or stream outputs before a new run operation starts: the same
 * checks run admission holds (open executions, unregistered commands, a live export lease).
 */
export async function workspaceSessionHasOpenWork(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  const openExecutions = await tx.workspaceExecution.count({
    where: { workspaceSessionId: sessionId, state: { in: [...WORKSPACE_EXECUTION_OPEN_STATES] } }
  });
  if (openExecutions > 0) return true;
  const unregisteredCommands = await tx.modelRunToolCall.count({ where: {
    ...UNREGISTERED_WORKSPACE_COMMAND_FILTER,
    workspaceRunBinding: { workspaceSessionId: sessionId }
  } });
  if (unregisteredCommands > 0) return true;
  const liveExports = await tx.workspaceRunBinding.count({
    where: { exportLeaseExpiresAt: { gt: new Date() }, exportState: "EXPORTING", workspaceSessionId: sessionId }
  });
  return liveExports > 0;
}

/** A new run operation for this run on an idle session (no owner): one generation higher, the run attached. */
async function claimWorkspaceRunOperation(
  tx: Prisma.TransactionClient, session: WorkspaceSession, runId: string
): Promise<boolean> {
  if (session.operationOwner !== null || ["FAILED", "RUNNING", "CREATING", "DELETING"].includes(session.state) ||
    await workspaceSessionHasOpenWork(tx, session.id)) return false;
  const claimed = await tx.workspaceSession.updateMany({
    data: { operationExpiresAt: null, operationOwner: workspaceRunOperationOwner(runId), version: { increment: 1 } },
    where: { id: session.id, operationOwner: null, version: session.version }
  });
  if (claimed.count !== 1) return false;
  await recordWorkspaceAttachment(tx, { chatId: session.chatId, generation: session.version + 1, runId });
  return true;
}

/**
 * After the runner proved the run's processes stopped (`terminateAgentProcesses`): its registered executions and
 * the accepted commands it never registered are settled with that proof, the sync cleanup obligations included.
 * Only this run's rows; the other attached runs keep theirs.
 */
export async function acknowledgeWorkspaceRunCommandsStopped(
  tx: Prisma.TransactionClient, input: Readonly<{ runId: string; sessionId: string }>
): Promise<void> {
  await tx.workspaceExecution.updateMany({
    data: { completedAt: new Date(), lastErrorCode: WORKSPACE_EXECUTION_STOP_PROOF, state: "LOST" },
    where: { modelRunId: input.runId, state: { in: [...WORKSPACE_EXECUTION_OPEN_STATES] }, workspaceSessionId: input.sessionId }
  });
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "WorkspaceExecution" (
      "id", "workspaceSessionId", "modelRunId", "modelRunToolCallId", "runtimeExecSessionId",
      "state", "startedAt", "completedAt", "lastErrorCode", "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid()::text, binding."workspaceSessionId", tc."modelRunId", tc."id",
      'workspace-sync:' || encode(sha256(convert_to(tc."id", 'UTF8')), 'hex'),
      'LOST'::"WorkspaceExecutionState", now(), now(), ${WORKSPACE_EXECUTION_STOP_PROOF}, now(), now()
    FROM "ModelRunToolCall" tc
    JOIN "WorkspaceRunBinding" binding ON binding."modelRunId" = tc."workspaceRunBindingId"
    WHERE binding."workspaceSessionId" = ${input.sessionId}
      AND tc."modelRunId" = ${input.runId}
      AND tc."toolName" IN (${Prisma.join(UNREGISTERED_WORKSPACE_COMMAND_FILTER.toolName.in)})
      AND (tc."state" != 'error' OR tc."startedAt" IS NOT NULL OR tc."completedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "WorkspaceExecution" e WHERE e."modelRunToolCallId" = tc."id")
    ON CONFLICT ("modelRunToolCallId") DO NOTHING
  `);
}

/** Whether a background sub-agent run is attached to the chat's Workspace (Reset and continuation wait for it). */
export async function workspaceSubagentRunsAttached(
  tx: Prisma.TransactionClient | PrismaClient, chatId: string
): Promise<boolean> {
  const session = await tx.workspaceSession.findUnique({ select: { chatId: true, operationOwner: true, version: true }, where: { chatId } });
  if (!session) return false;
  return (await currentWorkspaceAttachments(tx, session)).some((run) => run.active && run.subagentThreadId !== null);
}

/**
 * The chat's runs that hold or may take its Workspace: every active main-agent run, and the active sub-agent runs
 * attached to it. A background sub-agent run that never attached (no Workspace work) does not keep the Workspace
 * from its idle stop, its maintenance or its export recovery.
 */
export function workspaceActiveRunsWhere(chatId: string): Prisma.ModelRunWhereInput {
  return {
    chatId,
    status: { in: [...ACTIVE_RUN_STATUSES] },
    OR: [{ subagentTurnId: null }, { workspaceAttachment: { isNot: null } }]
  };
}

/** The same rule as SQL, for maintenance's set-based candidate queries (`ws` is the session alias). */
export function workspaceActiveRunExistsSql(session: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ModelRun" mr
    WHERE mr."chatId" = ${session}."chatId"
      AND mr."status" IN ('preparing'::"ModelRunStatus", 'queued'::"ModelRunStatus",
        'in_progress'::"ModelRunStatus", 'streaming'::"ModelRunStatus")
      AND (mr."subagentTurnId" IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceRunAttachment" wa WHERE wa."modelRunId" = mr."id"))
  )`;
}

/**
 * The agent ids whose guest processes belong to a run: a sub-agent run's thread; for a main-agent run `main` and the
 * threads its foreground sub-agent turns ran, except a thread another attached run now runs (its processes are
 * that run's to stop).
 */
export async function workspaceRunAgentIds(
  tx: Prisma.TransactionClient | PrismaClient, runId: string
): Promise<readonly string[]> {
  const run = await tx.modelRun.findUnique({ select: { chatId: true, subagentThreadId: true }, where: { id: runId } });
  if (!run) return [];
  if (run.subagentThreadId) return [run.subagentThreadId];
  const turns = await tx.subagentTurn.findMany({
    distinct: ["threadId"], select: { threadId: true }, where: { mode: "foreground", parentRunId: runId }
  });
  const threads = turns.map((turn) => turn.threadId);
  const elsewhere = threads.length === 0 ? [] : await tx.modelRun.findMany({
    select: { subagentThreadId: true },
    where: { chatId: run.chatId, id: { not: runId }, subagentThreadId: { in: threads }, workspaceAttachment: { isNot: null } }
  });
  const taken = new Set(elsewhere.map((entry) => entry.subagentThreadId));
  return [WORKSPACE_AGENT_PROTOCOL.MAIN_AGENT_ID, ...threads.filter((thread) => !taken.has(thread))];
}

/**
 * The Workspace binding of a background sub-agent run: its parent run's admitted bindings (image, network policy,
 * tool catalog, runtime and MCP versions, output directory, secret revisions), never current settings. The run has
 * no output obligations of its own, so its export is complete from the start; it gets its own browser sign-in
 * sequence, so a sign-in it makes is saved under today's rules. Called inside the background admission transaction.
 */
export async function bindSubagentRunWorkspace(
  tx: Prisma.TransactionClient,
  input: Readonly<{ browserSessionSequence: bigint | null; parentRunId: string; runId: string }>
): Promise<boolean> {
  const parent = await tx.workspaceRunBinding.findUnique({
    include: { secrets: { select: { secretId: true, valueId: true } } }, where: { modelRunId: input.parentRunId }
  });
  if (!parent) return false;
  await tx.workspaceRunBinding.create({ data: {
    browserSessionSequence: input.browserSessionSequence,
    exportCompletedAt: new Date(),
    exportState: "COMPLETE",
    guestUsedAt: null,
    imageRef: parent.imageRef,
    internetEnabled: parent.internetEnabled,
    mcpVersion: parent.mcpVersion,
    modelRunId: input.runId,
    // Its own folder, never the parent's: the main agent's export reads only its own output directory.
    outputDirectory: workspaceRunOutputDirectory(input.runId),
    policyRevision: parent.policyRevision,
    runtimeVersion: parent.runtimeVersion,
    toolCatalogHash: parent.toolCatalogHash,
    toolDefinitions: parent.toolDefinitions as Prisma.InputJsonValue,
    workspaceSessionId: parent.workspaceSessionId
  } });
  if (parent.secrets.length > 0) {
    await tx.workspaceRunSecret.createMany({ data: parent.secrets.map((secret) => ({ ...secret, modelRunId: input.runId })) });
  }
  return true;
}

// Exclusive lifecycle steps ------------------------------------------------------------------------------------------

const EXCLUSIVE = Symbol.for("aiqsa.workspace.exclusive.v1");

function exclusiveTails(): Map<string, Promise<void>> {
  const shared = globalThis as typeof globalThis & { [EXCLUSIVE]?: Map<string, Promise<void>> };
  return shared[EXCLUSIVE] ??= new Map();
}

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => { signal.removeEventListener("abort", abort); resolve(); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/**
 * One lifecycle step of a shared session at a time in this process (VM start and stop, export capture,
 * continuation restore, disk-loss handling), while exec calls of the attached runs go on. Other processes reach a
 * session only through exclusive database owners, which attached runs already exclude.
 */
export async function withWorkspaceSessionExclusive<T>(sessionId: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const tails = exclusiveTails();
  const previous = tails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(sessionId, tail);
  try {
    await abortable(previous, signal);
    return await work();
  } finally {
    release();
    // A waiter that gave up still waits behind its predecessor: its tail is registered until both resolved, so a
    // later caller never enters while the predecessor holds the step.
    void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
  }
}

// The port ------------------------------------------------------------------------------------------------------------

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function sameAgent(agent: WorkspaceAgent, run: Readonly<{ subagentThreadId: string | null; threadName: string | null }>): boolean {
  return agent.kind === "main"
    ? run.subagentThreadId === null
    : run.subagentThreadId === agent.threadId && run.threadName === agent.name;
}

async function attachOnce(tx: Prisma.TransactionClient, attachment: WorkspaceAttachment): Promise<WorkspaceAttachResult> {
  const refused = (code: string): WorkspaceAttachResult => ({ code, kind: "refused" });
  // Chat before session, the order run admission takes them.
  const [chat] = await tx.$queryRaw<Array<{ permanentDeletionAt: Date | null; userId: string | null }>>(Prisma.sql`
    SELECT "userId", "permanentDeletionAt" FROM "Chat" WHERE "id" = ${attachment.chatId} FOR UPDATE
  `);
  if (!chat || chat.userId !== attachment.userId || chat.permanentDeletionAt) return refused(WORKSPACE_UNAVAILABLE_CODE);
  const run = await tx.modelRun.findFirst({
    select: { status: true, subagentThreadId: true, subagentTurn: { select: { thread: { select: { name: true } } } },
      workspaceRunBinding: { select: { workspaceSessionId: true } } },
    where: { chatId: attachment.chatId, id: attachment.modelRunId, userId: attachment.userId }
  });
  if (!run?.workspaceRunBinding) return refused(WORKSPACE_UNAVAILABLE_CODE);
  if (!isActive(run.status)) return refused("workspace_run_ended");
  if (!sameAgent(attachment.agent, { subagentThreadId: run.subagentThreadId, threadName: run.subagentTurn?.thread.name ?? null })) {
    return refused(WORKSPACE_UNAVAILABLE_CODE);
  }
  await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "chatId" = ${attachment.chatId} FOR UPDATE`;
  const session = await tx.workspaceSession.findUnique({ where: { chatId: attachment.chatId } });
  if (!session || session.id !== run.workspaceRunBinding.workspaceSessionId || session.state === "DELETING") {
    return refused(WORKSPACE_UNAVAILABLE_CODE);
  }
  const attached = await currentWorkspaceAttachments(tx, session);
  const done = (count: number): WorkspaceAttachResult => ({ attachedRuns: count, kind: "attached", sessionId: session.id });
  if (attached.some((entry) => entry.modelRunId === attachment.modelRunId)) return done(attached.length);
  if (session.operationOwner === null) {
    return await claimWorkspaceRunOperation(tx, session, attachment.modelRunId) ? done(1) : refused(WORKSPACE_BUSY_CODE);
  }
  return await joinWorkspaceRunOperation(tx, session, attachment.modelRunId)
    ? done(Math.max(1, attached.length) + 1) : refused(WORKSPACE_BUSY_CODE);
}

/**
 * The `WorkspaceAttachments` port (`lib/server/subagents/ports.ts`). `retire` is the coordinator's per-run
 * retirement (`WorkspaceCoordinator.detach`): it stops only this run's processes with proof, or stops the VM and
 * names the runs that ended with it.
 */
export function createPrismaWorkspaceAttachments(input: Readonly<{
  prisma: PrismaClient;
  retire(input: WorkspaceDetachInput): Promise<WorkspaceDetachResult>;
  waitMs?: number;
}>): WorkspaceAttachments {
  const waitMs = input.waitMs ?? WORKSPACE_ATTACH_WAIT_MS;
  return {
    async attach(attachment, signal) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (signal?.aborted) return { code: "workspace_tool_cancelled", kind: "refused" };
        const result = await input.prisma.$transaction((tx) => attachOnce(tx, attachment));
        if (result.kind === "attached" || result.code !== WORKSPACE_BUSY_CODE || Date.now() >= deadline) return result;
        try {
          await delay(Math.min(WORKSPACE_ATTACH_RETRY_MS, Math.max(0, deadline - Date.now())), signal);
        } catch {
          return { code: "workspace_tool_cancelled", kind: "refused" };
        }
      }
    },
    detach: (detach) => input.retire(detach),
    async exclusive<T>(scope: SubagentChatScope & Readonly<{ operation: WorkspaceExclusiveOperation; signal?: AbortSignal }>,
      work: (lease: Readonly<{ sessionId: string }>) => Promise<T>): Promise<WorkspaceExclusiveResult<T>> {
      const session = await input.prisma.workspaceSession.findFirst({
        select: { id: true, state: true }, where: { chat: { permanentDeletionAt: null, userId: scope.userId }, chatId: scope.chatId }
      });
      if (!session || session.state === "DELETING") return { code: WORKSPACE_UNAVAILABLE_CODE, kind: "refused" };
      if (WORKSPACE_OPERATIONS_BLOCKED_BY_SUBAGENTS.includes(scope.operation) &&
        await workspaceSubagentRunsAttached(input.prisma, scope.chatId)) {
        return { code: WORKSPACE_SUBAGENTS_RUNNING_CODE, kind: "refused" };
      }
      try {
        return { kind: "done", value: await withWorkspaceSessionExclusive(session.id, scope.signal, () => work({ sessionId: session.id })) };
      } catch (error) {
        if (scope.signal?.aborted) return { code: "workspace_tool_cancelled", kind: "refused" };
        throw error;
      }
    },
    async attached(scope) {
      const session = await input.prisma.workspaceSession.findFirst({
        select: { chatId: true, operationOwner: true, version: true }, where: { chat: { userId: scope.userId }, chatId: scope.chatId }
      });
      if (!session) return [];
      const runs = await currentWorkspaceAttachments(input.prisma, session);
      const threads = await input.prisma.subagentThread.findMany({
        select: { id: true, name: true },
        where: { chatId: scope.chatId, id: { in: runs.flatMap((run) => run.subagentThreadId ? [run.subagentThreadId] : []) } }
      });
      const names = new Map(threads.map((thread) => [thread.id, thread.name]));
      return runs.flatMap((run): WorkspaceAttachment[] => {
        if (!run.subagentThreadId) return [{ agent: { kind: "main" }, chatId: scope.chatId, modelRunId: run.modelRunId, userId: scope.userId }];
        const name = names.get(run.subagentThreadId);
        return name ? [{ agent: { kind: "subagent", name, threadId: run.subagentThreadId }, chatId: scope.chatId,
          modelRunId: run.modelRunId, userId: scope.userId }] : [];
      });
    }
  };
}
