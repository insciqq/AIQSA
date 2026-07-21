import type {
  ShellWorkspacePaneActions,
  ShellWorkspacePaneState
} from "@/components/app-shell/powerAppShellViewContracts";
import {
  rememberCollapsedFolderIds,
  storedCollapsedFolderIds
} from "@/components/app-shell/shellStorage";
import type { ChatSummary, FolderSummary } from "@/components/app-shell/types";
import { useCallback, useMemo, useState } from "react";

type WorkspaceInteractionPaneState = Pick<
  ShellWorkspacePaneState,
  | "chatActionId"
  | "collapsedFolderIds"
  | "creatingFolder"
  | "editingChatId"
  | "editingChatTitle"
  | "editingFolderId"
  | "editingFolderName"
  | "folderActionId"
  | "folderMenuId"
  | "newFolderName"
  | "subfolderName"
  | "subfolderParentId"
>;

type WorkspaceInteractionPaneActions = Pick<
  ShellWorkspacePaneActions,
  | "cancelChatEdit"
  | "cancelFolderEdit"
  | "cancelSubfolder"
  | "changeEditingChatTitle"
  | "changeEditingFolderName"
  | "changeNewFolderName"
  | "changeSubfolderName"
  | "closeMenus"
  | "openProjectSettings"
  | "startChatEdit"
  | "startFolderEdit"
  | "startSubfolder"
  | "toggleChatActions"
  | "toggleFolderCollapsed"
  | "toggleFolderMenu"
>;

export type WorkspaceChatMutationPort = Readonly<{
  closeActions(): void;
  editingTitle: string;
  finishEditing(): void;
}>;

export type WorkspaceFolderCreateCompletion = Readonly<{
  parentId?: string | null;
  usedNameOverride: boolean;
}>;

export type WorkspaceFolderMutationPort = Readonly<{
  actionId: string | null;
  beginAction(folderId: string): void;
  beginCreate(): void;
  completeCreate(input: WorkspaceFolderCreateCompletion): void;
  completeDelete(folderId: string): void;
  completeMove(): void;
  completeProjectSave(): void;
  completeRename(): void;
  creating: boolean;
  editingName: string;
  endAction(): void;
  endCreate(): void;
  newName: string;
  projectMemoryDraft: string;
}>;

export type WorkspaceProjectSettingsPort = Readonly<{
  changeDraft(value: string): void;
  close(): void;
  draft: string;
  folderId: string | null;
  open(folder: FolderSummary): void;
}>;

export type WorkspaceInteractionController = Readonly<{
  chatMutation: WorkspaceChatMutationPort;
  folderMutation: WorkspaceFolderMutationPort;
  mobileWorkspaceClosed(): void;
  paneActions: WorkspaceInteractionPaneActions;
  paneState: WorkspaceInteractionPaneState;
  projectSettings: WorkspaceProjectSettingsPort;
}>;

export function useWorkspaceInteractionController(): WorkspaceInteractionController {
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() =>
    storedCollapsedFolderIds()
  );
  const [chatActionId, setChatActionId] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatTitle, setEditingChatTitle] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [folderActionId, setFolderActionId] = useState<string | null>(null);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [subfolderParentId, setSubfolderParentId] = useState<string | null>(null);
  const [subfolderName, setSubfolderName] = useState("");
  const [projectSettingsFolderId, setProjectSettingsFolderId] = useState<string | null>(null);
  const [projectMemoryDraft, setProjectMemoryDraft] = useState("");

  const cancelChatEdit = useCallback(() => {
    setEditingChatId(null);
    setEditingChatTitle("");
  }, []);
  const cancelFolderEdit = useCallback(() => {
    setEditingFolderId(null);
    setEditingFolderName("");
  }, []);
  const cancelSubfolder = useCallback(() => {
    setSubfolderParentId(null);
    setSubfolderName("");
  }, []);
  const closeChatActions = useCallback(() => {
    setChatActionId(null);
  }, []);
  const closeMenus = useCallback(() => {
    setChatActionId(null);
    setFolderMenuId(null);
    setSubfolderParentId(null);
    setSubfolderName("");
  }, []);
  const mobileWorkspaceClosed = useCallback(() => {
    setChatActionId(null);
    setFolderMenuId(null);
  }, []);
  const finishChatEditing = useCallback(() => {
    setEditingChatId(null);
    setEditingChatTitle("");
    setChatActionId(null);
  }, []);
  const openProjectSettings = useCallback((folder: FolderSummary) => {
    setProjectMemoryDraft(folder.projectMemory);
    setProjectSettingsFolderId(folder.id);
  }, []);
  const closeProjectSettings = useCallback(() => {
    setProjectSettingsFolderId(null);
    setProjectMemoryDraft("");
  }, []);
  const startChatEdit = useCallback((chat: ChatSummary) => {
    setEditingChatId(chat.id);
    setEditingChatTitle(chat.title);
    setChatActionId(null);
  }, []);
  const startFolderEdit = useCallback((folder: FolderSummary) => {
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
    setFolderMenuId(null);
    setSubfolderParentId(null);
    setSubfolderName("");
  }, []);
  const startSubfolder = useCallback((folder: FolderSummary) => {
    setSubfolderParentId(folder.id);
    setSubfolderName("");
  }, []);
  const toggleChatActions = useCallback((chatId: string) => {
    setFolderMenuId(null);
    setSubfolderParentId(null);
    setSubfolderName("");
    setChatActionId((current) => (current === chatId ? null : chatId));
  }, []);
  const toggleFolderCollapsed = useCallback((folderId: string) => {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      rememberCollapsedFolderIds(next);
      return next;
    });
  }, []);
  const toggleFolderMenu = useCallback((folderId: string) => {
    setChatActionId(null);
    setSubfolderParentId(null);
    setSubfolderName("");
    setFolderMenuId((current) => (current === folderId ? null : folderId));
  }, []);

  const beginFolderAction = useCallback((folderId: string) => {
    setFolderActionId(folderId);
  }, []);
  const beginFolderCreate = useCallback(() => {
    setCreatingFolder(true);
  }, []);
  const completeFolderCreate = useCallback(
    ({ parentId, usedNameOverride }: WorkspaceFolderCreateCompletion) => {
      if (usedNameOverride) {
        setSubfolderName("");
        setSubfolderParentId(null);
        setFolderMenuId(null);
      } else {
        setNewFolderName("");
      }

      if (parentId) {
        setCollapsedFolderIds((current) => {
          const next = new Set(current);
          next.delete(parentId);
          rememberCollapsedFolderIds(next);
          return next;
        });
      }
    },
    []
  );
  const completeFolderDelete = useCallback((folderId: string) => {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      next.delete(folderId);
      rememberCollapsedFolderIds(next);
      return next;
    });
  }, []);
  const completeFolderMove = useCallback(() => {
    setFolderMenuId(null);
  }, []);
  const completeProjectSave = useCallback(() => {
    setProjectSettingsFolderId(null);
    setProjectMemoryDraft("");
    setFolderMenuId(null);
  }, []);
  const completeFolderRename = useCallback(() => {
    setEditingFolderId(null);
    setEditingFolderName("");
  }, []);
  const endFolderAction = useCallback(() => {
    setFolderActionId(null);
  }, []);
  const endFolderCreate = useCallback(() => {
    setCreatingFolder(false);
  }, []);

  const paneState = useMemo<WorkspaceInteractionPaneState>(
    () => ({
      chatActionId,
      collapsedFolderIds,
      creatingFolder,
      editingChatId,
      editingChatTitle,
      editingFolderId,
      editingFolderName,
      folderActionId,
      folderMenuId,
      newFolderName,
      subfolderName,
      subfolderParentId
    }),
    [
      chatActionId,
      collapsedFolderIds,
      creatingFolder,
      editingChatId,
      editingChatTitle,
      editingFolderId,
      editingFolderName,
      folderActionId,
      folderMenuId,
      newFolderName,
      subfolderName,
      subfolderParentId
    ]
  );
  const paneActions = useMemo<WorkspaceInteractionPaneActions>(
    () => ({
      cancelChatEdit,
      cancelFolderEdit,
      cancelSubfolder,
      changeEditingChatTitle: setEditingChatTitle,
      changeEditingFolderName: setEditingFolderName,
      changeNewFolderName: setNewFolderName,
      changeSubfolderName: setSubfolderName,
      closeMenus,
      openProjectSettings,
      startChatEdit,
      startFolderEdit,
      startSubfolder,
      toggleChatActions,
      toggleFolderCollapsed,
      toggleFolderMenu
    }),
    [
      cancelChatEdit,
      cancelFolderEdit,
      cancelSubfolder,
      closeMenus,
      openProjectSettings,
      startChatEdit,
      startFolderEdit,
      startSubfolder,
      toggleChatActions,
      toggleFolderCollapsed,
      toggleFolderMenu
    ]
  );
  const chatMutation = useMemo<WorkspaceChatMutationPort>(
    () => ({
      closeActions: closeChatActions,
      editingTitle: editingChatTitle,
      finishEditing: finishChatEditing
    }),
    [closeChatActions, editingChatTitle, finishChatEditing]
  );
  const folderMutation = useMemo<WorkspaceFolderMutationPort>(
    () => ({
      actionId: folderActionId,
      beginAction: beginFolderAction,
      beginCreate: beginFolderCreate,
      completeCreate: completeFolderCreate,
      completeDelete: completeFolderDelete,
      completeMove: completeFolderMove,
      completeProjectSave,
      completeRename: completeFolderRename,
      creating: creatingFolder,
      editingName: editingFolderName,
      endAction: endFolderAction,
      endCreate: endFolderCreate,
      newName: newFolderName,
      projectMemoryDraft
    }),
    [
      beginFolderAction,
      beginFolderCreate,
      completeFolderCreate,
      completeFolderDelete,
      completeFolderMove,
      completeFolderRename,
      completeProjectSave,
      creatingFolder,
      editingFolderName,
      endFolderAction,
      endFolderCreate,
      folderActionId,
      newFolderName,
      projectMemoryDraft
    ]
  );
  const projectSettings = useMemo<WorkspaceProjectSettingsPort>(
    () => ({
      changeDraft: setProjectMemoryDraft,
      close: closeProjectSettings,
      draft: projectMemoryDraft,
      folderId: projectSettingsFolderId,
      open: openProjectSettings
    }),
    [closeProjectSettings, openProjectSettings, projectMemoryDraft, projectSettingsFolderId]
  );

  return useMemo(
    () => ({
      chatMutation,
      folderMutation,
      mobileWorkspaceClosed,
      paneActions,
      paneState,
      projectSettings
    }),
    [
      chatMutation,
      folderMutation,
      mobileWorkspaceClosed,
      paneActions,
      paneState,
      projectSettings
    ]
  );
}
