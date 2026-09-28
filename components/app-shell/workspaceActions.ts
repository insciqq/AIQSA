import { randomUUID } from "@/lib/browser/randomUUID";
import {
  chatDetailFromApi,
  chatSummaryFromApi,
  messageFromApi,
  shellFetch,
  shellReadJson
} from "@/components/app-shell/shellApi";
import { fallbackCatalogModel } from "@/components/app-shell/controlDefaults";
import {
  errorMessage,
  exportFileBaseName,
  nameSaveFailure,
  responseErrorMessage
} from "@/components/app-shell/shellFormatting";
import { chatRouteForChat, chatSendUnderWay, writeChatRoute } from "@/components/app-shell/chatRoute";
import { clearSessionExpiredDraftForSession } from "@/components/app-shell/shellStorage";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  NameSaveResult,
  WorkspaceChatSummary,
  Notice,
  RunEventView,
  ThreadMessage
} from "@/components/app-shell/types";
import { visibleMessagePath } from "@/components/app-shell/threadPath";
import {
  chatDetailBodyFromUnknown,
  chatUpdateFromEvent,
  resolveModelControlDefaults,
  resolvePreferredSearchPlan
} from "@/components/app-shell/powerAppShellData";
import type { SearchPlanMode } from "@/lib/domain/search";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  type KnowledgePlan,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import { chatExportMarkdown } from "@/lib/domain/chatExport";
import { useKnowledgeLibraryStore } from "@/components/app-shell/knowledgeLibraryStore";
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
  projectIdFromComposerSessionKey,
  selectComposerSession,
  type ComposerSessionKey,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import {
  archiveChat as archiveChatRequest,
  loadChatMemoryState,
  resolveChatSource,
  restoreChat as restoreChatRequest
} from "@/components/app-shell/chatLifecycleApi";
import {
  boundComposerAssistant,
  useComposerControlStore,
  type ComposerControlChangeOrigin
} from "@/components/app-shell/composerControlStore";
import {
  composerAssistantFromProjection,
  type ComposerAssistantContext
} from "@/components/app-shell/composerAssistantState";
import {
  cachedChatAssistantProjection,
  useChatAssistantProjectionStore
} from "@/components/app-shell/chatAssistantProjectionStore";
import { useSkillLibraryStore } from "@/components/app-shell/skillLibraryStore";
import type { AssistantIdentity } from "@/lib/contracts/assistants";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { SkillsMode } from "@/lib/contracts/skills";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import {
  emptyThreadHistoryState,
  emptyThreadSnapshot,
  threadHistoryState,
  useThreadStore,
  type ThreadSnapshot
} from "@/components/app-shell/threadStore";
import { sortChatsByFavoriteThenUpdatedAt, useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  chatScopeProjectId,
  mergeWorkspaceProjectDrafts,
  nextChatInScope
} from "@/components/app-shell/workspaceProjectDraftMerge";
import type { WorkspaceChatMutationPort } from "@/components/app-shell/useWorkspaceInteractionController";

type MutableRef<T> = {
  current: T;
};

type ActivateChatOptions = {
  catalogOverride?: Catalog | null;
  preserveControls?: boolean;
  /**
   * With preserved controls, still reads a chat whose Assistant projection
   * is unknown: a Project chat opened by its owner, which applies the
   * Project's values but never an Assistant.
   */
  readAssistant?: boolean;
  resumeRuns?: boolean;
};

/**
 * Opens what replaces a removed active chat inside its scope (`null` for
 * personal): `next`, or the scope's blank chat. The address follows through
 * `replaceState`, so the removal adds no history entry.
 */
export type RemovedChatFallback = (
  scopeProjectId: string | null,
  next: WorkspaceChatSummary | null
) => Promise<unknown> | void;

export type OlderPageLoadOutcome = "failed" | "prepended" | "reset";

export type ChatExportFormat = "json" | "markdown";

/** The per-chat Markdown export document is shared with the server-side archive export. */
export { chatExportMarkdown };

/** A read cannot undo a successful local mutation that settled after dispatch. */
function preserveChangesDuringRead<T extends { id: string }>(
  before: readonly T[],
  current: readonly T[],
  incoming: readonly T[]
): T[] {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.map((item) => item.id));
  return [
    ...incoming.flatMap((item) => {
      const previous = beforeById.get(item.id);
      const latest = currentById.get(item.id);
      if (previous && !latest) return [];
      return [latest && latest !== previous ? latest : item];
    }),
    ...current.filter((item) => !incomingIds.has(item.id) && item !== beforeById.get(item.id))
  ];
}

/**
 * How a chat's Assistant projection is applied in its scope: the ordinary
 * values of the chat without an Assistant, the values an Assistant alone can
 * express return to, and the catalog its rows resolve in.
 */
export type ChatAssistantScope = {
  applyChatDefaults(chat: WorkspaceChatSummary): void;
  clearFallback: { mcpSelection: McpRunSelection; skillsMode: SkillsMode };
  context: ComposerAssistantContext;
  known?(assistantId: string): Readonly<{
    description?: string;
    promptCharacterCount?: number;
    starterPrompts?: string[];
  }>;
};

/**
 * The personal default Assistant of the open blank chat: still loading, or
 * applied; `skipped` when something else decides the blank chat's Assistant
 * (an Assistant entry link, the end of Project access). It stays with that
 * blank chat; the next new chat starts afresh.
 */
export type BlankDefaultAssistant =
  | Readonly<{ assistantId: string; state: "applied" | "loading" }>
  | Readonly<{ state: "skipped" }>;

const SKIPPED_BLANK_ASSISTANT: BlankDefaultAssistant = Object.freeze({ state: "skipped" });

type WorkspaceActionsInput = {
  activeChatIdRef: MutableRef<string | null>;
  applyModelControlDefaults(model?: CatalogModel | null, controlValues?: Record<string, unknown>): void;
  /** Kept across renders; absent together with `chooseDefaultAssistant`. */
  blankDefaultAssistantRef?: MutableRef<BlankDefaultAssistant | null>;
  chatDetailRequestsRef: MutableRef<Map<string, Promise<ChatDetail | null>>>;
  chatHasActiveStream(chatId: string): boolean;
  chatHasPendingThreadMutation?(chatId: string): boolean;
  chatMutation: WorkspaceChatMutationPort;
  /**
   * Chooses the personal default Assistant for the open blank chat as the
   * user would, while `isCurrent` holds; resolves whether it was applied.
   */
  chooseDefaultAssistant?(assistantId: string, isCurrent: () => boolean): Promise<boolean>;
  loadingChatDetailIdRef: MutableRef<string | null>;
  /** The scope of a Project chat's Assistant; null while its Project is not loaded. */
  projectChatAssistantScope?(chat: WorkspaceChatSummary): ChatAssistantScope | null;
  resumeChatRun(chat: WorkspaceChatSummary): void;
  setNotice(notice: Notice | null): void;
  setSelectedModelId(value: string, origin?: ComposerControlChangeOrigin): void;
  setSelectedKnowledgePlan(
    selection: KnowledgePlan | readonly string[],
    source?: "chat" | "explicit" | "off" | "project",
    origin?: ComposerControlChangeOrigin
  ): void;
  setSelectedProvider(value: string, origin?: ComposerControlChangeOrigin): void;
  setSelectedSearchPlan(
    optionIds: readonly string[],
    mode: SearchPlanMode,
    origin?: ComposerControlChangeOrigin
  ): void;
  workspaceRefreshPromiseRef: MutableRef<Promise<ChatDetail | null> | null>;
};

export function useWorkspaceActions({
  activeChatIdRef,
  applyModelControlDefaults,
  blankDefaultAssistantRef,
  chatDetailRequestsRef,
  chatHasActiveStream,
  chatHasPendingThreadMutation = () => false,
  chatMutation,
  chooseDefaultAssistant,
  loadingChatDetailIdRef,
  projectChatAssistantScope,
  resumeChatRun,
  setNotice,
  setSelectedModelId,
  setSelectedKnowledgePlan,
  setSelectedProvider,
  setSelectedSearchPlan,
  workspaceRefreshPromiseRef
}: WorkspaceActionsInput) {
  function summaryFromDetail(detail: ChatDetail): WorkspaceChatSummary {
    return {
      ...(detail.hasContinuationSource ? { hasContinuationSource: true } : {}),
      activeLeafMessageId: detail.activeLeafMessageId,
      createdAt: detail.createdAt,
      defaultKnowledgePlan: detail.defaultKnowledgePlan ?? null,
      ...(detail.defaultSearchPlan ? { defaultSearchPlan: detail.defaultSearchPlan } : {}),
      defaultModelId: detail.defaultModelId,
      defaultProvider: detail.defaultProvider,
      folderId: detail.folderId,
      id: detail.id,
      messageCount: detail.messageCount,
      pinned: detail.pinned,
      projectId: detail.projectId ?? null,
      title: detail.title,
      ...(detail.titlePending ? { titlePending: true } : {}),
      updatedAt: detail.updatedAt,
      workspace: detail.workspace
    };
  }

  function detailFromOwners(summary: WorkspaceChatSummary, thread: ThreadSnapshot): ChatDetail {
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

  /**
   * `assistant` replaces the list row's Assistant after a local change of the
   * chat's binding; otherwise the row keeps the server's projection.
   */
  function mergeChatIntoList(chat: WorkspaceChatSummary, assistant?: AssistantIdentity | null) {
    const currentChat = useWorkspaceStore.getState().chats.find(
      (candidate) => candidate.id === chat.id
    );
    const resolvedChat = { ...currentChat, ...chat };
    useWorkspaceStore.getState().upsertChat(currentChat?.titlePending || chat.titlePending
      ? { ...chat, titlePending: chat.titlePending === true } : chat);
    if (
      useWorkspaceStore.getState().navigationReady &&
      !resolvedChat.projectId &&
      resolvedChat.memoryMode !== "TEMPORARY" &&
      resolvedChat.pendingInitialMemoryMode !== "TEMPORARY"
    ) {
      const existing = useWorkspaceStore.getState().navigationChats.find(
        (candidate) => candidate.id === chat.id
      );
      useWorkspaceStore.getState().upsertNavigationChat({
        activeRun: existing?.activeRun ?? chatHasActiveStream(chat.id),
        assistant: assistant !== undefined ? assistant : existing?.assistant ?? null,
        folderId: resolvedChat.folderId,
        id: resolvedChat.id,
        title: resolvedChat.title,
        updatedAt: resolvedChat.updatedAt
      });
    }
  }

  function markCachedSummaryRevision(chat: WorkspaceChatSummary) {
    if (useThreadStore.getState().threadsByChatId[chat.id]) {
      useThreadStore.getState().mergeMessages(chat.id, [], {
        sourceUpdatedAt: chat.updatedAt
      });
    }
  }

  function cacheChatDetail(
    detail: ChatDetail,
    requestContext?: {
      summary?: WorkspaceChatSummary;
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
    options: { admitMissingPersonalSummary?: boolean; force?: boolean; signal?: AbortSignal; onUnavailable?(): void } = {}
  ): Promise<ChatDetail | null> {
    if (options.signal?.aborted) return Promise.resolve(null);
    const pending = chatDetailRequestsRef.current.get(chatId);
    if (pending) {
      return options.force
        ? pending.then(() => fetchChatDetail(chatId, {
            ...options, force: false
          }))
        : pending;
    }

    const requestBase = useThreadStore.getState().threadsByChatId[chatId];
    const requestSummary = useWorkspaceStore
      .getState()
      .chats.find((candidate) => candidate.id === chatId);
    const request = (async () => {
      try {
        const { response, body } = await shellReadJson(`/api/chats/${chatId}`, options.signal);
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) options.onUnavailable?.();
          throw new Error(`chat_detail_failed_${response.status}`);
        }

        const chat = chatDetailBodyFromUnknown(body);
        if (options.signal?.aborted) return null;
        if (!chat || chat.id !== chatId) {
          throw new Error("chat_detail_malformed");
        }

        const summaryKnown = useWorkspaceStore.getState().chats.some(
          (candidate) => candidate.id === chatId
        );
        if (
          !summaryKnown &&
          (!options.admitMissingPersonalSummary || chat.projectId !== null)
        ) {
          return null;
        }
        useChatAssistantProjectionStore.getState().setProjection(chatId, chat.assistant);

        return cacheChatDetail(chatDetailFromApi(chat), {
          summary: requestSummary,
          thread: requestBase
        });
      } catch (error) {
        const message = errorMessage(error);
        if (!options.signal?.aborted && loadingChatDetailIdRef.current === chatId && activeChatIdRef.current === chatId) {
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

  /** Chats whose composer still owns a send, an edit or an upload in flight. */
  function pendingComposerChatIds(): Set<string> {
    const pendingChatIds = new Set<string>();
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
        pendingChatIds.add(sessionChatId);
      }
    }
    return pendingChatIds;
  }

  function protectedThreadChatIds(): Set<string> {
    const protectedChatIds = new Set([
      ...chatDetailRequestsRef.current.keys(),
      ...pendingComposerChatIds()
    ]);
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

  function personalChatAssistantScope(catalog: Catalog | null | undefined): ChatAssistantScope {
    return {
      applyChatDefaults: (chat) => applyOrdinaryChatDefaults(chat, catalog),
      clearFallback: {
        mcpSelection: { mode: catalog?.defaults.mcpMode ?? "auto" },
        skillsMode: catalog?.defaults.skillsMode ?? "auto"
      },
      context: {
        controlDefaults: (model) => resolveModelControlDefaults(model, catalog?.defaults.controlValues),
        models: catalog?.models ?? [],
        skill: (skillId) => useSkillLibraryStore.getState().data?.skills.find((skill) => skill.id === skillId) ?? null
      }
    };
  }

  /**
   * Applies the chat's Assistant as the server last projected it. A chat
   * without a binding, or one not read yet, has no Assistant; unavailable and
   * deleted bindings stay visible so the user chooses what happens next.
   */
  function applyChatAssistant(
    chat: WorkspaceChatSummary,
    catalogOverride: Catalog | null | undefined = useWorkspaceStore.getState().catalog
  ) {
    const scope = chatScopeProjectId(chat) === null
      ? personalChatAssistantScope(catalogOverride)
      : projectChatAssistantScope?.(chat) ?? null;
    if (!scope) return;
    const projection = cachedChatAssistantProjection(chat.id);
    if (projection?.state === "bound") {
      useComposerControlStore.getState().applyAssistantState(composerAssistantFromProjection(
        projection,
        scope.context,
        scope.known?.(projection.id)
      ));
      return;
    }
    const current = useComposerControlStore.getState().assistant;
    if (current?.state === "bound") scope.applyChatDefaults(chat);
    if (current) useComposerControlStore.getState().clearAssistant(scope.clearFallback);
    // An unavailable binding keeps its reason (archived by its owner).
    if (projection) useComposerControlStore.getState().applyAssistantState({ assistant: { ...projection }, controls: {} });
  }

  function applyChatDefaults(chat: WorkspaceChatSummary, catalogOverride: Catalog | null | undefined = useWorkspaceStore.getState().catalog) {
    applyOrdinaryChatDefaults(chat, catalogOverride);
    applyChatAssistant(chat, catalogOverride);
  }

  function applyOrdinaryChatDefaults(
    chat: WorkspaceChatSummary,
    catalogOverride: Catalog | null | undefined = useWorkspaceStore.getState().catalog
  ) {
    const model = fallbackCatalogModel(catalogOverride ?? null, {
      modelId: chat.defaultModelId,
      provider: chat.defaultProvider
    });

    setSelectedProvider(model?.provider ?? chat.defaultProvider, "system");
    setSelectedModelId(model?.modelId ?? chat.defaultModelId, "system");
    const searchPlan = chat.defaultSearchPlan ?? resolvePreferredSearchPlan(
      catalogOverride?.defaults.searchPlan,
      catalogOverride?.searchStrategies
    );
    setSelectedSearchPlan(searchPlan.optionIds, searchPlan.mode, "system");
    const folderDefault = chat.folderId
      ? useWorkspaceStore.getState().folders.find((folder) => folder.id === chat.folderId)
          ?.defaultKnowledgePlan ?? null
      : null;
    const knowledgePlan = chat.defaultKnowledgePlan ?? folderDefault;
    setSelectedKnowledgePlan(
      knowledgePlan ?? EMPTY_KNOWLEDGE_SELECTION,
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
    // The Project owner applies a Project chat's controls; the personal
    // catalog never replaces them.
    if (!activeChat || chatScopeProjectId(activeChat) !== null) {
      return false;
    }

    applyChatDefaults(activeChat, catalogOverride);
    return true;
  }

  function applyActiveChat(chat: WorkspaceChatSummary, options: ActivateChatOptions = {}) {
    activeChatIdRef.current = chat.id;
    useWorkspaceStore.getState().setPendingChatFolderId(null);
    useWorkspaceStore.getState().setActiveChatId(chat.id);
    useThreadStore.getState().touchThread(chat.id);
    pruneThreadCache();
    const sessionStore = useComposerSessionStore.getState();
    const sessionKey = composerSessionKey(chat.id);
    sessionStore.activateSession(sessionKey);
    writeChatRoute(chatRouteForChat(chat, chatSendUnderWay(chat.id)));
    if (chat.workspace) {
      useComposerSessionStore.getState().updateSession(sessionKey, {
        workspaceEnabled: chat.workspace.enabled
      });
    }
    if (!options.preserveControls) {
      applyChatDefaults(chat, options.catalogOverride);
    }
    if (options.resumeRuns !== false) {
      void resumeChatRun(chat);
    }
  }

  async function activateChat(chat: WorkspaceChatSummary, options: ActivateChatOptions = {}) {
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
    // A chat's Assistant is restored from the server projection, never from
    // browser state; a chat opened with its own controls not read in this
    // session reads it once. Preserved controls already hold the Assistant,
    // unless the caller asks for it (`readAssistant`).
    const projectionUnknown = cachedChatAssistantProjection(chat.id) === undefined &&
      !chat.pendingPersonalDraft && !chat.pendingProjectDraft &&
      (!options.preserveControls || Boolean(options.readAssistant));
    const needsDetail =
      projectionUnknown ||
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
    // The fresh projection replaces what the cache knew when the chat opened.
    // A Project chat's owner applies its Project values first.
    if (!options.preserveControls || options.readAssistant || chatScopeProjectId(currentSummary) !== null) {
      applyChatAssistant(currentSummary, options.catalogOverride ?? undefined);
    }
    return detail;
  }

  /**
   * Re-reads a chat after a change of its Assistant and applies the new
   * projection while the chat is still open and `isCurrent` holds.
   */
  async function refreshChatAssistant(chatId: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    const detail = await fetchChatDetail(chatId, { force: true });
    if (!detail) return false;
    if (activeChatIdRef.current === chatId && isCurrent()) {
      const summary = useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chatId) ??
        summaryFromDetail(detail);
      applyChatAssistant(summary);
    }
    return true;
  }

  async function activatePersonalChatById(chatId: string): Promise<ChatDetail | null> {
    const existing = useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId);
    if (existing?.projectId) {
      return null;
    }
    if (existing) {
      return activateChat(existing);
    }

    const detail = await fetchChatDetail(chatId, {
      admitMissingPersonalSummary: true,
      force: true
    });
    if (!detail || detail.projectId) {
      return null;
    }
    const summary = useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId);
    return summary ? activateChat(summary) : null;
  }

  /**
   * The pending folder of a personal blank chat stays browser state; a
   * Project's blank chat is addressed by its Project.
   */
  function activateBlankWorkspace(
    folderId: string | null = null,
    memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY" = "NORMAL",
    routeProjectId: string | null = null
  ) {
    // A chat's Assistant stays with that chat; an Assistant chosen for the
    // blank chat stays while the blank chat does.
    const leavingChat = activeChatIdRef.current !== null;
    activeChatIdRef.current = null;
    loadingChatDetailIdRef.current = null;
    useWorkspaceStore.getState().setPendingChatFolderId(folderId);
    useWorkspaceStore.getState().setActiveChatDetailError(null);
    useWorkspaceStore.getState().setActiveChatDetailLoading(false);
    useWorkspaceStore.getState().setActiveChatId(null);
    writeChatRoute({ chatId: null, projectId: routeProjectId });
    useComposerSessionStore.getState().activateSession(
      composerSessionKey(null, folderId, memoryMode)
    );
    const personalCatalog = useWorkspaceStore.getState().catalog;
    if (personalCatalog) {
      useComposerSessionStore.getState().applyWorkspaceDefault(
        composerSessionKey(null, folderId, memoryMode),
        personalCatalog.defaults.workspaceEnabled ?? false
      );
    }
    pruneThreadCache();
    if (leavingChat || !useComposerControlStore.getState().assistant) {
      applyPersonalBlankDefaults(folderId);
    }
    if (routeProjectId === null) reconcileBlankDefaultAssistant(leavingChat);
  }

  /**
   * A new personal chat starts with the personal default Assistant as if the
   * user had chosen it. Temporary and Project chats never use it; after
   * "Remove for this chat" the blank chat stays without it until the next
   * new chat. Call it whenever the open blank chat changes its mode.
   */
  function reconcileBlankDefaultAssistant(newChat = false) {
    if (!blankDefaultAssistantRef || !chooseDefaultAssistant) return;
    if (newChat) blankDefaultAssistantRef.current = null;
    const sessionKey = useComposerSessionStore.getState().activeSessionKey;
    if (
      activeChatIdRef.current !== null ||
      chatIdFromComposerSessionKey(sessionKey) !== null ||
      projectIdFromComposerSessionKey(sessionKey) !== null
    ) return;
    const mark = blankDefaultAssistantRef.current;
    if (mark?.state === "skipped") return;
    const bound = boundComposerAssistant(useComposerControlStore.getState());
    if (composerSessionModeFromKey(sessionKey) === "TEMPORARY") {
      if (mark?.state === "loading") blankDefaultAssistantRef.current = null;
      if (mark?.state === "applied" && bound?.id === mark.assistantId) {
        blankDefaultAssistantRef.current = null;
        applyPersonalBlankDefaults(folderIdFromComposerSessionKey(sessionKey));
      }
      return;
    }
    const assistantId = useWorkspaceStore.getState().catalog?.defaults.assistantId ?? null;
    if (mark && mark.assistantId !== assistantId) {
      // The setting changed since this blank chat took the previous default.
      blankDefaultAssistantRef.current = null;
      if (bound?.id === mark.assistantId) applyPersonalBlankDefaults(folderIdFromComposerSessionKey(sessionKey));
    }
    if (blankDefaultAssistantRef.current || useComposerControlStore.getState().assistant || !assistantId) return;
    const loading: BlankDefaultAssistant = { assistantId, state: "loading" };
    blankDefaultAssistantRef.current = loading;
    const isCurrent = () => blankDefaultAssistantRef.current === loading &&
      activeChatIdRef.current === null &&
      useComposerSessionStore.getState().activeSessionKey === sessionKey &&
      useComposerControlStore.getState().assistant === null;
    void chooseDefaultAssistant(assistantId, isCurrent).then((applied) => {
      if (blankDefaultAssistantRef.current !== loading) return;
      const kept = applied || boundComposerAssistant(useComposerControlStore.getState())?.id === assistantId;
      blankDefaultAssistantRef.current = kept ? { assistantId, state: "applied" } : null;
    });
  }

  /**
   * Something else decides the open personal blank chat's Assistant (an
   * Assistant entry link, whether it resolves or not; the end of Project
   * access): the personal default stops loading and does not come back for
   * this blank chat.
   */
  function skipBlankDefaultAssistant() {
    if (blankDefaultAssistantRef) blankDefaultAssistantRef.current = SKIPPED_BLANK_ASSISTANT;
  }

  /** Personal Chat defaults of a new chat, without an Assistant. */
  function applyPersonalBlankDefaults(folderId: string | null = useWorkspaceStore.getState().pendingChatFolderId) {
    const catalog = useWorkspaceStore.getState().catalog;
    useComposerControlStore.getState().clearAssistant({
      mcpSelection: { mode: catalog?.defaults.mcpMode ?? "auto" },
      skillsMode: catalog?.defaults.skillsMode ?? "auto"
    });
    const defaultModel = catalog?.models.find(
      (candidate) =>
        candidate.provider === catalog.defaults.provider &&
        candidate.modelId === catalog.defaults.modelId
    );
    setSelectedProvider(defaultModel?.provider ?? "", "system");
    setSelectedModelId(defaultModel?.modelId ?? "", "system");
    applyModelControlDefaults(defaultModel, catalog?.defaults.controlValues);
    const searchPlan = resolvePreferredSearchPlan(catalog?.defaults.searchPlan, catalog?.searchStrategies);
    setSelectedSearchPlan(searchPlan.optionIds, searchPlan.mode, "system");
    const projectPlan = folderId
      ? useWorkspaceStore.getState().folders.find((folder) => folder.id === folderId)
          ?.defaultKnowledgePlan ?? null
      : null;
    // Personal Chat defaults start a new chat; a
    // folder default still wins for Knowledge. Admission re-checks both.
    const personalPlan = projectPlan
      ? null
      : reconcilePersonalKnowledgeDefault(catalog?.defaults.knowledgePlan ?? null);
    setSelectedKnowledgePlan(
      projectPlan ?? personalPlan ?? EMPTY_KNOWLEDGE_SELECTION,
      projectPlan ? "project" : personalPlan ? "explicit" : "off",
      "system"
    );
    useComposerControlStore.getState().setMcpSelection({
      mode: catalog?.defaults.mcpMode ?? "auto"
    }, "system");
    useComposerControlStore.getState().setSkillsMode(catalog?.defaults.skillsMode ?? "auto", "system");
  }

  /**
   * Drops bases the user can no longer reach from the personal Knowledge
   * default and says so; the default is never substituted silently. Unloaded
   * Knowledge keeps the plan as saved and admission fails closed instead.
   */
  function reconcilePersonalKnowledgeDefault(
    plan: KnowledgeSelection | null
  ): KnowledgeSelection | null {
    if (!plan || plan.mode !== "explicit") return plan;
    const known = useKnowledgeLibraryStore.getState().data?.knowledgeBases;
    if (!known) return plan;
    const available = new Set(known.filter((base) => !base.archived).map((base) => base.id));
    const baseIds = plan.baseIds.filter((id) => available.has(id));
    if (baseIds.length === plan.baseIds.length) return plan;
    setNotice({
      autoDismiss: true,
      kind: "error",
      text: "A default knowledge base is no longer available. This chat starts without it."
    });
    return baseIds.length > 0 || plan.sourceIds.length > 0
      ? explicitKnowledgeSelection({ baseIds, sourceIds: plan.sourceIds })
      : null;
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
      mergeChatIntoList(chat);
      const folderPlan = chat.folderId
        ? useWorkspaceStore.getState().folders.find((folder) => folder.id === chat.folderId)
            ?.defaultKnowledgePlan ?? null
        : null;
      const effective = chat.defaultKnowledgePlan ?? folderPlan;
      if (activeChatIdRef.current === chatId) {
        setSelectedKnowledgePlan(
          effective ?? EMPTY_KNOWLEDGE_SELECTION,
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
      signal?: AbortSignal;
      onUnavailable?(): void;
    } = {}
  ) {
    if (!chatId) {
      return null;
    }

    const detail = await fetchChatDetail(chatId, { force: options.forceDetail, signal: options.signal, onUnavailable: options.onUnavailable });
    if (!detail || options.signal?.aborted) {
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

  /**
   * Reloads the personal workspace and activates `nextActiveChatId`, falling
   * back to the blank chat. `isCurrent` lets an address resolution drop a
   * result that another navigation superseded; `onTargetUnavailable` reports
   * a target that is neither listed nor a recoverable Temporary chat, with
   * the Project of a readable Project chat and `null` for any other target.
   */
  function refreshWorkspace(
    nextActiveChatId: string | null = useWorkspaceStore.getState().activeChatId,
    options: {
      catalogOverride?: Catalog | null;
      isCurrent?(): boolean;
      onTargetUnavailable?(projectId: string | null): void;
      preserveControls?: boolean;
      resumeRuns?: boolean;
    } = {}
  ): Promise<ChatDetail | null> {
    if (workspaceRefreshPromiseRef.current) {
      return workspaceRefreshPromiseRef.current;
    }

    const before = useWorkspaceStore.getState();
    const sourceSessionKey = useComposerSessionStore.getState().activeSessionKey;
    const wasReady = before.workspaceReady;
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
        const targetActiveChatId = nextActiveChatId;
        let recoveredTemporaryDetail: ChatDetail | null = null;
        let recoveredTemporarySummary: WorkspaceChatSummary | null = null;
        let targetProjectId: string | null = null;
        // A Project chat its owner already admitted needs no classification.
        const knownProjectTarget = useWorkspaceStore.getState().chats.some((chat) =>
          chat.id === targetActiveChatId && chatScopeProjectId(chat) !== null);
        if (
          targetActiveChatId &&
          !knownProjectTarget &&
          !nextChats.some((chat) => chat.id === targetActiveChatId)
        ) {
          try {
            // One detail read separates a readable Project chat, which is never
            // admitted here, from a hidden personal one.
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
            if (wireDetail.projectId) {
              targetProjectId = wireDetail.projectId;
            } else {
              const memoryState = await loadChatMemoryState(targetActiveChatId);
              if (memoryState.mode === "TEMPORARY" && !memoryState.archived) {
                recoveredTemporaryDetail = chatDetailFromApi(wireDetail);
                useChatAssistantProjectionStore.getState().setProjection(wireDetail.id, wireDetail.assistant);
                recoveredTemporarySummary = {
                  ...summaryFromDetail(recoveredTemporaryDetail),
                  memoryMode: "TEMPORARY",
                  temporaryRetentionDeadline: memoryState.temporaryRetentionDeadline
                };
              }
            }
          } catch {
            // Archived, expired, deleted, or inaccessible hidden targets fall
            // back to a blank workspace like any unknown chat.
          }
        }
        const ownedChats = recoveredTemporarySummary
          ? [...nextChats, recoveredTemporarySummary]
          : nextChats;
        const current = useWorkspaceStore.getState();
        const selectionChanged = current.activeChatId !== before.activeChatId ||
          useComposerSessionStore.getState().activeSessionKey !== sourceSessionKey;
        const mergedChats = mergeWorkspaceProjectDrafts({
          currentChats: current.chats,
          incomingChats: preserveChangesDuringRead(before.chats, current.chats, ownedChats)
        }).chats;
        const mergedFolders = preserveChangesDuringRead(before.folders, current.folders, body.folders);
        useWorkspaceStore.getState().setFolders(mergedFolders);
        useWorkspaceStore.getState().setChats(mergedChats);
        // Only chats this personal read removed lose their composer and
        // thread: Project chats stay in `mergedChats`, and a send, edit or
        // upload in flight keeps its session until it settles.
        const nextChatIds = new Set(mergedChats.map((chat) => chat.id));
        const nextFolderIds = new Set(mergedFolders.map((folder) => folder.id));
        const pendingChatIds = pendingComposerChatIds();
        const retainedChatId = (chatId: string) =>
          nextChatIds.has(chatId) || pendingChatIds.has(chatId) || chatHasActiveStream(chatId);
        const composerSessionKeys = Object.keys(
          useComposerSessionStore.getState().sessionsByKey
        ) as ComposerSessionKey[];
        for (const sessionKey of composerSessionKeys) {
          const sessionChatId = chatIdFromComposerSessionKey(sessionKey);
          // Project blank folders are not personal folders.
          const sessionFolderId = projectIdFromComposerSessionKey(sessionKey) === null
            ? folderIdFromComposerSessionKey(sessionKey)
            : null;
          if (sessionChatId) {
            if (!retainedChatId(sessionChatId)) {
              useComposerSessionStore.getState().removeSession(sessionKey);
            }
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
          if (!retainedChatId(cachedChatId)) {
            useThreadStore.getState().removeThread(cachedChatId);
            useRunSurfaceStore.getState().removeSurface(cachedChatId);
          }
        }
        useWorkspaceStore.getState().setWorkspaceError(null);
        useWorkspaceStore.getState().setWorkspaceReady(true);

        if (selectionChanged || options.isCurrent?.() === false) return null;

        const activationCatalog = options.catalogOverride ?? useWorkspaceStore.getState().catalog;

        if (targetActiveChatId) {
          const nextActive = mergedChats.find((chat) => chat.id === targetActiveChatId);
          if (nextActive) {
            if (recoveredTemporaryDetail?.id === nextActive.id) {
              cacheChatDetail(recoveredTemporaryDetail);
            }
            return await activateChat(nextActive, {
              catalogOverride: activationCatalog,
              // A Project chat keeps the controls its Project owner applied.
              preserveControls: options.preserveControls || chatScopeProjectId(nextActive) !== null,
              resumeRuns: options.resumeRuns
            });
          }
          options.onTargetUnavailable?.(targetProjectId);
        } else if (
          projectIdFromComposerSessionKey(useComposerSessionStore.getState().activeSessionKey) !== null
        ) {
          // A personal read leaves an open Project's blank chat to its owner.
          return null;
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
      const initialMemoryMode = sourceSessionKey
        ? composerSessionModeFromKey(sourceSessionKey)
        : "NORMAL";
      const response = await shellFetch("/api/chats", {
        body: JSON.stringify({
          folderId,
          ...(initialMemoryMode === "EXCLUDED" ? { memoryMode: "EXCLUDED" } : {}),
          ...(sourceSessionKey
            ? {
                workspaceEnabled: selectComposerSession(
                  useComposerSessionStore.getState(),
                  sourceSessionKey
                ).workspaceEnabled
              }
            : {})
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
      const summary: WorkspaceChatSummary = {
        ...chatSummaryFromApi(apiChat),
        ...(initialMemoryMode === "EXCLUDED"
          ? { memoryMode: "EXCLUDED" as const, memorySourceRevision: 0 }
          : {}),
        ...(initialMemoryMode === "TEMPORARY"
          ? { pendingInitialMemoryMode: "TEMPORARY" as const }
          : {})
      };
      mergeChatIntoList(summary);
      // The server created the chat without an Assistant.
      useChatAssistantProjectionStore.getState().setProjection(summary.id, null);

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

  async function createPersonalChatForSend(
    folderId: string | null = null,
    sourceSessionKey?: ComposerSessionKey
  ): Promise<WorkspaceChatSummary | null> {
    if (!sourceSessionKey) return null;
    useWorkspaceStore.getState().setCreatingChat(true);
    try {
      const session = selectComposerSession(
        useComposerSessionStore.getState(),
        sourceSessionKey
      );
      const controls = useComposerControlStore.getState();
      const memoryMode = composerSessionModeFromKey(sourceSessionKey);
      const now = new Date().toISOString();
      const summary: WorkspaceChatSummary = {
        activeLeafMessageId: null,
        createdAt: now,
        defaultKnowledgePlan: null,
        defaultModelId: controls.selectedModelId,
        defaultProvider: controls.selectedProvider,
        folderId,
        id: randomUUID(),
        memoryMode,
        messageCount: 0,
        pendingPersonalDraft: { folderId, memoryMode },
        ...(memoryMode === "TEMPORARY"
          ? { pendingInitialMemoryMode: "TEMPORARY" as const }
          : {}),
        pinned: false,
        projectId: null,
        title: "New Chat",
        updatedAt: now
      };
      if (!useComposerSessionStore.getState().transferSession(
        sourceSessionKey,
        composerSessionKey(summary.id)
      )) {
        return null;
      }
      // The transferred session owns the blank Workspace intent; keeping the
      // wire-only workspace projection absent avoids inventing availability.
      useComposerSessionStore.getState().updateSession(composerSessionKey(summary.id), {
        workspaceEnabled: session.workspaceEnabled
      });
      // The row shows the Assistant the first message names.
      const assistant = boundComposerAssistant(controls);
      mergeChatIntoList(summary, assistant?.availability.ok
        ? { avatar: assistant.avatar, name: assistant.name }
        : null);
      await activateChat(summary, { preserveControls: true, resumeRuns: false });
      return summary;
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
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
      mergeChatIntoList(chat);
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

  async function deleteChat(
    chat: WorkspaceChatSummary,
    activateFallback: RemovedChatFallback = activatePersonalFallback
  ) {
    if (chatHasActiveStream(chat.id)) {
      setNotice({
        kind: "error",
        text: "Stop the running response before archiving this chat."
      });
      return;
    }

    try {
      const memoryState = await loadChatMemoryState(chat.id);
      if (memoryState.mode === "TEMPORARY") {
        throw new Error("memory_temporary_chat_forbidden");
      }
      const source = await resolveChatSource(chat.id);
      const archived = await archiveChatRequest(chat.id, source.source.sourceRevision);

      const scopeProjectId = chatScopeProjectId(chat);
      const nextActive = nextChatInScope(useWorkspaceStore.getState().chats, chat.id, scopeProjectId);
      // Undo brings the row back with the Assistant it showed.
      const listedAssistant = useWorkspaceStore.getState().navigationChats
        .find((candidate) => candidate.id === chat.id)?.assistant ?? null;
      useWorkspaceStore.getState().updateChats((current) => current.filter((candidate) => candidate.id !== chat.id));
      useWorkspaceStore.getState().removeNavigationChat(chat.id);
      useThreadStore.getState().removeThread(chat.id);
      useRunSurfaceStore.getState().removeSurface(chat.id);
      useComposerSessionStore.getState().removeSession(composerSessionKey(chat.id));
      useChatAssistantProjectionStore.getState().forget(chat.id);
      chatDetailRequestsRef.current.delete(chat.id);
      setNotice({
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                const restored = await restoreChatRequest(
                  chat.id,
                  archived.chat.sourceRevision
                );
                const restoredChat: WorkspaceChatSummary = {
                  ...chat,
                  memoryMode: restored.chat.memoryMode,
                  memorySourceRevision: restored.chat.sourceRevision,
                  updatedAt: restored.chat.updatedAt
                };
                useWorkspaceStore.getState().upsertChat(restoredChat);
                useWorkspaceStore.getState().upsertNavigationChat({
                  activeRun: false,
                  assistant: listedAssistant,
                  folderId: restoredChat.folderId,
                  id: restoredChat.id,
                  title: restoredChat.title,
                  updatedAt: restoredChat.updatedAt
                });
                setNotice({ kind: "success", text: "Chat restored" });
              } catch (error) {
                setNotice({ kind: "error", text: errorMessage(error) });
              }
            })();
          }
        },
        kind: "success",
        text: "Chat moved to archive"
      });

      if (activeChatIdRef.current === chat.id) {
        await activateFallback(scopeProjectId, nextActive);
      }
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  /**
   * Without a Project owner a removed chat falls back within the personal
   * scope; a Project chat falls back to the personal blank chat.
   */
  async function activatePersonalFallback(
    scopeProjectId: string | null,
    next: WorkspaceChatSummary | null
  ) {
    if (scopeProjectId === null && next) await activateChat(next);
    else activateBlankWorkspace();
  }

  async function renameChat(chat: WorkspaceChatSummary): Promise<NameSaveResult> {
    const title = chatMutation.editingTitle.trim();
    if (!title) {
      return { fieldError: null, ok: false };
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
        const failure = await nameSaveFailure(response, `chat_rename_failed_${response.status}`);
        if (failure.fieldError) return { fieldError: failure.fieldError, ok: false };
        throw new Error(failure.message);
      }

      const apiChat = decodeChatSummaryResponse(await response.json());
      if (!apiChat || apiChat.id !== chat.id) {
        throw new Error("chat_rename_malformed");
      }
      const updated = chatSummaryFromApi(apiChat);
      markCachedSummaryRevision(updated);
      mergeChatIntoList(updated);
      chatMutation.finishEditing();
      setNotice(null);
      return { ok: true };
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
      return { fieldError: null, ok: false };
    }
  }

  async function exportChat(chat: WorkspaceChatSummary, format: ChatExportFormat = "markdown") {
    setNotice({ kind: "success", text: "Preparing the complete chat export…" });
    try {
      const visible = await loadCompleteActiveBranch(chat.id);
      const summary =
        useWorkspaceStore.getState().chats.find((candidate) => candidate.id === chat.id) ?? chat;
      const baseName = exportFileBaseName(summary.title);
      let blob: Blob;
      let fileName: string;
      if (format === "json") {
        const payload = {
          defaultModelId: summary.defaultModelId,
          defaultProvider: summary.defaultProvider,
          exportedAt: new Date().toISOString(),
          messages: visible.map((message) => ({
            ...(message.followups?.entries.length ? { followups: message.followups.entries } : {}),
            content: message.content,
            modelId: message.modelId ?? null,
            provider: message.provider ?? null,
            role: message.role,
            status: message.status
          })),
          title: summary.title
        };
        blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json"
        });
        fileName = `${baseName}.json`;
      } else {
        blob = new Blob([chatExportMarkdown(summary.title, visible)], {
          type: "text/markdown"
        });
        fileName = `${baseName}.md`;
      }
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(href);
      setNotice({ kind: "success", text: "Chat exported" });
    } catch (error) {
      setNotice({
        kind: "error",
        text: `The complete chat could not be exported: ${errorMessage(error)}`
      });
    }
  }

  async function toggleChatFavorite(chat: WorkspaceChatSummary) {
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
      mergeChatIntoList(updated);
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    }
  }

  return {
    openContinuedChat: async (chat: ChatDetail, sourceKey = useComposerSessionStore.getState().activeSessionKey) => {
      if (activeChatIdRef.current !== chatIdFromComposerSessionKey(sourceKey)) return false;
      mergeChatIntoList(chat);
      cacheChatDetail(chat);
      const opened = await activateChat(chat, { preserveControls: true });
      if (!opened || activeChatIdRef.current !== chat.id || useWorkspaceStore.getState().activeChatId !== chat.id) return false;
      if (useComposerSessionStore.getState().moveUnsentInputIfTargetEmpty(sourceKey, composerSessionKey(chat.id))) {
        clearSessionExpiredDraftForSession(sourceKey);
      }
      return true;
    },
    activateBlankWorkspace,
    activateChat,
    activatePersonalChatById,
    applyChatAssistant,
    applyChatUpdate,
    applyPersonalBlankDefaults,
    createChat,
    createPersonalChatForSend,
    deleteChat,
    exportChat,
    fetchChatDetail,
    loadCompleteActiveBranch,
    loadEarlierMessages,
    pruneThreadCache,
    reapplyActiveChatDefaults,
    reconcileBlankDefaultAssistant: () => reconcileBlankDefaultAssistant(),
    refreshActiveChat,
    refreshChatAssistant,
    refreshWorkspace,
    renameChat,
    skipBlankDefaultAssistant,
    setChatKnowledgeDefault,
    toggleChatFavorite,
    updateChatFolder
  };
}
