import { useEffect, useRef } from "react";
import type { WorkspaceChatSummary } from "./types";
import { shellFetch, subscribeToSessionExpired } from "./shellApi";
import { useWorkspaceStore } from "./workspaceStore";

/** A bounded metadata refresh survives navigation and never owns a run or its
 * stream. Only the title is merged, leaving current controls/history intact. */
export function useChatTitleReconciliation(input: Readonly<{
  accountId: string;
  chats: readonly WorkspaceChatSummary[];
}>): void {
  const pendingIds = input.chats.filter((chat) => !chat.projectId && chat.titlePending)
    .map((chat) => chat.id).sort().join("\0");
  const syncPending = useRef<(ids: readonly string[]) => void>(() => undefined);
  useEffect(() => {
    const controller = new AbortController();
    const pending = new Map<string, number>();
    let delay = 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let request: AbortController | null = null;
    const halt = () => { clearTimeout(timer); controller.abort(); };
    const schedule = () => {
      if (timer || polling || controller.signal.aborted || document.visibilityState !== "visible") return;
      if ([...pending.values()].some((deadline) => Date.now() < deadline)) {
        timer = setTimeout(() => { timer = undefined; void poll(); }, delay);
      }
    };
    const poll = async () => {
      if (polling || controller.signal.aborted || document.visibilityState !== "visible") return;
      polling = true;
      try {
        for (const [chatId, deadline] of pending) {
          if (Date.now() >= deadline) continue;
          if (controller.signal.aborted || document.visibilityState !== "visible") break;
          const before = useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId);
          if (!before?.titlePending) { pending.delete(chatId); continue; }
          try {
            request = new AbortController();
            const response = await shellFetch(`/api/chats/${encodeURIComponent(chatId)}/title`, {
              signal: AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(10_000)])
            });
            if ([401, 403, 404].includes(response.status)) { pending.delete(chatId); continue; }
            if (!response.ok) continue;
            const value: unknown = await response.json();
            if (!value || typeof value !== "object" || !("title" in value) || !("pending" in value) ||
              typeof value.title !== "string" || !value.title || typeof value.pending !== "boolean") continue;
            if (controller.signal.aborted) break;
            const current = useWorkspaceStore.getState();
            // A rename wins, while unrelated changes to controls or messages
            // must not discard a completed title. Merge only title metadata.
            const currentChat = current.chats.find((chat) => chat.id === chatId);
            if (!currentChat?.titlePending || currentChat.projectId || currentChat.title !== before.title) continue;
            const title = value.title;
            const titlePending = value.pending;
            useWorkspaceStore.setState((state) => ({
              chats: state.chats.map((chat) => chat.id === chatId ? { ...chat, title, titlePending } : chat),
              navigationChats: state.navigationChats.map((chat) => chat.id === chatId ? { ...chat, title } : chat),
              navigationSearchChats: state.navigationSearchChats.map((chat) => chat.id === chatId ? { ...chat, title } : chat)
            }));
            if (!titlePending) pending.delete(chatId);
          } catch { /* Keep the current title and retry at the bounded cadence. */ }
          finally { request = null; }
        }
      } finally {
        polling = false;
        delay = Math.min(delay * 2, 15_000);
        schedule();
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") request?.abort();
      else {
        // A hidden tab may outlive the job. Give every pending title a fresh
        // bounded foreground window so its terminal state can still arrive.
        for (const chatId of pending.keys()) pending.set(chatId, Date.now() + 360_000);
        schedule();
      }
    };
    syncPending.current = (ids) => {
      const selected = new Set(ids);
      for (const chatId of pending.keys()) if (!selected.has(chatId)) pending.delete(chatId);
      if (!pending.size) delay = 1_000;
      for (const chatId of ids) if (!pending.has(chatId)) pending.set(chatId, Date.now() + 360_000);
      if (!pending.size) { clearTimeout(timer); timer = undefined; }
      schedule();
    };
    const unsubscribe = subscribeToSessionExpired(halt);
    document.addEventListener("visibilitychange", visibility);
    return () => { halt(); syncPending.current = () => undefined; unsubscribe(); document.removeEventListener("visibilitychange", visibility); };
  }, [input.accountId]);
  useEffect(() => {
    syncPending.current(pendingIds ? pendingIds.split("\0") : []);
  }, [input.accountId, pendingIds]);
}
