import { decodeChatSummaryResponse } from "@/lib/contracts/chats";
import type { SearchPlan } from "@/lib/domain/search";
import { useWorkspaceStore } from "./workspaceStore";

/** Serialize writes per chat; rapid clicks and navigation cannot reorder saves. */
export function createChatSearchPreferences(input: { session?: symbol; isCurrent(): boolean; onError(): void }) {
  const queues = new Map<string, Promise<void>>();
  return {
    session: input.session,
    save(chatId: string, plan: SearchPlan) {
      const next = (queues.get(chatId) ?? Promise.resolve()).then(async () => {
        if (!input.isCurrent()) return;
        try {
          const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ defaultSearchPlan: plan })
          });
          const saved = response.ok ? decodeChatSummaryResponse(await response.json()) : null;
          if (!saved || saved.id !== chatId) throw new Error("chat_search_save_failed");
          if (input.isCurrent() && queues.get(chatId) === next) {
            updateLocalChatSearch(chatId, plan, saved.updatedAt);
          }
        } catch {
          if (input.isCurrent()) input.onError();
        }
      }).finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
      queues.set(chatId, next);
      return next;
    }
  };
}

export function updateLocalChatSearch(chatId: string, plan: SearchPlan, updatedAt?: string) {
  useWorkspaceStore.getState().setChats(chats => chats.map(chat => {
    if (chat.id !== chatId || updatedAt && Date.parse(chat.updatedAt) > Date.parse(updatedAt)) return chat;
    return { ...chat, defaultSearchPlan: plan, ...(updatedAt ? { updatedAt } : {}) };
  }));
}
