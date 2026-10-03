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
  onNewResult
}: Readonly<{
  accountId: string | null;
  activeChatId: string | null;
  /** The conversation (not Studio or Settings) is what the user sees. */
  chatVisible: boolean;
  enabled?: boolean;
  onNewResult(task: ScheduledTask): void;
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
  const announce = useEventCallback(onNewResult);

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
    const newest = [...newResults.tasks].sort((left, right) =>
      Date.parse(right.lastRun?.finishedAt ?? "") - Date.parse(left.lastRun?.finishedAt ?? ""))[0];
    if (enabled && newest) announce(newest);
  }, [announce, enabled, newResults]);

  useEffect(() => {
    if (!enabled || !chatVisible || !activeChatId) return;
    const task = tasks.find((candidate) => candidate.chatId === activeChatId && candidate.unseenResult);
    const taskId = task?.id ?? (activeNavigationTask?.unseen ? activeNavigationTask.taskId : null);
    if (!taskId || seenRequests.current.has(taskId)) return;
    seenRequests.current.add(taskId);
    // Clear locally first; a failed request leaves the server marker for the next read.
    markScheduledTaskSeenLocally(taskId);
    setNavigationUnseen(activeChatId, taskId, false);
    void markScheduledTaskSeen(taskId).catch(() => undefined).finally(() => seenRequests.current.delete(taskId));
  }, [activeChatId, activeNavigationTask, chatVisible, enabled, tasks]);
}
