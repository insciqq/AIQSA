"use client";

import { useEffect, useRef } from "react";
import { loadChatNavigation } from "@/components/app-shell/chatNavigationActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { ScheduledTask } from "@/lib/contracts/scheduledTasks";
import { markScheduledTaskSeen } from "./scheduledTasksApi";
import {
  activateScheduledTasksAccount,
  markScheduledTaskSeenLocally,
  refreshScheduledTasks,
  useScheduledTasksStore
} from "./scheduledTasksStore";

/** List refresh cadence while the page is visible and the account has tasks. */
export const SCHEDULED_TASK_POLL_MS = 60_000;
/** Shorter cadence while a run is pending or running, so its result shows promptly. */
export const SCHEDULED_TASK_RUNNING_POLL_MS = 15_000;

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
 * Marks a task's result seen: locally first (the task list and its chat row),
 * then on the server. A failed request leaves the server marker for the next read.
 */
export function markScheduledTaskResultSeen(taskId: string, chatId: string | null): Promise<void> {
  markScheduledTaskSeenLocally(taskId);
  if (chatId) setNavigationUnseen(chatId, taskId, false);
  return markScheduledTaskSeen(taskId).catch(() => undefined);
}

/**
 * Background owner of scheduled results: reads the task list once per
 * account, polls it while the document is visible and the account has tasks,
 * marks the chat row of a new result as unread, announces it once, and marks
 * a result seen when its chat is open in the conversation view.
 */
export function useScheduledTaskUpdates({
  accountId,
  activeChatId,
  chatVisible,
  enabled = true,
  onNewResult,
  refreshOpenChat
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
}>): void {
  const hasTasks = useScheduledTasksStore((state) => state.tasks.length > 0);
  const running = useScheduledTasksStore((state) => state.tasks.some((task) => task.running));
  const newResults = useScheduledTasksStore((state) => state.newResults);
  const tasks = useScheduledTasksStore((state) => state.tasks);
  const activeNavigationTask = useWorkspaceStore((state) => activeChatId
    ? state.navigationChats.find((chat) => chat.id === activeChatId)?.scheduledTask ?? null
    : null);
  const announced = useRef(newResults.sequence);
  const seenRequests = useRef(new Set<string>());
  /** Results that landed in the open chat: seen only once its transcript shows them. */
  const awaitingTranscript = useRef(new Set<string>());
  const runningChats = useRef(new Set<string>());
  const isOpenChat = useEventCallback((chatId: string) => chatVisible && activeChatId === chatId);
  const announce = useEventCallback(onNewResult);
  const refreshChat = useEventCallback(refreshOpenChat);
  const markSeen = useEventCallback((chatId: string, taskId: string) => {
    if (seenRequests.current.has(taskId)) return;
    seenRequests.current.add(taskId);
    void markScheduledTaskResultSeen(taskId, chatId).finally(() => seenRequests.current.delete(taskId));
  });

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
    for (const task of newResults.tasks) {
      if (!task.chatId) continue;
      if (!setNavigationUnseen(task.chatId, task.id, true, task.lastRun?.finishedAt)) reload = true;
    }
    if (reload && useWorkspaceStore.getState().navigationReady) void loadChatNavigation();
    const open = enabled && chatVisible && activeChatId
      ? newResults.tasks.find((task) => task.chatId === activeChatId) ?? null
      : null;
    if (open && activeChatId) {
      // The cached transcript predates this answer: reread it before the result counts as seen.
      const chatId = activeChatId;
      awaitingTranscript.current.add(open.id);
      void refreshChat(chatId).catch(() => false).then((loaded) => {
        awaitingTranscript.current.delete(open.id);
        if (loaded && isOpenChat(chatId)) markSeen(chatId, open.id);
      });
    }
    const newest = [...newResults.tasks].sort((left, right) =>
      Date.parse(right.lastRun?.finishedAt ?? "") - Date.parse(left.lastRun?.finishedAt ?? ""))[0];
    if (enabled && newest) announce(newest);
  }, [activeChatId, announce, chatVisible, enabled, isOpenChat, markSeen, newResults, refreshChat]);

  useEffect(() => {
    // A scheduled run that starts in the open chat: show its answer as it streams.
    const running = new Set(tasks.flatMap((task) => task.running && task.chatId ? [task.chatId] : []));
    if (enabled && chatVisible && activeChatId && running.has(activeChatId) && !runningChats.current.has(activeChatId)) {
      void refreshChat(activeChatId).catch(() => false);
    }
    runningChats.current = running;
  }, [activeChatId, chatVisible, enabled, refreshChat, tasks]);

  useEffect(() => {
    if (!enabled || !chatVisible || !activeChatId) return;
    const task = tasks.find((candidate) => candidate.chatId === activeChatId && candidate.unseenResult);
    const taskId = task?.id ?? (activeNavigationTask?.unseen ? activeNavigationTask.taskId : null);
    if (!taskId || awaitingTranscript.current.has(taskId)) return;
    markSeen(activeChatId, taskId);
  }, [activeChatId, activeNavigationTask, chatVisible, enabled, markSeen, tasks]);
}
