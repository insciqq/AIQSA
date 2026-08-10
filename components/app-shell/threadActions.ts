import { chatSummaryFromApi, shellFetch } from "@/components/app-shell/shellApi";
import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import {
  composerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import type {
  ChatDetail,
  ChatSummary,
  Notice,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  selectThreadSnapshot,
  useThreadStore
} from "@/components/app-shell/threadStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { decodeChatSummaryResponse } from "@/lib/contracts/chats";

type ThreadActionsInput = {
  activeChat: ChatSummary | null;
  activeChatId: string | null;
  activeChatTitle: string;
  activateChat(chat: ChatSummary): void;
  closeChatActions(): void;
  confirmDeleteMessage(messageId: string): Promise<boolean>;
  loadCompleteActiveBranch(chatId: string): Promise<ThreadMessage[]>;
  openShareDialog(target: ShareDialogTarget): void;
  onThreadMutationSettled?(): void;
  pendingBranchCheckouts: Map<string, Promise<BranchCheckoutSettlement>>;
  pendingThreadMutations?: Set<string>;
  refreshActiveChat(
    chatId: string | null,
    options?: {
      forceDetail?: boolean;
      preserveControls?: boolean;
      resumeRuns?: boolean;
    }
  ): Promise<ChatDetail | null>;
  resetThreadToLatest(): void;
  setNotice(notice: Notice): void;
  activeChatStreaming: boolean;
};

export type BranchCheckoutSettlement = {
  leafId: string;
  succeeded: boolean;
};

function restoreFocusAfterRemoval(selector: string) {
  const removalFocusOwner = document.activeElement;
  let remainingDisabledFrames = 2;

  function restore() {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement.isConnected &&
      activeElement !== removalFocusOwner
    ) {
      return;
    }

    const target = document.querySelector<HTMLElement>(selector);
    if (target instanceof HTMLButtonElement && target.disabled && remainingDisabledFrames > 0) {
      remainingDisabledFrames -= 1;
      window.requestAnimationFrame(restore);
      return;
    }
    target?.focus();
  }

  window.requestAnimationFrame(restore);
}

export function createThreadActions({
  activeChat,
  activeChatId,
  activeChatStreaming,
  activeChatTitle,
  activateChat,
  closeChatActions,
  confirmDeleteMessage,
  loadCompleteActiveBranch,
  openShareDialog,
  onThreadMutationSettled = () => undefined,
  pendingBranchCheckouts,
  pendingThreadMutations = new Set(),
  refreshActiveChat,
  resetThreadToLatest,
  setNotice
}: ThreadActionsInput) {
  async function copyVisibleThread() {
    try {
      if (!activeChatId) throw new Error("Nothing to copy yet.");
      setNotice({ kind: "success", text: "Preparing the complete thread…" });
      const thread = (await loadCompleteActiveBranch(activeChatId))
        .map(
          (message) =>
            `${message.role === "assistant" ? "Assistant" : "User"}:\n${textFromThreadContent(message.content).trim()}`
        )
        .join("\n\n");
      if (!thread.trim()) throw new Error("Nothing to copy yet.");
      await writeClipboardText(`# ${activeChatTitle}\n\n${thread}`);
      setNotice({
        kind: "success",
        text: "Thread copied"
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: `The complete thread could not be copied: ${errorMessage(error)}`
      });
    }
  }

  async function copyMessage(message: ThreadMessage) {
    const text = textFromThreadContent(message.content).trim();
    if (!text) {
      setNotice({
        kind: "error",
        text: "Nothing to copy yet."
      });
      return;
    }

    try {
      await writeClipboardText(text);
      setNotice({
        kind: "success",
        text: "Message copied"
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  async function branchChatFromMessage(messageId: string) {
    if (activeChatStreaming) {
      return;
    }

    try {
      const response = await shellFetch(`/api/messages/${messageId}/branch-chat`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `branch_chat_failed_${response.status}`));
      }

      const apiChat = decodeChatSummaryResponse(await response.json());
      if (!apiChat) {
        throw new Error("branch_chat_malformed");
      }
      const chat = chatSummaryFromApi(apiChat);
      useWorkspaceStore.getState().updateChats((current) => [
        chat,
        ...current.filter((candidate) => candidate.id !== chat.id)
      ]);
      activateChat(chat);
      setNotice({
        kind: "success",
        text: `Branched chat: ${chat.title}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  async function persistActiveLeafRequest(
    chatId: string,
    messageId: string | null,
    currentLeafId?: string | null
  ) {
    const chat = useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chatId);
    const persistedLeafId =
      currentLeafId === undefined ? chat?.activeLeafMessageId : currentLeafId;
    if (persistedLeafId === messageId) {
      return chat;
    }

    const response = await shellFetch(`/api/chats/${chatId}`, {
      body: JSON.stringify({
        activeLeafMessageId: messageId
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "PATCH"
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, `branch_checkout_failed_${response.status}`));
    }

    const apiChat = decodeChatSummaryResponse(await response.json());
    if (!apiChat || apiChat.id !== chatId) {
      throw new Error("branch_checkout_malformed");
    }

    const summary = chatSummaryFromApi(apiChat);
    if (useThreadStore.getState().threadsByChatId[summary.id]) {
      useThreadStore.getState().mergeMessages(summary.id, [], {
        sourceUpdatedAt: summary.updatedAt
      });
    }
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );

    return summary;
  }

  async function persistActiveLeaf(
    chatId: string,
    messageId: string | null,
    currentLeafId?: string | null
  ) {
    const pendingCheckout = pendingBranchCheckouts.get(chatId);
    if (pendingCheckout) {
      const settlement = await pendingCheckout;
      const settledLeafId = selectThreadSnapshot(
        useThreadStore.getState(),
        chatId
      ).activeLeafId;
      if (!settlement.succeeded || settledLeafId !== messageId) {
        throw new Error("active_leaf_changed");
      }
    }

    return persistActiveLeafRequest(chatId, messageId, currentLeafId);
  }

  async function checkoutBranch(messageId: string) {
    if (!activeChatId || activeChatStreaming) {
      return;
    }

    const chatId = activeChatId;
    const previousCheckout = pendingBranchCheckouts.get(chatId);
    const operation = (async () => {
      if (previousCheckout) {
        await previousCheckout;
      }
      if (useWorkspaceStore.getState().activeChatId !== chatId) {
        return { leafId: messageId, succeeded: false };
      }

      const threadBeforeCheckout = selectThreadSnapshot(useThreadStore.getState(), chatId);
      const previousLeafId = threadBeforeCheckout.activeLeafId;
      const selectedLeafIsLoaded = threadBeforeCheckout.messages.some(
        (message) => message.id === messageId
      );
      const previousStoredLeafId = useWorkspaceStore
        .getState()
        .chats.find((chat) => chat.id === chatId)?.activeLeafMessageId;
      if (selectedLeafIsLoaded) {
        useThreadStore.getState().checkoutBranch(chatId, messageId);
        resetThreadToLatest();
        useWorkspaceStore.getState().updateChats((current) =>
          current.map((chat) => (chat.id === chatId ? { ...chat, activeLeafMessageId: messageId } : chat))
        );
      }

      try {
        await persistActiveLeafRequest(chatId, messageId, previousStoredLeafId);
      } catch (error) {
        if (selectedLeafIsLoaded) {
          useThreadStore.getState().checkoutBranch(chatId, previousLeafId);
          useWorkspaceStore.getState().updateChats((current) =>
            current.map((chat) =>
              chat.id === chatId
                ? {
                    ...chat,
                    activeLeafMessageId:
                      previousStoredLeafId !== undefined ? previousStoredLeafId : previousLeafId
                  }
                : chat
            )
          );
        }
        setNotice({
          kind: "error",
          text: errorMessage(error)
        });
        await refreshActiveChat(chatId, {
          forceDetail: true,
          preserveControls: true,
          resumeRuns: false
        });
        return { leafId: messageId, succeeded: false };
      }

      const refreshed = await refreshActiveChat(chatId, {
        forceDetail: true,
        preserveControls: true,
        resumeRuns: false
      });
      if (!refreshed && !selectedLeafIsLoaded) {
        const rollbackLeafId =
          previousStoredLeafId !== undefined ? previousStoredLeafId : previousLeafId;
        try {
          await persistActiveLeafRequest(chatId, rollbackLeafId, messageId);
          useThreadStore.getState().checkoutBranch(chatId, previousLeafId);
          setNotice({
            kind: "error",
            text: "The selected version could not be loaded. The previous version is still open."
          });
        } catch (rollbackError) {
          setNotice({
            kind: "error",
            text: `The selected version could not be loaded or restored: ${errorMessage(rollbackError)}`
          });
        }
        return { leafId: messageId, succeeded: false };
      }
      return { leafId: messageId, succeeded: true };
    })();
    pendingBranchCheckouts.set(chatId, operation);

    try {
      await operation;
    } finally {
      if (pendingBranchCheckouts.get(chatId) === operation) {
        pendingBranchCheckouts.delete(chatId);
        onThreadMutationSettled();
      }
    }
  }

  async function deleteMessage(messageId: string) {
    if (!activeChatId || activeChatStreaming) {
      return;
    }

    if (!(await confirmDeleteMessage(messageId))) {
      return;
    }

    const chatId = activeChatId;
    if (pendingThreadMutations.has(chatId)) {
      return;
    }
    pendingThreadMutations.add(chatId);
    try {
      const response = await shellFetch(`/api/messages/${messageId}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `message_delete_failed_${response.status}`));
      }

      const body = (await response.json()) as {
        message: {
          activeLeafMessageId: string | null;
          chatId: string;
          deletedMessageIds: string[];
        };
      };
      const deletedIds = new Set(body.message.deletedMessageIds);
      useThreadStore.getState().deleteMessages(body.message.chatId, {
        activeLeafId: body.message.activeLeafMessageId,
        deletedIds
      });
      useWorkspaceStore.getState().updateChats((current) =>
        current.map((chat) =>
          chat.id === body.message.chatId
            ? {
              ...chat,
              activeLeafMessageId: body.message.activeLeafMessageId,
              messageCount: Math.max(0, chat.messageCount - deletedIds.size)
              }
            : chat
        )
      );
      const sourceSessionKey = composerSessionKey(body.message.chatId);
      const { editingMessageId } = selectComposerSession(
        useComposerSessionStore.getState(),
        sourceSessionKey
      );
      if (deletedIds.has(editingMessageId ?? "")) {
        useComposerSessionStore
          .getState()
          .cancelEdit(sourceSessionKey, editingMessageId ?? undefined);
      }
      setNotice({
        kind: "success",
        text: "Message deleted"
      });
      await refreshActiveChat(chatId, { preserveControls: true, resumeRuns: false });
      restoreFocusAfterRemoval("#composer");
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      pendingThreadMutations.delete(chatId);
      onThreadMutationSettled();
    }
  }

  function shareChat(chat: ChatSummary) {
    if (chat.memoryMode === "TEMPORARY" || chat.pendingInitialMemoryMode === "TEMPORARY") {
      setNotice({
        kind: "error",
        text: "Temporary Chats cannot be shared."
      });
      return;
    }
    if (!chat.activeLeafMessageId) {
      setNotice({
        kind: "error",
        text: "Send a message before sharing."
      });
      return;
    }

    closeChatActions();
    openShareDialog({
      activeLeafMessageId: chat.activeLeafMessageId,
      chat
    });
  }

  function shareActiveBranch() {
    const chat = activeChat;
    if (!chat) {
      setNotice({
        kind: "error",
        text: "Send a message before sharing."
      });
      return;
    }

    shareChat({
      ...chat,
      activeLeafMessageId:
        selectThreadSnapshot(useThreadStore.getState(), chat.id).activeLeafId ??
        chat.activeLeafMessageId
    });
  }

  return {
    branchChatFromMessage,
    checkoutBranch,
    copyMessage,
    copyVisibleThread,
    deleteMessage,
    persistActiveLeaf,
    shareActiveBranch,
    shareChat
  };
}
