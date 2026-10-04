import type { Catalog, FolderSummary, WorkspaceChatSummary } from "@/components/app-shell/types";
import type {
  ChatMessageMatchPageWire,
  ChatMessageMatchWire,
  ChatNavigationFolderWire,
  ChatNavigationPageWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);

export type WorkspaceSnapshot = {
  activeChatDetailError: string | null;
  activeChatDetailLoading: boolean;
  activeChatId: string | null;
  catalog: Catalog | null;
  catalogAccountId: string | null;
  catalogError: string | null;
  chats: WorkspaceChatSummary[];
  creatingChat: boolean;
  folders: FolderSummary[];
  navigationAttempted: boolean;
  navigationChats: ChatNavigationSummaryWire[];
  navigationError: string | null;
  navigationFolders: ChatNavigationFolderWire[];
  navigationLoading: boolean;
  /**
   * Chats whose message text matches the search query: a list of its own,
   * loaded beside the title results with its own loading and failure.
   */
  navigationMessageMatches: ChatMessageMatchWire[];
  navigationMessageMatchesError: string | null;
  navigationMessageMatchesLoading: boolean;
  navigationMessageMatchesNextCursor: string | null;
  /** The first message page of the current query has arrived. */
  navigationMessageMatchesReady: boolean;
  navigationNextCursor: string | null;
  navigationReady: boolean;
  navigationSearchChats: ChatNavigationSummaryWire[];
  navigationSearchError: string | null;
  navigationSearchLoading: boolean;
  navigationSearchNextCursor: string | null;
  navigationSearchQuery: string;
  pendingChatFolderId: string | null;
  workspaceError: string | null;
  workspaceLoading: boolean;
  workspaceReady: boolean;
};

export type WorkspaceStore = WorkspaceSnapshot & {
  setActiveChatDetailError(value: string | null): void;
  setActiveChatDetailLoading(value: boolean): void;
  setActiveChatId(value: string | null): void;
  setCatalog(update: StateUpdate<Catalog | null>, accountId?: string): void;
  setCatalogError(value: string | null): void;
  setChats(update: StateUpdate<WorkspaceChatSummary[]>): void;
  setCreatingChat(value: boolean): void;
  setFolders(update: StateUpdate<FolderSummary[]>): void;
  applyNavigationPage(page: ChatNavigationPageWire, append: boolean): void;
  applyNavigationSearchPage(page: ChatNavigationPageWire, append: boolean): void;
  /** A first page replaces the message matches; a later page continues them. */
  applyNavigationMessageMatchPage(page: ChatMessageMatchPageWire, append: boolean): void;
  setNavigationError(value: string | null): void;
  setNavigationLoading(value: boolean): void;
  setNavigationMessageMatchesError(value: string | null): void;
  setNavigationMessageMatchesLoading(value: boolean): void;
  setNavigationSearchError(value: string | null): void;
  setNavigationSearchLoading(value: boolean): void;
  setNavigationSearchQuery(value: string): void;
  setNavigationChatActiveRun(chatId: string, activeRun: boolean): void;
  upsertNavigationChat(chat: ChatNavigationSummaryWire): void;
  removeNavigationChat(chatId: string): void;
  upsertNavigationFolder(folder: ChatNavigationFolderWire): void;
  removeNavigationFolder(folderId: string): void;
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
  catalogAccountId: null,
  catalogError: null,
  chats: [],
  creatingChat: false,
  folders: [],
  navigationAttempted: false,
  navigationChats: [],
  navigationError: null,
  navigationFolders: [],
  navigationLoading: false,
  navigationMessageMatches: [],
  navigationMessageMatchesError: null,
  navigationMessageMatchesLoading: false,
  navigationMessageMatchesNextCursor: null,
  navigationMessageMatchesReady: false,
  navigationNextCursor: null,
  navigationReady: false,
  navigationSearchChats: [],
  navigationSearchError: null,
  navigationSearchLoading: false,
  navigationSearchNextCursor: null,
  navigationSearchQuery: "",
  pendingChatFolderId: null,
  workspaceError: null,
  workspaceLoading: true,
  workspaceReady: false
};

function applyUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function mergeNavigationChats(
  current: readonly ChatNavigationSummaryWire[],
  incoming: readonly ChatNavigationSummaryWire[],
  append: boolean
): ChatNavigationSummaryWire[] {
  const byId = new Map(
    (append ? [...current, ...incoming] : [...incoming]).map((chat) => [chat.id, chat])
  );
  return [...byId.values()].sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id)
  );
}

function mergeNavigationFolders(
  current: readonly ChatNavigationFolderWire[],
  incoming: readonly ChatNavigationFolderWire[]
): ChatNavigationFolderWire[] {
  return [...new Map([...current, ...incoming].map((folder) => [folder.id, folder])).values()];
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
  setCatalog(update, accountId) {
    set((state) => ({
      catalog: applyUpdate(state.catalog, update),
      ...(accountId !== undefined ? { catalogAccountId: accountId } : {})
    }));
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
  applyNavigationPage(page, append) {
    set((state) => ({
      navigationAttempted: true,
      navigationChats: mergeNavigationChats(state.navigationChats, page.chats, append),
      navigationError: null,
      navigationFolders: mergeNavigationFolders(
        append ? state.navigationFolders : [],
        page.folders
      ),
      navigationLoading: false,
      navigationNextCursor: page.nextCursor,
      navigationReady: true
    }));
  },
  applyNavigationSearchPage(page, append) {
    set((state) => ({
      navigationFolders: mergeNavigationFolders(state.navigationFolders, page.folders),
      navigationSearchChats: mergeNavigationChats(
        state.navigationSearchChats,
        page.chats,
        append
      ),
      navigationSearchError: null,
      navigationSearchLoading: false,
      navigationSearchNextCursor: page.nextCursor
    }));
  },
  applyNavigationMessageMatchPage(page, append) {
    set((state) => {
      // Server order continues the list; a chat already shown keeps its place.
      const shown = new Set(append ? state.navigationMessageMatches.map((match) => match.chatId) : []);
      return {
        navigationMessageMatches: [
          ...(append ? state.navigationMessageMatches : []),
          ...page.matches.filter((match) => !shown.has(match.chatId))
        ],
        navigationMessageMatchesError: null,
        navigationMessageMatchesLoading: false,
        navigationMessageMatchesNextCursor: page.nextCursor,
        navigationMessageMatchesReady: true
      };
    });
  },
  setNavigationError(value) {
    set({ navigationError: value });
  },
  setNavigationMessageMatchesError(value) {
    set({ navigationMessageMatchesError: value });
  },
  setNavigationMessageMatchesLoading(value) {
    set({ navigationMessageMatchesLoading: value });
  },
  setNavigationLoading(value) {
    // A started request (like an applied page) marks the list attempted; the
    // sidebar never auto-loads it again, so failures wait for a retry event.
    set(value ? { navigationAttempted: true, navigationLoading: true } : { navigationLoading: false });
  },
  setNavigationSearchError(value) {
    set({ navigationSearchError: value });
  },
  setNavigationSearchLoading(value) {
    set({ navigationSearchLoading: value });
  },
  setNavigationSearchQuery(value) {
    set({
      navigationMessageMatches: [],
      navigationMessageMatchesError: null,
      navigationMessageMatchesLoading: false,
      navigationMessageMatchesNextCursor: null,
      navigationMessageMatchesReady: false,
      navigationSearchChats: [],
      navigationSearchError: null,
      navigationSearchLoading: false,
      navigationSearchNextCursor: null,
      navigationSearchQuery: value
    });
  },
  setNavigationChatActiveRun(chatId, activeRun) {
    set((state) => ({
      navigationChats: state.navigationChats.map((chat) =>
        chat.id === chatId ? { ...chat, activeRun } : chat
      ),
      navigationSearchChats: state.navigationSearchChats.map((chat) =>
        chat.id === chatId ? { ...chat, activeRun } : chat
      )
    }));
  },
  upsertNavigationChat(chat) {
    set((state) => ({
      navigationChats: mergeNavigationChats(state.navigationChats, [chat], true),
      // A renamed chat keeps its message match under the new title.
      navigationMessageMatches: state.navigationMessageMatches.some((match) =>
        match.chatId === chat.id && match.title !== chat.title)
        ? state.navigationMessageMatches.map((match) =>
            match.chatId === chat.id ? { ...match, title: chat.title } : match)
        : state.navigationMessageMatches,
      navigationSearchChats: state.navigationSearchChats.some((item) => item.id === chat.id)
        ? mergeNavigationChats(state.navigationSearchChats, [chat], true)
        : state.navigationSearchChats
    }));
  },
  removeNavigationChat(chatId) {
    set((state) => ({
      navigationChats: state.navigationChats.filter((chat) => chat.id !== chatId),
      navigationMessageMatches: state.navigationMessageMatches.filter((match) => match.chatId !== chatId),
      navigationSearchChats: state.navigationSearchChats.filter((chat) => chat.id !== chatId)
    }));
  },
  upsertNavigationFolder(folder) {
    set((state) => ({
      navigationFolders: mergeNavigationFolders(state.navigationFolders, [folder])
    }));
  },
  removeNavigationFolder(folderId) {
    const clearFolder = (chat: ChatNavigationSummaryWire) =>
      chat.folderId === folderId ? { ...chat, folderId: null } : chat;
    set((state) => ({
      // Server deletion moves direct chats and child folders to the root.
      navigationChats: state.navigationChats.map(clearFolder),
      navigationFolders: state.navigationFolders
        .filter((folder) => folder.id !== folderId)
        .map((folder) =>
          folder.parentId === folderId ? { ...folder, parentId: null } : folder
        ),
      navigationSearchChats: state.navigationSearchChats.map(clearFolder)
    }));
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

/** Server revisions only move forward: a lagging response never rewinds a newer copy. */
export function laterRevision(current: string, incoming: string): string {
  const currentTime = Date.parse(current);
  const incomingTime = Date.parse(incoming);
  if (!Number.isFinite(incomingTime)) return current;
  return Number.isFinite(currentTime) && currentTime >= incomingTime ? current : incoming;
}

export function workspaceNavigationChats(chats: readonly WorkspaceChatSummary[]): WorkspaceChatSummary[] {
  return chats.filter(
    (chat) => !chat.projectId &&
      chat.memoryMode !== "TEMPORARY" &&
      chat.pendingInitialMemoryMode !== "TEMPORARY"
  );
}
