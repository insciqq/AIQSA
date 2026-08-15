import type { WorkspaceChatSummary, FolderSummary } from "@/components/app-shell/types";
import { useCallback, useMemo, useState } from "react";

type WorkspaceInteractionPaneState = Readonly<{
  editingChatId: string | null;
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
  openProjectSettings(folder: FolderSummary): void;
  startChatEdit(chat: WorkspaceChatSummary): void;
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
  completeProjectSave(): void;
  completeRename(): void;
  creating: boolean;
  editingName: string;
  endAction(): void;
  endCreate(): void;
  projectKnowledgeBaseIds: string[];
  projectMemoryDraft: string;
}>;

export type WorkspaceProjectSettingsPort = Readonly<{
  changeDraft(value: string): void;
  changeKnowledgeBaseIds(value: string[]): void;
  close(): void;
  draft: string;
  folderId: string | null;
  knowledgeBaseIds: string[];
  open(folder: FolderSummary): void;
}>;

export type WorkspaceInteractionController = Readonly<{
  chatMutation: WorkspaceChatMutationPort;
  folderMutation: WorkspaceFolderMutationPort;
  paneActions: WorkspaceInteractionPaneActions;
  paneState: WorkspaceInteractionPaneState;
  projectSettings: WorkspaceProjectSettingsPort;
}>;

export function useWorkspaceInteractionController(): WorkspaceInteractionController {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatTitle, setEditingChatTitle] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [folderActionId, setFolderActionId] = useState<string | null>(null);
  const [projectSettingsFolderId, setProjectSettingsFolderId] = useState<string | null>(null);
  const [projectMemoryDraft, setProjectMemoryDraft] = useState("");
  const [projectKnowledgeBaseIds, setProjectKnowledgeBaseIds] = useState<string[]>([]);

  const cancelChatEdit = useCallback(() => {
    setEditingChatId(null);
    setEditingChatTitle("");
  }, []);
  const cancelFolderEdit = useCallback(() => {
    setEditingFolderId(null);
    setEditingFolderName("");
  }, []);
  const finishChatEditing = useCallback(() => {
    setEditingChatId(null);
    setEditingChatTitle("");
  }, []);
  const openProjectSettings = useCallback((folder: FolderSummary) => {
    setProjectMemoryDraft(folder.projectMemory);
    setProjectKnowledgeBaseIds([...(folder.defaultKnowledgePlan?.baseIds ?? [])]);
    setProjectSettingsFolderId(folder.id);
  }, []);
  const closeProjectSettings = useCallback(() => {
    setProjectSettingsFolderId(null);
    setProjectMemoryDraft("");
    setProjectKnowledgeBaseIds([]);
  }, []);
  const startChatEdit = useCallback((chat: WorkspaceChatSummary) => {
    setEditingChatId(chat.id);
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
  const completeProjectSave = useCallback(() => {
    setProjectSettingsFolderId(null);
    setProjectMemoryDraft("");
    setProjectKnowledgeBaseIds([]);
  }, []);
  const endFolderAction = useCallback(() => setFolderActionId(null), []);

  const paneState = useMemo<WorkspaceInteractionPaneState>(() => ({
    editingChatId,
    editingChatTitle,
    editingFolderId,
    editingFolderName,
    folderActionId
  }), [editingChatId, editingChatTitle, editingFolderId, editingFolderName, folderActionId]);

  const paneActions = useMemo<WorkspaceInteractionPaneActions>(() => ({
    cancelChatEdit,
    cancelFolderEdit,
    changeEditingChatTitle: setEditingChatTitle,
    changeEditingFolderName: setEditingFolderName,
    openProjectSettings,
    startChatEdit,
    startFolderEdit
  }), [cancelChatEdit, cancelFolderEdit, openProjectSettings, startChatEdit, startFolderEdit]);

  const chatMutation = useMemo<WorkspaceChatMutationPort>(() => ({
    editingTitle: editingChatTitle,
    finishEditing: finishChatEditing
  }), [editingChatTitle, finishChatEditing]);

  const folderMutation = useMemo<WorkspaceFolderMutationPort>(() => ({
    actionId: folderActionId,
    beginAction: beginFolderAction,
    beginCreate: () => setCreatingFolder(true),
    completeProjectSave,
    completeRename: completeFolderRename,
    creating: creatingFolder,
    editingName: editingFolderName,
    endAction: endFolderAction,
    endCreate: () => setCreatingFolder(false),
    projectKnowledgeBaseIds,
    projectMemoryDraft
  }), [
    beginFolderAction,
    completeFolderRename,
    completeProjectSave,
    creatingFolder,
    editingFolderName,
    endFolderAction,
    folderActionId,
    projectKnowledgeBaseIds,
    projectMemoryDraft
  ]);

  const projectSettings = useMemo<WorkspaceProjectSettingsPort>(() => ({
    changeDraft: setProjectMemoryDraft,
    changeKnowledgeBaseIds: setProjectKnowledgeBaseIds,
    close: closeProjectSettings,
    draft: projectMemoryDraft,
    folderId: projectSettingsFolderId,
    knowledgeBaseIds: projectKnowledgeBaseIds,
    open: openProjectSettings
  }), [closeProjectSettings, openProjectSettings, projectKnowledgeBaseIds, projectMemoryDraft, projectSettingsFolderId]);

  return useMemo(() => ({
    chatMutation,
    folderMutation,
    paneActions,
    paneState,
    projectSettings
  }), [chatMutation, folderMutation, paneActions, paneState, projectSettings]);
}
