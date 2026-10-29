"use client";

import { useEffect, useRef } from "react";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { SUBAGENT_VIEW_LIMITS } from "@/lib/contracts/subagentViews";
import { SUBAGENT_POLL_INTERVAL_MS, invalidateChatSubagents, refreshSubagentSummary, useSubagentStore } from "./subagentStore";
import { useSubagentThreadAddress } from "./subagentThreadAddress";

const split = (key: string): string[] => key ? key.split("\0") : [];

/**
 * Keeps the sub-agent projections current, without a channel of their own:
 * the listed chats once (and again on focus or reconnect), the open chat on
 * open and on every branch or message change, and every chat whose
 * sub-agents run or whose main answer streams (it may start some) on a short
 * interval while the tab is visible. Mounted once by the shell.
 */
export function SubagentLivenessV2({
  onActiveChatSettled
}: Readonly<{
  /**
   * A sub-agent of the open chat ended while its main agent was idle: the
   * server may have started a wake-up answer the chat has not seen yet.
   */
  onActiveChatSettled?(chatId: string): void;
}>) {
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const activeLeaf = useWorkspaceStore((state) => state.activeChatId
    ? state.chats.find((chat) => chat.id === state.activeChatId)?.activeLeafMessageId ?? null
    : null);
  const listKey = useWorkspaceStore((state) => state.navigationChats
    .slice(0, SUBAGENT_VIEW_LIMITS.chatsPerSummary - 1).map((chat) => chat.id).join("\0"));
  const streamKey = useRunLifecycleStore((state) => Object.keys(state.activeStreams).sort().join("\0"));
  const runningKey = useSubagentStore((state) => Object.values(state.chats)
    .filter((chat) => chat.running > 0).map((chat) => chat.chatId).sort().join("\0"));
  const activeRunning = useSubagentStore((state) => activeChatId ? state.chats[activeChatId]?.running ?? 0 : 0);
  const settledRef = useRef(onActiveChatSettled);
  useEffect(() => {
    settledRef.current = onActiveChatSettled;
  });

  useSubagentThreadAddress(activeChatId);

  useEffect(() => {
    const ids = [...new Set([...(activeChatId ? [activeChatId] : []), ...split(listKey)])];
    if (ids.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void refreshSubagentSummary(ids, controller.signal), 250);
    const refresh = () => {
      if (document.visibilityState !== "hidden") void refreshSubagentSummary(ids, controller.signal);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [activeChatId, listKey]);

  // A new branch (or message) of the open chat drops what earlier requests
  // say about the old one; its rows refresh for the branch now shown.
  useEffect(() => {
    if (activeChatId) void invalidateChatSubagents(activeChatId);
  }, [activeChatId, activeLeaf]);

  useEffect(() => {
    const ids = [...new Set([...split(runningKey), ...split(streamKey)])];
    if (ids.length === 0) return;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (document.visibilityState !== "hidden") await refreshSubagentSummary(ids, controller.signal);
        if (!disposed) schedule();
      }, SUBAGENT_POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [runningKey, streamKey]);

  // A main answer that ended may have started or ended sub-agents.
  const streamsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const now = split(streamKey);
    const ended = streamsRef.current.filter((chatId) => !now.includes(chatId));
    streamsRef.current = now;
    if (ended.length > 0) void refreshSubagentSummary(ended);
  }, [streamKey]);

  const previousRef = useRef<Readonly<{ chatId: string | null; running: number }>>({ chatId: null, running: 0 });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { chatId: activeChatId, running: activeRunning };
    if (!activeChatId || previous.chatId !== activeChatId || activeRunning >= previous.running) return;
    // A callback into a streaming answer joins that answer; only an idle chat may wake.
    if (useRunLifecycleStore.getState().activeStreams[activeChatId]) return;
    settledRef.current?.(activeChatId);
  }, [activeChatId, activeRunning]);

  return null;
}
