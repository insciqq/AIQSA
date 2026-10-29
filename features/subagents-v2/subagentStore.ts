import { create } from "zustand";
import { isActiveSubagentState } from "@/lib/contracts/subagents";
import {
  SUBAGENT_VIEW_LIMITS,
  type SubagentChatThreads,
  type SubagentThreadSummary,
  type SubagentThreadView
} from "@/lib/contracts/subagentViews";
import {
  SubagentApiError,
  loadChatSubagents,
  loadSubagentSummary,
  loadSubagentThread,
  stopAllChatSubagents,
  stopSubagentThread
} from "./subagentApi";

/**
 * The one browser owner of a chat's sub-agents (FRONTEND "State"): the chat
 * list tree, the chat's cards and status line, "Stop all" and the thread
 * view all read the server's projections from here, keyed by chat. Every
 * write carries the sequence of the request that produced it, so a result
 * that a later request, a stop or a branch switch superseded is dropped.
 */

/** How often active sub-agents are checked while the tab is visible. */
export const SUBAGENT_POLL_INTERVAL_MS = 3_000;

export type SubagentThreadTarget = Readonly<{ chatId: string; threadId: string }>;

export type SubagentThreadViewEntry = Readonly<{
  key: string;
  /**
   * `loading` before the first answer (or after a branch switch), `error`
   * when the latest request failed (the last view stays shown), and
   * `unavailable` for the routes' one not-found answer.
   */
  status: "error" | "loading" | "ready" | "unavailable";
  view: SubagentThreadView | null;
}>;

/** A user's disclosure choice; it holds while the chat's running-ness is what it was when chosen. */
type DisclosureOverride = Readonly<{ expanded: boolean; whileRunning: boolean }>;

export type SubagentStoreState = {
  chats: Readonly<Record<string, SubagentChatThreads>>;
  /** Chats whose latest refresh failed; their last known rows stay. */
  chatErrors: Readonly<Record<string, true>>;
  disclosure: Readonly<Record<string, DisclosureOverride>>;
  openThread: SubagentThreadTarget | null;
  /** Ended threads a chat's rows list beyond the active ones before "Show all". */
  showAllEnded: Readonly<Record<string, true>>;
  /** Stops in flight: `<chat>\0<thread>`, or `<chat>\0*` for Stop all. */
  stopping: Readonly<Record<string, true>>;
  stopErrors: Readonly<Record<string, true>>;
  view: SubagentThreadViewEntry | null;
};

const initialState = (): SubagentStoreState => ({
  chatErrors: {},
  chats: {},
  disclosure: {},
  openThread: null,
  showAllEnded: {},
  stopping: {},
  stopErrors: {},
  view: null
});

export const useSubagentStore = create<SubagentStoreState>(initialState);

let sequence = 0;
/** Per chat: the sequence of the newest request whose result applied, or of the invalidation after it. */
const appliedAt = new Map<string, number>();
let viewApplied = 0;
const viewControllers = new Set<AbortController>();

export function resetSubagentStoreForTest(): void {
  sequence = 0;
  appliedAt.clear();
  viewApplied = 0;
  for (const controller of viewControllers) controller.abort();
  viewControllers.clear();
  useSubagentStore.setState(initialState(), true);
}

export function subagentThreadKey(target: SubagentThreadTarget): string {
  return `${target.chatId}\0${target.threadId}`;
}

export function subagentStopAllKey(chatId: string): string {
  return `${chatId}\0*`;
}

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

function accept(chatId: string, at: number): boolean {
  if ((appliedAt.get(chatId) ?? 0) >= at) return false;
  appliedAt.set(chatId, at);
  return true;
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) return record as Record<string, T>;
  const next = { ...record };
  delete next[key];
  return next;
}

function countRunning(threads: readonly SubagentThreadSummary[]): number {
  return threads.filter((thread) => isActiveSubagentState(thread.state)).length;
}

/**
 * Takes one thread's newer projection (a stop answer, a thread view) into
 * its chat's rows. Server timestamps decide which is newer, so a slower
 * answer never rolls a row back.
 */
function mergeThread(chatId: string, thread: SubagentThreadSummary): void {
  useSubagentStore.setState((state) => {
    const chat = state.chats[chatId];
    const index = chat?.threads.findIndex((candidate) => candidate.id === thread.id) ?? -1;
    if (!chat || index < 0) return state;
    const current = chat.threads[index]!;
    if (Date.parse(current.updatedAt) > Date.parse(thread.updatedAt)) return state;
    const threads = chat.threads.map((candidate, position) => position === index ? thread : candidate);
    return { chats: { ...state.chats, [chatId]: { ...chat, running: countRunning(threads), threads } } };
  });
}

function applyChat(chatId: string, chat: SubagentChatThreads | null): void {
  useSubagentStore.setState((state) => ({
    chatErrors: withoutKey(state.chatErrors, chatId),
    chats: chat && chat.threads.length > 0 ? { ...state.chats, [chatId]: chat } : withoutKey(state.chats, chatId)
  }));
}

function failChat(chatId: string, at: number): void {
  if ((appliedAt.get(chatId) ?? 0) >= at) return;
  useSubagentStore.setState((state) => ({ chatErrors: { ...state.chatErrors, [chatId]: true as const } }));
}

/**
 * Refreshes the chats' rows from the summary route. A chat the answer does
 * not list has no sub-agents on its active branch (or is not the caller's).
 */
export async function refreshSubagentSummary(chatIds: readonly string[], signal?: AbortSignal): Promise<void> {
  const ids = [...new Set(chatIds)].slice(0, SUBAGENT_VIEW_LIMITS.chatsPerSummary);
  if (ids.length === 0) return;
  const at = nextSequence();
  try {
    const response = await loadSubagentSummary(ids, signal);
    for (const chatId of ids) {
      if (accept(chatId, at)) applyChat(chatId, response.chats.find((chat) => chat.chatId === chatId) ?? null);
    }
  } catch {
    if (signal?.aborted) return;
    for (const chatId of ids) failChat(chatId, at);
  }
}

/** Refreshes one chat's rows from its own route (the open chat, after a stop). */
export async function refreshChatSubagents(chatId: string, signal?: AbortSignal): Promise<void> {
  const at = nextSequence();
  try {
    const chat = await loadChatSubagents(chatId, signal);
    if (accept(chatId, at)) applyChat(chatId, chat);
  } catch (error) {
    if (signal?.aborted) return;
    if (error instanceof SubagentApiError && error.notFound) {
      // The chat is gone or no longer the caller's: nothing of it stays.
      if (accept(chatId, at)) applyChat(chatId, null);
      return;
    }
    failChat(chatId, at);
  }
}

/**
 * The chat's branch changed: results of requests already sent describe the
 * previous branch and are dropped; the rows refresh for the new one.
 */
export function invalidateChatSubagents(chatId: string): Promise<void> {
  appliedAt.set(chatId, nextSequence());
  return refreshChatSubagents(chatId);
}

/** Loads or refreshes the open thread's view; a result for a thread no longer open is dropped. */
export async function refreshSubagentThreadView(target: SubagentThreadTarget, options: Readonly<{ reset?: boolean }> = {}): Promise<void> {
  const key = subagentThreadKey(target);
  const at = nextSequence();
  const isCurrent = () => {
    const open = useSubagentStore.getState().openThread;
    return open !== null && subagentThreadKey(open) === key;
  };
  if (!isCurrent()) return;
  useSubagentStore.setState((state) => {
    const shown = state.view?.key === key && !options.reset ? state.view.view : null;
    // A refresh keeps the shown view (and its error line) until it answers.
    return shown ? state : { view: { key, status: "loading", view: null } };
  });
  const controller = new AbortController();
  viewControllers.add(controller);
  try {
    const view = await loadSubagentThread(target.chatId, target.threadId, controller.signal);
    if (!isCurrent() || at <= viewApplied) return;
    viewApplied = at;
    useSubagentStore.setState({ view: { key, status: "ready", view } });
    mergeThread(target.chatId, view.thread);
  } catch (error) {
    if (controller.signal.aborted || !isCurrent() || at <= viewApplied) return;
    viewApplied = at;
    if (error instanceof SubagentApiError && error.notFound) {
      useSubagentStore.setState({ view: { key, status: "unavailable", view: null } });
      return;
    }
    useSubagentStore.setState((state) => ({
      view: { key, status: "error", view: state.view?.key === key ? state.view.view : null }
    }));
  } finally {
    viewControllers.delete(controller);
  }
}

/** Shows a thread's view; the address owner (`subagentThreadAddress`) calls it. */
export function setOpenSubagentThread(target: SubagentThreadTarget | null): void {
  const current = useSubagentStore.getState().openThread;
  if (current === target || (current && target && subagentThreadKey(current) === subagentThreadKey(target))) return;
  for (const controller of viewControllers) controller.abort();
  viewControllers.clear();
  useSubagentStore.setState({ openThread: target, view: null });
}

/** Stops one sub-agent; idempotent on the server. A failure stays visible on its Stop control. */
export async function stopSubagent(target: SubagentThreadTarget): Promise<boolean> {
  const key = subagentThreadKey(target);
  if (useSubagentStore.getState().stopping[key]) return false;
  useSubagentStore.setState((state) => ({ stopErrors: withoutKey(state.stopErrors, key), stopping: { ...state.stopping, [key]: true as const } }));
  try {
    const { thread } = await stopSubagentThread(target.chatId, target.threadId);
    mergeThread(target.chatId, thread);
    const open = useSubagentStore.getState().openThread;
    if (open && subagentThreadKey(open) === key) void refreshSubagentThreadView(target);
    void refreshChatSubagents(target.chatId);
    return true;
  } catch {
    useSubagentStore.setState((state) => ({ stopErrors: { ...state.stopErrors, [key]: true as const } }));
    return false;
  } finally {
    useSubagentStore.setState((state) => ({ stopping: withoutKey(state.stopping, key) }));
  }
}

/** "Stop all": every active sub-agent of the chat, on every branch. */
export async function stopAllSubagents(chatId: string): Promise<boolean> {
  const key = subagentStopAllKey(chatId);
  if (useSubagentStore.getState().stopping[key]) return false;
  useSubagentStore.setState((state) => ({ stopErrors: withoutKey(state.stopErrors, key), stopping: { ...state.stopping, [key]: true as const } }));
  try {
    await stopAllChatSubagents(chatId);
    await refreshChatSubagents(chatId);
    const open = useSubagentStore.getState().openThread;
    if (open?.chatId === chatId) void refreshSubagentThreadView(open);
    return true;
  } catch {
    useSubagentStore.setState((state) => ({ stopErrors: { ...state.stopErrors, [key]: true as const } }));
    return false;
  } finally {
    useSubagentStore.setState((state) => ({ stopping: withoutKey(state.stopping, key) }));
  }
}

/**
 * Whether a chat's sub-agent rows are expanded: open while any of them runs
 * and closed otherwise (or open to show the thread being viewed), unless
 * the user chose otherwise while the chat was in that same running state.
 */
export function subagentRowsExpanded(
  state: Pick<SubagentStoreState, "chats" | "disclosure" | "openThread">,
  chatId: string
): boolean {
  const chat = state.chats[chatId];
  const running = (chat?.running ?? 0) > 0;
  const override = state.disclosure[chatId];
  if (override && override.whileRunning === running) return override.expanded;
  if (state.openThread?.chatId === chatId && chat?.threads.some((thread) => thread.id === state.openThread?.threadId)) return true;
  return running;
}

export function toggleSubagentRows(chatId: string): void {
  useSubagentStore.setState((state) => {
    const running = (state.chats[chatId]?.running ?? 0) > 0;
    return { disclosure: { ...state.disclosure, [chatId]: { expanded: !subagentRowsExpanded(state, chatId), whileRunning: running } } };
  });
}

export function showAllEndedSubagents(chatId: string): void {
  useSubagentStore.setState((state) => ({ showAllEnded: { ...state.showAllEnded, [chatId]: true as const } }));
}
