import { Prisma, type ModelRunStatus, type PrismaClient, type SubagentTurnState } from "@prisma/client";
import { RUN_INTERRUPTED_FAILURE } from "../../../contracts/runs";
import {
  SUBAGENT_END_REASONS,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_FOLLOWUP_LIMITS,
  SUBAGENT_LIMITS,
  decodeSubagentCallResult,
  isActiveSubagentState,
  subagentCallbackNonce,
  type EndedSubagentCallResult,
  type EndedSubagentState,
  type SubagentErrorCode,
  type SubagentThreadState,
  type SubagentTurnMode
} from "../../../contracts/subagents";
import type { SubagentBinding, SubagentChatScope } from "../../subagents/ports";
import { branchPathMessageIds } from "../../toolObservations/repository";
import { activeModelRunStatuses, dispatchableModelRunStatuses, json, lockRunSettlementScope, mapActiveRunConflict } from "../prismaRepositoryShared";
import { cancelPendingToolLoopCallsInTransaction, closeRunningToolLoopCallsInTransaction, recoveredRunErrorPayload } from "../prismaRepositoryToolLoop";
import { ActiveRunConflictError } from "../runRepositoryContract";
import { followupTokenCost } from "../runFollowups";
import { renderCallbackFollowup, SUBAGENT_CALLBACK_DEFAULT_RESERVE_TOKENS, SUBAGENT_CALLBACK_MIN_TOKENS } from "./render";

/**
 * The chat's sub-agent admission lock, shared with the engine's foreground
 * admission (`lockChatSubagentAdmission` in the engine's thread store, same
 * key), so the running cap counts both modes atomically. A transaction lock:
 * it ends with the admission. Kept here until the two merge.
 */
export async function lockChatSubagentAdmission(tx: Prisma.TransactionClient, chatId: string): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`aiqsa:subagent-admission:${chatId}`}, 0))::text AS "lock"
  `);
}

/**
 * Persistence of background sub-agent runs (`SubagentTurn` with mode
 * `background` and its own `ModelRun`), their mailboxes and callbacks. Every
 * transaction takes the owner, chat, run lock order of run settlement
 * (`lockRunSettlementScope`), so settlements and deliveries of one chat
 * serialize on the chat row. Admission first takes the chat's sub-agent
 * admission lock the engine's foreground admission takes too
 * (`aiqsa:subagent-admission:<chatId>`), so the 20-running cap is exact across
 * both modes.
 *
 * Bindings (integrator decision 2026-10-30): a background run shares its
 * parent's user message and never answers one. At admission it copies its
 * parent's whole `normalizedRequest` into its own row, because the Workspace
 * code-to-MCP grant, the Workspace coordinator and every whole-request decoder
 * read the request by run id. Its provider, MCP and Skill binding rows stay
 * by reference: the runner reads them from `SubagentTurn.parentRunId` (an
 * interactive MCP write reaches the guard through the parent's
 * `McpRunBinding` rows), and they outlive it, because deleting the parent
 * deletes the turn and its run and the deleting paths stop the run first.
 */

const ACTIVE_TURN_STATES: SubagentTurnState[] = ["running", "waiting"];

/** One turn as the control and the callbacks use it. */
export type SubagentTurnRecord = Readonly<{
  chatId: string;
  mode: SubagentTurnMode;
  /** The model and effort the turn runs with. */
  model: Readonly<{ effort: string | null; id: string }>;
  name: string;
  parentRunId: string;
  /** The parent run's answer, which places the turn on a branch. */
  parentAnswerId: string | null;
  /** The ended turn's stored result, or the one its state implies when it has none. */
  result: EndedSubagentCallResult | null;
  /** The background turn's own run; null for a foreground turn. */
  runId: string | null;
  state: SubagentThreadState;
  threadId: string;
  turnId: string;
  userId: string;
}>;

export type SubagentAdmission =
  | Readonly<{ kind: "admitted"; runId: string; turnId: string }>
  | Readonly<{ code: SubagentErrorCode; kind: "refused" }>;

export type SubagentAdmissionInput = SubagentChatScope & Readonly<{
  binding: SubagentBinding;
  definitionRevisionId: string | null;
  parentRunId: string;
  parentToolCallId: string;
  /**
   * The ids the turn and its run take, chosen before admission so the
   * process registers the turn's execution, and a Stop can find it, before
   * the admission is visible (`control.ts`).
   */
  runId: string;
  threadId: string;
  turnId: string;
}>;

export type SubagentSettlement = Readonly<{ result: EndedSubagentCallResult | null; settled: boolean }>;

export type MailboxInsertOutcome = "closed" | "exists" | "full" | "inserted";

export type OwedSubagentCallback = Readonly<{ name: string; result: EndedSubagentCallResult; turnId: string }>;

export type OwedCallbacks = Readonly<{
  /** Owed callbacks of the chat's active branch, oldest end first. */
  activeBranch: readonly OwedSubagentCallback[];
  /** Owed callbacks of other branches: recorded there, waking nothing. */
  inactiveTurnIds: readonly string[];
  /** The chat's active main-agent run, if any. */
  mainRun: Readonly<{ id: string; status: ModelRunStatus }> | null;
}>;

export type CallbackIntoRunOutcome = "claimed" | "closed" | "delivered";

export type BackgroundOrphan = Readonly<{ chatId: string; runId: string; turnId: string; userId: string }>;

/** A chat with callbacks still owed and no main-agent run active: the turns that owe them. */
export type OwedCallbackChat = SubagentChatScope & Readonly<{ turnIds: readonly string[] }>;

export type SubagentBackgroundStore = Readonly<{
  /** Whether this main-agent run may start background turns: an active web or Assistant run, not scheduled, not Telegram. */
  callerAvailable(input: SubagentChatScope & Readonly<{ parentRunId: string }>): Promise<boolean>;
  admit(input: SubagentAdmissionInput): Promise<SubagentAdmission>;
  settle(input: SubagentChatScope & Readonly<{ result: EndedSubagentCallResult; turnId: string }>): Promise<SubagentSettlement>;
  findTurn(input: SubagentChatScope & Readonly<{ turnId: string }>): Promise<SubagentTurnRecord | null>;
  /** The latest turn on the caller's branch of the thread of that name visible there. */
  findThreadTurnOnBranch(input: SubagentChatScope & Readonly<{ name: string; parentRunId: string }>): Promise<SubagentTurnRecord | null>;
  /** Active turns of the chat: all, one thread's, or those of runs under a message's subtree. */
  activeTurns(input: SubagentChatScope & Readonly<{ threadId?: string; underMessageId?: string }>): Promise<readonly SubagentTurnRecord[]>;
  /** The main-agent runs that answer, or start from, a message of the subtree under this one: whose sub-agents its deletion stops. */
  runIdsUnderMessage(input: SubagentChatScope & Readonly<{ messageId: string }>): Promise<readonly string[]>;
  insertMailbox(input: SubagentChatScope & Readonly<{ nonce: string; runId: string; text: string }>): Promise<MailboxInsertOutcome>;
  markMailboxDelivered(input: SubagentChatScope & Readonly<{ nonce: string; runId: string }>): Promise<void>;
  owedCallbacks(input: SubagentChatScope): Promise<OwedCallbacks | null>;
  /** Renders the turn's stored result bounded to the run's remaining follow-up reserve, then claims and inserts it. */
  deliverIntoRun(input: SubagentChatScope & Readonly<{ runId: string; turnId: string }>): Promise<CallbackIntoRunOutcome>;
  /** The chat of a main-agent run, for its terminal flush; null for a background run or none. */
  mainRunScope(runId: string): Promise<SubagentChatScope | null>;
  findOrphans(input: Readonly<{ bootedBefore: Date; chatId?: string; limit: number; liveRunIds: readonly string[];
    staleBefore: Date; userId?: string }>): Promise<readonly BackgroundOrphan[]>;
  /**
   * Chats whose background turns ended at least `endedBefore` ago and still
   * owe their callbacks (none claimed, or one left unread in an answer that
   * ended) while no main-agent run of theirs is active: what recovery flushes.
   */
  findOwedCallbackChats(input: Readonly<{ chatId?: string; endedBefore: Date; limit: number; userId?: string }>):
    Promise<readonly OwedCallbackChat[]>;
  /** Foreground turns still active whose parent run ended (a restart cut both): they end interrupted. */
  interruptStrandedForegroundTurns(input: Readonly<{ chatId?: string; userId?: string }>): Promise<number>;
}>;

/** A wake-up's admission found a callback another delivery claimed first; the caller retries with what is still owed. */
export class SubagentCallbackClaimConflictError extends Error {
  constructor() {
    super("subagent_callback_claimed");
    this.name = "SubagentCallbackClaimConflictError";
  }
}

/**
 * Claims owed callbacks for a wake-up turn inside its admission transaction
 * (`createRun`, under its chat lock), after the run row exists: only turns
 * still unclaimed whose parent answer is on the receiving branch (the wake-up
 * message's own path) are taken, and the admission is refused unless it takes
 * every one it renders. A branch switch since the callbacks were read is
 * refused here and read again.
 */
export async function claimSubagentCallbacksForRun(tx: Prisma.TransactionClient,
  input: Readonly<{ chatId: string; runId: string; turnIds: readonly string[]; userMessageId: string }>): Promise<void> {
  const turnIds = [...new Set(input.turnIds)];
  if (turnIds.length === 0) throw new SubagentCallbackClaimConflictError();
  const path = await branchPathMessageIds(tx, input.chatId, input.userMessageId);
  const parents = await tx.subagentTurn.findMany({ select: { parentRun: { select: { assistantMessageId: true } } },
    where: { chatId: input.chatId, id: { in: turnIds } } });
  if (parents.length !== turnIds.length ||
    parents.some((turn) => !turn.parentRun.assistantMessageId || !path.has(turn.parentRun.assistantMessageId))) {
    throw new SubagentCallbackClaimConflictError();
  }
  const claimed = await tx.$executeRaw(Prisma.sql`
    UPDATE "SubagentTurn" SET "callbackRunId" = ${input.runId}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "chatId" = ${input.chatId} AND "id" IN (${Prisma.join(turnIds)}) AND "callbackRunId" IS NULL
      AND "mode" = 'background' AND "endedAt" IS NOT NULL
  `);
  if (claimed !== turnIds.length) throw new SubagentCallbackClaimConflictError();
}

async function lockChatScope(tx: Prisma.TransactionClient, scope: SubagentChatScope) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${scope.userId} FOR UPDATE`;
  const [chat] = await tx.$queryRaw<Array<{ activeLeafMessageId: string | null; archived: boolean; permanentDeletionAt: Date | null }>>`
    SELECT "activeLeafMessageId", "archived", "permanentDeletionAt" FROM "Chat"
    WHERE "id" = ${scope.chatId} AND "userId" = ${scope.userId} FOR UPDATE`;
  return chat ?? null;
}

const END_STATE_RUN_STATUS: Record<EndedSubagentState, ModelRunStatus> = {
  done: "complete", failed: "error", interrupted: "error", stopped: "cancelled"
};

/** A stored result, or the one its row implies (an orphan, a stop before any report): never invented content. */
function resultOf(row: Readonly<{ modelId: string; name: string; outcome: string | null; reasonCode: string | null;
  reasoningEffort: string | null; result: unknown; state: SubagentThreadState }>): EndedSubagentCallResult | null {
  if (isActiveSubagentState(row.state)) return null;
  const decoded = decodeSubagentCallResult(row.result);
  if (decoded?.kind === "ended") return decoded;
  return impliedResult({ modelId: row.modelId, name: row.name, outcome: row.outcome, reason: row.reasonCode,
    reasoningEffort: row.reasoningEffort, state: row.state as EndedSubagentState });
}

/** What a turn that ended without a report returns: its state and reason, no steps or files. */
export function impliedResult(input: Readonly<{ modelId: string; name: string; outcome?: string | null; reason: string | null;
  reasoningEffort: string | null; state: EndedSubagentState }>): EndedSubagentCallResult {
  const outcome = input.state === "done" ? (input.outcome === "partial" || input.outcome === "blocked" ? input.outcome : "done") : undefined;
  const reason = input.reason ?? (input.state === "failed" ? "subagent_failed" : outcome === "blocked" ? "blocked" : null);
  return { approvals: [], files: [], kind: "ended", model: { effort: input.reasoningEffort, id: input.modelId }, name: input.name,
    ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}), report: "", state: input.state, steps: [] };
}

/**
 * The result a turn keeps: the runner's, decoded, under the thread's own name,
 * with a reason wherever its state needs one. A result that does not decode
 * keeps only its state.
 */
export function normalizedEndResult(result: EndedSubagentCallResult, turn: Readonly<{ modelId: string; name: string;
  reasoningEffort: string | null }>): EndedSubagentCallResult {
  const decoded = decodeSubagentCallResult({ ...result, name: turn.name });
  if (decoded?.kind === "ended") return decoded;
  const state = (["done", "failed", "interrupted", "stopped"] as const).includes(result.state) ? result.state : "failed";
  return impliedResult({ modelId: turn.modelId, name: turn.name, outcome: result.outcome ?? null,
    reason: typeof result.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(result.reason) ? result.reason : null,
    reasoningEffort: turn.reasoningEffort, state });
}

const turnSelect = {
  chatId: true, endedAt: true, id: true, mode: true, modelId: true, outcome: true, parentRunId: true, reasonCode: true,
  reasoningEffort: true, result: true, state: true, threadId: true, userId: true,
  executionRun: { select: { id: true } },
  parentRun: { select: { assistantMessageId: true } },
  thread: { select: { name: true } }
} satisfies Prisma.SubagentTurnSelect;

type TurnRow = Prisma.SubagentTurnGetPayload<{ select: typeof turnSelect }>;

function turnRecord(row: TurnRow): SubagentTurnRecord {
  return {
    chatId: row.chatId, mode: row.mode, model: { effort: row.reasoningEffort, id: row.modelId }, name: row.thread.name, parentAnswerId: row.parentRun.assistantMessageId,
    parentRunId: row.parentRunId,
    result: resultOf({ modelId: row.modelId, name: row.thread.name, outcome: row.outcome, reasonCode: row.reasonCode,
      reasoningEffort: row.reasoningEffort, result: row.result, state: row.state }),
    runId: row.executionRun?.id ?? null, state: row.state, threadId: row.threadId, turnId: row.id, userId: row.userId
  };
}

/** Message ids of the subtree under a message (itself included). */
async function subtreeMessageIds(client: Pick<PrismaClient, "$queryRaw">, chatId: string, messageId: string): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`WITH RECURSIVE subtree AS (
    SELECT "id" FROM "Message" WHERE "chatId" = ${chatId} AND "id" = ${messageId}
    UNION SELECT child."id" FROM "Message" child JOIN subtree parent ON child."parentMessageId" = parent."id"
      WHERE child."chatId" = ${chatId}
  ) SELECT "id" FROM subtree`;
  return rows.map((row) => row.id);
}

export function createPrismaSubagentBackgroundStore(client: PrismaClient): SubagentBackgroundStore {
  return Object.freeze({
    async callerAvailable({ chatId, parentRunId, userId }) {
      const run = await client.modelRun.findFirst({
        select: { id: true },
        where: { chat: { permanentDeletionAt: null }, chatId, engine: "native", id: parentRunId, scheduledTaskId: null,
          status: { in: dispatchableModelRunStatuses }, subagentTurnId: null, telegramRunLinks: { none: {} }, userId }
      });
      return run !== null;
    },

    async admit(input) {
      try {
        return await mapActiveRunConflict(() => client.$transaction(async (tx): Promise<SubagentAdmission> => {
          // First, as the engine's foreground admission takes it, so the two never wait on each other in reverse.
          await lockChatSubagentAdmission(tx, input.chatId);
          const chat = await lockChatScope(tx, input);
          if (!chat || chat.permanentDeletionAt || chat.archived) {
            return { code: SUBAGENT_ERROR_CODES.backgroundUnavailable, kind: "refused" };
          }
          const [parent] = await tx.$queryRaw<Array<{ assistantId: string | null; assistantIdentity: unknown; engine: string;
            normalizedRequest: unknown; scheduledTaskId: string | null; status: ModelRunStatus; subagentTurnId: string | null;
            userMessageId: string }>>`
            SELECT "assistantId", "assistantIdentity", "engine"::text AS "engine", "normalizedRequest", "scheduledTaskId",
              "status", "subagentTurnId", "userMessageId"
            FROM "ModelRun" WHERE "id" = ${input.parentRunId} AND "chatId" = ${input.chatId} AND "userId" = ${input.userId}
            FOR UPDATE`;
          // A dispatchable run always has its request (`ModelRun_memory_request_shape_check`), which the background run copies.
          if (!parent || parent.engine !== "native" || parent.subagentTurnId !== null || parent.scheduledTaskId !== null ||
            !dispatchableModelRunStatuses.includes(parent.status) || parent.normalizedRequest === null) {
            return { code: SUBAGENT_ERROR_CODES.backgroundUnavailable, kind: "refused" };
          }
          const thread = await tx.subagentThread.findFirst({ select: { id: true },
            where: { chatId: input.chatId, id: input.threadId, userId: input.userId } });
          if (!thread) return { code: SUBAGENT_ERROR_CODES.notFound, kind: "refused" };
          if (await tx.subagentTurn.count({ where: { state: { in: ACTIVE_TURN_STATES }, threadId: input.threadId } }) > 0) {
            return { code: SUBAGENT_ERROR_CODES.busy, kind: "refused" };
          }
          const running = await tx.subagentTurn.count({ where: { chatId: input.chatId, state: { in: ACTIVE_TURN_STATES } } });
          if (running >= SUBAGENT_LIMITS.runningPerChat) return { code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" };
          const turn = await tx.subagentTurn.create({ data: {
            chatId: input.chatId, definitionRevisionId: input.definitionRevisionId, effortSource: input.binding.effortSource, id: input.turnId,
            mode: "background", modelId: input.binding.modelId, modelSource: input.binding.modelSource,
            parentRunId: input.parentRunId, parentToolCallId: input.parentToolCallId, provider: input.binding.provider,
            providerModelId: input.binding.providerModelId, reasoningEffort: input.binding.reasoningEffort, state: "running",
            threadId: input.threadId, userId: input.userId
          }, select: { id: true } });
          // Its own run beside the main agent's: one active run per thread (`ModelRun_one_active_per_chat_idx`), never the
          // Workspace wait slot, with its parent's request copied and its binding rows by reference (header).
          const run = await tx.modelRun.create({ data: {
            ...(parent.assistantId ? { assistantId: parent.assistantId } : {}),
            ...(parent.assistantIdentity !== null ? { assistantIdentity: json(parent.assistantIdentity) } : {}),
            chatId: input.chatId, engine: "native", id: input.runId, modelId: input.binding.modelId,
            normalizedRequest: json(parent.normalizedRequest),
            provider: input.binding.provider, status: "streaming", subagentThreadId: input.threadId, subagentTurnId: turn.id,
            userId: input.userId, userMessageId: parent.userMessageId
          }, select: { id: true } });
          await tx.subagentThread.update({ data: { updatedAt: new Date() }, where: { id: input.threadId } });
          return { kind: "admitted", runId: run.id, turnId: turn.id };
        }));
      } catch (error) {
        // The thread got an active run meanwhile, or this call already started a turn (one turn per call): nothing runs twice.
        if (error instanceof ActiveRunConflictError ||
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { code: SUBAGENT_ERROR_CODES.busy, kind: "refused" };
        throw error;
      }
    },

    async settle({ chatId, result, turnId, userId }) {
      return client.$transaction(async (tx): Promise<SubagentSettlement> => {
        const chat = await lockChatScope(tx, { chatId, userId });
        if (!chat) return { result: null, settled: false };
        const [turn] = await tx.$queryRaw<Array<{ id: string; modelId: string; outcome: string | null; reasonCode: string | null;
          reasoningEffort: string | null; result: unknown; startedAt: Date; state: SubagentThreadState; threadId: string }>>`
          SELECT "id", "modelId", "outcome"::text AS "outcome", "reasonCode", "reasoningEffort", "result", "startedAt",
            "state"::text AS "state", "threadId"
          FROM "SubagentTurn" WHERE "id" = ${turnId} AND "chatId" = ${chatId} AND "userId" = ${userId} FOR UPDATE`;
        if (!turn) return { result: null, settled: false };
        const thread = await tx.subagentThread.findUniqueOrThrow({ select: { name: true }, where: { id: turn.threadId } });
        if (!isActiveSubagentState(turn.state)) {
          return { result: resultOf({ ...turn, name: thread.name, reasonCode: turn.reasonCode }), settled: false };
        }
        const ended = normalizedEndResult(result, { modelId: turn.modelId, name: thread.name, reasoningEffort: turn.reasoningEffort });
        // Never before its start, whichever clock wrote that (`SubagentTurn_state_check`).
        const endedAt = new Date(Math.max(Date.now(), turn.startedAt.getTime()));
        await tx.subagentTurn.update({ data: {
          endedAt, outcome: ended.state === "done" ? ended.outcome ?? "done" : null, reasonCode: ended.reason ?? null,
          result: json(ended), state: ended.state
        }, where: { id: turnId } });
        const run = await tx.modelRun.findFirst({ select: { id: true }, where: { chatId, subagentTurnId: turnId, userId } });
        if (run) {
          const status = END_STATE_RUN_STATUS[ended.state];
          const payload = ended.state === "interrupted" ? recoveredRunErrorPayload(RUN_INTERRUPTED_FAILURE)
            : ended.state === "done" ? null : { code: ended.reason ?? `subagent_${ended.state}`, message: `Sub-agent ${ended.state}` };
          await tx.modelRun.updateMany({ data: { errorPayload: payload === null ? Prisma.JsonNull : json(payload), status },
            where: { id: run.id, status: { in: activeModelRunStatuses } } });
          await cancelPendingToolLoopCallsInTransaction(tx, run.id);
          await closeRunningToolLoopCallsInTransaction(tx, run.id);
        }
        await tx.subagentThread.update({ data: { updatedAt: endedAt }, where: { id: turn.threadId } });
        return { result: ended, settled: true };
      });
    },

    async findTurn({ chatId, turnId, userId }) {
      const row = await client.subagentTurn.findFirst({ select: turnSelect, where: { chatId, id: turnId, userId } });
      return row ? turnRecord(row) : null;
    },

    async findThreadTurnOnBranch({ chatId, name, parentRunId, userId }) {
      return client.$transaction(async (tx) => {
        const parent = await tx.modelRun.findFirst({ select: { assistantMessageId: true },
          where: { chatId, id: parentRunId, subagentTurnId: null, userId } });
        if (!parent?.assistantMessageId) return null;
        const path = await branchPathMessageIds(tx, chatId, parent.assistantMessageId);
        const threads = await tx.subagentThread.findMany({ select: { anchorRun: { select: { assistantMessageId: true } }, id: true },
          where: { chatId, name, userId } });
        const thread = threads.find((candidate) => candidate.anchorRun.assistantMessageId !== null &&
          path.has(candidate.anchorRun.assistantMessageId));
        if (!thread) return null;
        const turns = await tx.subagentTurn.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: turnSelect,
          where: { threadId: thread.id } });
        const onBranch = turns.find((turn) => turn.parentRun.assistantMessageId !== null && path.has(turn.parentRun.assistantMessageId));
        return onBranch ? turnRecord(onBranch) : null;
      });
    },

    async activeTurns({ chatId, threadId, underMessageId, userId }) {
      const messageIds = underMessageId ? await subtreeMessageIds(client, chatId, underMessageId) : null;
      if (messageIds && messageIds.length === 0) return [];
      const rows = await client.subagentTurn.findMany({ orderBy: { startedAt: "asc" }, select: turnSelect, where: {
        chatId, state: { in: ACTIVE_TURN_STATES }, userId, ...(threadId ? { threadId } : {}),
        ...(messageIds ? { parentRun: { OR: [{ userMessageId: { in: messageIds } }, { assistantMessageId: { in: messageIds } }] } } : {})
      } });
      return rows.map(turnRecord);
    },

    async runIdsUnderMessage({ chatId, messageId, userId }) {
      const messageIds = await subtreeMessageIds(client, chatId, messageId);
      if (messageIds.length === 0) return [];
      const runs = await client.modelRun.findMany({ select: { id: true }, where: { chatId, subagentTurnId: null, userId,
        OR: [{ userMessageId: { in: messageIds } }, { assistantMessageId: { in: messageIds } }] } });
      return runs.map((run) => run.id);
    },

    async insertMailbox({ chatId, nonce, runId, text, userId }) {
      return client.$transaction(async (tx): Promise<MailboxInsertOutcome> => {
        await lockRunSettlementScope(tx, runId);
        const [run] = await tx.$queryRaw<Array<{ followupRevision: number; status: ModelRunStatus; subagentTurnId: string | null }>>`
          SELECT "followupRevision", "status", "subagentTurnId" FROM "ModelRun"
          WHERE "id" = ${runId} AND "chatId" = ${chatId} AND "userId" = ${userId} FOR UPDATE`;
        if (!run?.subagentTurnId || !dispatchableModelRunStatuses.includes(run.status)) return "closed";
        const previous = await tx.runFollowup.findUnique({ select: { origin: true, text: true },
          where: { modelRunId_nonce: { modelRunId: runId, nonce } } });
        if (previous) return previous.origin === "main_agent" && previous.text === text ? "exists" : "closed";
        const sent = await tx.runFollowup.count({ where: { modelRunId: runId, origin: "main_agent" } });
        if (sent >= SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun) return "full";
        await tx.runFollowup.create({ data: { authorName: "Main agent", chatId, modelRunId: runId, nonce,
          ordinal: run.followupRevision + 1, origin: "main_agent", text } });
        await tx.modelRun.update({ data: { followupRevision: { increment: 1 } }, where: { id: runId } });
        return "inserted";
      });
    },

    async markMailboxDelivered({ chatId, nonce, runId }) {
      await client.runFollowup.updateMany({ data: { deliveredAt: new Date() },
        where: { chatId, deliveredAt: null, modelRunId: runId, nonce, origin: "main_agent" } });
    },

    async owedCallbacks(scope) {
      // Every send and every main run's end flushes: a chat with no background turn that ended unclaimed, or whose
      // callback sits unread in an answer that ended, takes no lock.
      const candidate = await client.subagentTurn.findFirst({ select: { id: true }, where: { chatId: scope.chatId, endedAt: { not: null },
        mode: "background", userId: scope.userId, OR: [{ callbackRunId: null },
          { callbackRun: { status: { in: ["complete", "cancelled", "error"] } }, followups: { some: { deliveredAt: null } } }] } });
      if (!candidate) return { activeBranch: [], inactiveTurnIds: [], mainRun: null };
      return client.$transaction(async (tx): Promise<OwedCallbacks | null> => {
        const chat = await lockChatScope(tx, scope);
        if (!chat || chat.permanentDeletionAt) return null;
        // A callback put into an answer that ended before reading it (Stop, a failure) is owed again.
        const stranded = await tx.$queryRaw<Array<{ followupId: string; turnId: string }>>`
          SELECT followup."id" AS "followupId", turn."id" AS "turnId"
          FROM "SubagentTurn" turn
          JOIN "ModelRun" run ON run."id" = turn."callbackRunId" AND run."chatId" = turn."chatId"
          JOIN "RunFollowup" followup ON followup."modelRunId" = run."id" AND followup."subagentTurnId" = turn."id"
          WHERE turn."chatId" = ${scope.chatId} AND followup."deliveredAt" IS NULL
            AND run."status" IN ('complete', 'cancelled', 'error')
          FOR UPDATE OF turn`;
        if (stranded.length > 0) {
          await tx.runFollowup.deleteMany({ where: { id: { in: stranded.map((row) => row.followupId) } } });
          await tx.subagentTurn.updateMany({ data: { callbackRunId: null }, where: { id: { in: stranded.map((row) => row.turnId) } } });
        }
        const owed = await tx.subagentTurn.findMany({ orderBy: [{ endedAt: "asc" }, { id: "asc" }], select: turnSelect, where: {
          callbackRunId: null, chatId: scope.chatId, endedAt: { not: null }, mode: "background", userId: scope.userId
        } });
        const path = chat.activeLeafMessageId ? await branchPathMessageIds(tx, scope.chatId, chat.activeLeafMessageId) : new Set<string>();
        const activeBranch: OwedSubagentCallback[] = [];
        const inactiveTurnIds: string[] = [];
        for (const row of owed) {
          const record = turnRecord(row);
          if (record.result && record.parentAnswerId && path.has(record.parentAnswerId)) {
            activeBranch.push({ name: record.name, result: record.result, turnId: record.turnId });
          } else inactiveTurnIds.push(record.turnId);
        }
        const mainRun = await tx.modelRun.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, status: true },
          where: { chatId: scope.chatId, status: { in: activeModelRunStatuses }, subagentTurnId: null } });
        return { activeBranch, inactiveTurnIds, mainRun };
      });
    },

    async deliverIntoRun({ chatId, runId, turnId, userId }) {
      return client.$transaction(async (tx): Promise<CallbackIntoRunOutcome> => {
        await lockRunSettlementScope(tx, runId);
        const [run] = await tx.$queryRaw<Array<{ answerCompletedAt: Date | null; assistantMessageId: string | null;
          followupClosedAt: Date | null; followupMode: string | null; followupRevision: number; reserveTokens: unknown;
          scheduledTaskId: string | null; status: ModelRunStatus; subagentTurnId: string | null }>>`
          SELECT "answerCompletedAt", "assistantMessageId", "followupClosedAt", "followupMode", "followupRevision", "scheduledTaskId",
            "status", "subagentTurnId", "normalizedRequest" -> 'followupContextReserveTokens' AS "reserveTokens"
          FROM "ModelRun" WHERE "id" = ${runId} AND "chatId" = ${chatId} AND "userId" = ${userId} FOR UPDATE`;
        // A scheduled occurrence's context stays as admission froze it: its callbacks wait for its end.
        if (!run || run.subagentTurnId !== null || run.scheduledTaskId !== null || !run.assistantMessageId || !run.followupMode ||
          run.followupClosedAt || run.answerCompletedAt || !dispatchableModelRunStatuses.includes(run.status)) return "closed";
        const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true },
          where: { id: chatId, permanentDeletionAt: null, userId } });
        if (!chat || chat.activeLeafMessageId !== run.assistantMessageId) return "closed";
        const turn = await tx.subagentTurn.findFirst({ select: { parentRun: { select: { assistantMessageId: true } } },
          where: { chatId, id: turnId, userId } });
        const parentAnswer = turn?.parentRun.assistantMessageId;
        if (!parentAnswer || !(await branchPathMessageIds(tx, chatId, run.assistantMessageId)).has(parentAnswer)) return "closed";
        const received = await tx.runFollowup.findMany({ select: { text: true }, where: { modelRunId: runId, origin: "subagent_callback" } });
        if (received.length >= SUBAGENT_FOLLOWUP_LIMITS.callbacksPerRun) return "closed";
        const result = await tx.subagentTurn.findFirst({ select: { result: true, thread: { select: { name: true } } },
          where: { chatId, id: turnId } });
        const ended = result && decodeSubagentCallResult(result.result);
        if (!result || ended?.kind !== "ended") return "claimed";
        // Bounded to what is left of the run's follow-up reserve, with a cut mark; the whole result stays on the turn.
        const reserve = typeof run.reserveTokens === "number" && Number.isSafeInteger(run.reserveTokens) && run.reserveTokens > 0
          ? run.reserveTokens : SUBAGENT_CALLBACK_DEFAULT_RESERVE_TOKENS;
        const spent = received.reduce((sum, entry) => sum + followupTokenCost(entry.text), 0);
        const text = renderCallbackFollowup({ name: result.thread.name, result: ended, turnId },
          { tokens: Math.max(SUBAGENT_CALLBACK_MIN_TOKENS, reserve - spent) });
        const claimed = await tx.$executeRaw(Prisma.sql`
          UPDATE "SubagentTurn" SET "callbackRunId" = ${runId}, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${turnId} AND "chatId" = ${chatId} AND "callbackRunId" IS NULL AND "mode" = 'background'
            AND "endedAt" IS NOT NULL`);
        if (claimed !== 1) return "claimed";
        // Its own row of the run's follow-ups: it moves the revision the answer closes at, so a finishing answer either
        // reads it or loses its compare-and-close, and it never spends the user's follow-ups or their token budget.
        await tx.runFollowup.create({ data: { authorName: "Sub-agent", chatId, modelRunId: runId, nonce: subagentCallbackNonce(turnId),
          ordinal: run.followupRevision + 1, origin: "subagent_callback", subagentTurnId: turnId, text } });
        await tx.modelRun.update({ data: { followupRevision: { increment: 1 } }, where: { id: runId } });
        return "delivered";
      });
    },

    async mainRunScope(runId) {
      const run = await client.modelRun.findFirst({ select: { chatId: true, userId: true }, where: { id: runId, subagentTurnId: null } });
      return run ? { chatId: run.chatId, userId: run.userId } : null;
    },

    async findOrphans(input) {
      const rows = await client.modelRun.findMany({
        orderBy: { updatedAt: "asc" },
        select: { chatId: true, id: true, subagentTurnId: true, userId: true },
        take: input.limit,
        where: {
          engine: "native", status: { in: activeModelRunStatuses }, subagentTurnId: { not: null },
          ...(input.liveRunIds.length > 0 ? { id: { notIn: [...input.liveRunIds] } } : {}),
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
          OR: [{ createdAt: { lt: input.bootedBefore } }, { updatedAt: { lt: input.staleBefore } }]
        }
      });
      return rows.flatMap((row) => row.subagentTurnId
        ? [{ chatId: row.chatId, runId: row.id, turnId: row.subagentTurnId, userId: row.userId }] : []);
    },

    async findOwedCallbackChats({ chatId, endedBefore, limit, userId }) {
      const rows = await client.$queryRaw<Array<{ chatId: string; turnIds: string[]; userId: string }>>(Prisma.sql`
        SELECT turn."chatId", turn."userId", array_agg(turn."id" ORDER BY turn."endedAt", turn."id") AS "turnIds"
        FROM "SubagentTurn" turn
        JOIN "Chat" chat ON chat."id" = turn."chatId" AND chat."userId" = turn."userId" AND chat."permanentDeletionAt" IS NULL
        WHERE turn."mode" = 'background' AND turn."endedAt" IS NOT NULL AND turn."endedAt" < ${endedBefore}
          ${chatId ? Prisma.sql`AND turn."chatId" = ${chatId}` : Prisma.empty}
          ${userId ? Prisma.sql`AND turn."userId" = ${userId}` : Prisma.empty}
          AND (turn."callbackRunId" IS NULL OR EXISTS (
            SELECT 1 FROM "ModelRun" receiver JOIN "RunFollowup" followup ON followup."modelRunId" = receiver."id"
            WHERE receiver."id" = turn."callbackRunId" AND followup."subagentTurnId" = turn."id" AND followup."deliveredAt" IS NULL
              AND receiver."status" IN ('complete', 'cancelled', 'error')))
          AND NOT EXISTS (SELECT 1 FROM "ModelRun" main WHERE main."chatId" = turn."chatId" AND main."subagentTurnId" IS NULL
            AND main."status" IN ('preparing', 'queued', 'streaming', 'in_progress'))
        GROUP BY turn."chatId", turn."userId"
        LIMIT ${limit}`);
      return rows.map((row) => ({ chatId: row.chatId, turnIds: row.turnIds, userId: row.userId }));
    },

    async interruptStrandedForegroundTurns({ chatId, userId }) {
      return client.$executeRaw(Prisma.sql`
        UPDATE "SubagentTurn" turn
        SET "state" = 'interrupted', "reasonCode" = ${SUBAGENT_END_REASONS.restart}, "endedAt" = GREATEST(CURRENT_TIMESTAMP::timestamp(3), turn."startedAt"),
          "updatedAt" = CURRENT_TIMESTAMP
        FROM "ModelRun" parent
        WHERE parent."id" = turn."parentRunId" AND turn."mode" = 'foreground' AND turn."state" IN ('running', 'waiting')
          AND parent."status" NOT IN ('preparing', 'queued', 'streaming', 'in_progress')
          ${chatId ? Prisma.sql`AND turn."chatId" = ${chatId}` : Prisma.empty}
          ${userId ? Prisma.sql`AND turn."userId" = ${userId}` : Prisma.empty}`);
    }
  });
}
