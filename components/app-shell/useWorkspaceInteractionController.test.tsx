import { act, renderHook } from "@testing-library/react";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChatSummary, FolderSummary } from "./types";
import {
  useWorkspaceInteractionController,
  type WorkspaceInteractionController
} from "./useWorkspaceInteractionController";

type RootSetterKey<T extends object> = {
  [Key in keyof T]: Key extends string
    ? Key extends `set${infer Suffix}`
      ? Suffix extends Capitalize<Suffix> ? Key : never
      : never
    : never;
}[keyof T];

const chat: ChatSummary = {
  activeLeafMessageId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  defaultModelId: "fake-qsa",
  defaultProvider: "fake",
  folderId: null,
  id: "chat-1",
  messageCount: 0,
  title: "Workspace controller chat",
  updatedAt: "2026-07-13T00:00:00.000Z"
};

const folder: FolderSummary = {
  defaultKnowledgePlan: { baseIds: ["kb-1"] },
  id: "folder-1",
  name: "Workspace folder",
  parentId: null,
  projectMemory: "Existing project memory",
  sortOrder: 0
};

describe("useWorkspaceInteractionController", () => {
  it("exposes only V2 semantic ports without a root setter bag", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    expect(Object.keys(result.current).sort()).toEqual([
      "chatMutation",
      "folderMutation",
      "paneActions",
      "paneState",
      "projectSettings"
    ]);
    expectTypeOf<RootSetterKey<WorkspaceInteractionController>>().toEqualTypeOf<never>();
    expect(result.current.paneState).toEqual({
      editingChatId: null,
      editingChatTitle: "",
      editingFolderId: null,
      editingFolderName: "",
      folderActionId: null
    });
  });

  it("owns exact chat and folder rename transitions", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    act(() => result.current.paneActions.startChatEdit(chat));
    expect(result.current.paneState).toMatchObject({
      editingChatId: chat.id,
      editingChatTitle: chat.title
    });
    act(() => result.current.chatMutation.finishEditing());
    expect(result.current.paneState.editingChatId).toBeNull();

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
  });

  it("keeps create concurrency and project-settings draft lifetimes explicit", () => {
    const { result } = renderHook(() => useWorkspaceInteractionController());

    act(() => result.current.folderMutation.beginCreate());
    expect(result.current.folderMutation.creating).toBe(true);
    act(() => result.current.folderMutation.endCreate());
    expect(result.current.folderMutation.creating).toBe(false);

    act(() => {
      result.current.projectSettings.open(folder);
      result.current.projectSettings.changeDraft("Changed memory");
    });
    expect(result.current.projectSettings).toMatchObject({
      draft: "Changed memory",
      folderId: folder.id,
      knowledgeBaseIds: ["kb-1"]
    });
    act(() => result.current.folderMutation.completeProjectSave());
    expect(result.current.projectSettings).toMatchObject({
      draft: "",
      folderId: null,
      knowledgeBaseIds: []
    });
  });
});
