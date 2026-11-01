import { Prisma, type ModelRunStatus, type PrismaClient, type RunFollowupOrigin, type SubagentTurnState } from "@prisma/client";
import { RUN_INTERRUPTED_FAILURE } from "../../../contracts/runs";
import {
  ASK_PARENT_TOOL_NAME,
  RUN_FOLLOWUP_REVISION_MAX,
  SUBAGENT_END_REASONS,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_FOLLOWUP_LIMITS,
  SUBAGENT_LIMITS,
  SUBAGENT_WAIT_REASONS,
  decodeSubagentCallResult,
  isActiveSubagentState,
  subagentCallbackNonce,
  subagentQuestionNonce,
  type EndedSubagentCallResult,
  type EndedSubagentState,
  type SubagentErrorCode,
  type SubagentThreadState,
  type SubagentTurnMode
} from "../../../contracts/subagents";
import type { SubagentBinding, SubagentCallbackClaim, SubagentChatScope } from "../../subagents/ports";
import { branchPathMessageIds } from "../../toolObservations/repository";
import { activeModelRunStatuses, dispatchableModelRunStatuses, json, lockRunSettlementScope, mapActiveRunConflict } from "../prismaRepositoryShared";
import { cancelPendingToolLoopCallsInTransaction, closeRunningToolLoopCallsInTransaction, recoveredRunErrorPayload } from "../prismaRepositoryToolLoop";
import { ActiveRunConflictError } from "../runRepositoryContract";
import { followupTokenCost } from "../runFollowups";
import { renderCallbackFollowup, renderMessageFollowup, renderQuestionFollowup, SUBAGENT_CALLBACK_DEFAULT_RESERVE_TOKENS,
  SUBAGENT_CALLBACK_MIN_TOKENS } from "./render";
import { bindSubagentRunWorkspace } from "../../workspace/attachments";
import { acceptWorkspaceBrowserSequence } from "../../workspace/secrets/store";

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
/** What a main-agent run takes from sub-agents among its own follow-ups, within one bound (`callbacksPerRun`). */
const FROM_SUBAGENTS: RunFollowupOrigin[] = ["subagent_callback", "subagent_message", "subagent_question"];
const ENDED_RUN_STATUSES: ModelRunStatus[] = ["complete", "cancelled", "error"];

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

export type MailboxInsertInput = SubagentChatScope & Readonly<{
  authorName: string;
  /** The sending call's id, so a repeat finds its row. */
  nonce: string;
  origin: "main_agent" | "subagent_message";
  text: string;
  /** The receiving turn, foreground or background: the row sits on the run hosting it. */
  turnId: string;
}>;

/** What a sub-agent's message to the main agent came to: in its running answer, past that run's bound, or no answer can read it. */
export type MainAgentMessageOutcome = "closed" | "delivered" | "full";

/** A turn that ended and owes its callback, or one waiting for an answer that owes its question. */
export type OwedSubagentCallback = Readonly<{ name: string; result: EndedSubagentCallResult; turnId: string }> |
  Readonly<{ callId: string; name: string; question: string; turnId: string }>;

export type OwedCallbacks = Readonly<{
  /** Owed callbacks of the chat's active branch, oldest end first, then its owed questions, oldest first. */
  activeBranch: readonly OwedSubagentCallback[];
  /** Owed callbacks and questions of other branches: recorded there, waking nothing. */
  inactiveTurnIds: readonly string[];
  /** The chat's active main-agent run, if any. */
  mainRun: Readonly<{ id: string; status: ModelRunStatus }> | null;
  /** Messages to the main agent an answer of this branch ended without reading, for its next answer: they wake nothing. */
  strandedMessageIds?: readonly string[];
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
  /** A message for a running turn's mailbox, kept whatever comes of the turn: the thread's next turn reads what this one did not. */
  insertMailbox(input: MailboxInsertInput): Promise<MailboxInsertOutcome>;
  /** A sub-agent's message into the main agent's running answer on the caller's branch, as one of that run's own follow-ups. */
  messageMainAgent(input: SubagentChatScope & Readonly<{ authorName: string; nonce: string; parentRunId: string; text: string }>):
    Promise<MainAgentMessageOutcome>;
  /** Moves a message an ended answer left unread into this run's, when it is on that message's branch; false leaves it owed. */
  moveMessageIntoRun(input: SubagentChatScope & Readonly<{ followupId: string; runId: string }>): Promise<boolean>;
  owedCallbacks(input: SubagentChatScope): Promise<OwedCallbacks | null>;
  /** Renders the turn's stored result (or its waiting question), bounded to the run's remaining follow-up reserve, then claims and inserts it. */
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
 * message's own path) are taken, each only for what the wake-up rendered of
 * it, and the admission is refused unless it takes every one. A branch switch,
 * or a turn that ended or asks something else since they were read, is refused
 * here and read again: a wake-up that held a question it no longer asks would
 * take the place of the callback its end owes, where recovery cannot find it.
 */
export async function claimSubagentCallbacksForRun(tx: Prisma.TransactionClient,
  input: Readonly<{ chatId: string; runId: string; turns: readonly SubagentCallbackClaim[]; userMessageId: string }>): Promise<void> {
  const claims = [...new Map(input.turns.map((claim) => [claim.turnId, claim])).values()];
  if (claims.length === 0) throw new SubagentCallbackClaimConflictError();
  const path = await branchPathMessageIds(tx, input.chatId, input.userMessageId);
  const turns = await tx.subagentTurn.findMany({ select: { executionRun: { select: { id: true } }, id: true, parentRun: { select: { assistantMessageId: true } } },
    where: { chatId: input.chatId, id: { in: claims.map((claim) => claim.turnId) } } });
  if (turns.length !== claims.length ||
    turns.some((turn) => !turn.parentRun.assistantMessageId || !path.has(turn.parentRun.assistantMessageId))) {
    throw new SubagentCallbackClaimConflictError();
  }
  const questions = claims.filter((claim) => claim.kind === "question");
  const asked = await askedQuestions(tx, turns.flatMap((turn) => questions.some((claim) => claim.turnId === turn.id)
    ? [{ id: turn.id, runId: turn.executionRun?.id ?? null }] : []));
  if (questions.some((claim) => asked.get(claim.turnId)?.callId !== claim.callId)) throw new SubagentCallbackClaimConflictError();
  const claimed = await claimTurns(tx, { chatId: input.chatId, claims, runId: input.runId });
  if (claimed !== claims.length) throw new SubagentCallbackClaimConflictError();
}

/**
 * The compare-and-set every delivery of a callback or a question goes through, for what that delivery rendered: a
 * callback only of a turn that ended, a question only of a turn that still waits for its answer.
 */
async function claimTurns(tx: Prisma.TransactionClient, input: Readonly<{ chatId: string; claims: readonly SubagentCallbackClaim[]; runId: string }>): Promise<number> {
  const turnIds = (kind: SubagentCallbackClaim["kind"]) => input.claims.flatMap((claim) => claim.kind === kind ? [claim.turnId] : []);
  const { count } = await tx.subagentTurn.updateMany({ data: { callbackRunId: input.runId }, where: { callbackRunId: null, chatId: input.chatId,
    mode: "background", OR: [{ endedAt: { not: null }, id: { in: turnIds("callback") } },
      { endedAt: null, id: { in: turnIds("question") }, reasonCode: SUBAGENT_WAIT_REASONS.answer, state: "waiting" }] } });
  return count;
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

/**
 * The message ids of the branch an agent works on: the chat's active branch while its parent run's answer is on it, so
 * it reaches agents the main agent started after it, otherwise that answer's own path. Null when it has no answer.
 */
export async function agentBranchPath(tx: Prisma.TransactionClient,
  input: SubagentChatScope & Readonly<{ activeLeafMessageId: string | null; parentRunId: string }>): Promise<ReadonlySet<string> | null> {
  const parent = await tx.modelRun.findFirst({ select: { assistantMessageId: true },
    where: { chatId: input.chatId, id: input.parentRunId, subagentTurnId: null, userId: input.userId } });
  if (!parent?.assistantMessageId) return null;
  const active = input.activeLeafMessageId ? await branchPathMessageIds(tx, input.chatId, input.activeLeafMessageId) : null;
  return active?.has(parent.assistantMessageId) ? active : branchPathMessageIds(tx, input.chatId, parent.assistantMessageId);
}

/** What a main-agent run must be to take a follow-up from a sub-agent. */
type ReceivingRun = Readonly<{ assistantMessageId: string; followupRevision: number; id: string; reserveTokens: unknown }>;

/** Locks the run in settlement order; null when it can no longer take a follow-up. */
async function receivingRun(tx: Prisma.TransactionClient, scope: SubagentChatScope, runId: string): Promise<ReceivingRun | null> {
  await lockRunSettlementScope(tx, runId);
  const [run] = await tx.$queryRaw<Array<{ answerCompletedAt: Date | null; assistantMessageId: string | null;
    followupClosedAt: Date | null; followupMode: string | null; followupRevision: number; reserveTokens: unknown;
    scheduledTaskId: string | null; status: ModelRunStatus; subagentTurnId: string | null }>>`
    SELECT "answerCompletedAt", "assistantMessageId", "followupClosedAt", "followupMode", "followupRevision", "scheduledTaskId",
      "status", "subagentTurnId", "normalizedRequest" -> 'followupContextReserveTokens' AS "reserveTokens"
    FROM "ModelRun" WHERE "id" = ${runId} AND "chatId" = ${scope.chatId} AND "userId" = ${scope.userId} FOR UPDATE`;
  // A scheduled occurrence's context stays as admission froze it: its callbacks wait for its end.
  if (!run || run.subagentTurnId !== null || run.scheduledTaskId !== null || !run.assistantMessageId || !run.followupMode ||
    run.followupClosedAt || run.answerCompletedAt || !dispatchableModelRunStatuses.includes(run.status) ||
    // The run's revision and ordinals hold the user's follow-ups and those from sub-agents (`ModelRun_followup_bounds`).
    run.followupRevision >= RUN_FOLLOWUP_REVISION_MAX) return null;
  const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true },
    where: { id: scope.chatId, permanentDeletionAt: null, userId: scope.userId } });
  if (!chat || chat.activeLeafMessageId !== run.assistantMessageId) return null;
  return { assistantMessageId: run.assistantMessageId, followupRevision: run.followupRevision, id: runId, reserveTokens: run.reserveTokens };
}

/**
 * One of the run's own follow-ups from a sub-agent: it moves the revision the answer closes at, so a finishing answer
 * either reads it or loses its compare-and-close, and it never spends the user's follow-ups or their token budget.
 */
async function addRunFollowup(tx: Prisma.TransactionClient, run: ReceivingRun, input: Readonly<{ authorName: string; chatId: string;
  nonce: string; origin: RunFollowupOrigin; subagentTurnId?: string; text: string }>): Promise<void> {
  await tx.runFollowup.create({ data: { authorName: input.authorName, chatId: input.chatId, modelRunId: run.id, nonce: input.nonce,
    ordinal: run.followupRevision + 1, origin: input.origin, ...(input.subagentTurnId ? { subagentTurnId: input.subagentTurnId } : {}),
    text: input.text } });
  await tx.modelRun.update({ data: { followupRevision: { increment: 1 } }, where: { id: run.id } });
}

/**
 * The questions these waiting turns are asking: each one's `ask_parent` call, which holds it until it is answered. A turn
 * asks one at a time (`EngineTool.serial`), so the latest open call is its question: an older one is a record left unsettled.
 */
async function askedQuestions(tx: Prisma.TransactionClient, turns: readonly Readonly<{ id: string; runId: string | null }>[]):
  Promise<ReadonlyMap<string, Readonly<{ callId: string; text: string }>>> {
  const runIds = turns.flatMap((turn) => turn.runId ? [turn.runId] : []);
  if (runIds.length === 0) return new Map();
  const calls = await tx.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { arguments: true, id: true, subagentTurnId: true },
    where: { modelRunId: { in: runIds }, state: { in: ["pending", "running"] }, subagentTurnId: { in: turns.map((turn) => turn.id) },
      toolName: ASK_PARENT_TOOL_NAME } });
  const questions = new Map<string, Readonly<{ callId: string; text: string }>>();
  for (const call of calls) {
    const text = (call.arguments as { question?: unknown } | null)?.question;
    if (call.subagentTurnId && typeof text === "string" && text.trim()) questions.set(call.subagentTurnId, { callId: call.id, text: text.trim() });
  }
  return questions;
}

/**
 * Messages to the main agent that an answer ended without reading. Only their own branch can take them
 * (`moveMessageIntoRun`), so with `path` a branch the user left keeps its messages for when the user comes back, and no
 * flush meets them meanwhile.
 */
function strandedMessages(scope: SubagentChatScope, path?: ReadonlySet<string>): Prisma.RunFollowupWhereInput {
  return { chatId: scope.chatId, deliveredAt: null, modelRun: { ...(path ? { assistantMessageId: { in: [...path] } } : {}),
    status: { in: ENDED_RUN_STATUSES }, subagentTurnId: null, userId: scope.userId }, ordinal: { lte: RUN_FOLLOWUP_REVISION_MAX }, origin: "subagent_message" };
}

/** Whether the chat's active branch holds one: nearly every chat has none at all, so only one that does walks its branch. */
async function hasStrandedMessage(client: PrismaClient, scope: SubagentChatScope): Promise<boolean> {
  if (!await client.runFollowup.findFirst({ select: { id: true }, where: strandedMessages(scope) })) return false;
  const chat = await client.chat.findFirst({ select: { activeLeafMessageId: true }, where: { id: scope.chatId, userId: scope.userId } });
  if (!chat?.activeLeafMessageId) return false;
  const path = await branchPathMessageIds(client, scope.chatId, chat.activeLeafMessageId);
  return await client.runFollowup.findFirst({ select: { id: true }, where: strandedMessages(scope, path) }) !== null;
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
          // Its Workspace binding is the parent's admitted one with its own output folder and browser sign-in sequence,
          // so it attaches to the chat's shared session; a parent without a Workspace leaves it without one.
          const parentWorkspace = await tx.workspaceRunBinding.findUnique({ select: { modelRunId: true },
            where: { modelRunId: input.parentRunId } });
          if (parentWorkspace) {
            await bindSubagentRunWorkspace(tx, { browserSessionSequence: await acceptWorkspaceBrowserSequence(tx, input.userId, input.chatId),
              parentRunId: input.parentRunId, runId: run.id });
          }
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
        // A claim on a turn ending now was its question's: its callback is owed like any other.
        await tx.subagentTurn.update({ data: {
          callbackRunId: null, endedAt, outcome: ended.state === "done" ? ended.outcome ?? "done" : null, reasonCode: ended.reason ?? null,
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
        const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true }, where: { id: chatId, userId } });
        if (!chat) return null;
        const path = await agentBranchPath(tx, { activeLeafMessageId: chat.activeLeafMessageId, chatId, parentRunId, userId });
        if (!path) return null;
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

    async insertMailbox({ authorName, chatId, nonce, origin, text, turnId, userId }) {
      return client.$transaction(async (tx): Promise<MailboxInsertOutcome> => {
        const chat = await lockChatScope(tx, { chatId, userId });
        if (!chat || chat.permanentDeletionAt) return "closed";
        const turn = await tx.subagentTurn.findFirst({ select: { executionRun: { select: { id: true } }, mode: true, parentRunId: true, state: true },
          where: { chatId, id: turnId, userId } });
        if (!turn || !isActiveSubagentState(turn.state)) return "closed";
        const runId = turn.mode === "foreground" ? turn.parentRunId : turn.executionRun?.id;
        if (!runId) return "closed";
        const [run] = await tx.$queryRaw<Array<{ status: ModelRunStatus }>>`
          SELECT "status" FROM "ModelRun" WHERE "id" = ${runId} AND "chatId" = ${chatId} AND "userId" = ${userId} FOR UPDATE`;
        if (!run || !dispatchableModelRunStatuses.includes(run.status)) return "closed";
        const previous = await tx.runFollowup.findUnique({ select: { origin: true, text: true },
          where: { modelRunId_nonce: { modelRunId: runId, nonce } } });
        if (previous) return previous.origin === origin && previous.text === text ? "exists" : "closed";
        const sent = await tx.runFollowup.count({ where: { modelRunId: runId, origin, subagentTurnId: turnId } });
        if (sent >= (origin === "main_agent" ? SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun : SUBAGENT_FOLLOWUP_LIMITS.agentMessagesPerTurn)) return "full";
        // Above the run's own ordinals, never its revision: that revision is what an answer closes at, and a run whose turn
        // ends with a message it never read must still settle (`ModelRun_followup_completion_guard`).
        const last = await tx.runFollowup.aggregate({ _max: { ordinal: true }, where: { modelRunId: runId } });
        await tx.runFollowup.create({ data: { authorName, chatId, modelRunId: runId, nonce,
          ordinal: Math.max(RUN_FOLLOWUP_REVISION_MAX, last._max.ordinal ?? 0) + 1, origin, subagentTurnId: turnId, text } });
        return "inserted";
      });
    },

    async messageMainAgent({ authorName, chatId, nonce, parentRunId, text, userId }) {
      return client.$transaction(async (tx): Promise<MainAgentMessageOutcome> => {
        const main = await tx.modelRun.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true },
          where: { chatId, status: { in: activeModelRunStatuses }, subagentTurnId: null, userId } });
        if (!main) return "closed";
        const run = await receivingRun(tx, { chatId, userId }, main.id);
        if (!run) return "closed";
        const parent = await tx.modelRun.findFirst({ select: { assistantMessageId: true }, where: { chatId, id: parentRunId, subagentTurnId: null, userId } });
        if (!parent?.assistantMessageId || !(await branchPathMessageIds(tx, chatId, run.assistantMessageId)).has(parent.assistantMessageId)) return "closed";
        if (await tx.runFollowup.findUnique({ select: { id: true }, where: { modelRunId_nonce: { modelRunId: run.id, nonce } } })) return "delivered";
        const received = await tx.runFollowup.count({ where: { modelRunId: run.id, origin: { in: FROM_SUBAGENTS } } });
        if (received >= SUBAGENT_FOLLOWUP_LIMITS.callbacksPerRun) return "full";
        await addRunFollowup(tx, run, { authorName, chatId, nonce, origin: "subagent_message", text: renderMessageFollowup({ from: authorName, text }) });
        return "delivered";
      });
    },

    async moveMessageIntoRun({ chatId, followupId, runId, userId }) {
      return client.$transaction(async (tx): Promise<boolean> => {
        const run = await receivingRun(tx, { chatId, userId }, runId);
        if (!run) return false;
        const message = await tx.runFollowup.findFirst({ select: { authorName: true, modelRun: { select: { assistantMessageId: true } }, nonce: true, text: true },
          where: { chatId, deliveredAt: null, id: followupId, modelRun: { status: { in: ENDED_RUN_STATUSES }, userId }, origin: "subagent_message" } });
        if (!message?.modelRun.assistantMessageId) return false;
        if (!(await branchPathMessageIds(tx, chatId, run.assistantMessageId)).has(message.modelRun.assistantMessageId)) return false;
        if (await tx.runFollowup.count({ where: { modelRunId: run.id, origin: { in: FROM_SUBAGENTS } } }) >= SUBAGENT_FOLLOWUP_LIMITS.callbacksPerRun) return false;
        await tx.runFollowup.delete({ where: { id: followupId } });
        await addRunFollowup(tx, run, { authorName: message.authorName, chatId, nonce: message.nonce, origin: "subagent_message", text: message.text });
        return true;
      });
    },

    async owedCallbacks(scope) {
      // Every send and every main run's end flushes: a chat with no background turn that ended unclaimed or waits for an
      // answer, none whose callback or question sits unread in an answer that ended, and no such message on its active
      // branch, takes no lock.
      const unread = { deliveredAt: null, ordinal: { lte: RUN_FOLLOWUP_REVISION_MAX } };
      const candidate = await client.subagentTurn.findFirst({ select: { id: true }, where: { chatId: scope.chatId,
        mode: "background", userId: scope.userId, OR: [{ endedAt: { not: null }, OR: [{ callbackRunId: null },
          { callbackRun: { status: { in: ENDED_RUN_STATUSES } }, followups: { some: unread } }] },
        { reasonCode: SUBAGENT_WAIT_REASONS.answer, state: "waiting" }] } }) ?? await hasStrandedMessage(client, scope);
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
        const asking = await tx.subagentTurn.findMany({ orderBy: [{ updatedAt: "asc" }, { id: "asc" }], select: turnSelect, where: {
          callbackRunId: null, chatId: scope.chatId, mode: "background", reasonCode: SUBAGENT_WAIT_REASONS.answer, state: "waiting", userId: scope.userId
        } });
        const questions = await askedQuestions(tx, asking.map((row) => ({ id: row.id, runId: row.executionRun?.id ?? null })));
        const path = chat.activeLeafMessageId ? await branchPathMessageIds(tx, scope.chatId, chat.activeLeafMessageId) : new Set<string>();
        const activeBranch: OwedSubagentCallback[] = [];
        const inactiveTurnIds: string[] = [];
        for (const row of owed) {
          const record = turnRecord(row);
          if (record.result && record.parentAnswerId && path.has(record.parentAnswerId)) {
            activeBranch.push({ name: record.name, result: record.result, turnId: record.turnId });
          } else inactiveTurnIds.push(record.turnId);
        }
        for (const row of asking) {
          const question = questions.get(row.id);
          const record = turnRecord(row);
          if (!question) continue;
          if (record.parentAnswerId && path.has(record.parentAnswerId)) {
            activeBranch.push({ callId: question.callId, name: record.name, question: question.text, turnId: record.turnId });
          } else inactiveTurnIds.push(record.turnId);
        }
        const mainRun = await tx.modelRun.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, status: true },
          where: { chatId: scope.chatId, status: { in: activeModelRunStatuses }, subagentTurnId: null } });
        const messages = await tx.runFollowup.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
          where: strandedMessages(scope, path) });
        return { activeBranch, inactiveTurnIds, mainRun, strandedMessageIds: messages.map((message) => message.id) };
      });
    },

    async deliverIntoRun({ chatId, runId, turnId, userId }) {
      return client.$transaction(async (tx): Promise<CallbackIntoRunOutcome> => {
        const run = await receivingRun(tx, { chatId, userId }, runId);
        if (!run) return "closed";
        const turn = await tx.subagentTurn.findFirst({ select: { executionRun: { select: { id: true } }, parentRun: { select: { assistantMessageId: true } },
          reasonCode: true, result: true, state: true, thread: { select: { name: true } } }, where: { chatId, id: turnId, userId } });
        const parentAnswer = turn?.parentRun.assistantMessageId;
        if (!turn || !parentAnswer || !(await branchPathMessageIds(tx, chatId, run.assistantMessageId)).has(parentAnswer)) return "closed";
        const received = await tx.runFollowup.findMany({ select: { text: true }, where: { modelRunId: runId, origin: { in: FROM_SUBAGENTS } } });
        if (received.length >= SUBAGENT_FOLLOWUP_LIMITS.callbacksPerRun) return "closed";
        if (turn.state === "waiting" && turn.reasonCode === SUBAGENT_WAIT_REASONS.answer) {
          const question = (await askedQuestions(tx, [{ id: turnId, runId: turn.executionRun?.id ?? null }])).get(turnId);
          if (!question || await claimTurns(tx, { chatId, claims: [{ callId: question.callId, kind: "question", turnId }], runId }) !== 1) return "claimed";
          await addRunFollowup(tx, run, { authorName: turn.thread.name, chatId, nonce: subagentQuestionNonce(question.callId),
            origin: "subagent_question", subagentTurnId: turnId, text: renderQuestionFollowup({ name: turn.thread.name, question: question.text }) });
          return "delivered";
        }
        const ended = decodeSubagentCallResult(turn.result);
        if (ended?.kind !== "ended") return "claimed";
        // Bounded to what is left of the run's follow-up reserve, with a cut mark; the whole result stays on the turn.
        const reserve = typeof run.reserveTokens === "number" && Number.isSafeInteger(run.reserveTokens) && run.reserveTokens > 0
          ? run.reserveTokens : SUBAGENT_CALLBACK_DEFAULT_RESERVE_TOKENS;
        const spent = received.reduce((sum, entry) => sum + followupTokenCost(entry.text), 0);
        const text = renderCallbackFollowup({ name: turn.thread.name, result: ended, turnId },
          { tokens: Math.max(SUBAGENT_CALLBACK_MIN_TOKENS, reserve - spent) });
        if (await claimTurns(tx, { chatId, claims: [{ kind: "callback", turnId }], runId }) !== 1) return "claimed";
        await addRunFollowup(tx, run, { authorName: "Sub-agent", chatId, nonce: subagentCallbackNonce(turnId), origin: "subagent_callback",
          subagentTurnId: turnId, text });
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
        WHERE turn."mode" = 'background' AND (
            (turn."endedAt" IS NOT NULL AND turn."endedAt" < ${endedBefore}) OR
            (turn."state" = 'waiting' AND turn."reasonCode" = ${SUBAGENT_WAIT_REASONS.answer} AND turn."updatedAt" < ${endedBefore}))
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
