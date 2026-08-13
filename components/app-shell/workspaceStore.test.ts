import { afterEach, describe, expect, it } from "vitest";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";
import type { ChatSummary, FolderSummary } from "./types";

function chat(input: Partial<ChatSummary> & { id: string; title: string }): ChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    messageCount: 0,
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...input
  };
}

function folder(input: Partial<FolderSummary> & { id: string; name: string }): FolderSummary {
  return {
    parentId: null,
    projectMemory: "",
    sortOrder: 0,
    ...input
  };
}

describe("workspace store", () => {
  afterEach(() => {
    resetWorkspaceStoreForTest();
  });

  it("records workspace bootstrap data", () => {
    const folderA = folder({ id: "folder-a", name: "A" });
    const chatA = chat({ id: "chat-a", title: "A" });

    useWorkspaceStore.getState().setWorkspaceLoading(false);
    useWorkspaceStore.getState().setWorkspaceError(null);
    useWorkspaceStore.getState().setWorkspaceReady(true);
    useWorkspaceStore.getState().setFolders([folderA]);
    useWorkspaceStore.getState().setChats([chatA]);

    expect(useWorkspaceStore.getState()).toMatchObject({
      chats: [chatA],
      folders: [folderA],
      workspaceError: null,
      workspaceLoading: false,
      workspaceReady: true
    });
  });

  it("records chat activation and blank workspace transitions", () => {
    useWorkspaceStore.getState().setActiveChatId("chat-a");
    useWorkspaceStore.getState().setActiveChatDetailLoading(true);
    useWorkspaceStore.getState().setActiveChatDetailError(null);

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeChatDetailError: null,
      activeChatDetailLoading: true,
      activeChatId: "chat-a"
    });

    useWorkspaceStore.getState().setPendingChatFolderId("folder-a");
    useWorkspaceStore.getState().setActiveChatId(null);
    useWorkspaceStore.getState().setActiveChatDetailLoading(false);

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeChatDetailLoading: false,
      activeChatId: null,
      pendingChatFolderId: "folder-a"
    });
  });

  it("applies chat-list patches and sorted upserts", () => {
    const olderPinned = chat({
      id: "chat-pinned",
      pinned: true,
      title: "Pinned",
      updatedAt: "2026-06-09T00:00:00.000Z"
    });
    const newerPlain = chat({
      id: "chat-newer",
      title: "Newer",
      updatedAt: "2026-06-11T00:00:00.000Z"
    });

    useWorkspaceStore.getState().setChats([newerPlain]);
    useWorkspaceStore.getState().upsertChat(olderPinned);
    useWorkspaceStore
      .getState()
      .updateChats((current) =>
        current.map((candidate) =>
          candidate.id === "chat-newer" ? { ...candidate, folderId: "folder-a" } : candidate
        )
      );

    expect(useWorkspaceStore.getState().chats.map((candidate) => candidate.id)).toEqual([
      "chat-pinned",
      "chat-newer"
    ]);
    expect(useWorkspaceStore.getState().chats.find((candidate) => candidate.id === "chat-newer")?.folderId).toBe(
      "folder-a"
    );
  });

  it("merges compact navigation pages and keeps search results isolated", () => {
    const older = {
      activeRun: false,
      folderId: null,
      id: "older",
      title: "Older",
      updatedAt: "2026-06-10T00:00:00.000Z"
    };
    const newer = {
      ...older,
      activeRun: true,
      folderId: "folder-a",
      id: "newer",
      title: "Newer",
      updatedAt: "2026-06-11T00:00:00.000Z"
    };
    const store = useWorkspaceStore.getState();
    store.applyNavigationPage({
      chats: [older],
      folders: [{ id: "folder-a", name: "Work", parentId: null }],
      nextCursor: "next"
    }, false);
    useWorkspaceStore.getState().applyNavigationPage({
      chats: [newer, { ...older, activeRun: true }],
      folders: [{ id: "folder-a", name: "Work", parentId: null }],
      nextCursor: null
    }, true);

    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationChats: [newer, { ...older, activeRun: true }],
      navigationNextCursor: null,
      navigationReady: true
    });

    useWorkspaceStore.getState().setNavigationSearchQuery("new");
    useWorkspaceStore.getState().applyNavigationSearchPage({
      chats: [newer],
      folders: [],
      nextCursor: null
    }, false);
    useWorkspaceStore.getState().removeNavigationChat(newer.id);
    expect(useWorkspaceStore.getState().navigationChats).toEqual([{ ...older, activeRun: true }]);
    expect(useWorkspaceStore.getState().navigationSearchChats).toEqual([]);
  });
});
