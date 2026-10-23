import type { WorkspaceChatSummary, FolderSummary } from "@/components/app-shell/types";
import { useCallback, useMemo, useState } from "react";

export type WorkspaceChatEditOrigin = "header" | "row";

type WorkspaceInteractionPaneState = Readonly<{
  editingChatId: string | null;
  /** Which surface opened the rename; only that surface renders the field (UX audit 2026-09-02 A7). */
  editingChatOrigin: WorkspaceChatEditOrigin | null;
  editingChatTitle: string;
  editingFolderId: string | null;
  editingFolderName: string;
  folderActionId: string | null;
}>;

type WorkspaceInteractionPaneActions = Readonly<{
  cancelChatEdit(): void;
  cancelFolderEdit(): void;
  changeEditingChatTitle(value: string): void;
  changeEditingFolderName(value: string): void;
  startChatEdit(chat: WorkspaceChatSummary, origin?: WorkspaceChatEditOrigin): void;
  startFolderEdit(folder: FolderSummary): void;
}>;

export type WorkspaceChatMutationPort = Readonly<{
  editingTitle: string;
  finishEditing(): void;
}>;

export type WorkspaceFolderMutationPort = Readonly<{
  actionId: string | null;
  beginAction(folderId: string): void;
  beginCreate(): void;
  completeRename(): void;
  creating: boolean;
  editingName: string;
  endAction(): void;
  endCreate(): void;
}>;

export type WorkspaceInteractionController = Readonly<{
  chatMutation: WorkspaceChatMutationPort;
  folderMutation: WorkspaceFolderMutationPort;
  paneActions: WorkspaceInteractionPaneActions;
  paneState: WorkspaceInteractionPaneState;
}>;

export function useWorkspaceInteractionController(): WorkspaceInteractionController {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatOrigin, setEditingChatOrigin] = useState<WorkspaceChatEditOrigin | null>(null);
  const [editingChatTitle, setEditingChatTitle] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [folderActionId, setFolderActionId] = useState<string | null>(null);

  const cancelChatEdit = useCallback(() => {
    setEditingChatId(null);
    setEditingChatOrigin(null);
    setEditingChatTitle("");
  }, []);
  const cancelFolderEdit = useCallback(() => {
    setEditingFolderId(null);
    setEditingFolderName("");
  }, []);
  const finishChatEditing = useCallback(() => {
    setEditingChatId(null);
    setEditingChatOrigin(null);
    setEditingChatTitle("");
  }, []);
  const startChatEdit = useCallback((chat: WorkspaceChatSummary, origin: WorkspaceChatEditOrigin = "row") => {
    setEditingChatId(chat.id);
    setEditingChatOrigin(origin);
    setEditingChatTitle(chat.title);
  }, []);
  const startFolderEdit = useCallback((folder: FolderSummary) => {
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
  }, []);
  const beginFolderAction = useCallback((folderId: string) => setFolderActionId(folderId), []);
  const completeFolderRename = useCallback(() => {
    setEditingFolderId(null);
    setEditingFolderName("");
  }, []);
  const endFolderAction = useCallback(() => setFolderActionId(null), []);

  const paneState = useMemo<WorkspaceInteractionPaneState>(() => ({
    editingChatId,
    editingChatOrigin,
    editingChatTitle,
    editingFolderId,
    editingFolderName,
    folderActionId
  }), [editingChatId, editingChatOrigin, editingChatTitle, editingFolderId, editingFolderName, folderActionId]);

  const paneActions = useMemo<WorkspaceInteractionPaneActions>(() => ({
    cancelChatEdit,
    cancelFolderEdit,
    changeEditingChatTitle: setEditingChatTitle,
    changeEditingFolderName: setEditingFolderName,
    startChatEdit,
    startFolderEdit
  }), [cancelChatEdit, cancelFolderEdit, startChatEdit, startFolderEdit]);

  const chatMutation = useMemo<WorkspaceChatMutationPort>(() => ({
    editingTitle: editingChatTitle,
    finishEditing: finishChatEditing
  }), [editingChatTitle, finishChatEditing]);

  const folderMutation = useMemo<WorkspaceFolderMutationPort>(() => ({
    actionId: folderActionId,
    beginAction: beginFolderAction,
    beginCreate: () => setCreatingFolder(true),
    completeRename: completeFolderRename,
    creating: creatingFolder,
    editingName: editingFolderName,
    endAction: endFolderAction,
    endCreate: () => setCreatingFolder(false)
  }), [
    beginFolderAction,
    completeFolderRename,
    creatingFolder,
    editingFolderName,
    endFolderAction,
    folderActionId
  ]);

  return useMemo(() => ({
    chatMutation,
    folderMutation,
    paneActions,
    paneState
  }), [chatMutation, folderMutation, paneActions, paneState]);
}
