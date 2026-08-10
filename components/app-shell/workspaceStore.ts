import type { Catalog, FolderSummary, WorkspaceChatSummary } from "@/components/app-shell/types";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);

export type WorkspaceSnapshot = {
  activeChatDetailError: string | null;
  activeChatDetailLoading: boolean;
  activeChatId: string | null;
  catalog: Catalog | null;
  catalogError: string | null;
  chats: WorkspaceChatSummary[];
  creatingChat: boolean;
  folders: FolderSummary[];
  pendingChatFolderId: string | null;
  workspaceError: string | null;
  workspaceLoading: boolean;
  workspaceReady: boolean;
};

export type WorkspaceStore = WorkspaceSnapshot & {
  setActiveChatDetailError(value: string | null): void;
  setActiveChatDetailLoading(value: boolean): void;
  setActiveChatId(value: string | null): void;
  setCatalog(update: StateUpdate<Catalog | null>): void;
  setCatalogError(value: string | null): void;
  setChats(update: StateUpdate<WorkspaceChatSummary[]>): void;
  setCreatingChat(value: boolean): void;
  setFolders(update: StateUpdate<FolderSummary[]>): void;
  setPendingChatFolderId(value: string | null): void;
  setWorkspaceError(value: string | null): void;
  setWorkspaceLoading(value: boolean): void;
  setWorkspaceReady(value: boolean): void;
  updateChats(update: (current: WorkspaceChatSummary[]) => WorkspaceChatSummary[]): void;
  updateFolders(update: (current: FolderSummary[]) => FolderSummary[]): void;
  upsertChat(chat: WorkspaceChatSummary): void;
};

export const initialWorkspaceSnapshot: WorkspaceSnapshot = {
  activeChatDetailError: null,
  activeChatDetailLoading: false,
  activeChatId: null,
  catalog: null,
  catalogError: null,
  chats: [],
  creatingChat: false,
  folders: [],
  pendingChatFolderId: null,
  workspaceError: null,
  workspaceLoading: true,
  workspaceReady: false
};

function applyUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export function sortChatsByFavoriteThenUpdatedAt(
  chatList: WorkspaceChatSummary[]
): WorkspaceChatSummary[] {
  return [...chatList].sort((a, b) => {
    const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinned !== 0) {
      return pinned;
    }

    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function sortFoldersByOrder(folders: FolderSummary[]): FolderSummary[] {
  return [...folders].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  ...initialWorkspaceSnapshot,
  setActiveChatDetailError(value) {
    set({ activeChatDetailError: value });
  },
  setActiveChatDetailLoading(value) {
    set({ activeChatDetailLoading: value });
  },
  setActiveChatId(value) {
    set({ activeChatId: value });
  },
  setCatalog(update) {
    set((state) => ({ catalog: applyUpdate(state.catalog, update) }));
  },
  setCatalogError(value) {
    set({ catalogError: value });
  },
  setChats(update) {
    set((state) => ({ chats: applyUpdate(state.chats, update) }));
  },
  setCreatingChat(value) {
    set({ creatingChat: value });
  },
  setFolders(update) {
    set((state) => ({ folders: applyUpdate(state.folders, update) }));
  },
  setPendingChatFolderId(value) {
    set({ pendingChatFolderId: value });
  },
  setWorkspaceError(value) {
    set({ workspaceError: value });
  },
  setWorkspaceLoading(value) {
    set({ workspaceLoading: value });
  },
  setWorkspaceReady(value) {
    set({ workspaceReady: value });
  },
  updateChats(update) {
    set((state) => ({ chats: update(state.chats) }));
  },
  updateFolders(update) {
    set((state) => ({ folders: update(state.folders) }));
  },
  upsertChat(chat) {
    set((state) => ({
      chats: sortChatsByFavoriteThenUpdatedAt([
        {
          ...state.chats.find((candidate) => candidate.id === chat.id),
          ...chat
        },
        ...state.chats.filter((candidate) => candidate.id !== chat.id)
      ])
    }));
  }
}));

export function workspaceNavigationChats(chats: readonly WorkspaceChatSummary[]): WorkspaceChatSummary[] {
  return chats.filter(
    (chat) => chat.memoryMode !== "TEMPORARY" && chat.pendingInitialMemoryMode !== "TEMPORARY"
  );
}

export function resetWorkspaceStoreForTest() {
  useWorkspaceStore.setState({
    ...initialWorkspaceSnapshot,
    chats: [],
    folders: []
  });
}
