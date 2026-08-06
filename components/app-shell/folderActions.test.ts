import { afterEach, describe, expect, it, vi } from "vitest";
import { createFolderActions } from "./folderActions";
import {
  composerSessionKey,
  resetComposerSessionStoreForTest,
  selectComposerSession,
  useComposerSessionStore
} from "./composerSessionStore";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";
import type { ChatSummary, FolderSummary, Notice } from "./types";
import type { WorkspaceFolderMutationPort } from "./useWorkspaceInteractionController";

function folder(input: Partial<FolderSummary> & { id: string; name: string }): FolderSummary {
  return {
    parentId: null,
    projectMemory: "",
    sortOrder: 0,
    ...input
  };
}

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

function createFolderActionsHarness({ activeBlankFolder = false } = {}) {
  const researchFolder = folder({ id: "folder-research", name: "Research" });
  const chats = [
    chat({ folderId: researchFolder.id, id: "chat-a", title: "Chat A" }),
    chat({ folderId: null, id: "chat-b", title: "Chat B" })
  ];
  resetComposerSessionStoreForTest();
  resetWorkspaceStoreForTest();
  useWorkspaceStore.setState({
    activeChatId: activeBlankFolder ? null : "chat-a",
    chats,
    folders: [researchFolder],
    pendingChatFolderId: activeBlankFolder ? researchFolder.id : null
  });
  const blankFolderSessionKey = composerSessionKey(null, researchFolder.id);
  useComposerSessionStore.getState().activateSession(blankFolderSessionKey);
  useComposerSessionStore.getState().setDraft("Folder draft");
  const uploadGeneration = useComposerSessionStore
    .getState()
    .beginUpload(blankFolderSessionKey)!;
  if (!activeBlankFolder) {
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-a"));
  }
  let notices: Notice[] = [];
  const confirmDeleteFolder = vi.fn(async () => true);
  const folderMutation: WorkspaceFolderMutationPort = {
    actionId: null,
    beginAction: vi.fn(),
    beginCreate: vi.fn(),
    completeCreate: vi.fn(),
    completeDelete: vi.fn(),
    completeMove: vi.fn(),
    completeProjectSave: vi.fn(),
    completeRename: vi.fn(),
    creating: false,
    editingName: "",
    endAction: vi.fn(),
    endCreate: vi.fn(),
    newName: "",
    projectMemoryDraft: ""
  };

  const actions = createFolderActions({
    activeChat: activeBlankFolder ? null : chats[0] ?? null,
    activeChatId: activeBlankFolder ? null : "chat-a",
    confirmDeleteFolder,
    folderMutation,
    setNotice(notice) {
      notices = [...notices, notice];
    }
  });

  return {
    actions,
    blankFolderSessionKey,
    chats: () => useWorkspaceStore.getState().chats,
    confirmDeleteFolder,
    folderMutation,
    folder: researchFolder,
    folders: () => useWorkspaceStore.getState().folders,
    notices: () => notices,
    uploadGeneration
  };
}

describe("folder actions", () => {
  afterEach(() => {
    resetComposerSessionStoreForTest();
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deletes folders through the custom confirmation path", async () => {
    const state = createFolderActionsHarness({ activeBlankFolder: true });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const nativeConfirm = vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("native confirm should not be used");
    });
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.deleteFolder(state.folder);

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(state.confirmDeleteFolder).toHaveBeenCalledWith(state.folder);
    expect(fetchMock).toHaveBeenCalledWith("/api/folders/folder-research", { method: "DELETE" });
    expect(state.folderMutation.beginAction).toHaveBeenCalledWith(state.folder.id);
    expect(state.folderMutation.completeDelete).toHaveBeenCalledWith(state.folder.id);
    expect(state.folderMutation.endAction).toHaveBeenCalledOnce();
    expect(state.folders()).toEqual([]);
    expect(state.chats().map((candidate) => candidate.folderId)).toEqual([null, null]);
    expect(useWorkspaceStore.getState().pendingChatFolderId).toBeNull();
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(composerSessionKey(null));
    expect(
      selectComposerSession(
        useComposerSessionStore.getState(),
        state.blankFolderSessionKey
      )
    ).toMatchObject({ attachments: [], draft: "" });
    expect(
      useComposerSessionStore
        .getState()
        .appendUploadedAttachment(state.blankFolderSessionKey, state.uploadGeneration, {
          fileName: "late.pdf",
          id: "late",
          kind: "pdf"
        })
    ).toBe(false);
    expect(state.notices().at(-1)).toMatchObject({
      kind: "success",
      text: "Folder deleted: Research"
    });
  });

  it("cancels folder deletion when the custom confirmation is dismissed", async () => {
    const state = createFolderActionsHarness();
    state.confirmDeleteFolder.mockResolvedValueOnce(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.deleteFolder(state.folder);

    expect(state.confirmDeleteFolder).toHaveBeenCalledWith(state.folder);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.folderMutation.beginAction).not.toHaveBeenCalled();
    expect(state.folders()).toEqual([state.folder]);
    expect(state.chats().map((candidate) => candidate.folderId)).toEqual(["folder-research", null]);
    expect(
      selectComposerSession(useComposerSessionStore.getState(), state.blankFolderSessionKey)
    ).toMatchObject({
      draft: "Folder draft",
      pendingUploadGenerations: [state.uploadGeneration]
    });
  });
});
