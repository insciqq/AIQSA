import { Prisma, type PrismaClient, type SubagentBindingSource, type SubagentTurnMode, type SubagentTurnState } from "@prisma/client";
import {
  SUBAGENT_END_REASONS,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_LIMITS,
  type EndedSubagentCallResult,
  type SubagentErrorCode
} from "../../../contracts/subagents";
import { dispatchableModelRunStatuses, json } from "../../runs/prismaRepositoryShared";
import type { SubagentBinding } from "../../subagents/ports";
import type { TranscriptItem } from "../transcript";
import { decodeTranscriptItem } from "../transcriptCodec";
import { attemptFenced, durableAttemptTimes, withRecordedAt } from "../transcriptRepository";

/**
 * Sub-agent threads and turns of a chat (`SubagentThread`, `SubagentTurn`).
 * A thread is visible on a branch where its anchor run is (the main-agent run
 * whose call started it): `branchRunIds` are the native runs of the
 * branch's answers and the running one, so editing an earlier message or
 * regenerating an answer branches threads like the conversation. A foreground
 * turn runs inside its parent run; one whose parent run is no longer active
 * (a restart ended it as interrupted, `agent_docs/RUN_CONTRACTS.md`) is ended
 * as interrupted the next time its chat admits a turn, never resumed. Every
 * query names the owner and chat.
 */

export type SubagentThreadRecord = Readonly<{
  anchorRunId: string;
  definitionId: string | null;
  id: string;
  name: string;
  typeName: string | null;
}>;

export type SubagentTurnRecord = Readonly<{
  definitionRevisionId: string | null;
  effortSource: SubagentBindingSource;
  id: string;
  mode: SubagentTurnMode;
  modelId: string;
  modelSource: SubagentBindingSource;
  parentRunId: string;
  provider: string;
  providerModelId: string | null;
  reasoningEffort: string | null;
  startedAt: Date;
  state: SubagentTurnState;
  threadId: string;
}>;

export type SubagentThreadLookup = Readonly<{
  /** The thread's active turn on any branch, if any (one active run per thread). */
  active: SubagentTurnRecord | null;
  /** The thread's latest turn on this branch: what a continuation keeps of its binding. */
  latest: SubagentTurnRecord | null;
  thread: SubagentThreadRecord;
}>;

export type SubagentForegroundAdmission = Readonly<{
  binding: SubagentBinding;
  branchRunIds: readonly string[];
  chatId: string;
  definitionId: string | null;
  definitionRevisionId: string | null;
  name: string;
  /** The parent run, which anchors a new thread. */
  parentRunId: string;
  /** The `call_subagent` call's `ModelRunToolCall` row. */
  parentToolCallId: string;
  typeName: string | null;
  userId: string;
}>;

export type SubagentAdmissionResult =
  | Readonly<{ continued: boolean; kind: "admitted"; thread: SubagentThreadRecord; turn: SubagentTurnRecord }>
  | Readonly<{ code: SubagentErrorCode; kind: "refused" }>;

export type SubagentTurnSettlement = Readonly<{
  chatId: string;
  result: EndedSubagentCallResult;
  turnId: string;
  userId: string;
}>;

const ACTIVE: SubagentTurnState[] = ["running", "waiting"];
/** An active turn that still runs: a background one (its own run settles it), or a foreground one whose parent runs. */
const LIVE_TURN = { OR: [{ mode: "background" as const }, { parentRun: { status: { in: dispatchableModelRunStatuses } } }] };

const turnSelect = {
  definitionRevisionId: true, effortSource: true, id: true, mode: true, modelId: true, modelSource: true, parentRunId: true,
  provider: true, providerModelId: true, reasoningEffort: true, startedAt: true, state: true, threadId: true
} as const;
const threadSelect = { anchorRunId: true, definitionId: true, id: true, name: true, typeName: true } as const;

type StoreClient = Pick<PrismaClient, "$transaction" | "modelRun" | "modelRunToolCall" | "runTranscriptItem" | "subagentThread" | "subagentTurn">;

/** Runs one fence read takes: a branch longer than this is beyond any context window (`TRANSCRIPT_LOAD_RUN_LIMIT`). */
const EFFECT_RUN_LIMIT = 2_000;

/** The transaction lock under which a chat's sub-agent admissions count its running turns (the 20-running cap). */
export async function lockChatSubagentAdmission(tx: Prisma.TransactionClient, chatId: string): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`aiqsa:subagent-admission:${chatId}`}, 0))::text AS "lock"
  `);
}

/** The result of a turn its parent run left behind (a restart): interrupted, with nothing reported. */
function interruptedResult(name: string, turn: Pick<SubagentTurnRecord, "modelId" | "reasoningEffort">): EndedSubagentCallResult {
  return { approvals: [], files: [], kind: "ended", model: { effort: turn.reasoningEffort, id: turn.modelId }, name,
    reason: SUBAGENT_END_REASONS.restart, report: "", state: "interrupted", steps: [] };
}

/**
 * Ends the chat's foreground turns whose parent run is no longer active, so
 * they neither count toward the cap nor keep their thread busy; returns how
 * many it ended. A background turn is its own run's to settle.
 */
async function endOrphanedForegroundTurns(tx: Prisma.TransactionClient, chatId: string, userId: string): Promise<number> {
  const orphans = await tx.subagentTurn.findMany({
    select: { ...turnSelect, thread: { select: { name: true } } },
    where: { chatId, mode: "foreground", parentRun: { status: { notIn: dispatchableModelRunStatuses } }, state: { in: ACTIVE }, userId }
  });
  for (const turn of orphans) {
    await tx.subagentTurn.updateMany({
      data: { endedAt: new Date(), reasonCode: SUBAGENT_END_REASONS.restart, result: json(interruptedResult(turn.thread.name, turn)),
        state: "interrupted" },
      where: { id: turn.id, state: { in: ACTIVE } }
    });
  }
  return orphans.length;
}

/** Active turns of the chat on every branch: what the cap counts. */
async function runningTurns(tx: Prisma.TransactionClient, chatId: string, userId: string): Promise<number> {
  return tx.subagentTurn.count({ where: { chatId, state: { in: ACTIVE }, userId } });
}

async function visibleThread(tx: Pick<Prisma.TransactionClient, "subagentThread">, input: Readonly<{
  branchRunIds: readonly string[]; chatId: string; name: string; userId: string;
}>): Promise<SubagentThreadRecord | null> {
  if (input.branchRunIds.length === 0) return null;
  return tx.subagentThread.findFirst({
    orderBy: { createdAt: "desc" },
    select: threadSelect,
    where: { anchorRunId: { in: [...new Set(input.branchRunIds)] }, chatId: input.chatId, name: input.name, userId: input.userId }
  });
}

export function createSubagentThreadStore(client: StoreClient) {
  return {
    /** The thread of this name visible on the branch, with its latest turn there and its active turn anywhere. */
    async find(input: Readonly<{ branchRunIds: readonly string[]; chatId: string; name: string; userId: string }>):
      Promise<SubagentThreadLookup | null> {
      const thread = await visibleThread(client, input);
      if (!thread) return null;
      const [latest, active] = await Promise.all([
        client.subagentTurn.findFirst({ orderBy: { startedAt: "desc" }, select: turnSelect,
          where: { chatId: input.chatId, parentRunId: { in: [...new Set(input.branchRunIds)] }, threadId: thread.id, userId: input.userId } }),
        // A foreground turn whose parent run ended (a restart) no longer runs: it is no active turn, and the next locked
        // admission ends it as interrupted.
        client.subagentTurn.findFirst({ orderBy: { startedAt: "desc" }, select: turnSelect,
          where: { chatId: input.chatId, state: { in: ACTIVE }, threadId: thread.id, userId: input.userId, ...LIVE_TURN } })
      ]);
      return { active, latest, thread };
    },

    /**
     * Admits a foreground turn of the name: a new thread anchored to the
     * parent run, or the branch's visible one. Under the chat's admission
     * lock it ends orphaned foreground turns, refuses a thread that runs a
     * turn (`subagent_busy`) and a chat that already runs
     * `SUBAGENT_LIMITS.runningPerChat` turns (`subagent_limit_reached`), then
     * records the turn running with its binding. A refusal writes nothing.
     */
    async admitForeground(input: SubagentForegroundAdmission): Promise<SubagentAdmissionResult> {
      return client.$transaction(async (tx) => {
        await lockChatSubagentAdmission(tx, input.chatId);
        await endOrphanedForegroundTurns(tx, input.chatId, input.userId);
        let thread = await visibleThread(tx, { branchRunIds: [...input.branchRunIds, input.parentRunId], chatId: input.chatId,
          name: input.name, userId: input.userId });
        const continued = thread !== null;
        if (thread) {
          const active = await tx.subagentTurn.findFirst({ select: { id: true },
            where: { chatId: input.chatId, state: { in: ACTIVE }, threadId: thread.id, userId: input.userId } });
          if (active) return { code: SUBAGENT_ERROR_CODES.busy, kind: "refused" as const };
        }
        if (await runningTurns(tx, input.chatId, input.userId) >= SUBAGENT_LIMITS.runningPerChat) {
          return { code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" as const };
        }
        thread ??= await tx.subagentThread.create({ data: { anchorRunId: input.parentRunId, chatId: input.chatId,
          definitionId: input.definitionId, name: input.name, typeName: input.typeName, userId: input.userId }, select: threadSelect });
        const turn = await tx.subagentTurn.create({ data: {
          chatId: input.chatId, definitionRevisionId: input.definitionRevisionId, effortSource: input.binding.effortSource,
          mode: "foreground", modelId: input.binding.modelId, modelSource: input.binding.modelSource, parentRunId: input.parentRunId,
          parentToolCallId: input.parentToolCallId, provider: input.binding.provider, providerModelId: input.binding.providerModelId,
          reasoningEffort: input.binding.reasoningEffort, state: "running", threadId: thread.id, userId: input.userId
        }, select: turnSelect });
        return { continued, kind: "admitted" as const, thread, turn };
      });
    },

    /**
     * The branch's visible thread of the name, or a new one anchored to the
     * parent run: what a background turn's admission runs on. Two calls of one
     * round that start one name meet one row (`(chatId, anchorRunId, name)`).
     */
    async ensureThread(input: Readonly<{ branchRunIds: readonly string[]; chatId: string; definitionId: string | null; name: string;
      parentRunId: string; typeName: string | null; userId: string }>): Promise<SubagentThreadRecord> {
      const visible = await visibleThread(client, { ...input, branchRunIds: [...input.branchRunIds, input.parentRunId] });
      if (visible) return visible;
      return client.subagentThread.upsert({
        create: { anchorRunId: input.parentRunId, chatId: input.chatId, definitionId: input.definitionId, name: input.name,
          typeName: input.typeName, userId: input.userId },
        select: threadSelect,
        update: {},
        where: { chatId_anchorRunId_name: { anchorRunId: input.parentRunId, chatId: input.chatId, name: input.name } }
      });
    },

    /** Ends, under the chat's admission lock, the foreground turns whose parent run no longer runs; how many it ended. */
    async endOrphanedTurns(input: Readonly<{ chatId: string; userId: string }>): Promise<number> {
      return client.$transaction(async (tx) => {
        await lockChatSubagentAdmission(tx, input.chatId);
        return endOrphanedForegroundTurns(tx, input.chatId, input.userId);
      });
    },

    /** Marks an active turn as waiting for the user (a browser handoff) or running again. */
    async setActiveState(input: Readonly<{ chatId: string; state: "running" | "waiting"; turnId: string; userId: string }>): Promise<boolean> {
      const updated = await client.subagentTurn.updateMany({ data: { state: input.state },
        where: { chatId: input.chatId, id: input.turnId, state: { in: ACTIVE }, userId: input.userId } });
      return updated.count === 1;
    },

    /** Ends an active turn with its result; a turn that already ended keeps how it ended. */
    async settle(input: SubagentTurnSettlement): Promise<boolean> {
      const result = input.result;
      const updated = await client.subagentTurn.updateMany({
        data: { endedAt: new Date(), outcome: result.state === "done" ? result.outcome ?? "done" : null,
          reasonCode: result.reason ?? null, result: json(result), state: result.state },
        where: { chatId: input.chatId, id: input.turnId, state: { in: ACTIVE }, userId: input.userId }
      });
      return updated.count === 1;
    },

    /**
     * The tool calls and results of every sub-agent thread in these runs of
     * the chat, one list per run and thread in sequence order, runs in the
     * order given: what the run's one unknown-effect fence must respect
     * (`unknownEffects.ts`). Only the fence reads them; they never enter any
     * model's context.
     */
    async threadEffectItems(input: Readonly<{ chatId: string; runIds: readonly string[]; userId: string }>):
      Promise<Readonly<{ items: TranscriptItem[]; threadId: string }>[]> {
      const runIds = [...new Set(input.runIds)];
      if (runIds.length === 0) return [];
      if (runIds.length > EFFECT_RUN_LIMIT) throw new Error("transcript_load_too_large");
      const rows = await client.runTranscriptItem.findMany({
        orderBy: [{ modelRunId: "asc" }, { subagentThreadId: "asc" }, { sequence: "asc" }],
        select: { body: true, callId: true, createdAt: true, id: true, kind: true, modelRunId: true, subagentThreadId: true },
        where: { chatId: input.chatId, kind: { in: ["tool_call", "tool_result"] }, modelRunId: { in: runIds },
          subagentThreadId: { not: null }, userId: input.userId }
      });
      // A call without a result is fenced from its durable attempt, as the main agent's are (`durableAttemptTimes`).
      const attempts = new Map<string, ReadonlyMap<string, Date>>();
      for (const threadId of new Set(rows.flatMap((row) => row.subagentThreadId ? [row.subagentThreadId] : []))) {
        attempts.set(threadId, await durableAttemptTimes(client, { callIds: rows.flatMap((row) => row.subagentThreadId === threadId &&
          row.callId && attemptFenced(decodeTranscriptItem(row)) ? [row.callId] : []), runIds, threadId }));
      }
      const lists = new Map<string, TranscriptItem[]>();
      for (const row of rows) {
        const key = `${row.modelRunId}\n${row.subagentThreadId ?? ""}`;
        const item = decodeTranscriptItem(row);
        const recorded = withRecordedAt(item, row, attempts.get(row.subagentThreadId ?? "") ?? new Map());
        lists.set(key, [...lists.get(key) ?? [], recorded]);
      }
      return runIds.flatMap((runId) => [...lists].filter(([key]) => key.startsWith(`${runId}\n`))
        .map(([key, items]) => ({ items, threadId: key.slice(runId.length + 1) })));
    },

    /**
     * The runs that hold one thread's items on a branch, in turn order: a foreground turn's parent run, a background
     * turn's own run. `parentRunIds` are the branch's main-agent runs; a turn started elsewhere is not on it.
     */
    async threadRunIds(input: Readonly<{ chatId: string; parentRunIds: readonly string[]; threadId: string; userId: string }>):
      Promise<string[]> {
      const parentRunIds = [...new Set(input.parentRunIds)];
      if (parentRunIds.length === 0) return [];
      const turns = await client.subagentTurn.findMany({ orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        select: { executionRun: { select: { id: true } }, mode: true, parentRunId: true },
        where: { chatId: input.chatId, parentRunId: { in: parentRunIds }, threadId: input.threadId, userId: input.userId } });
      return [...new Set(turns.flatMap((turn) => turn.mode === "foreground" ? [turn.parentRunId]
        : turn.executionRun ? [turn.executionRun.id] : []))];
    },

    /** The background turns' own runs started by these main-agent runs, oldest first: their threads' records. */
    async backgroundRunIds(input: Readonly<{ chatId: string; parentRunIds: readonly string[]; userId: string }>): Promise<string[]> {
      const parentRunIds = [...new Set(input.parentRunIds)];
      if (parentRunIds.length === 0) return [];
      const runs = await client.modelRun.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
        where: { chatId: input.chatId, subagentTurn: { is: { mode: "background", parentRunId: { in: parentRunIds } } },
          userId: input.userId } });
      return runs.map((run) => run.id);
    },

    /** The stored result of an ended turn of the chat; null while it runs or when it is not the chat's. */
    async result(input: Readonly<{ chatId: string; turnId: string; userId: string }>): Promise<unknown> {
      const row = await client.subagentTurn.findFirst({ select: { result: true },
        where: { chatId: input.chatId, id: input.turnId, state: { notIn: ACTIVE }, userId: input.userId } });
      return row?.result ?? null;
    }
  };
}

export type SubagentThreadStore = ReturnType<typeof createSubagentThreadStore>;
