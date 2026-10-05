"use client";

import { useEffect } from "react";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import type { ThreadMessage } from "@/lib/contracts/chats";
import { reportShownRun, type BrowserPushEnvironment } from "./browserNotificationsClient";

/**
 * The person can see the page: it is visible and focused, or visible on a
 * touch-first device, which shows one app at a time and whose installed web
 * apps report focus unreliably.
 */
export function pageOnScreen(): boolean {
  if (document.visibilityState !== "visible") return false;
  if (document.hasFocus()) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Reports each answer of the open chat that this page saw complete while on
 * screen, so its run's push skips this device. Only runs seen unfinished here
 * count: an answer that was already done when the chat opened, or that ended
 * while the page was hidden, still notifies. A failed answer is not reported:
 * a lost connection also shows as failed while the run goes on, and the run's
 * later push must still reach this device.
 */
export function useShownRunReports(input: Readonly<{
  /** Push is on and allowed on this device. */
  active: boolean;
  chatId: string | null;
  environment: BrowserPushEnvironment | null;
  /** Injected in tests; defaults to the real page state. */
  onScreen?: () => boolean;
}>): void {
  const { active, chatId, environment } = input;
  const onScreen = input.onScreen ?? pageOnScreen;
  useEffect(() => {
    if (!active || !chatId || !environment) return;
    // Optimistic answers change their message id when the server confirms
    // them, and older answers can bind their run id late: either marks a run.
    const unfinishedRuns = new Set<string>();
    const unfinishedMessages = new Set<string>();
    const observe = (messages: readonly ThreadMessage[]) => {
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const runId = message.runId ?? null;
        if (message.status === "streaming") {
          unfinishedMessages.add(message.id);
          if (runId) unfinishedRuns.add(runId);
          continue;
        }
        const seenUnfinished = (runId !== null && unfinishedRuns.has(runId)) || unfinishedMessages.has(message.id);
        if (!seenUnfinished) continue;
        unfinishedMessages.delete(message.id);
        if (runId) unfinishedRuns.delete(runId);
        if (runId && message.status === "complete" && onScreen()) reportShownRun(environment, runId);
      }
    };
    observe(selectThreadSnapshot(useThreadStore.getState(), chatId).messages);
    return useThreadStore.subscribe((state, previous) => {
      const messages = selectThreadSnapshot(state, chatId).messages;
      if (messages !== selectThreadSnapshot(previous, chatId).messages) observe(messages);
    });
  }, [active, chatId, environment, onScreen]);
}
