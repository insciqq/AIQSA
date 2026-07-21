import { mergeThreadMessages as mergeThreadMessageList } from "@/components/app-shell/runState";
import {
  branchTreeHasForks,
  effectiveActiveLeafId,
  visibleMessagePath
} from "@/components/app-shell/threadPath";
import type { ChatUsageStats, ThreadMessage } from "@/components/app-shell/types";
import { create } from "zustand";

export type ThreadSnapshot = {
  activeLeafId: string | null;
  messages: ThreadMessage[];
  sourceUpdatedAt: string | null;
  usageStats: ChatUsageStats | null;
};

type ThreadPatchOptions = {
  activeLeafId?: string | null;
  sourceUpdatedAt?: string | null;
  usageStats?: ChatUsageStats | null;
};

type ThreadReplacement = Omit<ThreadSnapshot, "sourceUpdatedAt"> & {
  sourceUpdatedAt?: string | null;
};

export type ThreadStore = {
  threadsByChatId: Record<string, ThreadSnapshot>;
  appendMessage(chatId: string, message: ThreadMessage, options?: { activate?: boolean }): void;
  checkoutBranch(chatId: string, messageId: string | null): void;
  deleteMessages(
    chatId: string,
    input: { activeLeafId: string | null; deletedIds: Set<string> }
  ): void;
  mergeMessages(chatId: string, updates: ThreadMessage[], options?: ThreadPatchOptions): void;
  removeThread(chatId: string): void;
  replaceThread(chatId: string, input: ThreadReplacement): void;
  updateMessages(chatId: string, update: (current: ThreadMessage[]) => ThreadMessage[]): void;
};

export const emptyThreadSnapshot: ThreadSnapshot = {
  activeLeafId: null,
  messages: [],
  sourceUpdatedAt: null,
  usageStats: null
};

export const initialThreadStoreState: Pick<ThreadStore, "threadsByChatId"> = {
  threadsByChatId: {}
};

function currentSnapshot(
  threadsByChatId: Record<string, ThreadSnapshot>,
  chatId: string
): ThreadSnapshot {
  return threadsByChatId[chatId] ?? emptyThreadSnapshot;
}

function withSnapshot(
  state: Pick<ThreadStore, "threadsByChatId">,
  chatId: string,
  snapshot: ThreadSnapshot
): Pick<ThreadStore, "threadsByChatId"> {
  return {
    threadsByChatId: {
      ...state.threadsByChatId,
      [chatId]: snapshot
    }
  };
}

function patchedValue<T>(
  options: ThreadPatchOptions | undefined,
  key: "activeLeafId" | "sourceUpdatedAt" | "usageStats",
  fallback: T
): T {
  const value = options?.[key];
  return value !== undefined ? (value as T) : fallback;
}

export function selectThreadSnapshot(
  state: Pick<ThreadStore, "threadsByChatId">,
  chatId: string | null
): ThreadSnapshot {
  return chatId ? state.threadsByChatId[chatId] ?? emptyThreadSnapshot : emptyThreadSnapshot;
}

export function selectThreadRenderActiveLeafId(state: ThreadSnapshot): string | null {
  return effectiveActiveLeafId(state.messages, state.activeLeafId);
}

export function selectThreadVisibleMessages(state: ThreadSnapshot): ThreadMessage[] {
  return visibleMessagePath(state.messages, state.activeLeafId);
}

export function selectThreadHasForks(state: ThreadSnapshot): boolean {
  return branchTreeHasForks(state.messages);
}

export const useThreadStore = create<ThreadStore>((set) => ({
  ...initialThreadStoreState,
  appendMessage(chatId, message, options) {
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      return withSnapshot(state, chatId, {
        ...current,
        activeLeafId: options?.activate ? message.id : current.activeLeafId,
        messages: [...current.messages, message]
      });
    });
  },
  checkoutBranch(chatId, messageId) {
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      return withSnapshot(state, chatId, {
        ...current,
        activeLeafId: messageId
      });
    });
  },
  deleteMessages(chatId, { activeLeafId, deletedIds }) {
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      return withSnapshot(state, chatId, {
        ...current,
        activeLeafId,
        messages: current.messages.filter((message) => !deletedIds.has(message.id))
      });
    });
  },
  mergeMessages(chatId, updates, options) {
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      return withSnapshot(state, chatId, {
        activeLeafId: patchedValue(options, "activeLeafId", current.activeLeafId),
        messages: mergeThreadMessageList(current.messages, updates),
        sourceUpdatedAt: patchedValue(options, "sourceUpdatedAt", current.sourceUpdatedAt),
        usageStats: patchedValue(options, "usageStats", current.usageStats)
      });
    });
  },
  removeThread(chatId) {
    set((state) => {
      if (!(chatId in state.threadsByChatId)) {
        return state;
      }

      const { [chatId]: _removed, ...threadsByChatId } = state.threadsByChatId;
      return { threadsByChatId };
    });
  },
  replaceThread(chatId, input) {
    set((state) =>
      withSnapshot(state, chatId, {
        ...input,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null
      })
    );
  },
  updateMessages(chatId, update) {
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      return withSnapshot(state, chatId, {
        ...current,
        messages: update(current.messages)
      });
    });
  }
}));

export function resetThreadStoreForTest() {
  useThreadStore.setState({
    threadsByChatId: {}
  });
}
