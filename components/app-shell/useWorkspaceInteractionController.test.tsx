import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  rememberCollapsedFolderIds,
  storedCollapsedFolderIds
} from "./shellStorage";
import type { ChatSummary, FolderSummary } from "./types";
import {
  useWorkspaceInteractionController,
  type WorkspaceInteractionController
} from "./useWorkspaceInteractionController";

type RootSetterKey<T extends object> = {
  [Key in keyof T]: Key extends string
    ? Key extends `set${infer Suffix}`
      ? Suffix extends Capitalize<Suffix>
        ? Key
        : never
      : never
    : never;
}[keyof T];

const chat: ChatSummary = {
  activeLeafMessageId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  defaultModelId: "fake-qsa",
  defaultPromptPresetId: null,
  defaultProvider: "fake",
  folderId: null,
  id: "chat-1",
  messageCount: 0,
  title: "Workspace controller chat",
  updatedAt: "2026-07-13T00:00:00.000Z"
};

const folder: FolderSummary = {
  id: "folder-1",
  name: "Workspace folder",
  parentId: null,
  projectMemory: "Existing project memory",
  sortOrder: 0
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("useWorkspaceInteractionController", () => {
  it("exposes focused semantic ports without a root setter bag", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    expect(Object.keys(result.current).sort()).toEqual([
      "chatMutation",
      "folderMutation",
      "mobileWorkspaceClosed",
      "paneActions",
      "paneState",
      "projectSettings"
    ]);
    expectTypeOf<RootSetterKey<WorkspaceInteractionController>>().toEqualTypeOf<never>();
    expect(result.current.paneState).toMatchObject({
      chatActionId: null,
      creatingFolder: false,
      editingChatId: null,
      editingFolderId: null,
      folderActionId: null,
      folderMenuId: null,
      newFolderName: "",
      subfolderParentId: null
    });
  });

  it("hydrates, toggles, expands, and forgets collapsed folders through persisted copies", () => {
    rememberCollapsedFolderIds(new Set(["folder-1", "folder-2"]));
    const { result } = renderHook(() => useWorkspaceInteractionController());

    expect(result.current.paneState.collapsedFolderIds).toEqual(
      new Set(["folder-1", "folder-2"])
    );

    act(() => result.current.paneActions.toggleFolderCollapsed("folder-1"));
    expect(result.current.paneState.collapsedFolderIds).toEqual(new Set(["folder-2"]));
    expect(storedCollapsedFolderIds()).toEqual(new Set(["folder-2"]));

    act(() => result.current.paneActions.toggleFolderCollapsed("folder-3"));
    expect(result.current.paneState.collapsedFolderIds).toEqual(
      new Set(["folder-2", "folder-3"])
    );
    expect(storedCollapsedFolderIds()).toEqual(new Set(["folder-2", "folder-3"]));

    act(() =>
      result.current.folderMutation.completeCreate({
        parentId: "folder-2",
        usedNameOverride: true
      })
    );
    expect(result.current.paneState.collapsedFolderIds).toEqual(new Set(["folder-3"]));
    expect(storedCollapsedFolderIds()).toEqual(new Set(["folder-3"]));

    act(() => result.current.folderMutation.completeDelete("folder-3"));
    expect(result.current.paneState.collapsedFolderIds).toEqual(new Set());
    expect(storedCollapsedFolderIds()).toEqual(new Set());
  });

  it("keeps chat, folder, and subfolder menu transitions mutually scoped", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    act(() => {
      result.current.paneActions.toggleFolderMenu(folder.id);
      result.current.paneActions.startSubfolder(folder);
      result.current.paneActions.changeSubfolderName("Nested folder");
    });
    expect(result.current.paneState).toMatchObject({
      folderMenuId: folder.id,
      subfolderName: "Nested folder",
      subfolderParentId: folder.id
    });

    act(() => result.current.paneActions.toggleChatActions(chat.id));
    expect(result.current.paneState).toMatchObject({
      chatActionId: chat.id,
      folderMenuId: null,
      subfolderName: "",
      subfolderParentId: null
    });

    act(() => result.current.paneActions.startChatEdit(chat));
    expect(result.current.paneState).toMatchObject({
      chatActionId: null,
      editingChatId: chat.id,
      editingChatTitle: chat.title
    });
    expect(result.current.chatMutation.editingTitle).toBe(chat.title);

    act(() => result.current.paneActions.cancelChatEdit());
    expect(result.current.paneState).toMatchObject({
      editingChatId: null,
      editingChatTitle: ""
    });

    act(() => {
      result.current.paneActions.toggleFolderMenu(folder.id);
      result.current.paneActions.startSubfolder(folder);
      result.current.paneActions.startFolderEdit(folder);
    });
    expect(result.current.paneState).toMatchObject({
      editingFolderId: folder.id,
      editingFolderName: folder.name,
      folderMenuId: null,
      subfolderName: "",
      subfolderParentId: null
    });

    act(() => result.current.paneActions.closeMenus());
    expect(result.current.paneState).toMatchObject({
      chatActionId: null,
      folderMenuId: null,
      subfolderName: "",
      subfolderParentId: null
    });
  });

  it("closes mobile popover menus without discarding an unfinished subfolder draft", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    act(() => {
      result.current.paneActions.toggleFolderMenu(folder.id);
      result.current.paneActions.startSubfolder(folder);
      result.current.paneActions.changeSubfolderName("Nested draft");
      result.current.mobileWorkspaceClosed();
    });

    expect(result.current.paneState).toMatchObject({
      chatActionId: null,
      folderMenuId: null,
      subfolderName: "Nested draft",
      subfolderParentId: folder.id
    });
  });

  it("provides exact chat and folder mutation completion transitions", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    act(() => {
      result.current.paneActions.startChatEdit(chat);
      result.current.paneActions.toggleChatActions(chat.id);
      result.current.chatMutation.finishEditing();
    });
    expect(result.current.paneState).toMatchObject({
      chatActionId: null,
      editingChatId: null,
      editingChatTitle: ""
    });

    act(() => {
      result.current.paneActions.changeNewFolderName("Root folder");
      result.current.folderMutation.beginCreate();
      result.current.folderMutation.completeCreate({ usedNameOverride: false });
    });
    expect(result.current.folderMutation.creating).toBe(true);
    expect(result.current.paneState.newFolderName).toBe("");

    act(() => result.current.folderMutation.endCreate());
    expect(result.current.folderMutation.creating).toBe(false);

    act(() => {
      result.current.paneActions.startFolderEdit(folder);
      result.current.paneActions.changeEditingFolderName("Renamed folder");
      result.current.folderMutation.beginAction(folder.id);
    });
    expect(result.current.folderMutation).toMatchObject({
      actionId: folder.id,
      editingName: "Renamed folder"
    });

    act(() => {
      result.current.folderMutation.completeRename();
      result.current.folderMutation.endAction();
    });
    expect(result.current.paneState).toMatchObject({
      editingFolderId: null,
      editingFolderName: "",
      folderActionId: null
    });

    act(() => {
      result.current.paneActions.toggleFolderMenu(folder.id);
      result.current.folderMutation.completeMove();
    });
    expect(result.current.paneState.folderMenuId).toBeNull();
  });

  it("keeps project settings draft lifetime explicit across close and successful save", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    act(() => {
      result.current.projectSettings.open(folder);
      result.current.projectSettings.changeDraft("Changed memory");
    });
    expect(result.current.projectSettings).toMatchObject({
      draft: "Changed memory",
      folderId: folder.id
    });
    expect(result.current.folderMutation.projectMemoryDraft).toBe("Changed memory");

    act(() => result.current.projectSettings.close());
    expect(result.current.projectSettings).toMatchObject({
      draft: "",
      folderId: null
    });

    act(() => {
      result.current.paneActions.toggleFolderMenu(folder.id);
      result.current.paneActions.openProjectSettings(folder);
      result.current.projectSettings.changeDraft("Saved memory");
      result.current.folderMutation.completeProjectSave();
    });
    expect(result.current.projectSettings).toMatchObject({
      draft: "",
      folderId: null
    });
    expect(result.current.paneState.folderMenuId).toBeNull();
  });
});
