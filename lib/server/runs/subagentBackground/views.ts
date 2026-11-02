import type { ModelRunStatus, Prisma, PrismaClient } from "@prisma/client";
import {
  ASK_PARENT_TOOL_NAME,
  MAIN_AGENT_NAME,
  RUN_FOLLOWUP_REVISION_MAX,
  SEND_AGENT_MESSAGE_TOOL_NAME,
  SUBAGENT_LIMITS,
  SUBAGENT_LISTING_LIMITS,
  decodeSubagentCallResult,
  isActiveSubagentState,
  isSubagentCode,
  isSubagentOutcome,
  normalizeSubagentName,
  type SubagentAgentEntry,
  type SubagentAgentListing,
  type SubagentAgentStep,
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
import { summarizeMessageRunToolActivity, toolCallSubagentSelect } from "../../chats/prismaRepository";
import { TOOL_ACTIVITY_REQUEST_KEYS } from "../../tools/activityDescriptors";
import { branchPathMessageIds } from "../../toolObservations/repository";
import { TURN_ANSWER_SELECT, mailboxWriter, turnAnswerMessageId } from "../../subagents/nesting";
import { foldWorkspaceActivityEntries, projectWorkspaceActivity } from "../../workspace/activityProjection";
import { activeModelRunStatuses } from "../prismaRepositoryShared";
import { isRunEndedToolCallResult } from "../toolLoopPersistence";
import { agentBranchPath } from "../../subagents/branchPath";
import { impliedResult } from "./store";

/**
 * The owner-only projections of a chat's sub-agents
 * (`lib/contracts/subagentViews.ts`): only the chat's active branch, only the
 * owner's own chat while it is not pending deletion, content-free apart from
 * names, briefs and reports. A missing chat or thread and one the caller may
 * not see read the same (null). `branchAgents` is the same reading for an
 * agent of the chat (`list_agents`): the caller's own branch, bounded excerpts.
 */

const turnSelect = {
  endedAt: true, id: true, mode: true, modelId: true, outcome: true, parentRunId: true, parentToolCallId: true,
  providerModelId: true, reasonCode: true, reasoningEffort: true, result: true, startedAt: true, state: true, updatedAt: true,
  executionRun: { select: { id: true, status: true } },
  parentRun: { select: { ...TURN_ANSWER_SELECT, status: true } }
} satisfies Prisma.SubagentTurnSelect;

type TurnRow = Prisma.SubagentTurnGetPayload<{ select: typeof turnSelect }>;

type ThreadRow = Readonly<{
  createdAt: Date; id: string; name: string; typeName: string | null; updatedAt: Date;
  anchorRun: Readonly<{ assistantMessageId: string | null }>;
  parentThread: Readonly<{ id: string; name: string }> | null;
  turns: readonly TurnRow[];
}>;

const threadSelect = {
  anchorRun: { select: { assistantMessageId: true } }, createdAt: true, id: true, name: true,
  parentThread: { select: { id: true, name: true } }, typeName: true, updatedAt: true,
  turns: { orderBy: [{ startedAt: "asc" }, { id: "asc" }], select: turnSelect }
} satisfies Prisma.SubagentThreadSelect;

const onPath = (path: ReadonlySet<string>, messageId: string | null) => messageId !== null && path.has(messageId);

/** Turns of a thread on the branch, oldest first; the last is the thread's state there. */
function branchTurns(thread: ThreadRow, path: ReadonlySet<string>): readonly TurnRow[] {
  return thread.turns.filter((turn) => onPath(path, turnAnswerMessageId(turn.parentRun)));
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
      ...(shown.fetchProxyName ? { fetchProxyName: shown.fetchProxyName } : {}),
      ...(shown.fetchProxyCode ? { fetchProxyCode: shown.fetchProxyCode } : {}),
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
    latestAnswerMessageId: turnAnswerMessageId(latest.parentRun),
    mode: latest.mode,
    model: turnModel(latest, facts.modelNames),
    name: thread.name,
    outcome: outcomeOf(state, latest.outcome),
    // Only a child names one: a tab still running the release before children reads keys strictly, and would lose every thread over a null.
    ...(thread.parentThread ? { parent: thread.parentThread } : {}),
    reason: isSubagentCode(latest.reasonCode) ? latest.reasonCode : null,
    state,
    turnCount: turns.length,
    type: thread.typeName !== null && normalizeSubagentName(thread.typeName) === thread.typeName ? thread.typeName : null,
    updatedAt: updatedAt.toISOString()
  };
}

/**
 * What a turn wrote to other agents, from its own calls: each is on record there whatever became of it, so a sent message
 * needs no second row. A refused call delivered nothing and shows as the failed step it was.
 */
function sentMessages(calls: readonly Readonly<{ arguments: unknown; startedAt: Date | null; state: string; toolName: string }>[],
  parentName: string): SubagentTurnMessage[] {
  return calls.flatMap((call): SubagentTurnMessage[] => {
    if (call.state === "error" || !call.startedAt || typeof call.arguments !== "object" || call.arguments === null) return [];
    const args = call.arguments as { message?: unknown; question?: unknown; to?: unknown };
    const createdAt = call.startedAt.toISOString();
    if (call.toolName === ASK_PARENT_TOOL_NAME && typeof args.question === "string" && args.question.trim()) {
      return [{ createdAt, delivery: "accepted", question: true, text: boundedText(args.question, SUBAGENT_LIMITS.messageCharacters), to: parentName }];
    }
    if (call.toolName !== SEND_AGENT_MESSAGE_TOOL_NAME || typeof args.message !== "string" || !args.message.trim() || typeof args.to !== "string") return [];
    const to = args.to.trim().toLowerCase();
    return to === MAIN_AGENT_NAME || normalizeSubagentName(to) === to
      ? [{ createdAt, delivery: "accepted", text: boundedText(args.message, SUBAGENT_LIMITS.messageCharacters), to }] : [];
  });
}

/** The call that started a turn: its `message` argument is the turn's brief. */
function briefOf(args: unknown): string {
  return typeof args === "object" && args !== null && !Array.isArray(args) && typeof (args as Record<string, unknown>).message === "string"
    ? (args as Record<string, string>).message : "";
}

/** The start of a text, with whether anything was left out. */
function excerpt(value: string, max: number): Readonly<{ cut: boolean; text: string }> {
  const characters = Array.from(value.trim());
  return { cut: characters.length > max, text: characters.slice(0, max).join("") };
}

const stepLine = (value: string) => excerpt(value.replace(/\s+/gu, " "), SUBAGENT_LISTING_LIMITS.stepSummaryCharacters).text;

const listedCallSelect = {
  arguments: true, completedAt: true, id: true, modelRunId: true, ordinal: true, providerCallId: true, result: true, roundIndex: true,
  startedAt: true, state: true, subagentTurnId: true, toolName: true
} satisfies Prisma.ModelRunToolCallSelect;

type ListedCall = Prisma.ModelRunToolCallGetPayload<{ select: typeof listedCallSelect }>;

/**
 * One call as a line of a listing: the name an answer's process disclosure gives it and, for a Workspace or fetch step,
 * the one bounded line that tells what it was on. Never its arguments or result as such.
 */
function agentStep(call: ListedCall, input: Readonly<{ active: boolean; definitions: unknown; normalizedRequest: Prisma.JsonValue | undefined;
  run: Readonly<{ id: string; status: ModelRunStatus }>; userId: string }>): SubagentAgentStep | null {
  if (input.normalizedRequest === undefined) return null;
  const shown = summarizeMessageRunToolActivity({ errorPayload: null, normalizedRequest: input.normalizedRequest, status: input.run.status,
    toolCalls: [call], userId: input.userId }, input.userId)?.calls[0];
  if (!shown) return null;
  const entry = subagentTurnWorkspaceActivity({ active: input.active, calls: [call], definitions: input.definitions, runId: input.run.id })?.entries.at(-1);
  const summary = entry?.command?.preview ?? entry?.file?.displayPath ?? entry?.search?.query ?? shown.fetchTarget ?? "";
  return { outcome: shown.status === "running" ? "running" : shown.status === "complete" ? "complete" : shown.status === "error" ? "error" : "unknown",
    summary: stepLine(summary), tool: stepLine(shown.serverName ? `${shown.serverName}: ${shown.toolName}` : shown.toolName) || "tool" };
}

export type SubagentViews = Readonly<{
  /** The agents on the branch of `parentRunId`, for an agent of the chat; null when the chat is not the caller's to read. */
  branchAgents(input: Readonly<{ chatId: string; parentRunId: string; userId: string }>): Promise<SubagentAgentListing | null>;
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

  /**
   * What the listing shows of the agents it names, active ones first: a stored step list and report for one that ended,
   * and for one still working only the latest lines of its calls, so listing never reads a whole history.
   */
  async function listAgents(tx: Prisma.TransactionClient, input: Readonly<{ chatId: string; parentRunId: string; userId: string }>):
    Promise<SubagentAgentListing | null> {
    const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true }, where: { id: input.chatId, permanentDeletionAt: null, userId: input.userId } });
    if (!chat) return null;
    const path = await agentBranchPath(tx, { activeLeafMessageId: chat.activeLeafMessageId, chatId: input.chatId, parentRunId: input.parentRunId, userId: input.userId });
    if (!path) return null;
    const threads = await tx.subagentThread.findMany({ orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: threadSelect,
      where: { chatId: input.chatId, userId: input.userId } });
    const onBranch = threads.flatMap((thread) => {
      const latest = onPath(path, thread.anchorRun.assistantMessageId) ? branchTurns(thread, path).at(-1) : undefined;
      return latest ? [{ latest, thread }] : [];
    });
    const ordered = [...onBranch.filter(({ latest }) => isActiveSubagentState(latest.state)),
      ...onBranch.filter(({ latest }) => !isActiveSubagentState(latest.state))];
    const shown = ordered.slice(0, SUBAGENT_LISTING_LIMITS.agents);
    const turns = shown.map(({ latest }) => latest);
    const [requests, briefs, hostRuns, mainRun] = await Promise.all([
      loadActivityRequests(tx, [...new Set(turns.map((turn) => turn.parentRunId))], input.userId),
      tx.modelRunToolCall.findMany({ select: { arguments: true, id: true, modelRunId: true },
        where: { OR: turns.map((turn) => ({ id: turn.parentToolCallId, modelRunId: turn.parentRunId })) } }),
      tx.modelRun.findMany({ select: { id: true, workspaceRunBinding: { select: { toolDefinitions: true } } },
        where: { id: { in: turns.flatMap((turn) => turn.executionRun ? [turn.executionRun.id] : []) } } }),
      tx.modelRun.findFirst({ select: { id: true }, where: { chatId: input.chatId, status: { in: activeModelRunStatuses }, subagentTurnId: null, userId: input.userId } })
    ]);
    const entries: SubagentAgentEntry[] = [{ name: MAIN_AGENT_NAME, parent: null, state: mainRun ? "running" : "idle", steps: [] }];
    for (const { latest, thread } of shown) {
      const active = isActiveSubagentState(latest.state);
      const hostRunId = latest.executionRun?.id ?? latest.parentRunId;
      const stored = active ? null : decodeSubagentCallResult(latest.result);
      const ended = stored?.kind === "ended" ? stored : null;
      const calls = active ? await tx.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "desc" }, { ordinal: "desc" }], select: listedCallSelect,
        take: SUBAGENT_LISTING_LIMITS.steps, where: { modelRunId: hostRunId, subagentTurnId: latest.id } }) : [];
      const steps = active ? [...calls].reverse().flatMap((call) => {
        const step = agentStep(call, { active, definitions: hostRuns.find((run) => run.id === hostRunId)?.workspaceRunBinding?.toolDefinitions,
          normalizedRequest: requests.get(latest.parentRunId), run: { id: hostRunId, status: latest.executionRun?.status ?? latest.parentRun.status },
          userId: input.userId });
        return step ? [step] : [];
      }) : (ended?.steps ?? []).slice(-SUBAGENT_LISTING_LIMITS.steps).map((step): SubagentAgentStep =>
        ({ outcome: step.outcome, summary: stepLine(step.summary), tool: stepLine(step.tool) }));
      const brief = excerpt(briefOf(briefs.find((call) => call.id === latest.parentToolCallId && call.modelRunId === latest.parentRunId)?.arguments),
        SUBAGENT_LISTING_LIMITS.briefCharacters);
      const report = excerpt(ended?.report ?? "", SUBAGENT_LISTING_LIMITS.reportCharacters);
      const outcome = outcomeOf(latest.state, latest.outcome);
      entries.push({
        ...(brief.text ? { brief: brief.text } : {}), ...(brief.cut ? { briefTruncated: true as const } : {}),
        mode: latest.mode, name: thread.name, ...(outcome ? { outcome } : {}),
        parent: thread.parentThread?.name ?? MAIN_AGENT_NAME,
        ...(isSubagentCode(latest.reasonCode) ? { reason: latest.reasonCode } : {}),
        ...(report.text ? { report: report.text } : {}), ...(report.cut ? { reportTruncated: true as const } : {}),
        ...(ended?.resultHandle ? { resultHandle: ended.resultHandle } : {}),
        state: latest.state, steps
      });
    }
    return { agents: entries, ...(ordered.length > shown.length ? { truncated: true as const } : {}) };
  }

  return Object.freeze({
    async branchAgents(input) {
      return client.$transaction((tx) => listAgents(tx, input));
    },

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
            ...toolCallSubagentSelect, toolName: true
          }, where: { modelRunId: { in: hostRunIds }, subagentTurnId: { in: shown.map((turn) => turn.id) } } }),
          tx.runFollowup.findMany({ orderBy: { ordinal: "asc" }, select: { authorName: true, createdAt: true, deliveredAt: true, modelRunId: true,
            origin: true, subagentTurnId: true, text: true }, where: { OR: [
            { ordinal: { gt: RUN_FOLLOWUP_REVISION_MAX }, subagentTurnId: { in: shown.map((turn) => turn.id) } },
            // A message from before mailboxes named their turn, on the run that was the turn's.
            { modelRunId: { in: shown.flatMap((turn) => turn.executionRun ? [turn.executionRun.id] : []) }, origin: "main_agent", subagentTurnId: null }
          ] } }),
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
          const brief = boundedText(briefOf(call?.arguments), SUBAGENT_LIMITS.messageCharacters);
          const ended = isActiveSubagentState(turn.state) ? null : turn.result;
          const result = ended === null ? null : (() => {
            const decoded = ended as { files?: unknown; report?: unknown } | null;
            return decoded && typeof decoded === "object" ? decoded : impliedResult({ modelId: turn.modelId, name: visible.thread.name,
              reason: turn.reasonCode, reasoningEffort: turn.reasoningEffort, state: "failed" });
          })();
          const files = Array.isArray(result?.files)
            ? result.files.filter((path): path is string => typeof path === "string" && path.trim().length > 0 &&
              path.length <= SUBAGENT_LIMITS.filePathCharacters).slice(0, SUBAGENT_LIMITS.files) : [];
          const turnCalls = calls.filter((entry) => entry.modelRunId === hostRunId && entry.subagentTurnId === turn.id);
          // A child's report is its own thread's reply, which the tree links; here it would repeat as server-written JSON.
          const received = mailbox.filter((entry) => entry.origin !== "subagent_callback" &&
            (entry.subagentTurnId ? entry.subagentTurnId === turn.id : entry.modelRunId === turn.executionRun?.id))
            .flatMap((entry): SubagentTurnMessage[] => {
              const text = boundedText(entry.text, SUBAGENT_LIMITS.messageCharacters);
              const from = mailboxWriter(entry.authorName);
              return text ? [{ createdAt: entry.createdAt.toISOString(),
                delivery: entry.deliveredAt ? "delivered" : isActiveSubagentState(turn.state) ? "accepted" : "undelivered",
                ...(entry.origin === "user" ? { user: true as const } : from ? { from } : {}),
                ...(entry.origin === "subagent_question" ? { question: true as const } : {}), text }] : [];
            });
          const messages = [...received, ...sentMessages(turnCalls, visible.thread.parentThread?.name ?? MAIN_AGENT_NAME)]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .slice(-SUBAGENT_VIEW_LIMITS.messagesPerTurn);
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
            parentMessageId: turnAnswerMessageId(turn.parentRun)!,
            reason: isSubagentCode(turn.reasonCode) ? turn.reasonCode : null,
            report: result && typeof result.report === "string" ? result.report : null,
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
