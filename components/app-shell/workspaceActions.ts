import {
  chatDetailFromApi,
  chatSummaryFromApi
} from "@/components/app-shell/shellApi";
import { fallbackCatalogModel } from "@/components/app-shell/controlDefaults";
import { errorMessage, safeDownloadName } from "@/components/app-shell/shellFormatting";
import {
  rememberActiveChatId,
  storedActiveChatId
} from "@/components/app-shell/shellStorage";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  ChatSummary,
  FolderSummary,
  Notice,
  PromptPreset,
  RunEventView
} from "@/components/app-shell/types";
import { visibleMessagePath } from "@/components/app-shell/threadPath";
import {
  chatDetailBodyFromUnknown,
  chatUpdateFromEvent,
  resolveModelSearchStrategy
} from "@/components/app-shell/powerAppShellData";
import {
  decodeChatSummaryResponse,
  decodeWorkspaceChatsResponse
} from "@/lib/contracts/chats";
import { mergeThreadMessages } from "@/components/app-shell/runState";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  folderIdFromComposerSessionKey,
  type ComposerSessionKey,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import {
  emptyThreadSnapshot,
  useThreadStore,
  type ThreadSnapshot
} from "@/components/app-shell/threadStore";
import { sortChatsByFavoriteThenUpdatedAt, useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { WorkspaceChatMutationPort } from "@/components/app-shell/useWorkspaceInteractionController";

type MutableRef<T> = {
  current: T;
};

type ActivateChatOptions = {
  catalogOverride?: Catalog | null;
  preserveControls?: boolean;
  resumeRuns?: boolean;
};

type WorkspaceActionsInput = {
  activeChatIdRef: MutableRef<string | null>;
  applyModelControlDefaults(model?: CatalogModel | null, controlValues?: Record<string, unknown>): void;
  applyPrompt(prompt: PromptPreset | null): void;
  chatDetailRequestsRef: MutableRef<Map<string, Promise<ChatDetail | null>>>;
  chatHasActiveStream(chatId: string): boolean;
  chatMutation: WorkspaceChatMutationPort;
  confirmDeleteChat(chat: ChatSummary): Promise<boolean>;
  loadingChatDetailIdRef: MutableRef<string | null>;
  resumeChatRun(chat: ChatSummary): void;
  setNotice(notice: Notice): void;
  setSelectedModelId(value: string): void;
  setSelectedProvider(value: string): void;
  setSelectedSearchStrategy(value: string): void;
  workspaceRefreshPromiseRef: MutableRef<Promise<ChatDetail | null> | null>;
};

export function useWorkspaceActions({
  activeChatIdRef,
  applyModelControlDefaults,
  applyPrompt,
  chatDetailRequestsRef,
  chatHasActiveStream,
  chatMutation,
  confirmDeleteChat,
  loadingChatDetailIdRef,
  resumeChatRun,
  setNotice,
  setSelectedModelId,
  setSelectedProvider,
  setSelectedSearchStrategy,
  workspaceRefreshPromiseRef
}: WorkspaceActionsInput) {
  function summaryFromDetail(detail: ChatDetail): ChatSummary {
    return {
      activeLeafMessageId: detail.activeLeafMessageId,
      createdAt: detail.createdAt,
      defaultModelId: detail.defaultModelId,
      defaultPromptPresetId: detail.defaultPromptPresetId,
      defaultProvider: detail.defaultProvider,
      folderId: detail.folderId,
      id: detail.id,
      messageCount: detail.messageCount,
      pinned: detail.pinned,
      title: detail.title,
      updatedAt: detail.updatedAt
    };
  }

  function detailFromOwners(summary: ChatSummary, thread: ThreadSnapshot): ChatDetail {
    return {
      ...summary,
      messages: thread.messages,
      usageStats: thread.usageStats
    };
  }

  function mergeChatIntoList(chat: ChatSummary) {
    useWorkspaceStore.getState().upsertChat(chat);
  }

  function markCachedSummaryRevision(chat: ChatSummary) {
    if (useThreadStore.getState().threadsByChatId[chat.id]) {
      useThreadStore.getState().mergeMessages(chat.id, [], {
        sourceUpdatedAt: chat.updatedAt
      });
    }
  }

  function cacheChatDetail(
    detail: ChatDetail,
    requestContext?: {
      summary?: ChatSummary;
      thread?: ThreadSnapshot;
    }
  ): ChatDetail {
    const threadStore = useThreadStore.getState();
    const current = threadStore.threadsByChatId[detail.id];
    const changedDuringRequest = requestContext !== undefined && current !== requestContext.thread;
    const snapshot: ThreadSnapshot =
      changedDuringRequest && current
        ? {
            activeLeafId:
              current.activeLeafId !== (requestContext.thread?.activeLeafId ?? null)
                ? current.activeLeafId
                : detail.activeLeafMessageId,
            messages:
              current.messages !== requestContext.thread?.messages
                ? mergeThreadMessages(detail.messages, current.messages)
                : detail.messages,
            sourceUpdatedAt:
              current.sourceUpdatedAt !== (requestContext.thread?.sourceUpdatedAt ?? null)
                ? current.sourceUpdatedAt
                : detail.updatedAt,
            usageStats:
              current.usageStats !== (requestContext.thread?.usageStats ?? null)
                ? current.usageStats
                : detail.usageStats
          }
        : {
            activeLeafId: detail.activeLeafMessageId,
            messages: detail.messages,
            sourceUpdatedAt: detail.updatedAt,
            usageStats: detail.usageStats
          };
    const serverSummary = summaryFromDetail(detail);
    const currentSummary = useWorkspaceStore
      .getState()
      .chats.find((candidate) => candidate.id === detail.id);
    const summary =
      requestContext !== undefined && currentSummary !== requestContext.summary
        ? currentSummary ?? serverSummary
        : serverSummary;

    threadStore.replaceThread(detail.id, snapshot);
    mergeChatIntoList(summary);
    return detailFromOwners(summary, snapshot);
  }

  function applyChatUpdate(event: RunEventView, expectedChatId: string | null): boolean {
    const update = chatUpdateFromEvent(event);
    if (!update || (expectedChatId && update.chat.id !== expectedChatId)) {
      return false;
    }

    mergeChatIntoList(update.chat);
    useThreadStore.getState().mergeMessages(update.chat.id, update.messages, {
      activeLeafId: update.chat.activeLeafMessageId,
      sourceUpdatedAt: update.chat.updatedAt,
      usageStats: update.usageStats
    });

    return true;
  }

  function fetchChatDetail(
    chatId: string,
    options: { force?: boolean } = {}
  ): Promise<ChatDetail | null> {
    const pending = chatDetailRequestsRef.current.get(chatId);
    if (pending) {
      return options.force
        ? pending.then(() => fetchChatDetail(chatId))
        : pending;
    }

    const requestBase = useThreadStore.getState().threadsByChatId[chatId];
    const requestSummary = useWorkspaceStore
      .getState()
      .chats.find((candidate) => candidate.id === chatId);
    const request = (async () => {
      try {
        const response = await fetch(`/api/chats/${chatId}`);
        if (!response.ok) {
          throw new Error(`chat_detail_failed_${response.status}`);
        }

        const chat = chatDetailBodyFromUnknown(await response.json());
        if (!chat || chat.id !== chatId) {
          throw new Error("chat_detail_malformed");
        }

        if (!useWorkspaceStore.getState().chats.some((candidate) => candidate.id === chatId)) {
          return null;
        }

        return cacheChatDetail(chatDetailFromApi(chat), {
          summary: requestSummary,
          thread: requestBase
        });
      } catch (error) {
        const message = errorMessage(error);
        if (loadingChatDetailIdRef.current === chatId && activeChatIdRef.current === chatId) {
          useWorkspaceStore.getState().setActiveChatDetailError(message);
        }
        return null;
      }
    })();

    chatDetailRequestsRef.current.set(chatId, request);
    void request.finally(() => {
      if (chatDetailRequestsRef.current.get(chatId) === request) {
        chatDetailRequestsRef.current.delete(chatId);
      }
    });
    return request;
  }

  function applyChatDefaults(chat: ChatSummary, catalogOverride: Catalog | null | undefined = useWorkspaceStore.getState().catalog) {
    const model = fallbackCatalogModel(catalogOverride, {
      modelId: chat.defaultModelId,
      provider: chat.defaultProvider
    });

    setSelectedProvider(model?.provider ?? chat.defaultProvider);
    setSelectedModelId(model?.modelId ?? chat.defaultModelId);
    setSelectedSearchStrategy(
      resolveModelSearchStrategy(
        model,
        catalogOverride?.defaults.controlValues,
        catalogOverride?.defaults.searchStrategyId
      )
    );
    applyModelControlDefaults(model, catalogOverride?.defaults.controlValues);

    const prompt = chat.defaultPromptPresetId
      ? catalogOverride?.promptPresets.find(
          (candidate) => candidate.id === chat.defaultPromptPresetId
        ) ?? null
      : null;
    applyPrompt(prompt);
  }

  function reapplyActiveChatDefaults(catalogOverride: Catalog): boolean {
    const activeId = activeChatIdRef.current;
    const activeChat = activeId
      ? useWorkspaceStore.getState().chats.find((candidate) => candidate.id === activeId)
      : null;
    if (!activeChat) {
      return false;
    }

    applyChatDefaults(activeChat, catalogOverride);
    return true;
  }

  function applyActiveChat(chat: ChatSummary, options: ActivateChatOptions = {}) {
    activeChatIdRef.current = chat.id;
    useWorkspaceStore.getState().setPendingChatFolderId(null);
    rememberActiveChatId(chat.id);
    useWorkspaceStore.getState().setActiveChatId(chat.id);
    useComposerSessionStore.getState().activateSession(composerSessionKey(chat.id));
    if (!options.preserveControls) {
      applyChatDefaults(chat, options.catalogOverride);
    }
    if (options.resumeRuns !== false) {
      void resumeChatRun(chat);
    }
  }

  async function activateChat(chat: ChatSummary, options: ActivateChatOptions = {}) {
    let cachedThread = useThreadStore.getState().threadsByChatId[chat.id];
    if (!cachedThread && chat.messageCount === 0) {
      cachedThread = {
        ...emptyThreadSnapshot,
        activeLeafId: chat.activeLeafMessageId,
        sourceUpdatedAt: chat.updatedAt
      };
      useThreadStore.getState().replaceThread(chat.id, cachedThread);
    }
    const needsDetail =
      !cachedThread ||
      chat.messageCount > cachedThread.messages.length ||
      (!chatHasActiveStream(chat.id) && cachedThread.sourceUpdatedAt !== chat.updatedAt);
    loadingChatDetailIdRef.current = needsDetail ? chat.id : null;
    useWorkspaceStore.getState().setActiveChatDetailError(null);
    useWorkspaceStore.getState().setActiveChatDetailLoading(needsDetail);
    applyActiveChat(chat, {
      ...options,
      resumeRuns: !needsDetail && options.resumeRuns !== false
    });

    if (!needsDetail) {
      return detailFromOwners(chat, cachedThread);
    }

    const detail = await fetchChatDetail(chat.id);
    if (!detail || activeChatIdRef.current !== chat.id) {
      if (loadingChatDetailIdRef.current === chat.id) {
        loadingChatDetailIdRef.current = null;
        useWorkspaceStore.getState().setActiveChatDetailLoading(false);
      }
      return null;
    }

    if (loadingChatDetailIdRef.current === chat.id) {
      loadingChatDetailIdRef.current = null;
      useWorkspaceStore.getState().setActiveChatDetailLoading(false);
    }

    const currentSummary =
      useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chat.id) ??
      summaryFromDetail(detail);
    applyActiveChat(currentSummary, {
      preserveControls: true,
      resumeRuns: options.resumeRuns !== false
    });
    return detail;
  }

  function activateBlankWorkspace(folderId: string | null = null) {
    activeChatIdRef.current = null;
    loadingChatDetailIdRef.current = null;
    useWorkspaceStore.getState().setPendingChatFolderId(folderId);
    useWorkspaceStore.getState().setActiveChatDetailError(null);
    useWorkspaceStore.getState().setActiveChatDetailLoading(false);
    rememberActiveChatId(null);
    useWorkspaceStore.getState().setActiveChatId(null);
    useComposerSessionStore.getState().activateSession(composerSessionKey(null, folderId));
  }

  async function refreshActiveChat(
    chatId: string | null,
    options: {
      forceDetail?: boolean;
      preserveControls?: boolean;
      resumeRuns?: boolean;
    } = {}
  ) {
    if (!chatId) {
      return null;
    }

    const detail = await fetchChatDetail(chatId, { force: options.forceDetail });
    if (!detail) {
      return null;
    }

    if (activeChatIdRef.current === chatId) {
      const summary =
        useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chatId) ??
        summaryFromDetail(detail);
      applyActiveChat(summary, {
        preserveControls: options.preserveControls,
        resumeRuns: options.resumeRuns
      });
    }

    return detail;
  }

  function refreshWorkspace(
    nextActiveChatId: string | null = useWorkspaceStore.getState().activeChatId,
    options: { catalogOverride?: Catalog | null; preserveControls?: boolean; resumeRuns?: boolean } = {}
  ): Promise<ChatDetail | null> {
    if (workspaceRefreshPromiseRef.current) {
      return workspaceRefreshPromiseRef.current;
    }

    const wasReady = useWorkspaceStore.getState().workspaceReady;
    const request = (async () => {
      useWorkspaceStore.getState().setWorkspaceLoading(true);
      try {
        const response = await fetch("/api/chats");
        if (!response.ok) {
          throw new Error(`workspace_failed_${response.status}`);
        }

        const body = decodeWorkspaceChatsResponse(await response.json());
        if (!body) {
          throw new Error("workspace_malformed");
        }

        const nextChats = body.chats.map(chatSummaryFromApi);
        useWorkspaceStore.getState().setFolders(body.folders);
        useWorkspaceStore.getState().setChats(sortChatsByFavoriteThenUpdatedAt(nextChats));
        const nextChatIds = new Set(nextChats.map((chat) => chat.id));
        const nextFolderIds = new Set(body.folders.map((folder) => folder.id));
        const composerSessionKeys = Object.keys(
          useComposerSessionStore.getState().sessionsByKey
        ) as ComposerSessionKey[];
        for (const sessionKey of composerSessionKeys) {
          const sessionChatId = chatIdFromComposerSessionKey(sessionKey);
          const sessionFolderId = folderIdFromComposerSessionKey(sessionKey);
          if (
            sessionChatId &&
            !nextChatIds.has(sessionChatId) &&
            !chatHasActiveStream(sessionChatId)
          ) {
            useComposerSessionStore.getState().removeSession(sessionKey);
          } else if (sessionFolderId && !nextFolderIds.has(sessionFolderId)) {
            useComposerSessionStore.getState().removeSession(sessionKey);
            if (
              activeChatIdRef.current === null &&
              useWorkspaceStore.getState().pendingChatFolderId === sessionFolderId
            ) {
              useWorkspaceStore.getState().setPendingChatFolderId(null);
            }
          }
        }
        for (const cachedChatId of Object.keys(useThreadStore.getState().threadsByChatId)) {
          if (!nextChatIds.has(cachedChatId) && !chatHasActiveStream(cachedChatId)) {
            useThreadStore.getState().removeThread(cachedChatId);
            useRunSurfaceStore.getState().removeSurface(cachedChatId);
          }
        }
        useWorkspaceStore.getState().setWorkspaceError(null);
        useWorkspaceStore.getState().setWorkspaceReady(true);

        const targetActiveChatId = nextActiveChatId ?? storedActiveChatId();
        const activationCatalog = options.catalogOverride ?? useWorkspaceStore.getState().catalog;

        if (targetActiveChatId) {
          const nextActive = nextChats.find((chat) => chat.id === targetActiveChatId);
          if (nextActive) {
            return await activateChat(nextActive, {
              catalogOverride: activationCatalog,
              preserveControls: options.preserveControls,
              resumeRuns: options.resumeRuns
            });
          }
        }

        activateBlankWorkspace();

        return null;
      } catch (error) {
        const message = errorMessage(error);
        if (wasReady) {
          setNotice({
            kind: "error",
            text: message
          });
        } else {
          useWorkspaceStore.getState().setWorkspaceError(message);
        }
        return null;
      } finally {
        useWorkspaceStore.getState().setWorkspaceLoading(false);
      }
    })();

    workspaceRefreshPromiseRef.current = request;
    void request.finally(() => {
      if (workspaceRefreshPromiseRef.current === request) {
        workspaceRefreshPromiseRef.current = null;
      }
    });
    return request;
  }

  async function createChat(
    folderId: string | null = null,
    sourceSessionKey?: ComposerSessionKey
  ) {
    useWorkspaceStore.getState().setCreatingChat(true);
    try {
      const response = await fetch("/api/chats", {
        body: JSON.stringify({
          folderId
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(`chat_create_failed_${response.status}`);
      }

      const apiChat = decodeChatSummaryResponse(await response.json());
      if (!apiChat) {
        throw new Error("chat_create_malformed");
      }
      const summary = chatSummaryFromApi(apiChat);
      useWorkspaceStore.getState().upsertChat(summary);

      if (sourceSessionKey) {
        const sourceWasSelected =
          useComposerSessionStore.getState().activeSessionKey === sourceSessionKey;
        useComposerSessionStore
          .getState()
          .transferSession(sourceSessionKey, composerSessionKey(summary.id));
        if (sourceWasSelected && activeChatIdRef.current === null) {
          await activateChat(summary);
        }
      } else {
        await activateChat(summary);
      }
      return summary;
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
      return null;
    } finally {
      useWorkspaceStore.getState().setCreatingChat(false);
    }
  }

  async function updateChatFolder(chatId: string, folderId: string | null) {
    try {
      const response = await fetch(`/api/chats/${chatId}`, {
        body: JSON.stringify({ folderId }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(`chat_move_failed_${response.status}`);
      }

      const apiChat = decodeChatSummaryResponse(await response.json());
      if (!apiChat || apiChat.id !== chatId) {
        throw new Error("chat_move_malformed");
      }
      const chat = chatSummaryFromApi(apiChat);
      markCachedSummaryRevision(chat);
      useWorkspaceStore
        .getState()
        .updateChats((current) =>
          sortChatsByFavoriteThenUpdatedAt(current.map((candidate) => (candidate.id === chat.id ? chat : candidate)))
        );
      chatMutation.closeActions();
      setNotice({
        kind: "success",
        text: `Moved: ${chat.title}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  async function deleteChat(chat: ChatSummary) {
    if (chatHasActiveStream(chat.id)) {
      setNotice({
        kind: "error",
        text: "Stop the running response before deleting this chat."
      });
      return;
    }

    if (!(await confirmDeleteChat(chat))) {
      return;
    }

    try {
      const response = await fetch(`/api/chats/${chat.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(`chat_delete_failed_${response.status}`);
      }

      const nextActive = useWorkspaceStore.getState().chats.find((candidate) => candidate.id !== chat.id) ?? null;
      useWorkspaceStore.getState().updateChats((current) => current.filter((candidate) => candidate.id !== chat.id));
      useThreadStore.getState().removeThread(chat.id);
      useRunSurfaceStore.getState().removeSurface(chat.id);
      useComposerSessionStore.getState().removeSession(composerSessionKey(chat.id));
      chatDetailRequestsRef.current.delete(chat.id);
      chatMutation.closeActions();
      setNotice({
        kind: "success",
        text: `Deleted: ${chat.title}`
      });

      if (activeChatIdRef.current === chat.id) {
        if (nextActive) {
          await activateChat(nextActive);
        } else {
          activateBlankWorkspace();
        }
      }
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  async function renameChat(chat: ChatSummary) {
    const title = chatMutation.editingTitle.trim();
    if (!title) {
      return;
    }

    try {
      const response = await fetch(`/api/chats/${chat.id}`, {
        body: JSON.stringify({ title }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(`chat_rename_failed_${response.status}`);
      }

      const apiChat = decodeChatSummaryResponse(await response.json());
      if (!apiChat || apiChat.id !== chat.id) {
        throw new Error("chat_rename_malformed");
      }
      const updated = chatSummaryFromApi(apiChat);
      markCachedSummaryRevision(updated);
      useWorkspaceStore
        .getState()
        .updateChats((current) =>
          sortChatsByFavoriteThenUpdatedAt(
            current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
          )
        );
      chatMutation.finishEditing();
      setNotice({
        kind: "success",
        text: `Chat renamed: ${updated.title}`
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  async function exportChat(chat: ChatSummary) {
    let summary =
      useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chat.id) ?? chat;
    let thread = useThreadStore.getState().threadsByChatId[chat.id];
    if (
      !thread ||
      summary.messageCount > thread.messages.length ||
      (!chatHasActiveStream(chat.id) && thread.sourceUpdatedAt !== summary.updatedAt)
    ) {
      await fetchChatDetail(chat.id);
      thread = useThreadStore.getState().threadsByChatId[chat.id];
      summary =
        useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chat.id) ?? summary;
    }
    const visible = visibleMessagePath(
      thread?.messages ?? emptyThreadSnapshot.messages,
      thread?.activeLeafId ?? summary.activeLeafMessageId
    );
    const payload = {
      defaultModelId: summary.defaultModelId,
      defaultProvider: summary.defaultProvider,
      exportedAt: new Date().toISOString(),
      messages: visible.map((message) => ({
        content: message.content,
        modelId: message.modelId ?? null,
        provider: message.provider ?? null,
        role: message.role,
        status: message.status
      })),
      title: summary.title
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${safeDownloadName(summary.title)}.json`;
    link.click();
    URL.revokeObjectURL(href);
    chatMutation.closeActions();
  }

  async function toggleChatFavorite(chat: ChatSummary) {
    try {
      const response = await fetch(`/api/chats/${chat.id}`, {
        body: JSON.stringify({ pinned: !chat.pinned }),
        headers: {
          "content-type": "application/json"
        },
        method: "PATCH"
      });

      if (!response.ok) {
        throw new Error(`chat_update_failed_${response.status}`);
      }

      const apiChat = decodeChatSummaryResponse(await response.json());
      if (!apiChat || apiChat.id !== chat.id) {
        throw new Error("chat_update_malformed");
      }
      const updated = chatSummaryFromApi(apiChat);
      markCachedSummaryRevision(updated);
      useWorkspaceStore
        .getState()
        .updateChats((current) =>
          sortChatsByFavoriteThenUpdatedAt(
            current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
          )
        );
      chatMutation.closeActions();
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  return {
    activateBlankWorkspace,
    activateChat,
    applyChatUpdate,
    createChat,
    deleteChat,
    exportChat,
    fetchChatDetail,
    reapplyActiveChatDefaults,
    refreshActiveChat,
    refreshWorkspace,
    renameChat,
    toggleChatFavorite,
    updateChatFolder
  };
}
