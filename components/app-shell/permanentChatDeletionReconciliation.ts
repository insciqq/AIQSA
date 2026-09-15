import { composerSessionKey, useComposerSessionStore } from "./composerSessionStore";
import { useRunSurfaceStore } from "./runSurfaceStore";
import { useThreadStore } from "./threadStore";
import { useWorkspaceStore } from "./workspaceStore";

/** Reconcile every keyed projection only after the server confirms deletion. */
export function removePermanentlyDeletedChat(chatId: string) {
  const workspace = useWorkspaceStore.getState();
  const wasActive = workspace.activeChatId === chatId;
  workspace.updateChats((current) => current.filter((chat) => chat.id !== chatId));
  workspace.removeNavigationChat(chatId);
  useThreadStore.getState().removeThread(chatId);
  useRunSurfaceStore.getState().removeSurface(chatId);
  useComposerSessionStore.getState().removeSession(composerSessionKey(chatId));
  return { wasActive, nextChat: useWorkspaceStore.getState().chats[0] ?? null };
}
