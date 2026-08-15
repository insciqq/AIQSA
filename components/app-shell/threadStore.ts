import { mergeThreadMessages as mergeThreadMessageList } from "@/components/app-shell/runState";
import {
  effectiveActiveLeafId,
  visibleMessagePath
} from "@/components/app-shell/threadPath";
import type {
  ChatContextStats,
  ChatUsageStats,
  ThreadMessage
} from "@/components/app-shell/types";
import { create } from "zustand";

export type ThreadSnapshot = {
  activeLeafId: string | null;
  contextStats?: ChatContextStats | null;
  history?: ThreadHistoryState;
  messages: ThreadMessage[];
  sourceUpdatedAt: string | null;
  usageStats: ChatUsageStats | null;
};

export type ThreadHistoryState = {
  beforeCursor: string | null;
  error: string | null;
  hasOlder: boolean;
  loading: boolean;
  requestGeneration: number;
  snapshotActiveLeafId: string | null;
  snapshotUpdatedAt: string | null;
};

type ThreadPatchOptions = {
  activeLeafId?: string | null;
  contextStats?: ChatContextStats | null;
  sourceUpdatedAt?: string | null;
  usageStats?: ChatUsageStats | null;
};

type ThreadReplacement = Omit<ThreadSnapshot, "sourceUpdatedAt"> & {
  sourceUpdatedAt?: string | null;
};

export type ThreadStore = {
  threadRecency: string[];
  threadsByChatId: Record<string, ThreadSnapshot>;
  appendMessage(chatId: string, message: ThreadMessage, options?: { activate?: boolean }): void;
  beginOlderPage(chatId: string): number;
  checkoutBranch(chatId: string, messageId: string | null): void;
  deleteMessages(
    chatId: string,
    input: { activeLeafId: string | null; deletedIds: Set<string> }
  ): void;
  mergeMessages(chatId: string, updates: ThreadMessage[], options?: ThreadPatchOptions): void;
  failOlderPage(chatId: string, requestGeneration: number, error: string): void;
  prependOlderPage(
    chatId: string,
    input: {
      beforeCursor: string | null;
      hasOlder: boolean;
      messages: ThreadMessage[];
      requestGeneration: number;
      snapshotActiveLeafId: string | null;
      snapshotUpdatedAt: string;
    }
  ): boolean;
  pruneInactiveThreads(input: {
    activeChatId: string | null;
    inactiveLimit?: number;
    protectedChatIds?: ReadonlySet<string>;
  }): string[];
  removeThread(chatId: string): void;
  replaceThread(chatId: string, input: ThreadReplacement): void;
  touchThread(chatId: string): void;
  updateMessages(chatId: string, update: (current: ThreadMessage[]) => ThreadMessage[]): void;
};

export const emptyThreadHistoryState: ThreadHistoryState = {
  beforeCursor: null,
  error: null,
  hasOlder: false,
  loading: false,
  requestGeneration: 0,
  snapshotActiveLeafId: null,
  snapshotUpdatedAt: null
};

export const emptyThreadSnapshot: ThreadSnapshot = {
  activeLeafId: null,
  contextStats: null,
  history: emptyThreadHistoryState,
  messages: [],
  sourceUpdatedAt: null,
  usageStats: null
};

export const initialThreadStoreState: Pick<ThreadStore, "threadRecency" | "threadsByChatId"> = {
  threadRecency: [],
  threadsByChatId: {}
};

export function threadHistoryState(snapshot: ThreadSnapshot): ThreadHistoryState {
  return snapshot.history ?? emptyThreadHistoryState;
}

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
  beginOlderPage(chatId) {
    let requestGeneration = 0;
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      const history = threadHistoryState(current);
      requestGeneration = history.requestGeneration + 1;
      return withSnapshot(state, chatId, {
        ...current,
        history: {
          ...history,
          error: null,
          loading: true,
          requestGeneration
        }
      });
    });
    return requestGeneration;
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
        contextStats: options?.contextStats !== undefined
          ? options.contextStats
          : current.contextStats ?? null,
        history: current.history,
        messages: mergeThreadMessageList(current.messages, updates),
        sourceUpdatedAt: patchedValue(options, "sourceUpdatedAt", current.sourceUpdatedAt),
        usageStats: patchedValue(options, "usageStats", current.usageStats)
      });
    });
  },
  failOlderPage(chatId, requestGeneration, error) {
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      const history = threadHistoryState(current);
      if (history.requestGeneration !== requestGeneration) return state;
      return withSnapshot(state, chatId, {
        ...current,
        history: {
          ...history,
          error,
          loading: false
        }
      });
    });
  },
  prependOlderPage(chatId, input) {
    let applied = false;
    set((state) => {
      const current = currentSnapshot(state.threadsByChatId, chatId);
      const history = threadHistoryState(current);
      if (
        history.requestGeneration !== input.requestGeneration ||
        history.snapshotActiveLeafId !== input.snapshotActiveLeafId ||
        history.snapshotUpdatedAt !== input.snapshotUpdatedAt
      ) {
        return state;
      }

      const currentIds = new Set(current.messages.map((message) => message.id));
      const older = input.messages.filter((message) => !currentIds.has(message.id));
      applied = true;
      return withSnapshot(state, chatId, {
        ...current,
        history: {
          ...history,
          beforeCursor: input.beforeCursor,
          error: null,
          hasOlder: input.hasOlder,
          loading: false
        },
        messages: [...older, ...current.messages]
      });
    });
    return applied;
  },
  pruneInactiveThreads({ activeChatId, inactiveLimit = 2, protectedChatIds = new Set() }) {
    const removed: string[] = [];
    set((state) => {
      const boundedLimit = Math.max(0, Math.floor(inactiveLimit));
      const knownIds = Object.keys(state.threadsByChatId);
      const recency = [
        ...state.threadRecency.filter((chatId) => knownIds.includes(chatId)),
        ...knownIds.filter((chatId) => !state.threadRecency.includes(chatId))
      ];
      const inactiveCandidates = recency.filter(
        (chatId) => chatId !== activeChatId && !protectedChatIds.has(chatId)
      );
      const inactiveKeep = new Set(
        boundedLimit > 0 ? inactiveCandidates.slice(-boundedLimit) : []
      );
      const threadsByChatId = Object.fromEntries(
        Object.entries(state.threadsByChatId).filter(([chatId]) => {
          const keep = chatId === activeChatId || protectedChatIds.has(chatId) || inactiveKeep.has(chatId);
          if (!keep) removed.push(chatId);
          return keep;
        })
      );
      if (removed.length === 0) return state;
      return {
        threadRecency: recency.filter((chatId) => !removed.includes(chatId)),
        threadsByChatId
      };
    });
    return removed;
  },
  removeThread(chatId) {
    set((state) => {
      if (!(chatId in state.threadsByChatId)) {
        return state;
      }

      const { [chatId]: _removed, ...threadsByChatId } = state.threadsByChatId;
      return {
        threadRecency: state.threadRecency.filter((candidate) => candidate !== chatId),
        threadsByChatId
      };
    });
  },
  replaceThread(chatId, input) {
    set((state) =>
      withSnapshot(state, chatId, {
        ...input,
        contextStats: input.contextStats ?? null,
        history: input.history ?? emptyThreadHistoryState,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null
      })
    );
  },
  touchThread(chatId) {
    set((state) => ({
      threadRecency: [...state.threadRecency.filter((candidate) => candidate !== chatId), chatId]
    }));
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
