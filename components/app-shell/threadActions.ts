import { chatSummaryFromApi } from "@/components/app-shell/shellApi";
import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import {
  composerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import type { ChatDetail, ChatSummary, Notice, ThreadMessage } from "@/components/app-shell/types";
import {
  selectThreadSnapshot,
  selectThreadVisibleMessages,
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
  pendingBranchCheckouts: Map<string, Promise<BranchCheckoutSettlement>>;
  refreshActiveChat(
    chatId: string | null,
    options?: {
      forceDetail?: boolean;
      preserveControls?: boolean;
      resumeRuns?: boolean;
    }
  ): Promise<ChatDetail | null>;
  resetThreadToLatest(): void;
  shareMutationCoordinator: ShareMutationCoordinator;
  setNotice(notice: Notice): void;
  setSharing(value: boolean): void;
  activeChatStreaming: boolean;
};

export type BranchCheckoutSettlement = {
  leafId: string;
  succeeded: boolean;
};

type ShareOwner = {
  chatId: string;
  generation: number;
  href: string;
  shareId: string;
};

type ShareMutation =
  | {
    generation: number;
    kind: "create";
  }
  | {
    generation: number;
    kind: "revoke";
    shareGeneration: number;
    shareId: string;
  };

export type ShareMutationCoordinator = {
  generation: number;
  mutation: ShareMutation | null;
  visibleShare: ShareOwner | null;
};

export function createShareMutationCoordinator(): ShareMutationCoordinator {
  return {
    generation: 0,
    mutation: null,
    visibleShare: null
  };
}

function ownsShareMutation(coordinator: ShareMutationCoordinator, generation: number): boolean {
  return coordinator.mutation?.generation === generation;
}

function ownsVisibleShare(coordinator: ShareMutationCoordinator, owner: ShareOwner): boolean {
  const visibleShare = coordinator.visibleShare;
  return Boolean(
    visibleShare &&
      visibleShare.generation === owner.generation &&
      visibleShare.shareId === owner.shareId &&
      visibleShare.href === owner.href
  );
}

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
  pendingBranchCheckouts,
  refreshActiveChat,
  resetThreadToLatest,
  shareMutationCoordinator,
  setNotice,
  setSharing
}: ThreadActionsInput) {
  async function copyVisibleThread() {
    const thread = selectThreadVisibleMessages(
      selectThreadSnapshot(useThreadStore.getState(), activeChatId)
    )
      .map(
        (message) =>
          `${message.role === "assistant" ? "Assistant" : "User"}:\n${textFromThreadContent(message.content).trim()}`
      )
      .join("\n\n");

    if (!thread.trim()) {
      setNotice({
        kind: "error",
        text: "Nothing to copy yet."
      });
      return;
    }

    try {
      await writeClipboardText(`# ${activeChatTitle}\n\n${thread}`);
      setNotice({
        kind: "success",
        text: "Thread copied"
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
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
      const response = await fetch(`/api/messages/${messageId}/branch-chat`, {
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

    const response = await fetch(`/api/chats/${chatId}`, {
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

      const previousLeafId = selectThreadSnapshot(
        useThreadStore.getState(),
        chatId
      ).activeLeafId;
      const previousStoredLeafId = useWorkspaceStore
        .getState()
        .chats.find((chat) => chat.id === chatId)?.activeLeafMessageId;
      useThreadStore.getState().checkoutBranch(chatId, messageId);
      resetThreadToLatest();
      useWorkspaceStore.getState().updateChats((current) =>
        current.map((chat) => (chat.id === chatId ? { ...chat, activeLeafMessageId: messageId } : chat))
      );

      try {
        await persistActiveLeafRequest(chatId, messageId, previousStoredLeafId);
      } catch (error) {
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

      await refreshActiveChat(chatId, {
        forceDetail: true,
        preserveControls: true,
        resumeRuns: false
      });
      return { leafId: messageId, succeeded: true };
    })();
    pendingBranchCheckouts.set(chatId, operation);

    try {
      await operation;
    } finally {
      if (pendingBranchCheckouts.get(chatId) === operation) {
        pendingBranchCheckouts.delete(chatId);
      }
    }
  }

  async function deleteMessage(messageId: string) {
    if (activeChatStreaming) {
      return;
    }

    if (!(await confirmDeleteMessage(messageId))) {
      return;
    }

    try {
      const response = await fetch(`/api/messages/${messageId}`, {
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
      await refreshActiveChat(activeChatId, { preserveControls: true, resumeRuns: false });
      restoreFocusAfterRemoval("#composer");
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  function showLiveShareNotice(owner: ShareOwner, text: string) {
    setNotice({
      action: {
        label: "Revoke link",
        onClick: () => void revokeShare(owner),
        tone: "destructive"
      },
      href: owner.href,
      kind: "success",
      persistent: true,
      text
    });
  }

  async function shareChat(chat: ChatSummary) {
    if (shareMutationCoordinator.mutation) {
      return;
    }

    if (shareMutationCoordinator.visibleShare) {
      showLiveShareNotice(
        shareMutationCoordinator.visibleShare,
        "A public share link is already active. Revoke it before creating another."
      );
      closeChatActions();
      return;
    }

    if (!chat.activeLeafMessageId) {
      setNotice({
        kind: "error",
        text: "Send a message before sharing."
      });
      return;
    }

    const generation = shareMutationCoordinator.generation + 1;
    shareMutationCoordinator.generation = generation;
    shareMutationCoordinator.mutation = {
      generation,
      kind: "create"
    };
    setSharing(true);
    try {
      const response = await fetch(`/api/chats/${chat.id}/share`, {
        body: JSON.stringify({
          activeLeafMessageId: chat.activeLeafMessageId
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(`share_failed_${response.status}`);
      }

      const body = (await response.json()) as { share?: { id?: unknown; publicPath?: unknown } };
      if (typeof body.share?.id !== "string" || typeof body.share.publicPath !== "string") {
        throw new Error("share_response_invalid");
      }

      const shareId = body.share.id;
      const href = new URL(body.share.publicPath, window.location.origin).toString();
      let noticeText = "Share link copied";
      try {
        await writeClipboardText(href);
      } catch {
        noticeText = "Share link created. Copy it from here.";
      }

      if (!ownsShareMutation(shareMutationCoordinator, generation)) {
        return;
      }

      const owner: ShareOwner = {
        chatId: chat.id,
        generation,
        href,
        shareId
      };
      shareMutationCoordinator.visibleShare = owner;
      showLiveShareNotice(owner, noticeText);
      closeChatActions();
    } catch (error) {
      if (ownsShareMutation(shareMutationCoordinator, generation)) {
        setNotice({
          kind: "error",
          text: errorMessage(error)
        });
      }
    } finally {
      if (ownsShareMutation(shareMutationCoordinator, generation)) {
        shareMutationCoordinator.mutation = null;
        setSharing(false);
      }
    }
  }

  async function revokeShare(owner: ShareOwner) {
    if (
      shareMutationCoordinator.mutation ||
      !ownsVisibleShare(shareMutationCoordinator, owner)
    ) {
      return;
    }

    const generation = shareMutationCoordinator.generation + 1;
    shareMutationCoordinator.generation = generation;
    shareMutationCoordinator.mutation = {
      generation,
      kind: "revoke",
      shareGeneration: owner.generation,
      shareId: owner.shareId
    };
    setSharing(true);
    setNotice({
      action: {
        disabled: true,
        label: "Revoking…",
        onClick: () => undefined,
        tone: "destructive"
      },
      href: owner.href,
      kind: "success",
      persistent: true,
      text: "Revoking public share link."
    });

    try {
      const response = await fetch(`/api/shares/${owner.shareId}/revoke`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `share_revoke_failed_${response.status}`));
      }

      if (
        !ownsShareMutation(shareMutationCoordinator, generation) ||
        !ownsVisibleShare(shareMutationCoordinator, owner)
      ) {
        return;
      }

      shareMutationCoordinator.visibleShare = null;
      setNotice({
        kind: "success",
        text: "Public share link revoked"
      });
      restoreFocusAfterRemoval('button[aria-label="Share anonymously"]');
    } catch (error) {
      if (
        ownsShareMutation(shareMutationCoordinator, generation) &&
        ownsVisibleShare(shareMutationCoordinator, owner)
      ) {
        setNotice({
          action: {
            label: "Retry revoke",
            onClick: () => void revokeShare(owner),
            tone: "destructive"
          },
          href: owner.href,
          kind: "error",
          persistent: true,
          text: errorMessage(error)
        });
      }
    } finally {
      if (ownsShareMutation(shareMutationCoordinator, generation)) {
        shareMutationCoordinator.mutation = null;
        setSharing(false);
      }
    }
  }

  async function shareActiveBranch() {
    const chat = activeChat;
    if (!chat) {
      setNotice({
        kind: "error",
        text: "Send a message before sharing."
      });
      return;
    }

    await shareChat({
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
