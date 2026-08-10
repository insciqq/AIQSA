import {
  chatDetailFromApi,
  chatSummaryFromApi,
  messageFromApi,
  shellFetch
} from "@/components/app-shell/shellApi";
import { fallbackCatalogModel } from "@/components/app-shell/controlDefaults";
import {
  errorMessage,
  responseErrorMessage,
  safeDownloadName
} from "@/components/app-shell/shellFormatting";
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
  RunEventView,
  ThreadMessage
} from "@/components/app-shell/types";
import { visibleMessagePath } from "@/components/app-shell/threadPath";
import {
  chatDetailBodyFromUnknown,
  chatUpdateFromEvent,
  resolvePreferredSearchPlan
} from "@/components/app-shell/powerAppShellData";
import type { SearchPlanMode } from "@/lib/domain/search";
import type { KnowledgePlan } from "@/lib/contracts/knowledge";
import {
  decodeChatMessagesPageResponse,
  decodeChatSummaryResponse,
  decodeWorkspaceChatsResponse
} from "@/lib/contracts/chats";
import { mergeThreadMessages } from "@/components/app-shell/runState";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  composerSessionModeFromKey,
  folderIdFromComposerSessionKey,
  type ComposerSessionKey,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import {
  archiveChat as archiveChatRequest,
  loadChatMemoryState
} from "@/components/app-shell/chatLifecycleApi";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import {
  emptyThreadHistoryState,
  emptyThreadSnapshot,
  threadHistoryState,
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

export type OlderPageLoadOutcome = "failed" | "prepended" | "reset";

type WorkspaceActionsInput = {
  activeChatIdRef: MutableRef<string | null>;
  applyModelControlDefaults(model?: CatalogModel | null, controlValues?: Record<string, unknown>): void;
  chatDetailRequestsRef: MutableRef<Map<string, Promise<ChatDetail | null>>>;
  chatHasActiveStream(chatId: string): boolean;
  chatHasPendingThreadMutation?(chatId: string): boolean;
  chatMutation: WorkspaceChatMutationPort;
  confirmDeleteChat(chat: ChatSummary): Promise<boolean>;
  loadingChatDetailIdRef: MutableRef<string | null>;
  resumeChatRun(chat: ChatSummary): void;
  setNotice(notice: Notice): void;
  setSelectedModelId(value: string, origin?: "assistant" | "system" | "user"): void;
  setSelectedKnowledgePlan(
    baseIds: readonly string[],
    source?: "chat" | "explicit" | "off" | "project",
    origin?: "assistant" | "system" | "user"
  ): void;
  setSelectedProvider(value: string, origin?: "assistant" | "system" | "user"): void;
  setSelectedSearchPlan(
    optionIds: readonly string[],
    mode: SearchPlanMode,
    origin?: "assistant" | "system" | "user"
  ): void;
  workspaceRefreshPromiseRef: MutableRef<Promise<ChatDetail | null> | null>;
};

export function useWorkspaceActions({
  activeChatIdRef,
  applyModelControlDefaults,
  chatDetailRequestsRef,
  chatHasActiveStream,
  chatHasPendingThreadMutation = () => false,
  chatMutation,
  confirmDeleteChat,
  loadingChatDetailIdRef,
  resumeChatRun,
  setNotice,
  setSelectedModelId,
  setSelectedKnowledgePlan,
  setSelectedProvider,
  setSelectedSearchPlan,
  workspaceRefreshPromiseRef
}: WorkspaceActionsInput) {
  function summaryFromDetail(detail: ChatDetail): ChatSummary {
    return {
      activeLeafMessageId: detail.activeLeafMessageId,
      createdAt: detail.createdAt,
      defaultKnowledgePlan: detail.defaultKnowledgePlan ?? null,
      defaultModelId: detail.defaultModelId,
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
    const history = threadHistoryState(thread);
    return {
      ...summary,
      contextStats: thread.contextStats ?? { approximateActiveBranchInputTokens: 0 },
      messages: thread.messages,
      pageInfo: {
        activeLeafMessageId: history.snapshotActiveLeafId,
        beforeCursor: history.beforeCursor,
        hasOlder: history.hasOlder,
        snapshotUpdatedAt: history.snapshotUpdatedAt ?? summary.updatedAt
      },
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
    const serverHistory = {
      beforeCursor: detail.pageInfo.beforeCursor,
      error: null,
      hasOlder: detail.pageInfo.hasOlder,
      loading: false,
      requestGeneration: (requestContext?.thread
        ? threadHistoryState(requestContext.thread).requestGeneration
        : 0) + 1,
      snapshotActiveLeafId: detail.pageInfo.activeLeafMessageId,
      snapshotUpdatedAt: detail.pageInfo.snapshotUpdatedAt
    };
    const snapshot: ThreadSnapshot =
      changedDuringRequest && current
        ? {
            activeLeafId:
              current.activeLeafId !== (requestContext.thread?.activeLeafId ?? null)
                ? current.activeLeafId
                : detail.activeLeafMessageId,
            contextStats:
              current.contextStats !== (requestContext.thread?.contextStats ?? null)
                ? current.contextStats ?? null
                : detail.contextStats,
            history:
              current.history !== requestContext.thread?.history
                ? current.history
                : serverHistory,
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
            contextStats: detail.contextStats,
            history: serverHistory,
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
      contextStats: update.contextStats,
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
        const response = await shellFetch(`/api/chats/${chatId}`);
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
        queueMicrotask(pruneThreadCache);
      }
    });
    return request;
  }

  async function loadEarlierMessages(chatId: string): Promise<OlderPageLoadOutcome> {
    const initial = useThreadStore.getState().threadsByChatId[chatId];
    const initialHistory = initial ? threadHistoryState(initial) : emptyThreadHistoryState;
    if (
      !initial ||
      initialHistory.loading ||
      !initialHistory.hasOlder ||
      !initialHistory.beforeCursor ||
      !initialHistory.snapshotUpdatedAt
    ) {
      return "failed";
    }

    const requestGeneration = useThreadStore.getState().beginOlderPage(chatId);
    try {
      const query = new URLSearchParams({ before: initialHistory.beforeCursor });
      const response = await shellFetch(`/api/chats/${chatId}/messages?${query.toString()}`);
      if (response.status === 409) {
        const reset = await fetchChatDetail(chatId, { force: true });
        if (!reset) {
          useThreadStore.getState().failOlderPage(
            chatId,
            requestGeneration,
            "Conversation changed, but its latest messages did not reload."
          );
          return "failed";
        }
        setNotice({
          kind: "success",
          text: "Conversation changed. Reloaded its latest messages."
        });
        return "reset";
      }
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, `chat_page_failed_${response.status}`)
        );
      }

      const page = decodeChatMessagesPageResponse(await response.json());
      const current = useThreadStore.getState().threadsByChatId[chatId];
      const expectedParentId = current?.messages[0]?.parentMessageId ?? null;
      const pageIds = new Set(page?.messages.map((message) => message.id) ?? []);
      if (
        !page ||
        page.pageInfo.activeLeafMessageId !== initialHistory.snapshotActiveLeafId ||
        page.pageInfo.snapshotUpdatedAt !== initialHistory.snapshotUpdatedAt ||
        page.messages.length === 0 ||
        page.messages.at(-1)?.id !== expectedParentId ||
        current?.messages.some((message) => pageIds.has(message.id))
      ) {
        throw new Error("chat_page_malformed");
      }

      const applied = useThreadStore.getState().prependOlderPage(chatId, {
        beforeCursor: page.pageInfo.beforeCursor,
        hasOlder: page.pageInfo.hasOlder,
        messages: page.messages.map(messageFromApi),
        requestGeneration,
        snapshotActiveLeafId: page.pageInfo.activeLeafMessageId,
        snapshotUpdatedAt: page.pageInfo.snapshotUpdatedAt
      });
      return applied ? "prepended" : "failed";
    } catch (error) {
      useThreadStore.getState().failOlderPage(chatId, requestGeneration, errorMessage(error));
      return "failed";
    }
  }

  async function loadCompleteActiveBranch(chatId: string): Promise<ThreadMessage[]> {
    let summary = useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId);
    if (!summary) throw new Error("chat_not_found");
    let thread = useThreadStore.getState().threadsByChatId[chatId];
    if (
      !thread ||
      threadHistoryState(thread).snapshotUpdatedAt === null ||
      (!chatHasActiveStream(chatId) &&
        threadHistoryState(thread).snapshotUpdatedAt !== summary.updatedAt) ||
      (!chatHasActiveStream(chatId) && thread.sourceUpdatedAt !== summary.updatedAt)
    ) {
      const detail = await fetchChatDetail(chatId, { force: Boolean(thread) });
      if (!detail) throw new Error("chat_detail_failed");
      summary = useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId) ?? summary;
      thread = useThreadStore.getState().threadsByChatId[chatId];
    }
    if (!thread) throw new Error("chat_detail_missing");

    const history = threadHistoryState(thread);
    if (!history.snapshotUpdatedAt) throw new Error("chat_page_snapshot_missing");
    let messages = visibleMessagePath(thread.messages, thread.activeLeafId);
    let beforeCursor = history.beforeCursor;
    const seenMessageIds = new Set(messages.map((message) => message.id));
    const seenCursors = new Set<string>();
    while (beforeCursor) {
      if (seenCursors.has(beforeCursor) || messages.length > summary.messageCount + 4) {
        throw new Error("chat_page_cycle");
      }
      seenCursors.add(beforeCursor);
      const query = new URLSearchParams({ before: beforeCursor });
      const response = await shellFetch(`/api/chats/${chatId}/messages?${query.toString()}`);
      if (response.status === 409) throw new Error("chat_page_stale");
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, `chat_page_failed_${response.status}`)
        );
      }
      const page = decodeChatMessagesPageResponse(await response.json());
      const expectedParentId = messages[0]?.parentMessageId ?? null;
      if (
        !page ||
        page.pageInfo.activeLeafMessageId !== history.snapshotActiveLeafId ||
        page.pageInfo.snapshotUpdatedAt !== history.snapshotUpdatedAt ||
        page.messages.length === 0 ||
        page.messages.at(-1)?.id !== expectedParentId ||
        page.messages.some((message) => seenMessageIds.has(message.id))
      ) {
        throw new Error("chat_page_malformed");
      }
      const older = page.messages.map(messageFromApi);
      for (const message of older) seenMessageIds.add(message.id);
      messages = [...older, ...messages];
      beforeCursor = page.pageInfo.beforeCursor;
    }

    if (messages.length > 0 && messages[0]?.parentMessageId !== null) {
      throw new Error("chat_history_incomplete");
    }
    return messages;
  }

  function protectedThreadChatIds(): Set<string> {
    const protectedChatIds = new Set(chatDetailRequestsRef.current.keys());
    const composerState = useComposerSessionStore.getState();
    for (const sessionKey of Object.keys(composerState.sessionsByKey) as ComposerSessionKey[]) {
      const session = composerState.sessionsByKey[sessionKey];
      const sessionChatId = chatIdFromComposerSessionKey(sessionKey);
      if (
        sessionChatId &&
        (session?.pendingEdit ||
          session?.pendingSend ||
          (session?.pendingUploadGenerations.length ?? 0) > 0)
      ) {
        protectedChatIds.add(sessionChatId);
      }
    }
    for (const cachedChatId of Object.keys(useThreadStore.getState().threadsByChatId)) {
      if (chatHasActiveStream(cachedChatId) || chatHasPendingThreadMutation(cachedChatId)) {
        protectedChatIds.add(cachedChatId);
      }
    }
    return protectedChatIds;
  }

  function pruneThreadCache(): string[] {
    const removedChatIds = useThreadStore.getState().pruneInactiveThreads({
      activeChatId: useWorkspaceStore.getState().activeChatId,
      protectedChatIds: protectedThreadChatIds()
    });
    for (const removedChatId of removedChatIds) {
      useRunSurfaceStore.getState().removeSurface(removedChatId);
    }
    return removedChatIds;
  }

  function applyChatDefaults(chat: ChatSummary, catalogOverride: Catalog | null | undefined = useWorkspaceStore.getState().catalog) {
    const model = fallbackCatalogModel(catalogOverride, {
      modelId: chat.defaultModelId,
      provider: chat.defaultProvider
    });

    setSelectedProvider(model?.provider ?? chat.defaultProvider, "system");
    setSelectedModelId(model?.modelId ?? chat.defaultModelId, "system");
    const searchPlan = resolvePreferredSearchPlan(
      catalogOverride?.defaults.searchPlan,
      catalogOverride?.defaults.searchStrategyId,
      catalogOverride?.searchStrategies
    );
    setSelectedSearchPlan(searchPlan.optionIds, searchPlan.mode, "system");
    const folderDefault = chat.folderId
      ? useWorkspaceStore.getState().folders.find((folder) => folder.id === chat.folderId)
          ?.defaultKnowledgePlan ?? null
      : null;
    const knowledgePlan = chat.defaultKnowledgePlan ?? folderDefault;
    setSelectedKnowledgePlan(
      knowledgePlan?.baseIds ?? [],
      chat.defaultKnowledgePlan
        ? "chat"
        : folderDefault
          ? "project"
          : "off",
      "system"
    );
    applyModelControlDefaults(model, catalogOverride?.defaults.controlValues);
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
    useThreadStore.getState().touchThread(chat.id);
    pruneThreadCache();
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
        history: {
          ...emptyThreadHistoryState,
          snapshotActiveLeafId: chat.activeLeafMessageId,
          snapshotUpdatedAt: chat.updatedAt
        },
        sourceUpdatedAt: chat.updatedAt
      };
      useThreadStore.getState().replaceThread(chat.id, cachedThread);
    }
    const needsDetail =
      !cachedThread ||
      threadHistoryState(cachedThread).snapshotUpdatedAt === null ||
      (!chatHasActiveStream(chat.id) &&
        threadHistoryState(cachedThread).snapshotUpdatedAt !== chat.updatedAt) ||
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
    pruneThreadCache();
    if (!useComposerControlStore.getState().selectedAssistant) {
      const catalog = useWorkspaceStore.getState().catalog;
      const defaultModel = catalog?.models.find(
        (candidate) =>
          candidate.provider === catalog.defaults.provider &&
          candidate.modelId === catalog.defaults.modelId
      );
      setSelectedProvider(defaultModel?.provider ?? "", "system");
      setSelectedModelId(defaultModel?.modelId ?? "", "system");
      applyModelControlDefaults(defaultModel, catalog?.defaults.controlValues);
      const projectPlan = folderId
        ? useWorkspaceStore.getState().folders.find((folder) => folder.id === folderId)
            ?.defaultKnowledgePlan ?? null
        : null;
      setSelectedKnowledgePlan(
        projectPlan?.baseIds ?? [],
        projectPlan ? "project" : "off",
        "system"
      );
    }
  }

  async function setChatKnowledgeDefault(plan: KnowledgePlan | null): Promise<boolean> {
    const chatId = activeChatIdRef.current;
    if (!chatId) return false;
    try {
      const response = await shellFetch(`/api/chats/${chatId}`, {
        body: JSON.stringify({ defaultKnowledgePlan: plan }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) throw new Error(`chat_knowledge_default_failed_${response.status}`);
      const decoded = decodeChatSummaryResponse(await response.json());
      if (!decoded || decoded.id !== chatId) throw new Error("chat_knowledge_default_malformed");
      const chat = chatSummaryFromApi(decoded);
      useWorkspaceStore.getState().upsertChat(chat);
      const folderPlan = chat.folderId
        ? useWorkspaceStore.getState().folders.find((folder) => folder.id === chat.folderId)
            ?.defaultKnowledgePlan ?? null
        : null;
      const effective = chat.defaultKnowledgePlan ?? folderPlan;
      if (activeChatIdRef.current === chatId) {
        setSelectedKnowledgePlan(
          effective?.baseIds ?? [],
          chat.defaultKnowledgePlan ? "chat" : folderPlan ? "project" : "off",
          "system"
        );
      }
      setNotice({
        kind: "success",
        text: plan === null
          ? folderPlan
            ? "This chat now follows its project Knowledge default."
            : "Chat Knowledge default cleared. Knowledge is Off."
          : "Chat Knowledge default saved."
      });
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
      return false;
    }
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
        const response = await shellFetch("/api/chats");
        if (!response.ok) {
          throw new Error(`workspace_failed_${response.status}`);
        }

        const body = decodeWorkspaceChatsResponse(await response.json());
        if (!body) {
          throw new Error("workspace_malformed");
        }

        const nextChats = body.chats.map(chatSummaryFromApi);
        const targetActiveChatId = nextActiveChatId ?? storedActiveChatId();
        let recoveredTemporaryDetail: ChatDetail | null = null;
        let recoveredTemporarySummary: ChatSummary | null = null;
        if (targetActiveChatId && !nextChats.some((chat) => chat.id === targetActiveChatId)) {
          try {
            const memoryState = await loadChatMemoryState(targetActiveChatId);
            if (memoryState.chat.mode === "TEMPORARY" && !memoryState.chat.archived) {
              const detailResponse = await shellFetch(
                `/api/chats/${encodeURIComponent(targetActiveChatId)}`
              );
              if (!detailResponse.ok) {
                throw new Error(`chat_detail_failed_${detailResponse.status}`);
              }
              const wireDetail = chatDetailBodyFromUnknown(await detailResponse.json());
              if (!wireDetail || wireDetail.id !== targetActiveChatId) {
                throw new Error("chat_detail_malformed");
              }
              recoveredTemporaryDetail = chatDetailFromApi(wireDetail);
              recoveredTemporarySummary = {
                ...summaryFromDetail(recoveredTemporaryDetail),
                memoryMode: "TEMPORARY",
                memorySourceRevision: memoryState.chat.sourceRevision,
                temporaryRetentionDeadline: memoryState.chat.temporaryRetentionDeadline
              };
            }
          } catch {
            // A remembered hidden chat is optional recovery state. Archived,
            // expired, deleted, or inaccessible targets fall back to a blank workspace.
          }
        }
        const ownedChats = recoveredTemporarySummary
          ? [...nextChats, recoveredTemporarySummary]
          : nextChats;
        useWorkspaceStore.getState().setFolders(body.folders);
        useWorkspaceStore.getState().setChats(sortChatsByFavoriteThenUpdatedAt(ownedChats));
        const nextChatIds = new Set(ownedChats.map((chat) => chat.id));
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

        const activationCatalog = options.catalogOverride ?? useWorkspaceStore.getState().catalog;

        if (targetActiveChatId) {
          const nextActive = ownedChats.find((chat) => chat.id === targetActiveChatId);
          if (nextActive) {
            if (recoveredTemporaryDetail?.id === nextActive.id) {
              cacheChatDetail(recoveredTemporaryDetail);
            }
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
      const response = await shellFetch("/api/chats", {
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
      const initialMemoryMode = sourceSessionKey
        ? composerSessionModeFromKey(sourceSessionKey)
        : "NORMAL";
      const summary: ChatSummary = {
        ...chatSummaryFromApi(apiChat),
        ...(initialMemoryMode === "TEMPORARY"
          ? { pendingInitialMemoryMode: "TEMPORARY" as const }
          : {})
      };
      useWorkspaceStore.getState().upsertChat(summary);

      if (sourceSessionKey) {
        const sourceWasSelected =
          useComposerSessionStore.getState().activeSessionKey === sourceSessionKey;
        useComposerSessionStore
          .getState()
          .transferSession(sourceSessionKey, composerSessionKey(summary.id));
        if (sourceWasSelected && activeChatIdRef.current === null) {
          await activateChat(summary, { preserveControls: true });
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
      const response = await shellFetch(`/api/chats/${chatId}`, {
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
        text: "Stop the running response before archiving this chat."
      });
      return;
    }

    if (!(await confirmDeleteChat(chat))) {
      return;
    }

    try {
      const memoryState = await loadChatMemoryState(chat.id);
      if (memoryState.chat.mode === "TEMPORARY") {
        throw new Error("memory_temporary_chat_forbidden");
      }
      await archiveChatRequest(chat.id, memoryState.chat.sourceRevision);

      const nextActive = useWorkspaceStore.getState().chats.find((candidate) => candidate.id !== chat.id) ?? null;
      useWorkspaceStore.getState().updateChats((current) => current.filter((candidate) => candidate.id !== chat.id));
      useThreadStore.getState().removeThread(chat.id);
      useRunSurfaceStore.getState().removeSurface(chat.id);
      useComposerSessionStore.getState().removeSession(composerSessionKey(chat.id));
      chatDetailRequestsRef.current.delete(chat.id);
      chatMutation.closeActions();
      setNotice({
        kind: "success",
        text: `Archived: ${chat.title}`
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
      const response = await shellFetch(`/api/chats/${chat.id}`, {
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
    setNotice({ kind: "success", text: "Preparing the complete chat export…" });
    try {
      const visible = await loadCompleteActiveBranch(chat.id);
      const summary =
        useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chat.id) ?? chat;
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
      setNotice({ kind: "success", text: "Chat exported" });
    } catch (error) {
      setNotice({
        kind: "error",
        text: `The complete chat could not be exported: ${errorMessage(error)}`
      });
    }
  }

  async function toggleChatFavorite(chat: ChatSummary) {
    try {
      const response = await shellFetch(`/api/chats/${chat.id}`, {
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
    loadCompleteActiveBranch,
    loadEarlierMessages,
    pruneThreadCache,
    reapplyActiveChatDefaults,
    refreshActiveChat,
    refreshWorkspace,
    renameChat,
    setChatKnowledgeDefault,
    toggleChatFavorite,
    updateChatFolder
  };
}
