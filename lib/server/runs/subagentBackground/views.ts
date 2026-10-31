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
  decodeSubagentCurrentStep,
  type SubagentChatThreads,
  type SubagentCurrentStep,
  type SubagentSummaryResponse,
  type SubagentThreadSummary,
  type SubagentThreadView,
  type SubagentTurnMessage,
  type SubagentTurnModel,
  type SubagentTurnView
} from "../../../contracts/subagentViews";
import { decodeThreadWorkspaceActivityEntry, type ThreadWorkspaceActivity, type ThreadWorkspaceActivityEntry } from "../../../contracts/workspace";
import type { WorkspaceMcpToolName } from "../../../domain/workspace";
import { summarizeMessageRunToolActivity } from "../../chats/prismaRepository";
import { TOOL_ACTIVITY_REQUEST_KEYS } from "../../tools/activityDescriptors";
import { branchPathMessageIds } from "../../toolObservations/repository";
import { foldWorkspaceActivityEntries, projectWorkspaceActivity } from "../../workspace/activityProjection";
import { isRunEndedToolCallResult } from "../toolLoopPersistence";
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
  executionRun: { select: { id: true, status: true } },
  parentRun: { select: { assistantMessageId: true, status: true } }
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

/** Display names by provider model id, null for one that no longer exists; one summary request shares it across its chats. */
type ModelNames = Map<string, string | null>;

/** What a summary row needs beyond its thread's own rows. */
type SummaryFacts = Readonly<{ modelNames: ReadonlyMap<string, string | null>; steps: ReadonlyMap<string, SubagentCurrentStep> }>;

function boundedText(value: string, max: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= max ? characters.join("") : characters.slice(0, max).join("");
}

function turnModel(turn: TurnRow, modelNames: ReadonlyMap<string, string | null>): SubagentTurnModel {
  const displayName = (turn.providerModelId ? modelNames.get(turn.providerModelId) : null) ?? turn.modelId;
  return {
    displayName: boundedText(displayName, SUBAGENT_VIEW_LIMITS.displayCharacters) || "-",
    effort: turn.reasoningEffort && turn.reasoningEffort.length <= SUBAGENT_LIMITS.effortCharacters ? turn.reasoningEffort : null
  };
}

/**
 * The part of runs' frozen requests that names their tools, by run. Polled for
 * as long as a sub-agent runs, so it never transfers the admitted context the
 * rest of the request holds. The caller's own runs only.
 */
async function loadActivityRequests(
  tx: Prisma.TransactionClient,
  runIds: readonly string[],
  userId: string
): Promise<ReadonlyMap<string, Prisma.JsonValue>> {
  const rows = await tx.$queryRaw<Array<{ activityRequest: Prisma.JsonValue; id: string }>>`
    SELECT run."id", COALESCE((
      SELECT jsonb_object_agg(entry.key, entry.value)
      FROM jsonb_each(CASE WHEN jsonb_typeof(run."normalizedRequest") = 'object' THEN run."normalizedRequest" ELSE '{}'::jsonb END) AS entry
      WHERE entry.key = ANY(${[...TOOL_ACTIVITY_REQUEST_KEYS]}::text[])
    ), '{}'::jsonb) AS "activityRequest"
    FROM "ModelRun" AS run
    WHERE run."id" = ANY(${[...runIds]}::text[]) AND run."userId" = ${userId}`;
  return new Map(rows.map((row) => [row.id, row.activityRequest]));
}

/** Running calls one poll of a chat reads: enough for every active turn's parallel calls. */
const CURRENT_STEP_CALLS = SUBAGENT_LIMITS.runningPerChat * 8;

/**
 * Each active turn's latest running call, projected by the same reader as an
 * answer's process disclosure and cut down to its identity. A chat with no
 * active turn costs nothing here; one with active turns takes one bounded
 * query, and a second for the tool names' frozen part only while a call runs. A
 * call the projection does not name stays unknown, never guessed.
 */
async function loadCurrentSteps(
  tx: Prisma.TransactionClient,
  turns: readonly TurnRow[],
  userId: string
): Promise<ReadonlyMap<string, SubagentCurrentStep>> {
  const active = turns.filter((turn) => isActiveSubagentState(turn.state));
  if (active.length === 0) return new Map();
  const calls = await tx.modelRunToolCall.findMany({
    orderBy: [{ roundIndex: "desc" }, { ordinal: "desc" }],
    select: { arguments: true, completedAt: true, id: true, ordinal: true, providerCallId: true, result: true, roundIndex: true,
      startedAt: true, state: true, subagentTurnId: true, toolName: true },
    take: CURRENT_STEP_CALLS,
    where: { modelRunId: { in: [...new Set(active.map((turn) => turn.executionRun?.id ?? turn.parentRunId))] },
      state: { in: ["pending", "running"] }, subagentTurnId: { in: active.map((turn) => turn.id) } }
  });
  if (calls.length === 0) return new Map();
  const running = active.flatMap((turn) => {
    const call = calls.find((candidate) => candidate.subagentTurnId === turn.id);
    return call ? [{ call, turn }] : [];
  });
  const requests = await loadActivityRequests(tx, [...new Set(running.map(({ turn }) => turn.parentRunId))], userId);
  return new Map(running.flatMap(({ call, turn }): [string, SubagentCurrentStep][] => {
    const normalizedRequest = requests.get(turn.parentRunId);
    const shown = normalizedRequest !== undefined ? summarizeMessageRunToolActivity({ errorPayload: null, normalizedRequest,
      status: turn.executionRun?.status ?? turn.parentRun.status, toolCalls: [call], userId }, userId)?.calls[0] : undefined;
    if (shown?.status !== "running") return [];
    const step = decodeSubagentCurrentStep({
      ...(shown.fetchTarget ? { fetchTarget: shown.fetchTarget } : {}),
      origin: shown.origin,
      ...(shown.serverName ? { serverName: shown.serverName } : {}),
      ...(shown.skillName ? { skillName: shown.skillName } : {}),
      ...(shown.skillPath ? { skillPath: shown.skillPath } : {}),
      toolName: shown.toolName
    });
    return step ? [[turn.id, step]] : [];
  }));
}

async function loadSummaryFacts(
  tx: Prisma.TransactionClient,
  turns: readonly TurnRow[],
  userId: string,
  modelNames: ModelNames
): Promise<SummaryFacts> {
  const unknown = [...new Set(turns.flatMap((turn) => turn.providerModelId && !modelNames.has(turn.providerModelId) ? [turn.providerModelId] : []))];
  if (unknown.length > 0) {
    const models = await tx.providerModel.findMany({ select: { displayName: true, id: true }, where: { id: { in: unknown } } });
    for (const id of unknown) modelNames.set(id, models.find((model) => model.id === id)?.displayName ?? null);
  }
  return { modelNames, steps: await loadCurrentSteps(tx, turns, userId) };
}

/** `turns` holds at least the thread's latest turn on the branch. */
function summarize(thread: ThreadRow, turns: readonly TurnRow[], facts: SummaryFacts): SubagentThreadSummary {
  const latest = turns.at(-1)!;
  const state = latest.state;
  const updatedAt = new Date(Math.max(thread.updatedAt.getTime(), latest.updatedAt.getTime()));
  return {
    createdAt: thread.createdAt.toISOString(),
    currentStep: facts.steps.get(latest.id) ?? null,
    endedAt: isActiveSubagentState(state) ? null : (latest.endedAt ?? latest.updatedAt).toISOString(),
    id: thread.id,
    latestAnswerMessageId: latest.parentRun.assistantMessageId,
    mode: latest.mode,
    model: turnModel(latest, facts.modelNames),
    name: thread.name,
    outcome: outcomeOf(state, latest.outcome),
    reason: isSubagentCode(latest.reasonCode) ? latest.reasonCode : null,
    state,
    turnCount: turns.length,
    type: thread.typeName !== null && normalizeSubagentName(thread.typeName) === thread.typeName ? thread.typeName : null,
    updatedAt: updatedAt.toISOString()
  };
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

type TurnWorkspaceCall = Readonly<{ arguments: unknown; id: string; result: unknown; startedAt: Date | null; toolName: string }>;

/** The sanitized `workspace_activity` entries a settled Workspace call carries in its stored result. */
function storedActivityEntries(result: unknown): ThreadWorkspaceActivityEntry[] {
  const artifacts = typeof result === "object" && result !== null ? (result as { artifacts?: unknown }).artifacts : null;
  return (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) => {
    const data = (artifact as { data?: { artifactType?: unknown; payload?: unknown } } | null)?.data;
    const entry = data?.artifactType === "workspace_activity" ? decodeThreadWorkspaceActivityEntry(data.payload) : null;
    return entry ? [entry] : [];
  });
}

/**
 * A turn's Workspace steps. A sub-agent publishes no activity events of its own, so they come from its recorded calls:
 * a settled call's stored entries, which update an async command's starting row by id, and a row from its arguments for
 * a call still running, or one whose result holds none (a timeout, an oversized result, the run ending), which is an
 * unknown step. The thread shows them, and they tell the live Browser panel that this agent browses.
 */
export function subagentTurnWorkspaceActivity(input: Readonly<{
  active: boolean; calls: readonly TurnWorkspaceCall[]; definitions: unknown; runId: string;
}>): ThreadWorkspaceActivity | null {
  const originals = new Map((Array.isArray(input.definitions) ? input.definitions : []).flatMap((value): [string, WorkspaceMcpToolName][] => {
    const tool = value as { namespacedName?: unknown; originalName?: unknown } | null;
    return typeof tool?.namespacedName === "string" && typeof tool.originalName === "string"
      ? [[tool.namespacedName, tool.originalName as WorkspaceMcpToolName]] : [];
  }));
  const entries = input.calls.flatMap((call) => {
    const settled = call.result !== null && call.result !== undefined && !isRunEndedToolCallResult(call.result);
    const stored = settled ? storedActivityEntries(call.result) : [];
    if (stored.length > 0) return stored;
    const originalName = originals.get(call.toolName);
    if (!originalName || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) return [];
    const entry = projectWorkspaceActivity({ arguments: call.arguments as Record<string, unknown>, callId: call.id, originalName,
      runId: input.runId, ...(call.startedAt ? { startedAt: call.startedAt } : {}) }, "running");
    return entry ? [settled ? { ...entry, phase: "unknown" as const } : entry] : [];
  }).map((entry, sequence) => ({ ...entry, sequence }));
  if (entries.length === 0) return null;
  return { entries: foldWorkspaceActivityEntries(entries, input.active ? null : "complete") };
}

export function createSubagentViews(client: PrismaClient): SubagentViews {
  async function activePath(tx: Prisma.TransactionClient, chatId: string, userId: string): Promise<ReadonlySet<string> | null> {
    const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true }, where: { id: chatId, permanentDeletionAt: null, userId } });
    if (!chat) return null;
    return chat.activeLeafMessageId ? branchPathMessageIds(tx, chatId, chat.activeLeafMessageId) : new Set<string>();
  }

  async function chatThreads(
    tx: Prisma.TransactionClient,
    chatId: string,
    userId: string,
    modelNames: ModelNames = new Map()
  ): Promise<SubagentChatThreads | null> {
    const path = await activePath(tx, chatId, userId);
    if (!path) return null;
    const threads = await tx.subagentThread.findMany({ orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: threadSelect,
      where: { chatId, userId } });
    const onBranch = threads.flatMap((thread) => {
      if (!onPath(path, thread.anchorRun.assistantMessageId)) return [];
      const turns = branchTurns(thread, path);
      return turns.length > 0 ? [{ thread, turns }] : [];
    });
    const facts = await loadSummaryFacts(tx, onBranch.map(({ turns }) => turns.at(-1)!), userId, modelNames);
    const visible = onBranch.map(({ thread, turns }) => summarize(thread, turns, facts)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
    const latest = turns.at(-1);
    if (!latest) return null;
    return { summary: summarize(thread, turns, await loadSummaryFacts(tx, [latest], input.userId, new Map())), thread, turns };
  }

  return Object.freeze({
    async chatThreads({ chatId, userId }) {
      return client.$transaction((tx) => chatThreads(tx, chatId, userId));
    },

    async summary({ chatIds, userId }) {
      const owned = await client.chat.findMany({ select: { id: true },
        where: { id: { in: [...chatIds] }, permanentDeletionAt: null, subagentThreads: { some: {} }, userId } });
      const chats: SubagentChatThreads[] = [];
      const modelNames: ModelNames = new Map();
      for (const chat of owned) {
        const threads = await client.$transaction((tx) => chatThreads(tx, chat.id, userId, modelNames));
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
        const [hostRuns, activityRequests, calls, mailbox, models] = await Promise.all([
          tx.modelRun.findMany({ select: { errorPayload: true, id: true, status: true,
            workspaceRunBinding: { select: { toolDefinitions: true } } }, where: { id: { in: hostRunIds } } }),
          loadActivityRequests(tx, [...new Set(shown.map((turn) => turn.parentRunId))], input.userId),
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
        const modelNames = new Map(models.map((model) => [model.id, model.displayName]));
        const turns = shown.map((turn): SubagentTurnView => {
          const hostRunId = turn.executionRun?.id ?? turn.parentRunId;
          const host = hostRuns.find((run) => run.id === hostRunId);
          const normalizedRequest = activityRequests.get(turn.parentRunId);
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
          const turnCalls = calls.filter((entry) => entry.modelRunId === hostRunId && entry.subagentTurnId === turn.id);
          const toolActivity = host && normalizedRequest !== undefined ? summarizeMessageRunToolActivity({
            errorPayload: host.errorPayload, normalizedRequest, status: host.status, toolCalls: turnCalls, userId: input.userId
          }, input.userId) : null;
          return {
            brief: brief || "-",
            endedAt: isActiveSubagentState(turn.state) ? null : (turn.endedAt ?? turn.updatedAt).toISOString(),
            files,
            id: turn.id,
            messages,
            mode: turn.mode,
            model: turnModel(turn, modelNames),
            outcome: outcomeOf(turn.state, turn.outcome),
            parentMessageId: turn.parentRun.assistantMessageId!,
            reason: isSubagentCode(turn.reasonCode) ? turn.reasonCode : null,
            report: result && typeof result.report === "string" ? Array.from(result.report).slice(0, SUBAGENT_LIMITS.reportCharacters).join("") : null,
            startedAt: turn.startedAt.toISOString(),
            state: turn.state,
            toolActivity,
            workspaceActivity: subagentTurnWorkspaceActivity({ active: isActiveSubagentState(turn.state), calls: turnCalls,
              definitions: host?.workspaceRunBinding?.toolDefinitions, runId: hostRunId })
          };
        });
        return { chatId: input.chatId, thread: visible.summary, truncated: visible.turns.length > shown.length, turns };
      });
    }
  });
}
