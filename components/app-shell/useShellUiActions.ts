import type { InspectorTabId } from "@/components/inspector/InspectorTabs";
import { useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import type { InspectorMode, ThreadMessage } from "@/components/app-shell/types";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { Dispatch, SetStateAction } from "react";

type ShellUiActionsInput = {
  branchChatFromMessage(messageId: string): Promise<void> | void;
  copyMessage(message: ThreadMessage): Promise<void> | void;
  deleteMessage(messageId: string): Promise<void> | void;
  regenerateMessage(messageId: string): Promise<void> | void;
  setInspectorActiveTab(value: InspectorTabId): void;
  setInspectorMode: Dispatch<SetStateAction<InspectorMode>>;
};

export function useShellUiActions({
  branchChatFromMessage,
  copyMessage,
  deleteMessage,
  regenerateMessage,
  setInspectorActiveTab,
  setInspectorMode
}: ShellUiActionsInput) {
  function openDetails(tab?: InspectorTabId) {
    if (tab) {
      setInspectorActiveTab(tab);
    }

    setInspectorMode((mode) => (mode === "pinned" ? mode : "overlay"));
  }

  const handleBranchFromMessage = useEventCallback((messageId: string) => {
    void branchChatFromMessage(messageId);
  });
  const handleDeleteMessage = useEventCallback((messageId: string) => {
    void deleteMessage(messageId);
  });
  const handleCopyMessage = useEventCallback((message: ThreadMessage) => {
    void copyMessage(message);
  });
  const handleEditMessage = useEventCallback((selectedMessage: ThreadMessage) => {
    useComposerSessionStore
      .getState()
      .startEdit(selectedMessage.id, textFromThreadContent(selectedMessage.content));
  });
  const handleRegenerateMessage = useEventCallback((messageId: string) => {
    void regenerateMessage(messageId);
  });

  return {
    handleBranchFromMessage,
    handleCopyMessage,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    openDetails
  };
}
