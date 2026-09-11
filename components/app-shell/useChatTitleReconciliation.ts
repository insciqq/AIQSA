import { useEffect } from "react";
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
  useEffect(() => {
    if (!pendingIds) return;
    const controller = new AbortController();
    const pending = new Set(pendingIds.split("\0"));
    const deadline = Date.now() + 360_000;
    let delay = 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let request: AbortController | null = null;
    const halt = () => { clearTimeout(timer); controller.abort(); };
    const schedule = () => {
      if (!controller.signal.aborted && pending.size && Date.now() < deadline && document.visibilityState === "visible") {
        timer = setTimeout(() => { void poll(); }, delay);
      }
    };
    const poll = async () => {
      if (polling || controller.signal.aborted || document.visibilityState !== "visible") return;
      polling = true;
      try {
        for (const chatId of pending) {
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
            // A rename or another summary update during this request wins.
            // A subsequent poll can read its current title without restoring a stale one.
            if (current.chats.find((chat) => chat.id === chatId) !== before) continue;
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
      if (document.visibilityState !== "visible") request?.abort();
      if (!polling) schedule();
    };
    const unsubscribe = subscribeToSessionExpired(halt);
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => { halt(); unsubscribe(); document.removeEventListener("visibilitychange", visibility); };
  }, [input.accountId, pendingIds]);
}
