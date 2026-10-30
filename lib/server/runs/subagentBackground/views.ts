import type { Prisma, PrismaClient } from "@prisma/client";
import {
  SUBAGENT_LIMITS,
  isActiveSubagentState,
  isSubagentCode,
  isSubagentOutcome,
  normalizeSubagentName,
  type SubagentOutcome,
  type SubagentThreadState
} from "../../../contracts/subagents";
import {
  SUBAGENT_VIEW_LIMITS,
  type SubagentChatThreads,
  type SubagentSummaryResponse,
  type SubagentThreadSummary,
  type SubagentThreadView,
  type SubagentTurnMessage,
  type SubagentTurnView
} from "../../../contracts/subagentViews";
import { summarizeMessageRunToolActivity } from "../../chats/prismaRepository";
import { branchPathMessageIds } from "../../toolObservations/repository";
import { impliedResult } from "./store";

/**
 * The owner-only projections of a chat's sub-agents
 * (`lib/contracts/subagentViews.ts`): only the chat's active branch, only the
 * owner's own chat while it is not pending deletion, content-free apart from
 * names, briefs and reports. A missing chat or thread and one the caller may
 * not see read the same (null).
 */

const turnSelect = {
  endedAt: true, id: true, mode: true, modelId: true, outcome: true, parentRunId: true, parentToolCallId: true,
  providerModelId: true, reasonCode: true, reasoningEffort: true, result: true, startedAt: true, state: true, updatedAt: true,
  executionRun: { select: { id: true } },
  parentRun: { select: { assistantMessageId: true } }
} satisfies Prisma.SubagentTurnSelect;

type TurnRow = Prisma.SubagentTurnGetPayload<{ select: typeof turnSelect }>;

type ThreadRow = Readonly<{
  createdAt: Date; id: string; name: string; typeName: string | null; updatedAt: Date;
  anchorRun: Readonly<{ assistantMessageId: string | null }>;
  turns: readonly TurnRow[];
}>;

const threadSelect = {
  anchorRun: { select: { assistantMessageId: true } }, createdAt: true, id: true, name: true, typeName: true, updatedAt: true,
  turns: { orderBy: [{ startedAt: "asc" }, { id: "asc" }], select: turnSelect }
} satisfies Prisma.SubagentThreadSelect;

const onPath = (path: ReadonlySet<string>, messageId: string | null) => messageId !== null && path.has(messageId);

/** Turns of a thread on the branch, oldest first; the last is the thread's state there. */
function branchTurns(thread: ThreadRow, path: ReadonlySet<string>): readonly TurnRow[] {
  return thread.turns.filter((turn) => onPath(path, turn.parentRun.assistantMessageId));
}

function outcomeOf(state: SubagentThreadState, outcome: string | null): SubagentOutcome | null {
  if (state !== "done") return null;
  return isSubagentOutcome(outcome) ? outcome : "done";
}

function summarize(thread: ThreadRow, turns: readonly TurnRow[]): SubagentThreadSummary | null {
  const latest = turns.at(-1);
  if (!latest) return null;
  const state = latest.state;
  const updatedAt = new Date(Math.max(thread.updatedAt.getTime(), latest.updatedAt.getTime()));
  return {
    createdAt: thread.createdAt.toISOString(),
    endedAt: isActiveSubagentState(state) ? null : (latest.endedAt ?? latest.updatedAt).toISOString(),
    id: thread.id,
    mode: latest.mode,
    name: thread.name,
    outcome: outcomeOf(state, latest.outcome),
    reason: isSubagentCode(latest.reasonCode) ? latest.reasonCode : null,
    state,
    turnCount: turns.length,
    type: thread.typeName !== null && normalizeSubagentName(thread.typeName) === thread.typeName ? thread.typeName : null,
    updatedAt: updatedAt.toISOString()
  };
}

function boundedText(value: string, max: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= max ? characters.join("") : characters.slice(0, max).join("");
}

export type SubagentViews = Readonly<{
  /** The chat's threads on its active branch; null when the caller may not see the chat. */
  chatThreads(input: Readonly<{ chatId: string; userId: string }>): Promise<SubagentChatThreads | null>;
  /** The chats among these that the caller owns and that have sub-agents on their active branch. */
  summary(input: Readonly<{ chatIds: readonly string[]; userId: string }>): Promise<SubagentSummaryResponse>;
  /** One thread on the chat's active branch; null otherwise. */
  thread(input: Readonly<{ chatId: string; threadId: string; userId: string }>): Promise<SubagentThreadSummary | null>;
  threadView(input: Readonly<{ chatId: string; threadId: string; userId: string }>): Promise<SubagentThreadView | null>;
  /** Whether the caller owns this chat and it is not pending deletion ("Stop all"). */
  ownsChat(input: Readonly<{ chatId: string; userId: string }>): Promise<boolean>;
}>;

export function createSubagentViews(client: PrismaClient): SubagentViews {
  async function activePath(tx: Prisma.TransactionClient, chatId: string, userId: string): Promise<ReadonlySet<string> | null> {
    const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true }, where: { id: chatId, permanentDeletionAt: null, userId } });
    if (!chat) return null;
    return chat.activeLeafMessageId ? branchPathMessageIds(tx, chatId, chat.activeLeafMessageId) : new Set<string>();
  }

  async function chatThreads(tx: Prisma.TransactionClient, chatId: string, userId: string): Promise<SubagentChatThreads | null> {
    const path = await activePath(tx, chatId, userId);
    if (!path) return null;
    const threads = await tx.subagentThread.findMany({ orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: threadSelect,
      where: { chatId, userId } });
    const visible = threads.flatMap((thread) => {
      if (!onPath(path, thread.anchorRun.assistantMessageId)) return [];
      const summary = summarize(thread, branchTurns(thread, path));
      return summary ? [summary] : [];
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const shown = visible.slice(0, SUBAGENT_VIEW_LIMITS.threadsPerChat);
    return { chatId, running: Math.min(SUBAGENT_LIMITS.runningPerChat, shown.filter((thread) => isActiveSubagentState(thread.state)).length),
      threads: shown, truncated: visible.length > shown.length };
  }

  async function visibleThread(tx: Prisma.TransactionClient, input: Readonly<{ chatId: string; threadId: string; userId: string }>) {
    const path = await activePath(tx, input.chatId, input.userId);
    if (!path) return null;
    const thread = await tx.subagentThread.findFirst({ select: threadSelect,
      where: { chatId: input.chatId, id: input.threadId, userId: input.userId } });
    if (!thread || !onPath(path, thread.anchorRun.assistantMessageId)) return null;
    const turns = branchTurns(thread, path);
    const summary = summarize(thread, turns);
    return summary ? { summary, thread, turns } : null;
  }

  return Object.freeze({
    async chatThreads({ chatId, userId }) {
      return client.$transaction((tx) => chatThreads(tx, chatId, userId));
    },

    async summary({ chatIds, userId }) {
      const owned = await client.chat.findMany({ select: { id: true },
        where: { id: { in: [...chatIds] }, permanentDeletionAt: null, subagentThreads: { some: {} }, userId } });
      const chats: SubagentChatThreads[] = [];
      for (const chat of owned) {
        const threads = await client.$transaction((tx) => chatThreads(tx, chat.id, userId));
        if (threads && threads.threads.length > 0) chats.push(threads);
      }
      return { chats };
    },

    async thread(input) {
      return (await client.$transaction((tx) => visibleThread(tx, input)))?.summary ?? null;
    },

    async ownsChat({ chatId, userId }) {
      return (await client.chat.count({ where: { id: chatId, permanentDeletionAt: null, userId } })) === 1;
    },

    async threadView(input) {
      return client.$transaction(async (tx): Promise<SubagentThreadView | null> => {
        const visible = await visibleThread(tx, input);
        if (!visible) return null;
        const shown = visible.turns.slice(-SUBAGENT_VIEW_LIMITS.turnsPerView);
        const hostRunIds = [...new Set(shown.map((turn) => turn.executionRun?.id ?? turn.parentRunId))];
        const [hostRuns, parentRuns, calls, mailbox, models] = await Promise.all([
          tx.modelRun.findMany({ select: { errorPayload: true, id: true, status: true }, where: { id: { in: hostRunIds } } }),
          tx.modelRun.findMany({ select: { id: true, normalizedRequest: true },
            where: { id: { in: [...new Set(shown.map((turn) => turn.parentRunId))] } } }),
          tx.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }], select: {
            arguments: true, completedAt: true, id: true, mcpRunBinding: { select: { runtimeGenerationFingerprint: true } },
            modelRunId: true, ordinal: true, providerCallId: true, result: true, roundIndex: true, startedAt: true, state: true,
            subagentTurnId: true, toolName: true
          }, where: { modelRunId: { in: hostRunIds }, subagentTurnId: { in: shown.map((turn) => turn.id) } } }),
          tx.runFollowup.findMany({ orderBy: { ordinal: "asc" }, select: { createdAt: true, deliveredAt: true, modelRunId: true, text: true },
            where: { modelRunId: { in: shown.flatMap((turn) => turn.executionRun ? [turn.executionRun.id] : []) }, origin: "main_agent" } }),
          tx.providerModel.findMany({ select: { displayName: true, id: true },
            where: { id: { in: shown.flatMap((turn) => turn.providerModelId ? [turn.providerModelId] : []) } } })
        ]);
        // The brief is the main agent's call that started the turn: its `message` argument.
        const parentCalls = await tx.modelRunToolCall.findMany({ select: { arguments: true, id: true, modelRunId: true },
          where: { OR: shown.map((turn) => ({ id: turn.parentToolCallId, modelRunId: turn.parentRunId })) } });
        const turns = shown.map((turn): SubagentTurnView => {
          const hostRunId = turn.executionRun?.id ?? turn.parentRunId;
          const host = hostRuns.find((run) => run.id === hostRunId);
          const parent = parentRuns.find((run) => run.id === turn.parentRunId);
          const call = parentCalls.find((candidate) => candidate.id === turn.parentToolCallId && candidate.modelRunId === turn.parentRunId);
          const args = call?.arguments;
          const brief = typeof args === "object" && args !== null && !Array.isArray(args) && typeof (args as Record<string, unknown>).message === "string"
            ? boundedText((args as Record<string, string>).message, SUBAGENT_LIMITS.messageCharacters) : "";
          const ended = isActiveSubagentState(turn.state) ? null : turn.result;
          const result = ended === null ? null : (() => {
            const decoded = ended as { files?: unknown; report?: unknown } | null;
            return decoded && typeof decoded === "object" ? decoded : impliedResult({ modelId: turn.modelId, name: visible.thread.name,
              reason: turn.reasonCode, reasoningEffort: turn.reasoningEffort, state: "failed" });
          })();
          const files = Array.isArray(result?.files)
            ? result.files.filter((path): path is string => typeof path === "string" && path.trim().length > 0 &&
              path.length <= SUBAGENT_LIMITS.filePathCharacters).slice(0, SUBAGENT_LIMITS.files) : [];
          const messages = mailbox.filter((entry) => entry.modelRunId === turn.executionRun?.id)
            .slice(0, SUBAGENT_VIEW_LIMITS.messagesPerTurn).flatMap((entry): SubagentTurnMessage[] => {
              const text = boundedText(entry.text, SUBAGENT_LIMITS.messageCharacters);
              return text ? [{ createdAt: entry.createdAt.toISOString(),
                delivery: entry.deliveredAt ? "delivered" : isActiveSubagentState(turn.state) ? "accepted" : "undelivered", text }] : [];
            });
          const displayName = models.find((model) => model.id === turn.providerModelId)?.displayName ?? turn.modelId;
          const toolActivity = host && parent ? summarizeMessageRunToolActivity({
            errorPayload: host.errorPayload, normalizedRequest: parent.normalizedRequest, status: host.status,
            toolCalls: calls.filter((entry) => entry.modelRunId === hostRunId && entry.subagentTurnId === turn.id),
            userId: input.userId
          }, input.userId) : null;
          return {
            brief: brief || "-",
            endedAt: isActiveSubagentState(turn.state) ? null : (turn.endedAt ?? turn.updatedAt).toISOString(),
            files,
            id: turn.id,
            messages,
            mode: turn.mode,
            model: { displayName: boundedText(displayName, SUBAGENT_VIEW_LIMITS.displayCharacters) || "-",
              effort: turn.reasoningEffort && turn.reasoningEffort.length <= SUBAGENT_LIMITS.effortCharacters ? turn.reasoningEffort : null },
            outcome: outcomeOf(turn.state, turn.outcome),
            parentMessageId: turn.parentRun.assistantMessageId!,
            reason: isSubagentCode(turn.reasonCode) ? turn.reasonCode : null,
            report: result && typeof result.report === "string" ? Array.from(result.report).slice(0, SUBAGENT_LIMITS.reportCharacters).join("") : null,
            startedAt: turn.startedAt.toISOString(),
            state: turn.state,
            toolActivity,
            workspaceActivity: null
          };
        });
        return { chatId: input.chatId, thread: visible.summary, truncated: visible.turns.length > shown.length, turns };
      });
    }
  });
}
