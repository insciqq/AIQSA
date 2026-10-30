import { decodeThreadToolActivity, isThreadToolActivityOrigin, type ThreadToolActivity, type ThreadToolActivityOrigin } from "./chats";
import { decodeFetchUrlTarget } from "./fetchUrlActivity";
import {
  SUBAGENT_LIMITS,
  isActiveSubagentState,
  isSubagentCode,
  isSubagentIdentifier,
  isSubagentOutcome,
  isSubagentThreadState,
  isSubagentTurnMode,
  normalizeSubagentName,
  type SubagentOutcome,
  type SubagentThreadState,
  type SubagentTurnMode
} from "./subagents";
import { decodeThreadWorkspaceActivity, type ThreadWorkspaceActivity } from "./workspace";

/**
 * Owner-only projections of a chat's sub-agents for the chat list tree, the
 * answer's rows, the chip above the composer with its list and "Stop all", and
 * the read-only thread view (operator decision 2026-10-29: sub-agents nest
 * under their chat; a thread opens read-only with Stop). A branch shows only
 * its own sub-agents: every projection reads the chat's active branch
 * (`isSubagentTurnOnBranch`).
 * Sub-agents are never chats of their own: they are absent from chat search,
 * Favorites, exports and shares.
 *
 * Authorization (every route below): the caller's own signed-in session; the
 * chat must be the caller's own and not pending permanent deletion; a thread
 * must belong to that chat and be on its active branch ("Stop all" covers
 * every branch of the chat). A missing chat or thread, another user's, one
 * pending deletion and one off the active branch all get the same
 * `SUBAGENT_NOT_FOUND` refusal, administrators included.
 * The summary route takes chat ids the caller may not own: those are left
 * out exactly like chats without sub-agents. Stop routes are mutations
 * (same-origin guard) and idempotent: stopping an ended thread returns its
 * state.
 */
export const SUBAGENT_NOT_FOUND = Object.freeze({ error: "subagent_not_found", status: 404 } as const);

export const SUBAGENT_VIEW_LIMITS = Object.freeze({
  /** Chats one summary request names. */
  chatsPerSummary: 100,
  /** Threads one chat lists, most recently updated first; more set `truncated`. */
  threadsPerChat: 100,
  /** Turns one thread view holds, oldest first; more set `truncated` (the oldest are left out). */
  turnsPerView: 50,
  /** Messages the main agent sent one running turn. */
  messagesPerTurn: 32,
  displayCharacters: 256
});

/** `GET`: `?chatId=<id>` repeated, at most `chatsPerSummary`. */
export const SUBAGENT_SUMMARY_PATH = "/api/subagents";

const segment = encodeURIComponent;

export const SUBAGENT_API_PATHS = Object.freeze({
  /** `GET` with `chatId` query values: `SubagentSummaryResponse`. */
  summary(chatIds: readonly string[]): string {
    const query = new URLSearchParams();
    for (const chatId of chatIds) query.append("chatId", chatId);
    return `${SUBAGENT_SUMMARY_PATH}?${query.toString()}`;
  },
  /** `GET`: `SubagentChatThreads` of the chat's active branch. */
  chatThreads(chatId: string): string {
    return `/api/chats/${segment(chatId)}/subagents`;
  },
  /** `POST`, empty body: stops every active sub-agent of the chat, on every branch (`SubagentStopAllResponse`). */
  stopAll(chatId: string): string {
    return `/api/chats/${segment(chatId)}/subagents/stop-all`;
  },
  /** `GET`: `SubagentThreadView`. */
  thread(chatId: string, threadId: string): string {
    return `/api/chats/${segment(chatId)}/subagents/${segment(threadId)}`;
  },
  /** `POST`, empty body: stops the thread's active turn (`SubagentStopResponse`). */
  stopThread(chatId: string, threadId: string): string {
    return `/api/chats/${segment(chatId)}/subagents/${segment(threadId)}/stop`;
  }
});

/**
 * The tool call an active thread is in now: only the identity an answer's
 * process disclosure already shows (`ThreadToolActivityCall`), never its
 * arguments, its result or ready-made words. The client words it
 * (`describeToolCallV2`) and says something neutral without one.
 */
export type SubagentCurrentStep = Readonly<{
  /** `web_fetch` only: the page's "host/path". */
  fetchTarget?: string;
  origin: ThreadToolActivityOrigin;
  serverName?: string;
  /** `skill` only. */
  skillName?: string;
  /** `skill` only. */
  skillPath?: string;
  toolName: string;
}>;

/** The model a turn runs on: its display name and the effort, or null for the model's default. */
export type SubagentTurnModel = Readonly<{ displayName: string; effort: string | null }>;

/** One thread as a list row: content-free apart from its name, type, model and current step. */
export type SubagentThreadSummary = Readonly<{
  createdAt: string;
  /** What an active thread is doing now; null once it ended or when no step is known. */
  currentStep: SubagentCurrentStep | null;
  /** When its latest turn on the branch ended; null while it is active. */
  endedAt: string | null;
  id: string;
  /**
   * The answer whose call started the latest turn: that answer's rows take the
   * thread even before its saved steps name it. Null on an older row: unknown.
   */
  latestAnswerMessageId: string | null;
  /** The latest turn's mode. */
  mode: SubagentTurnMode;
  /** The latest turn's model; null on a row from before the summary carried it. */
  model: SubagentTurnModel | null;
  name: string;
  outcome: SubagentOutcome | null;
  /** A stable code: a blocked outcome's reason, or why it failed, stopped or was interrupted. */
  reason: string | null;
  state: SubagentThreadState;
  /** Its turns on the branch: real progress, never invented. */
  turnCount: number;
  /** A custom sub-agent's name; null for the default sub-agent. */
  type: string | null;
  updatedAt: string;
}>;

export type SubagentChatThreads = Readonly<{
  chatId: string;
  /** Active threads among `threads`; while any runs the chat list keeps the chat's rows expanded. */
  running: number;
  threads: readonly SubagentThreadSummary[];
  truncated: boolean;
}>;

/** The chats of a summary request that have sub-agents on their active branch. */
export type SubagentSummaryResponse = Readonly<{ chats: readonly SubagentChatThreads[] }>;

/** One message the main agent sent a running sub-agent, with its delivery (receipt, not obedience). */
export type SubagentTurnMessage = Readonly<{
  createdAt: string;
  delivery: "accepted" | "delivered" | "undelivered";
  text: string;
}>;

/** One turn in the thread view: the brief, its later messages, its steps as an answer shows them, and its reply. */
export type SubagentTurnView = Readonly<{
  /** The main agent's message that started or continued the turn. */
  brief: string;
  endedAt: string | null;
  files: readonly string[];
  id: string;
  messages: readonly SubagentTurnMessage[];
  mode: SubagentTurnMode;
  model: SubagentTurnModel;
  outcome: SubagentOutcome | null;
  /** The main-agent answer whose call started the turn, for the link back into the chat. */
  parentMessageId: string;
  reason: string | null;
  /** The sub-agent's report; null while it runs. */
  report: string | null;
  startedAt: string;
  state: SubagentThreadState;
  /** The same projections as an answer's process disclosure. */
  toolActivity: ThreadToolActivity | null;
  workspaceActivity: ThreadWorkspaceActivity | null;
}>;

export type SubagentThreadView = Readonly<{
  chatId: string;
  thread: SubagentThreadSummary;
  truncated: boolean;
  turns: readonly SubagentTurnView[];
}>;

export type SubagentStopResponse = Readonly<{ thread: SubagentThreadSummary }>;
/** How many active sub-agent turns of the chat were stopped (none is not an error). */
export type SubagentStopAllResponse = Readonly<{ stopped: number }>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const text = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !value.includes("\0");
const nullableCode = (value: unknown): value is string | null => value === null || isSubagentCode(value);

const STEP_KEYS = ["fetchTarget", "origin", "serverName", "skillName", "skillPath", "toolName"];

const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);

export function decodeSubagentCurrentStep(value: unknown): SubagentCurrentStep | null {
  if (!record(value) || !only(value, STEP_KEYS) || !isThreadToolActivityOrigin(value.origin) || !text(value.toolName, 160) ||
    !optionalText(value.serverName, 160) || !optionalText(value.skillName, 160) || !optionalText(value.skillPath, 256)) return null;
  if (value.origin !== "skill" && (value.skillName !== undefined || value.skillPath !== undefined)) return null;
  if (value.fetchTarget !== undefined && (value.origin !== "web_fetch" || !decodeFetchUrlTarget(value.fetchTarget))) return null;
  return {
    ...(value.fetchTarget !== undefined ? { fetchTarget: value.fetchTarget as string } : {}),
    origin: value.origin,
    ...(value.serverName !== undefined ? { serverName: value.serverName as string } : {}),
    ...(value.skillName !== undefined ? { skillName: value.skillName as string } : {}),
    ...(value.skillPath !== undefined ? { skillPath: value.skillPath as string } : {}),
    toolName: value.toolName
  };
}

function decodeTurnModel(value: unknown): SubagentTurnModel | null {
  if (!record(value) || !only(value, ["displayName", "effort"]) || !text(value.displayName, SUBAGENT_VIEW_LIMITS.displayCharacters) ||
    (value.effort !== null && !text(value.effort, SUBAGENT_LIMITS.effortCharacters))) return null;
  return { displayName: value.displayName, effort: value.effort as string | null };
}

const SUMMARY_KEYS = ["createdAt", "currentStep", "endedAt", "id", "latestAnswerMessageId", "mode", "model", "name", "outcome", "reason", "state", "turnCount",
  "type", "updatedAt"];

/**
 * `currentStep`, `latestAnswerMessageId` and `model` came later: a row without them still renders, as
 * "not known" (null). One that has them malformed, or a step on a thread that
 * ended, is refused like any other broken field.
 */
export function decodeSubagentThreadSummary(value: unknown): SubagentThreadSummary | null {
  if (!record(value) || !only(value, SUMMARY_KEYS)) return null;
  if (!isSubagentIdentifier(value.id) || normalizeSubagentName(value.name) !== value.name || !isSubagentThreadState(value.state) ||
    !isSubagentTurnMode(value.mode) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
    !count(value.turnCount) || (value.turnCount as number) < 1 || !nullableCode(value.reason)) return null;
  if (isActiveSubagentState(value.state) ? value.endedAt !== null : !timestamp(value.endedAt)) return null;
  if (value.state === "done" ? !isSubagentOutcome(value.outcome) : value.outcome !== null) return null;
  if (value.type !== null && normalizeSubagentName(value.type) !== value.type) return null;
  const hasStep = value.currentStep !== undefined && value.currentStep !== null;
  const currentStep = hasStep ? decodeSubagentCurrentStep(value.currentStep) : null;
  if (hasStep && (!currentStep || !isActiveSubagentState(value.state))) return null;
  const hasModel = value.model !== undefined && value.model !== null;
  const model = hasModel ? decodeTurnModel(value.model) : null;
  if (hasModel && !model) return null;
  const hasAnswer = value.latestAnswerMessageId !== undefined && value.latestAnswerMessageId !== null;
  const latestAnswerMessageId = isSubagentIdentifier(value.latestAnswerMessageId) ? value.latestAnswerMessageId : null;
  if (hasAnswer && !latestAnswerMessageId) return null;
  return {
    createdAt: value.createdAt as string, currentStep, endedAt: value.endedAt as string | null, id: value.id, latestAnswerMessageId,
    mode: value.mode, model,
    name: value.name as string, outcome: value.outcome as SubagentOutcome | null, reason: value.reason, state: value.state,
    turnCount: value.turnCount as number, type: value.type as string | null, updatedAt: value.updatedAt as string
  };
}

function decodeThreadList(value: unknown, max: number): SubagentThreadSummary[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const threads = value.map(decodeSubagentThreadSummary);
  if (threads.some((thread) => thread === null)) return null;
  const decoded = threads as SubagentThreadSummary[];
  return new Set(decoded.map((thread) => thread.id)).size === decoded.length ? decoded : null;
}

export function decodeSubagentChatThreads(value: unknown): SubagentChatThreads | null {
  if (!record(value) || !only(value, ["chatId", "running", "threads", "truncated"])) return null;
  const threads = decodeThreadList(value.threads, SUBAGENT_VIEW_LIMITS.threadsPerChat);
  if (!isSubagentIdentifier(value.chatId) || !threads || typeof value.truncated !== "boolean" ||
    !count(value.running, SUBAGENT_LIMITS.runningPerChat) ||
    value.running !== threads.filter((thread) => isActiveSubagentState(thread.state)).length) return null;
  return { chatId: value.chatId, running: value.running as number, threads, truncated: value.truncated };
}

export function decodeSubagentSummaryResponse(value: unknown): SubagentSummaryResponse | null {
  if (!record(value) || !only(value, ["chats"]) || !Array.isArray(value.chats) ||
    value.chats.length > SUBAGENT_VIEW_LIMITS.chatsPerSummary) return null;
  const chats = value.chats.map(decodeSubagentChatThreads);
  if (chats.some((chat) => chat === null)) return null;
  const decoded = chats as SubagentChatThreads[];
  return new Set(decoded.map((chat) => chat.chatId)).size === decoded.length ? { chats: decoded } : null;
}

/** The chat ids of a summary request's query: distinct valid ids, at most `chatsPerSummary`, or null. */
export function decodeSubagentSummaryQuery(params: URLSearchParams): string[] | null {
  const chatIds = params.getAll("chatId");
  if ([...params.keys()].some((key) => key !== "chatId") || chatIds.length === 0 ||
    chatIds.length > SUBAGENT_VIEW_LIMITS.chatsPerSummary || !chatIds.every(isSubagentIdentifier)) return null;
  return [...new Set(chatIds)];
}

function decodeTurnMessage(value: unknown): SubagentTurnMessage | null {
  if (!record(value) || !only(value, ["createdAt", "delivery", "text"])) return null;
  if (!timestamp(value.createdAt) || !["accepted", "delivered", "undelivered"].includes(value.delivery as string) ||
    !text(value.text, SUBAGENT_LIMITS.messageCharacters)) return null;
  return { createdAt: value.createdAt, delivery: value.delivery as SubagentTurnMessage["delivery"], text: value.text };
}

const TURN_KEYS = ["brief", "endedAt", "files", "id", "messages", "mode", "model", "outcome", "parentMessageId", "reason", "report",
  "startedAt", "state", "toolActivity", "workspaceActivity"];

export function decodeSubagentTurnView(value: unknown): SubagentTurnView | null {
  if (!record(value) || !only(value, TURN_KEYS)) return null;
  if (!isSubagentIdentifier(value.id) || !isSubagentIdentifier(value.parentMessageId) || !isSubagentTurnMode(value.mode) ||
    !isSubagentThreadState(value.state) || !timestamp(value.startedAt) || !text(value.brief, SUBAGENT_LIMITS.messageCharacters) ||
    !nullableCode(value.reason)) return null;
  const active = isActiveSubagentState(value.state);
  if (active ? value.endedAt !== null : !timestamp(value.endedAt)) return null;
  if (value.state === "done" ? !isSubagentOutcome(value.outcome) : value.outcome !== null) return null;
  if (value.report !== null && !text(value.report, SUBAGENT_LIMITS.reportCharacters * 2, true)) return null;
  if (!Array.isArray(value.files) || value.files.length > SUBAGENT_LIMITS.files ||
    !value.files.every((path) => text(path, SUBAGENT_LIMITS.filePathCharacters))) return null;
  if (!Array.isArray(value.messages) || value.messages.length > SUBAGENT_VIEW_LIMITS.messagesPerTurn) return null;
  const messages = value.messages.map(decodeTurnMessage);
  if (messages.some((message) => message === null)) return null;
  const model = decodeTurnModel(value.model);
  if (!model) return null;
  const toolActivity = value.toolActivity === null ? null : decodeThreadToolActivity(value.toolActivity);
  const workspaceActivity = value.workspaceActivity === null ? null : decodeThreadWorkspaceActivity(value.workspaceActivity);
  if ((value.toolActivity !== null && !toolActivity) || (value.workspaceActivity !== null && !workspaceActivity)) return null;
  return {
    brief: value.brief, endedAt: value.endedAt as string | null, files: [...value.files as string[]], id: value.id,
    messages: messages as SubagentTurnMessage[], mode: value.mode,
    model,
    outcome: value.outcome as SubagentOutcome | null, parentMessageId: value.parentMessageId, reason: value.reason,
    report: value.report as string | null, startedAt: value.startedAt, state: value.state, toolActivity, workspaceActivity
  };
}

export function decodeSubagentThreadView(value: unknown): SubagentThreadView | null {
  if (!record(value) || !only(value, ["chatId", "thread", "truncated", "turns"])) return null;
  const thread = decodeSubagentThreadSummary(value.thread);
  if (!isSubagentIdentifier(value.chatId) || !thread || typeof value.truncated !== "boolean" || !Array.isArray(value.turns) ||
    value.turns.length === 0 || value.turns.length > SUBAGENT_VIEW_LIMITS.turnsPerView) return null;
  const turns = value.turns.map(decodeSubagentTurnView);
  if (turns.some((turn) => turn === null)) return null;
  const decoded = turns as SubagentTurnView[];
  // The thread's state is its latest turn's.
  if (decoded.at(-1)!.state !== thread.state || new Set(decoded.map((turn) => turn.id)).size !== decoded.length) return null;
  return { chatId: value.chatId, thread, truncated: value.truncated, turns: decoded };
}

export function decodeSubagentStopResponse(value: unknown): SubagentStopResponse | null {
  if (!record(value) || !only(value, ["thread"])) return null;
  const thread = decodeSubagentThreadSummary(value.thread);
  return thread ? { thread } : null;
}

export function decodeSubagentStopAllResponse(value: unknown): SubagentStopAllResponse | null {
  if (!record(value) || !only(value, ["stopped"]) || !count(value.stopped, SUBAGENT_LIMITS.runningPerChat)) return null;
  return { stopped: value.stopped as number };
}
