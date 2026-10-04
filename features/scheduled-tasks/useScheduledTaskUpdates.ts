"use client";

import { useEffect, useRef } from "react";
import { loadChatNavigation } from "@/components/app-shell/chatNavigationActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { ChatMessageScheduledTaskWire } from "@/lib/contracts/chats";
import type { ScheduledTask } from "@/lib/contracts/scheduledTasks";
import { markScheduledTaskSeen } from "./scheduledTasksApi";
import {
  activateScheduledTasksAccount,
  refreshScheduledTasks,
  refreshScheduledTasksAfterChange,
  useScheduledTasksStore
} from "./scheduledTasksStore";

/** List refresh cadence while the page is visible and the account has tasks. */
export const SCHEDULED_TASK_POLL_MS = 60_000;
/** Shorter cadence while a run is pending or running, so its result shows promptly. */
export const SCHEDULED_TASK_RUNNING_POLL_MS = 15_000;

/** An unread scheduled result the open transcript renders: its task and `ScheduledTaskRun.id`. */
export type ScheduledTaskRenderedRun = Readonly<{ taskId: string; taskRunId: string }>;

type ScheduledTurn = Readonly<{ scheduledTask?: ChatMessageScheduledTaskWire | null }>;

/** The unread results among a transcript's scheduled turns, in transcript order. */
export function renderedUnseenScheduledRuns(messages: readonly ScheduledTurn[]): ScheduledTaskRenderedRun[] {
  return messages.flatMap(({ scheduledTask: marker }) =>
    marker?.unseen ? [{ taskId: marker.taskId, taskRunId: marker.taskRunId }] : []);
}

/** The task whose later runs continue in this chat: it keeps one chat and this is its newest. */
export function scheduledTaskContinuingIn(tasks: readonly ScheduledTask[], chatId: string | null): ScheduledTask | null {
  return chatId ? tasks.find((task) => task.chatMode === "same" && task.chatId === chatId) ?? null : null;
}

function setNavigationUnseen(chatId: string, taskId: string, unseen: boolean, updatedAt?: string): boolean {
  const workspace = useWorkspaceStore.getState();
  const row = workspace.navigationChats.find((chat) => chat.id === chatId) ??
    workspace.navigationSearchChats.find((chat) => chat.id === chatId);
  if (!row) return false;
  if (row.scheduledTask?.taskId === taskId && row.scheduledTask.unseen === unseen &&
    (!updatedAt || Date.parse(updatedAt) <= Date.parse(row.updatedAt))) return true;
  workspace.upsertNavigationChat({
    ...row,
    scheduledTask: { taskId, unseen },
    ...(updatedAt && Date.parse(updatedAt) > Date.parse(row.updatedAt) ? { updatedAt } : {})
  });
  return true;
}

/**
 * Marks results the viewer has rendered seen, never others. Afterwards the
 * chats that showed them lose their unread dot, and the task's unread
 * aggregate is reread because other runs may still be unread. Resolves false
 * when the request failed; the server marker then stays for the next read.
 */
export async function markScheduledTaskRunsSeen(
  taskId: string,
  runIds: readonly string[],
  chatIds: readonly string[]
): Promise<boolean> {
  if (!runIds.length) return true;
  try {
    await markScheduledTaskSeen(taskId, runIds);
  } catch {
    return false;
  }
  for (const chatId of new Set(chatIds)) setNavigationUnseen(chatId, taskId, false);
  void refreshScheduledTasksAfterChange();
  return true;
}

/**
 * Background owner of scheduled results: reads the task list once per
 * account, polls it while the document is visible and the account has tasks,
 * marks the chat row of a new result as unread, announces it once, and marks
 * the unread results the open conversation renders as seen.
 */
export function useScheduledTaskUpdates({
  accountId,
  activeChatId,
  chatVisible,
  enabled = true,
  onNewResult,
  refreshOpenChat,
  renderedUnseenRuns
}: Readonly<{
  accountId: string | null;
  activeChatId: string | null;
  /** The conversation (not Studio or Settings) is what the user sees. */
  chatVisible: boolean;
  enabled?: boolean;
  onNewResult(task: ScheduledTask): void;
  /**
   * Rereads the open chat's transcript so a scheduled run that starts or ends
   * in it becomes visible; resolves false when nothing was loaded.
   */
  refreshOpenChat(chatId: string): Promise<boolean>;
  /** Unread scheduled results rendered in the open chat's transcript, from its turn markers. */
  renderedUnseenRuns: readonly ScheduledTaskRenderedRun[];
}>): void {
  const hasTasks = useScheduledTasksStore((state) => state.tasks.length > 0);
  const running = useScheduledTasksStore((state) => state.tasks.some((task) => task.running));
  const newResults = useScheduledTasksStore((state) => state.newResults);
  const tasks = useScheduledTasksStore((state) => state.tasks);
  const announced = useRef(newResults.sequence);
  /** Run ids already sent (or being sent) as seen; a failed request releases them. */
  const seenRequests = useRef(new Set<string>());
  const runningChats = useRef(new Set<string>());
  /** The open chat a new result already reread during this commit, so its run's end does not reread it again. */
  const resultRefresh = useRef<string | null>(null);
  const announce = useEventCallback(onNewResult);
  const refreshChat = useEventCallback(refreshOpenChat);

  useEffect(() => {
    if (!enabled || !accountId) return;
    activateScheduledTasksAccount(accountId);
    void refreshScheduledTasks();
  }, [accountId, enabled]);

  useEffect(() => {
    if (!enabled || !accountId || !hasTasks) return;
    const interval = running ? SCHEDULED_TASK_RUNNING_POLL_MS : SCHEDULED_TASK_POLL_MS;
    let cancelled = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!cancelled && document.visibilityState === "visible") timer = window.setTimeout(tick, interval);
    };
    const tick = () => {
      void refreshScheduledTasks().finally(schedule);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
      else window.clearTimeout(timer);
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accountId, enabled, hasTasks, running]);

  useEffect(() => {
    if (newResults.sequence === announced.current) return;
    announced.current = newResults.sequence;
    let reload = false;
    // Each result lands in its task's newest chat; older chats keep their own markers.
    for (const task of newResults.tasks) {
      if (!task.chatId) continue;
      if (!setNavigationUnseen(task.chatId, task.id, true, task.lastRun?.finishedAt)) reload = true;
    }
    if (reload && useWorkspaceStore.getState().navigationReady) void loadChatNavigation();
    // The cached transcript predates this answer: reread it, and the result counts as seen once it renders.
    if (enabled && chatVisible && activeChatId && newResults.tasks.some((task) => task.chatId === activeChatId)) {
      resultRefresh.current = activeChatId;
      void refreshChat(activeChatId).catch(() => false);
    }
    const newest = [...newResults.tasks].sort((left, right) =>
      Date.parse(right.lastRun?.finishedAt ?? "") - Date.parse(left.lastRun?.finishedAt ?? ""))[0];
    if (enabled && newest) announce(newest);
  }, [activeChatId, announce, chatVisible, enabled, newResults, refreshChat]);

  useEffect(() => {
    // A scheduled run that starts in the open chat: show its answer as it streams. One
    // that ends there settles its transcript, also when it is not news: a monitoring
    // check with no update collapses only once the reread carries its outcome.
    const running = new Set(tasks.flatMap((task) => task.running && task.chatId ? [task.chatId] : []));
    const started = activeChatId !== null && running.has(activeChatId) && !runningChats.current.has(activeChatId);
    const ended = activeChatId !== null && !running.has(activeChatId) && runningChats.current.has(activeChatId) &&
      resultRefresh.current !== activeChatId;
    if (enabled && chatVisible && activeChatId && (started || ended)) void refreshChat(activeChatId).catch(() => false);
    runningChats.current = running;
    resultRefresh.current = null;
  }, [activeChatId, chatVisible, enabled, refreshChat, tasks]);

  useEffect(() => {
    if (!enabled || !chatVisible || !activeChatId) return;
    const byTask = new Map<string, string[]>();
    for (const run of renderedUnseenRuns) {
      if (seenRequests.current.has(run.taskRunId)) continue;
      seenRequests.current.add(run.taskRunId);
      byTask.set(run.taskId, [...byTask.get(run.taskId) ?? [], run.taskRunId]);
    }
    for (const [taskId, runIds] of byTask) {
      void markScheduledTaskRunsSeen(taskId, runIds, [activeChatId]).then((marked) => {
        if (!marked) for (const runId of runIds) seenRequests.current.delete(runId);
      });
    }
  }, [activeChatId, chatVisible, enabled, renderedUnseenRuns]);
}
