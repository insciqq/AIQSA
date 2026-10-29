"use client";

import { useEffect } from "react";
import { isSubagentIdentifier } from "@/lib/contracts/subagents";
import { SUBAGENT_THREAD_ROUTE_PARAMETER, formatChatRoutePath, parseChatRoutePath } from "@/lib/domain/chatRoute";
import { setOpenSubagentThread, useSubagentStore, type SubagentThreadTarget } from "./subagentStore";

/**
 * A sub-agent's thread view is a state of its chat's address
 * (`/c/<chat>?agent=<thread>`), so reload, back and forward keep it and
 * another chat never inherits it (`CHAT_SCOPED_ROUTE_PARAMETERS`). The view
 * shows only while its chat is the open one.
 */
export function subagentThreadHref(target: SubagentThreadTarget): string {
  const query = new URLSearchParams({ [SUBAGENT_THREAD_ROUTE_PARAMETER]: target.threadId });
  return `${formatChatRoutePath({ chatId: target.chatId })}?${query.toString()}`;
}

/** The thread the current address names, or null. */
export function subagentThreadFromAddress(): SubagentThreadTarget | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const chatId = parseChatRoutePath(url.pathname)?.chatId ?? null;
  const values = url.searchParams.getAll(SUBAGENT_THREAD_ROUTE_PARAMETER);
  const threadId = values.length === 1 ? values[0]! : null;
  return chatId && isSubagentIdentifier(threadId) ? { chatId, threadId } : null;
}

function writeAddress(target: SubagentThreadTarget | null, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  const chatId = parseChatRoutePath(url.pathname)?.chatId ?? null;
  const params = target && chatId !== target.chatId ? new URLSearchParams() : new URLSearchParams(url.search);
  params.delete(SUBAGENT_THREAD_ROUTE_PARAMETER);
  if (target) params.set(SUBAGENT_THREAD_ROUTE_PARAMETER, target.threadId);
  const path = target ? formatChatRoutePath({ chatId: target.chatId }) : url.pathname;
  const query = params.toString();
  const href = `${path}${query ? `?${query}` : ""}${target ? "" : url.hash}`;
  if (href === `${url.pathname}${url.search}${url.hash}`) return;
  // A null state lets the framework router adopt the new address.
  if (mode === "push") window.history.pushState(null, "", href);
  else window.history.replaceState(null, "", href);
}

/**
 * Opens a thread view. `push` adds one history entry (a user's choice in the
 * open chat); `replace` settles the entry a chat navigation just added, so
 * opening another chat's sub-agent is still one entry.
 */
export function openSubagentThread(target: SubagentThreadTarget, mode: "push" | "replace" = "push"): void {
  writeAddress(target, mode);
  setOpenSubagentThread(target);
}

/** Back to the chat: one history entry, like any other navigation in the shell. */
export function closeSubagentThread(): void {
  if (useSubagentStore.getState().openThread === null && subagentThreadFromAddress() === null) return;
  writeAddress(null, "push");
  setOpenSubagentThread(null);
}

/**
 * Follows the address into the open thread: on load, on back and forward,
 * and when the open chat changes. A view of a chat that is no longer open
 * closes.
 */
export function useSubagentThreadAddress(activeChatId: string | null): void {
  useEffect(() => {
    const sync = () => {
      const target = subagentThreadFromAddress();
      setOpenSubagentThread(target && target.chatId === activeChatId ? target : null);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [activeChatId]);
}

/** The thread view the open chat shows, or null. */
export function useOpenSubagentThread(activeChatId: string | null): SubagentThreadTarget | null {
  const open = useSubagentStore((state) => state.openThread);
  return open && open.chatId === activeChatId ? open : null;
}
