import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import {
  composerSessionKey,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { shellFetch } from "@/components/app-shell/shellApi";
import type { ChatSummary, FolderSummary, Notice } from "@/components/app-shell/types";
import type { WorkspaceFolderMutationPort } from "@/components/app-shell/useWorkspaceInteractionController";
import { sortFoldersByOrder, useWorkspaceStore } from "@/components/app-shell/workspaceStore";

type FolderActionsInput = {
  activeChat: ChatSummary | null;
  activeChatId: string | null;
  confirmDeleteFolder(folder: FolderSummary): Promise<boolean>;
  folderMutation: WorkspaceFolderMutationPort;
  setNotice(notice: Notice): void;
};

export function createFolderActions({
  activeChat,
  activeChatId,
  confirmDeleteFolder,
  folderMutation,
  setNotice
}: FolderActionsInput) {
  async function createFolder(parentId?: string | null, nameOverride?: string) {
    const name = (nameOverride ?? folderMutation.newName).trim();
    if (!name || folderMutation.creating) {
      return;
    }

    folderMutation.beginCreate();
    try {
      const response = await shellFetch("/api/folders", {
        body: JSON.stringify({
          name,
          ...(parentId !== undefined ? { parentId } : {})
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(`folder_create_failed_${response.status}`);
      }

      const body = (await response.json()) as { folder: FolderSummary };
      useWorkspaceStore.getState().updateFolders((current) => sortFoldersByOrder([...current, body.folder]));
      folderMutation.completeCreate({
        parentId,
        usedNameOverride: nameOverride !== undefined
      });
      setNotice({
        kind: "success",
        text: `Folder created: ${body.folder.name}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      folderMutation.endCreate();
    }
  }

  async function renameFolder(folder: FolderSummary) {
    const name = folderMutation.editingName.trim();
    if (!name || folderMutation.actionId) {
      return;
    }

    folderMutation.beginAction(folder.id);
    try {
      const response = await shellFetch(`/api/folders/${folder.id}`, {
        body: JSON.stringify({ name }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `folder_rename_failed_${response.status}`));
      }

      const body = (await response.json()) as { folder: FolderSummary };
      useWorkspaceStore
        .getState()
        .updateFolders((current) =>
          sortFoldersByOrder(current.map((candidate) => (candidate.id === body.folder.id ? body.folder : candidate)))
        );
      folderMutation.completeRename();
      setNotice({
        kind: "success",
        text: `Folder renamed: ${body.folder.name}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      folderMutation.endAction();
    }
  }

  async function deleteFolder(folder: FolderSummary) {
    if (folderMutation.actionId) {
      return;
    }

    if (!(await confirmDeleteFolder(folder))) {
      return;
    }

    folderMutation.beginAction(folder.id);
    try {
      const response = await shellFetch(`/api/folders/${folder.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `folder_delete_failed_${response.status}`));
      }

      useWorkspaceStore.getState().updateFolders((current) => current.filter((candidate) => candidate.id !== folder.id));
      useWorkspaceStore
        .getState()
        .updateChats((current) =>
          current.map((chat) => (chat.folderId === folder.id ? { ...chat, folderId: null } : chat))
        );
      if (activeChat?.folderId === folder.id && activeChatId) {
        useWorkspaceStore
          .getState()
          .updateChats((current) =>
            current.map((chat) => (chat.id === activeChatId ? { ...chat, folderId: null } : chat))
          );
      }
      const deletedBlankSessionKey = composerSessionKey(null, folder.id);
      const deletedBlankSessionWasActive =
        useComposerSessionStore.getState().activeSessionKey === deletedBlankSessionKey;
      useComposerSessionStore.getState().removeSession(deletedBlankSessionKey);
      if (
        deletedBlankSessionWasActive &&
        useWorkspaceStore.getState().activeChatId === null &&
        useWorkspaceStore.getState().pendingChatFolderId === folder.id
      ) {
        useWorkspaceStore.getState().setPendingChatFolderId(null);
      }
      folderMutation.completeDelete(folder.id);
      setNotice({
        kind: "success",
        text: `Folder deleted: ${folder.name}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      folderMutation.endAction();
    }
  }

  async function updateFolderParent(folder: FolderSummary, parentId: string | null) {
    folderMutation.beginAction(folder.id);
    try {
      const response = await shellFetch(`/api/folders/${folder.id}`, {
        body: JSON.stringify({ parentId }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `folder_move_failed_${response.status}`));
      }

      const body = (await response.json()) as { folder: FolderSummary };
      useWorkspaceStore
        .getState()
        .updateFolders((current) =>
          sortFoldersByOrder(current.map((candidate) => (candidate.id === body.folder.id ? body.folder : candidate)))
        );
      folderMutation.completeMove();
      setNotice({
        kind: "success",
        text: `Folder moved: ${body.folder.name}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      folderMutation.endAction();
    }
  }

  async function saveProjectSettings(folder: FolderSummary) {
    folderMutation.beginAction(folder.id);
    try {
      const response = await shellFetch(`/api/folders/${folder.id}`, {
        body: JSON.stringify({ projectMemory: folderMutation.projectMemoryDraft }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `project_settings_failed_${response.status}`));
      }

      const body = (await response.json()) as { folder: FolderSummary };
      useWorkspaceStore
        .getState()
        .updateFolders((current) =>
          sortFoldersByOrder(current.map((candidate) => (candidate.id === body.folder.id ? body.folder : candidate)))
        );
      folderMutation.completeProjectSave();
      setNotice({
        kind: "success",
        text: `Project settings saved: ${body.folder.name}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      folderMutation.endAction();
    }
  }

  return {
    createFolder,
    deleteFolder,
    renameFolder,
    saveProjectSettings,
    updateFolderParent
  };
}
