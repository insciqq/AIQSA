import { composerSessionKey, useComposerSessionStore } from "./composerSessionStore";
import { useRunSurfaceStore } from "./runSurfaceStore";
import { useThreadStore } from "./threadStore";
import { chatScopeProjectId, nextChatInScope } from "./workspaceProjectDraftMerge";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Reconcile every keyed projection only after the server confirms deletion.
 * The replacement for an active chat comes from the deleted chat's scope.
 */
export function removePermanentlyDeletedChat(chatId: string) {
  const workspace = useWorkspaceStore.getState();
  const wasActive = workspace.activeChatId === chatId;
  const deleted = workspace.chats.find((chat) => chat.id === chatId);
  const scopeProjectId = deleted ? chatScopeProjectId(deleted) : null;
  workspace.updateChats((current) => current.filter((chat) => chat.id !== chatId));
  workspace.removeNavigationChat(chatId);
  useThreadStore.getState().removeThread(chatId);
  useRunSurfaceStore.getState().removeSurface(chatId);
  useComposerSessionStore.getState().removeSession(composerSessionKey(chatId));
  return {
    nextChat: nextChatInScope(useWorkspaceStore.getState().chats, chatId, scopeProjectId),
    scopeProjectId,
    wasActive
  };
}
