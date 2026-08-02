import { LeftChatPane } from "@/components/app-shell/LeftChatPane";
import type { ShellWorkspacePaneView } from "@/components/app-shell/powerAppShellViewContracts";
import type { ChatSummary } from "@/components/app-shell/types";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { ReactNode, Ref } from "react";

export type ShellLeftPaneProps = {
  activeChatId: string | null;
  availableChatModelKeys: ReadonlySet<string> | null;
  chatModelLabels: ReadonlyMap<string, string> | null;
  footer?: ReactNode;
  layout?: "desktop" | "mobile";
  onHideWorkspace?(): void;
  pane: ShellWorkspacePaneView;
  scrollTopRef?: { current: number | undefined };
  workspaceToggleRef?: Ref<HTMLButtonElement>;
};

export function ShellLeftPane({
  activeChatId,
  availableChatModelKeys,
  chatModelLabels,
  footer,
  layout = "desktop",
  onHideWorkspace,
  pane,
  scrollTopRef,
  workspaceToggleRef
}: ShellLeftPaneProps) {
  const { actions, state } = pane;

  function currentChat(chat: ChatSummary): ChatSummary {
    return useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chat.id) ?? chat;
  }

  const activateChatEvent = useEventCallback((chat: ChatSummary) => actions.activateChat(currentChat(chat)));

  return (
    <LeftChatPane
      activeChatId={activeChatId}
      activeRunChatIds={state.activeRunChatIds}
      availableChatModelKeys={availableChatModelKeys}
      chatModelLabels={chatModelLabels}
      chatActionId={state.chatActionId}
      chatContentMatchIds={state.chatContentMatchIds}
      chatContentSearchError={state.chatContentSearchError}
      chatContentSearchLoading={state.chatContentSearchLoading}
      chatGroups={state.chatGroups}
      chatQuery={state.chatQuery}
      collapsedFolderIds={state.collapsedFolderIds}
      creatingChat={state.creatingChat}
      creatingFolder={state.creatingFolder}
      editingChatId={state.editingChatId}
      editingChatTitle={state.editingChatTitle}
      editingFolderId={state.editingFolderId}
      editingFolderName={state.editingFolderName}
      folderActionId={state.folderActionId}
      folderMenuId={state.folderMenuId}
      folders={state.folders}
      footer={footer}
      layout={layout}
      newFolderName={state.newFolderName}
      scrollTopRef={scrollTopRef}
      subfolderName={state.subfolderName}
      subfolderParentId={state.subfolderParentId}
      workspaceError={state.workspaceError}
      workspaceLoading={state.workspaceLoading}
      workspaceReady={state.workspaceReady}
      onActivateChat={activateChatEvent}
      onCancelChatEdit={actions.cancelChatEdit}
      onCancelFolderEdit={actions.cancelFolderEdit}
      onCancelSubfolder={actions.cancelSubfolder}
      onChatActionToggle={actions.toggleChatActions}
      onChatQueryChange={actions.changeChatQuery}
      onCloseMenus={actions.closeMenus}
      onCreateChat={(folderId) => void actions.createChat(folderId)}
      onCreateFolder={(parentId, nameOverride) => actions.createFolder(parentId, nameOverride)}
      onDeleteChat={(chat) => void actions.deleteChat(currentChat(chat))}
      onDeleteFolder={(folder) => void actions.deleteFolder(folder)}
      onEditChatTitleChange={actions.changeEditingChatTitle}
      onEditFolderNameChange={actions.changeEditingFolderName}
      onExportChat={(chat) => actions.exportChat(currentChat(chat))}
      onFolderMenuToggle={actions.toggleFolderMenu}
      onHideWorkspace={onHideWorkspace}
      onMoveChat={(chatId, folderId) => void actions.moveChat(chatId, folderId)}
      onMoveFolder={(folder, folderId) => void actions.moveFolder(folder, folderId)}
      onNewFolderNameChange={actions.changeNewFolderName}
      onOpenProjectSettings={(folder) => {
        actions.closeMenus();
        window.setTimeout(() => actions.openProjectSettings(folder), 0);
      }}
      onRetryWorkspace={actions.retry}
      onSaveChatTitle={(chat) => void actions.saveChatTitle(currentChat(chat))}
      onSaveFolder={(folder) => void actions.saveFolder(folder)}
      onShareChat={(chat) => void actions.shareChat(currentChat(chat))}
      onStartChatEdit={actions.startChatEdit}
      onStartFolderEdit={actions.startFolderEdit}
      onStartSubfolder={actions.startSubfolder}
      onSubfolderNameChange={actions.changeSubfolderName}
      onToggleChatFavorite={(chat) => void actions.toggleChatFavorite(currentChat(chat))}
      onToggleFolderCollapsed={actions.toggleFolderCollapsed}
      workspaceToggleRef={workspaceToggleRef}
    />
  );
}
