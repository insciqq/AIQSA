import type { ChatAssistantProjection } from "@/lib/contracts/chats";
import { create } from "zustand";

/**
 * The server's Assistant projection of each chat read in this session: the
 * single owner the composer restores a chat's Assistant from. An absent key
 * means the projection has not been read yet; null means the chat has none.
 */
export type ChatAssistantProjectionStore = {
  pendingChatIds: Readonly<Record<string, number>>;
  projections: Readonly<Record<string, ChatAssistantProjection | null>>;
  beginUpdate(chatId: string): void;
  finishUpdate(chatId: string): void;
  forget(chatId: string): void;
  setProjection(chatId: string, projection: ChatAssistantProjection | null): void;
};

export const useChatAssistantProjectionStore = create<ChatAssistantProjectionStore>((set) => ({
  pendingChatIds: {},
  projections: {},
  beginUpdate(chatId) {
    set((state) => ({
      pendingChatIds: { ...state.pendingChatIds, [chatId]: (state.pendingChatIds[chatId] ?? 0) + 1 }
    }));
  },
  finishUpdate(chatId) {
    set((state) => {
      const pendingChatIds = { ...state.pendingChatIds };
      const count = (pendingChatIds[chatId] ?? 0) - 1;
      if (count > 0) pendingChatIds[chatId] = count;
      else delete pendingChatIds[chatId];
      return { pendingChatIds };
    });
  },
  forget(chatId) {
    set((state) => {
      if (!(chatId in state.projections)) return {};
      const projections = { ...state.projections };
      delete projections[chatId];
      return { projections };
    });
  },
  setProjection(chatId, projection) {
    set((state) => ({ projections: { ...state.projections, [chatId]: projection } }));
  }
}));

export function cachedChatAssistantProjection(
  chatId: string
): ChatAssistantProjection | null | undefined {
  const projections = useChatAssistantProjectionStore.getState().projections;
  return chatId in projections ? projections[chatId] : undefined;
}
