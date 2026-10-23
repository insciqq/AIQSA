import { composerSessionKey, useComposerSessionStore } from "./composerSessionStore";
import { removePersistedComposerDraft } from "./composerDraftPersistence";
import { useRunSurfaceStore } from "./runSurfaceStore";
import { useThreadStore } from "./threadStore";
import { nextChatAfterRemoval } from "./workspaceDraftMerge";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Reconcile every keyed projection only after the server confirms deletion.
 * An active chat is replaced by another chat, or by the blank chat.
 */
export function removePermanentlyDeletedChat(chatId: string) {
  const workspace = useWorkspaceStore.getState();
  const wasActive = workspace.activeChatId === chatId;
  workspace.updateChats((current) => current.filter((chat) => chat.id !== chatId));
  workspace.removeNavigationChat(chatId);
  useThreadStore.getState().removeThread(chatId);
  useRunSurfaceStore.getState().removeSurface(chatId);
  useComposerSessionStore.getState().removeSession(composerSessionKey(chatId));
  removePersistedComposerDraft(composerSessionKey(chatId));
  return {
    nextChat: nextChatAfterRemoval(useWorkspaceStore.getState().chats, chatId),
    wasActive
  };
}
