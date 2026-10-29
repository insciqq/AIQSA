import { Prisma, type PrismaClient } from "@prisma/client";
import { MCP_APPROVAL_CONTINUATION_KIND } from "../../contracts/mcpApprovals";
import { json } from "../runs/prismaRepositoryShared";
import { decodeTranscriptItem, encodeTranscriptItem } from "./transcriptCodec";
import type { TranscriptItem } from "./transcript";

/**
 * One native run, named with the owner and chat every read and write carries.
 * `thread`: a sub-agent thread's own transcript inside the run (`SubagentThread`,
 * with the turn that writes), which keeps its own sequence; absent for the
 * main agent, whose items carry no thread key.
 */
export type TranscriptRunScope = Readonly<{ chatId: string; runId: string; thread?: TranscriptThreadKey; userId: string }>;

/** The thread key of a sub-agent's items: its thread and the turn that wrote them. */
export type TranscriptThreadKey = Readonly<{ threadId: string; turnId: string }>;

type TranscriptClient = Pick<PrismaClient, "message" | "modelRun" | "modelRunToolCall" | "runTranscriptItem">;

/**
 * One run of the old core on a branch, with the effect records of its tool
 * calls (`retiredRunEffects`): what an equivalent native call must respect.
 */
export type RetiredRunEffects = Readonly<{
  assistantMessageId: string;
  /** Tool call and result items in the run's call order, for the unknown-effect guard only; never sent to a model. */
  items: readonly TranscriptItem[];
  userMessageId: string;
}>;

/** A native run whose stopped answer the branch's next turn follows (`nativeRunsBeforeTurns`). */
export type NativeRunBeforeTurn = Readonly<{
  assistantMessageId: string;
  nextUserMessageId: string;
  /**
   * The stopped answer is a step of an answer review recorded before the
   * feature's removal, or an answer to one of its steps' turns
   * (`lib/server/chats/legacyAnswerReviews.ts`): the branch reads without it,
   * so its run's items never return to the conversation, and only its calls
   * still count for the unknown-effect guard.
   */
  reviewStep?: true;
  runId: string;
}>;

/** Old-core calls one branch read takes of each kind: more unknown outcomes than this are beyond any chat. */
const RETIRED_EFFECT_CALL_LIMIT = 2_000;

/**
 * An old-core call whose outcome is unknown: still running, or closed with an
 * unknown outcome (`runEndedToolCallResult`, which retirement writes for a
 * call its run left running, or the old core's own interrupted calls).
 */
const unknownOldCoreCall = {
  OR: [{ state: "running" as const }, { result: { equals: "unknown", path: ["outcome"] }, state: "error" as const }]
};

/**
 * When each of these calls was last attempted, by run and provider call id:
 * the latest of its `ModelRunToolCall` rows' start and end (the dispatch, or
 * the run's ending that closed it). A round's call items are recorded before
 * its batch runs, so a call queued behind slower ones was sent later than its
 * item says; an unknown effect without a result is fenced from the durable
 * attempt, never from the model's response (`unknownEffects.ts`).
 */
export async function durableAttemptTimes(client: Pick<PrismaClient, "modelRunToolCall">, input: Readonly<{
  callIds: readonly string[]; runIds: readonly string[]; threadId: string | null;
}>): Promise<ReadonlyMap<string, Date>> {
  const callIds = [...new Set(input.callIds)];
  if (callIds.length === 0 || input.runIds.length === 0) return new Map();
  const rows = await client.modelRunToolCall.findMany({
    select: { completedAt: true, modelRunId: true, providerCallId: true, startedAt: true },
    where: { modelRunId: { in: [...new Set(input.runIds)] }, providerCallId: { in: callIds }, subagentThreadId: input.threadId }
  });
  const times = new Map<string, Date>();
  for (const row of rows) {
    const key = `${row.modelRunId}\n${row.providerCallId}`;
    for (const at of [row.startedAt, row.completedAt]) {
      if (at && at.getTime() > (times.get(key)?.getTime() ?? Number.NEGATIVE_INFINITY)) times.set(key, at);
    }
  }
  return times;
}

/** A call item's fence time: its durable attempt when later than the item's own record. */
export function attemptRecordedAt(row: Readonly<{ callId: string | null; createdAt: Date; modelRunId: string }>,
  attempts: ReadonlyMap<string, Date>): Date {
  const attempt = row.callId ? attempts.get(`${row.modelRunId}\n${row.callId}`) : undefined;
  return attempt && attempt.getTime() > row.createdAt.getTime() ? attempt : row.createdAt;
}

/** Runs one transcript load may read: a branch longer than this is beyond any context window. */
export const TRANSCRIPT_LOAD_RUN_LIMIT = 2_000;

/**
 * Durable transcript of native runs (`RunTranscriptItem`). Every query names
 * the run's owner and chat, and the composite foreign key makes a row of
 * another user's or another chat's run unwritable, so a transcript is only
 * ever read and written inside its own chat.
 */
export function createTranscriptRepository(client: TranscriptClient) {
  return {
    /** The sequence the run's next item of this agent (the main agent, or the scope's thread) takes: 0 for none yet. */
    async nextSequence(scope: TranscriptRunScope): Promise<number> {
      const last = await client.runTranscriptItem.findFirst({
        orderBy: { sequence: "desc" },
        select: { sequence: true },
        where: { chatId: scope.chatId, modelRunId: scope.runId, subagentThreadId: scope.thread?.threadId ?? null,
          userId: scope.userId }
      });
      return last ? last.sequence + 1 : 0;
    },

    /**
     * Appends items in order from sequence `from`; a taken sequence refuses the
     * whole batch. Repeating a batch that committed already (its outcome was
     * lost) finds exactly its own rows and succeeds without a second copy.
     */
    async append(scope: TranscriptRunScope, from: number, items: readonly TranscriptItem[]): Promise<void> {
      if (items.length === 0) return;
      if (!Number.isSafeInteger(from) || from < 0) throw new Error("transcript_sequence_invalid");
      const rows = items.map((item, index) => {
        const fields = encodeTranscriptItem(item);
        return {
          body: json(fields.body),
          callId: fields.callId,
          chatId: scope.chatId,
          id: item.id,
          kind: fields.kind,
          modelRunId: scope.runId,
          sequence: from + index,
          subagentThreadId: scope.thread?.threadId ?? null,
          subagentTurnId: scope.thread?.turnId ?? null,
          userId: scope.userId
        };
      });
      try {
        await client.runTranscriptItem.createMany({ data: rows });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        const written = await client.runTranscriptItem.count({ where: { chatId: scope.chatId, modelRunId: scope.runId,
          OR: rows.map((row) => ({ id: row.id, sequence: row.sequence })), subagentThreadId: scope.thread?.threadId ?? null,
          userId: scope.userId } });
        if (written !== rows.length) throw error;
      }
    },

    /**
     * The items of these runs of one chat and owner, by run, each in sequence
     * order: the main agent's (no thread key), or with `threadId` that
     * sub-agent thread's own. A thread's items never enter the main agent's
     * context, and another thread's never enter a thread's.
     */
    async loadRuns(input: Readonly<{ chatId: string; runIds: readonly string[]; threadId?: string; userId: string }>):
      Promise<Map<string, TranscriptItem[]>> {
      const runIds = [...new Set(input.runIds)];
      const loaded = new Map<string, TranscriptItem[]>(runIds.map((runId) => [runId, []]));
      if (runIds.length === 0) return loaded;
      if (runIds.length > TRANSCRIPT_LOAD_RUN_LIMIT) throw new Error("transcript_load_too_large");
      const rows = await client.runTranscriptItem.findMany({
        orderBy: [{ modelRunId: "asc" }, { sequence: "asc" }],
        select: { body: true, callId: true, createdAt: true, id: true, kind: true, modelRunId: true },
        where: { chatId: input.chatId, modelRunId: { in: runIds }, subagentThreadId: input.threadId ?? null, userId: input.userId }
      });
      const attempts = await durableAttemptTimes(client, { callIds: rows.flatMap((row) => row.kind === "tool_call" && row.callId
        ? [row.callId] : []), runIds, threadId: input.threadId ?? null });
      for (const row of rows) {
        const item = decodeTranscriptItem(row);
        loaded.get(row.modelRunId)?.push(item.kind === "tool_call" || item.kind === "tool_result"
          ? { ...item, recordedAt: item.kind === "tool_call" ? attemptRecordedAt(row, attempts) : row.createdAt } : item);
      }
      return loaded;
    },

    /**
     * The native run that answered each of these assistant messages of one
     * chat and owner. A message answered by the old core has none: its text
     * is its history.
     */
    async nativeRunsForAnswers(input: Readonly<{ assistantMessageIds: readonly string[]; chatId: string; userId: string }>):
      Promise<Map<string, string>> {
      const ids = [...new Set(input.assistantMessageIds)];
      if (ids.length === 0) return new Map();
      if (ids.length > TRANSCRIPT_LOAD_RUN_LIMIT) throw new Error("transcript_load_too_large");
      const runs = await client.modelRun.findMany({
        orderBy: { createdAt: "asc" },
        select: { assistantMessageId: true, id: true },
        where: { assistantMessageId: { in: ids }, chatId: input.chatId, engine: "native", userId: input.userId }
      });
      // An answer has one run; the newest wins should a message ever carry more.
      return new Map(runs.flatMap((run) => run.assistantMessageId ? [[run.assistantMessageId, run.id] as const] : []));
    },

    /**
     * Native runs whose answer stopped (error or cancelled) and is the parent
     * of one of these user messages of the branch, with that message. The
     * context leaves an answer that stopped without text out, but the next
     * turn still follows it, so this is how its tool steps and results (and
     * their unknown effects) stay on the branch. A sibling answer, or one
     * whose next turn left the branch, is the parent of none of them. Every
     * query names the owner and chat.
     */
    async nativeRunsBeforeTurns(input: Readonly<{ chatId: string; userId: string; userMessageIds: readonly string[] }>):
      Promise<NativeRunBeforeTurn[]> {
      const ids = [...new Set(input.userMessageIds)];
      if (ids.length === 0) return [];
      if (ids.length > TRANSCRIPT_LOAD_RUN_LIMIT) throw new Error("transcript_load_too_large");
      const children = { chatId: input.chatId, id: { in: ids } };
      const runs = await client.modelRun.findMany({
        orderBy: { createdAt: "asc" },
        select: { assistantMessage: { select: { answerReviewSessionId: true, parent: { select: { answerReviewSessionId: true } },
          children: { select: { id: true }, take: 1, where: children } } }, assistantMessageId: true, id: true },
        where: { chatId: input.chatId, engine: "native", userId: input.userId, assistantMessage: {
          chatId: input.chatId, children: { some: children }, status: { in: ["cancelled", "error"] } } }
      });
      // An answer has one run; the newest wins should a message ever carry more.
      const byAnswer = new Map<string, NativeRunBeforeTurn>();
      for (const run of runs) {
        const next = run.assistantMessage?.children[0]?.id;
        if (run.assistantMessageId && next) {
          byAnswer.set(run.assistantMessageId, { assistantMessageId: run.assistantMessageId, nextUserMessageId: next, runId: run.id,
            // A legacy review step, or a revision copy under one (`lib/server/chats/legacyAnswerReviews.ts`): its calls
            // count, its answer stays off the branch.
            ...(run.assistantMessage?.answerReviewSessionId || run.assistantMessage?.parent?.answerReviewSessionId
              ? { reviewStep: true as const } : {}) });
        }
      }
      return [...byAnswer.values()];
    },

    /**
     * The old core's runs that answered this branch, each with its calls
     * whose outcome is unknown and the completed calls of the same tools,
     * which settle an earlier equivalent one. The native conversation carries
     * those answers only as text, or not at all when they stopped without
     * text, so this is how a native run still respects an effect the old core
     * left unknown (`unknownEffects.ts`). A run is on the branch when it
     * answered one of the branch's answers (`assistantMessageIds`) or the
     * message one of the branch's user messages (`userMessageIds`) follows: an
     * answer that stopped without text is left out of the context but stays
     * the parent of the next turn. Every query names the owner and chat.
     */
    async retiredRunEffects(input: Readonly<{ assistantMessageIds: readonly string[]; chatId: string; userId: string;
      userMessageIds: readonly string[] }>): Promise<RetiredRunEffects[]> {
      const answerIds = [...new Set(input.assistantMessageIds)];
      const userIds = [...new Set(input.userMessageIds)];
      if (answerIds.length === 0 && userIds.length === 0) return [];
      if (answerIds.length > TRANSCRIPT_LOAD_RUN_LIMIT || userIds.length > TRANSCRIPT_LOAD_RUN_LIMIT) {
        throw new Error("transcript_load_too_large");
      }
      const runs = await client.modelRun.findMany({
        orderBy: { createdAt: "asc" },
        select: { assistantMessageId: true, id: true, userMessageId: true },
        where: { chatId: input.chatId, engine: "v1", userId: input.userId, OR: [
          { assistantMessageId: { in: answerIds } },
          { assistantMessage: { chatId: input.chatId, children: { some: { chatId: input.chatId, id: { in: userIds } } } } }
        ] }
      });
      if (runs.length === 0) return [];
      const runIds = runs.map((run) => run.id);
      const orderBy = [{ modelRunId: "asc" as const }, { roundIndex: "asc" as const }, { ordinal: "asc" as const }];
      const select = { arguments: true, completedAt: true, createdAt: true, id: true, modelRunId: true, ordinal: true,
        roundIndex: true, startedAt: true, toolName: true };
      const unknown = await client.modelRunToolCall.findMany({ orderBy, select, take: RETIRED_EFFECT_CALL_LIMIT,
        where: { modelRunId: { in: runIds }, ...unknownOldCoreCall } });
      if (unknown.length === 0) return [];
      const completed = await client.modelRunToolCall.findMany({ orderBy, select, take: RETIRED_EFFECT_CALL_LIMIT,
        where: { modelRunId: { in: runIds }, state: "complete", toolName: { in: [...new Set(unknown.map((call) => call.toolName))] } } });
      const unknownIds = new Set(unknown.map((call) => call.id));
      const calls = [...unknown, ...completed].sort((a, b) => a.roundIndex - b.roundIndex || a.ordinal - b.ordinal);
      return runs.flatMap((run) => {
        const items = calls.filter((call) => call.modelRunId === run.id && isJsonObject(call.arguments)).flatMap((call) => {
          const callId = `retired-${call.id}`;
          return [
            { arguments: JSON.stringify(call.arguments), callId, id: `${callId}-call`, kind: "tool_call", name: call.toolName,
              recordedAt: call.startedAt ?? call.createdAt },
            { callId, id: `${callId}-result`, kind: "tool_result", name: call.toolName,
              outcome: unknownIds.has(call.id) ? "unknown" : "complete", output: "",
              recordedAt: call.completedAt ?? call.startedAt ?? call.createdAt }
          ] satisfies TranscriptItem[];
        });
        return items.length > 0 && run.assistantMessageId
          ? [{ assistantMessageId: run.assistantMessageId, items, userMessageId: run.userMessageId }] : [];
      });
    },

    /**
     * The run is still on record and its chat is not being deleted: what a
     * compaction finishing after its run checks before it records anything.
     */
    async runLive(scope: TranscriptRunScope): Promise<boolean> {
      const run = await client.modelRun.findFirst({
        select: { id: true },
        where: { chat: { permanentDeletionAt: null }, chatId: scope.chatId, id: scope.runId, userId: scope.userId }
      });
      return run !== null;
    },

    /** Which of these user messages of the chat are approval continuation turns the server wrote. */
    async approvalContinuationTurns(input: Readonly<{ chatId: string; messageIds: readonly string[] }>): Promise<Set<string>> {
      const ids = [...new Set(input.messageIds)];
      if (ids.length === 0) return new Set();
      const rows = await client.message.findMany({
        select: { id: true },
        where: { chatId: input.chatId, id: { in: ids }, role: "user", systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND }
      });
      return new Set(rows.map((row) => row.id));
    }
  };
}

export type TranscriptRepository = ReturnType<typeof createTranscriptRepository>;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
