import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import {
  composerSessionKey,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { shellFetch } from "@/components/app-shell/shellApi";
import type { WorkspaceChatSummary, FolderSummary, Notice } from "@/components/app-shell/types";
import type { WorkspaceFolderMutationPort } from "@/components/app-shell/useWorkspaceInteractionController";
import { sortFoldersByOrder, useWorkspaceStore } from "@/components/app-shell/workspaceStore";

type FolderActionsInput = {
  activeChat: WorkspaceChatSummary | null;
  activeChatId: string | null;
  confirmDeleteFolder(folder: FolderSummary): Promise<boolean>;
  folderMutation: WorkspaceFolderMutationPort;
  setNotice(notice: Notice): void;
};

function mirrorFolderIntoNavigation(folder: FolderSummary) {
  useWorkspaceStore.getState().upsertNavigationFolder({
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId ?? null
  });
}

export function createFolderActions({
  activeChat,
  activeChatId,
  confirmDeleteFolder,
  folderMutation,
  setNotice
}: FolderActionsInput) {
  async function createFolder(parentId?: string | null, nameOverride?: string) {
    const name = (nameOverride ?? "").trim();
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
      mirrorFolderIntoNavigation(body.folder);
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
      mirrorFolderIntoNavigation(body.folder);
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

      useWorkspaceStore.getState().updateFolders((current) => current
        .filter((candidate) => candidate.id !== folder.id)
        // The server reparents child folders of a deleted folder to the root.
        .map((candidate) =>
          candidate.parentId === folder.id ? { ...candidate, parentId: null } : candidate
        ));
      useWorkspaceStore
        .getState()
        .updateChats((current) =>
          current.map((chat) => (chat.folderId === folder.id ? { ...chat, folderId: null } : chat))
        );
      useWorkspaceStore.getState().removeNavigationFolder(folder.id);
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
      mirrorFolderIntoNavigation(body.folder);
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
        body: JSON.stringify({
          defaultKnowledgePlan: { baseIds: folderMutation.projectKnowledgeBaseIds },
          projectMemory: folderMutation.projectMemoryDraft
        }),
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
      const workspace = useWorkspaceStore.getState();
      const currentChat = workspace.activeChatId
        ? workspace.chats.find((candidate) => candidate.id === workspace.activeChatId) ?? null
        : null;
      const currentProjectId = currentChat?.folderId ?? (
        workspace.activeChatId === null ? workspace.pendingChatFolderId : null
      );
      const controls = useComposerControlStore.getState();
      if (currentProjectId === body.folder.id && controls.knowledgePlanSource === "project") {
        controls.setSelectedKnowledgePlan(
          body.folder.defaultKnowledgePlan?.baseIds ?? [],
          body.folder.defaultKnowledgePlan ? "project" : "off",
          "system"
        );
      }
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
