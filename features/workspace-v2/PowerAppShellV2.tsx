"use client";

import { unsupportedAttachmentMessage } from "@/components/app-shell/attachmentCapabilities";
import {
  attachmentCountSelectionLimitMessage,
  withAttachmentLimitFeedbackMessage,
  withoutAttachmentLimitFeedbackMessage
} from "@/components/app-shell/attachmentLimitUsage";
import { reconcileCurrentComposerAttachments } from "@/components/app-shell/attachmentReconciliation";
import {
  useComposerControlStore,
  type ComposerControlSnapshot
} from "@/components/app-shell/composerControlStore";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  composerSessionModeFromKey,
  folderIdFromComposerSessionKey,
  selectActiveComposerSession,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import { createFolderActions } from "@/components/app-shell/folderActions";
import { useMessageRunActions } from "@/components/app-shell/messageRunActions";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { navigateMemorySource } from "@/components/app-shell/memorySourceNavigation";
import {
  activateMemoryHistorySearchAccount,
  deactivateMemoryHistorySearchAccount
} from "@/components/app-shell/memoryHistorySearchStore";
import {
  deactivateMemorySettings,
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { PowerAppShellV2View } from "@/features/workspace-v2/PowerAppShellV2View";
import type {
  ShellComposerView,
  ShellBranchesView,
  ShellOverlaysView,
  ShellSessionView,
  ShellSettingsView,
  ShellThreadView,
  ShellWorkspacePaneView,
  ShellWorkspaceView
} from "@/components/app-shell/powerAppShellV2Contracts";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions,
  readRecentAssistantIds
} from "@/components/app-shell/assistantLibraryController";
import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import {
  buildKnowledgeLibraryView,
  createKnowledgeLibraryActions
} from "@/components/app-shell/knowledgeLibraryController";
import { useKnowledgeLibraryStore } from "@/components/app-shell/knowledgeLibraryStore";
import { useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import {
  consumeMcpOAuthReturn,
  deactivateMcpSettings,
  refreshMcpSettings
} from "@/components/app-shell/mcpSettingsStore";
import { deactivateMemoryManager } from "@/components/app-shell/memoryManagerStore";
import { useRunControlsActions } from "@/components/app-shell/runControlsActions";
import {
  abortActiveStreamControllers,
  useRunLifecycleActions
} from "@/components/app-shell/runLifecycleActions";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import {
  selectRunSurface,
  useRunSurfaceStore
} from "@/components/app-shell/runSurfaceStore";
import {
  normalizeThreadStatus,
  sessionExpiredLoginHref,
  shellFetch,
  subscribeToSessionExpired
} from "@/components/app-shell/shellApi";
import { errorMessage, responseErrorMessage } from "@/components/app-shell/shellFormatting";
import {
  clearSessionExpiredDraft,
  rememberSessionExpiredDraft,
  storedSessionExpiredDraft
} from "@/components/app-shell/shellStorage";
import type { SettingsMutationCoordinator } from "@/components/app-shell/settingsMutationCoordinator";
import {
  createThreadActions,
  type BranchCheckoutSettlement
} from "@/components/app-shell/threadActions";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import { useAnswerNotification } from "@/components/app-shell/useAnswerNotification";
import { useCommandPaletteActions } from "@/components/app-shell/useCommandPaletteActions";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { usePinnedScroll } from "@/components/app-shell/usePinnedScroll";
import { usePowerAppShellViewModel } from "@/components/app-shell/usePowerAppShellViewModel";
import { useRunStreaming } from "@/components/app-shell/useRunStreaming";
import { useShellAppearanceController } from "@/components/app-shell/useShellAppearanceController";
import { useShellOverlayController } from "@/components/app-shell/useShellOverlayController";
import { useShellUiActions } from "@/components/app-shell/useShellUiActions";
import { useWorkspaceInteractionController } from "@/components/app-shell/useWorkspaceInteractionController";
import { useWorkspaceActions } from "@/components/app-shell/workspaceActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  deactivateArchivedChats,
  openArchivedChats,
  openArchivedChatPreview,
  removePermanentlyDeletedArchivedChat,
  useArchivedChatsStore
} from "@/components/app-shell/archivedChatsStore";
import {
  activatePermanentChatDeletionAccount,
  deactivatePermanentChatDeletionAccount,
  openPermanentChatDeletion
} from "@/components/app-shell/permanentChatDeletionStore";
import { loadPermanentChatDeletionSnapshot } from "@/components/app-shell/permanentChatDeletionApi";
import {
  loadChatMemoryState,
  patchChatMemoryMode,
  resolveChatSource
} from "@/components/app-shell/chatLifecycleApi";
import {
  selectThreadRenderActiveLeafId,
  selectThreadSnapshot,
  selectThreadVisibleMessages,
  threadHistoryState,
  useThreadStore
} from "@/components/app-shell/threadStore";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  WorkspaceChatSummary,
  Notice,
  ThreadMessage
} from "@/components/app-shell/types";
import { decodeCatalogResponse } from "@/lib/contracts/catalog";
import {
  decodeChatBranchesResponse,
  type ChatBranchGraphWire
} from "@/lib/contracts/chats";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  resolveModelControlDefaults,
  resolvePreferredSearchPlan,
  type SavedControlDraft
} from "@/components/app-shell/powerAppShellData";

export function workspaceDefaultControlsFingerprint(state: ComposerControlSnapshot): string {
  return JSON.stringify({
    backgroundMode: state.backgroundMode,
    maxOutputTokens: state.maxOutputTokens,
    knowledgePlanSource: state.knowledgePlanSource,
    reasoningEffort: state.reasoningEffort,
    reasoningMode: state.reasoningMode,
    selectedAssistantId: state.selectedAssistant?.id ?? null,
    selectedKnowledgeBaseIds: state.selectedKnowledgeBaseIds,
    selectedModelId: state.selectedModelId,
    selectedProvider: state.selectedProvider,
    selectedSearchOptionIds: state.selectedSearchOptionIds,
    searchPlanMode: state.searchPlanMode,
    streamMode: state.streamMode,
    temperature: state.temperature
  });
}

type BranchGraphState = {
  activeLeafId: string | null;
  chatId: string;
  error: string | null;
  graph: ChatBranchGraphWire | null;
  loading: boolean;
  messages: ThreadMessage[] | null;
  snapshotUpdatedAt: string | null;
};

export function runCatalogLoadDeduped<T>({
  getLoadedCatalog,
  load,
  requestRef
}: {
  getLoadedCatalog(): T | null;
  load(): Promise<T | null>;
  requestRef: { current: Promise<T | null> | null };
}): Promise<T | null> {
  const loadedCatalog = getLoadedCatalog();
  if (loadedCatalog) {
    return Promise.resolve(loadedCatalog);
  }
  if (requestRef.current) {
    return requestRef.current;
  }

  const request = load();
  requestRef.current = request;
  const clear = () => {
    if (requestRef.current === request) {
      requestRef.current = null;
    }
  };
  void request.then(clear, clear);
  return request;
}

export function PowerAppShellV2({
  accountId,
  accountEmail,
  adminEntryVisible = false
}: {
  accountId: string;
  accountEmail: string | null;
  adminEntryVisible?: boolean;
}) {
  const catalog = useWorkspaceStore((state) => state.catalog);
  const catalogError = useWorkspaceStore((state) => state.catalogError);
  const folders = useWorkspaceStore((state) => state.folders);
  const chats = useWorkspaceStore((state) => state.chats);
  const workspaceLoading = useWorkspaceStore((state) => state.workspaceLoading);
  const workspaceReady = useWorkspaceStore((state) => state.workspaceReady);
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const pendingChatFolderId = useWorkspaceStore((state) => state.pendingChatFolderId);
  const memorySettings = useMemorySettingsStore((state) => state.data);
  const archivedChatsOpen = useArchivedChatsStore((state) => state.open);
  const activeChatDetailLoading = useWorkspaceStore((state) => state.activeChatDetailLoading);
  const activeChatDetailError = useWorkspaceStore((state) => state.activeChatDetailError);
  const setCatalog = useWorkspaceStore((state) => state.setCatalog);
  const setCatalogError = useWorkspaceStore((state) => state.setCatalogError);

  useEffect(() => {
    activateMemoryHistorySearchAccount(accountId);
    return () => deactivateMemoryHistorySearchAccount(accountId);
  }, [accountId]);
  useEffect(() => () => {
    deactivateArchivedChats();
    deactivateMcpSettings();
    deactivateMemoryManager();
    deactivateMemorySettings();
  }, [accountId]);
  const activeThread = useThreadStore((state) => selectThreadSnapshot(state, activeChatId));
  const [branchGraph, setBranchGraph] = useState<BranchGraphState | null>(null);
  const branchGraphRequestRef = useRef(0);
  const activeRunSurface = useRunSurfaceStore((state) => selectRunSurface(state, activeChatId));
  const activeThreadHistory = threadHistoryState(activeThread);
  const renderActiveLeafId = useMemo(
    () => selectThreadRenderActiveLeafId(activeThread),
    [activeThread]
  );
  const visibleMessages = useMemo(
    () => selectThreadVisibleMessages(activeThread),
    [activeThread]
  );
  const composerSession = useComposerSessionStore(selectActiveComposerSession);
  const activeComposerSessionKey = useComposerSessionStore((state) => state.activeSessionKey);
  const pendingComposerChatIdsKey = useComposerSessionStore((state) =>
    (Object.keys(state.sessionsByKey) as ComposerSessionKey[])
      .flatMap((sessionKey) => {
        const session = state.sessionsByKey[sessionKey];
        const chatId = chatIdFromComposerSessionKey(sessionKey);
        return chatId &&
          (session?.pendingEdit ||
            session?.pendingSend ||
            (session?.pendingUploadGenerations.length ?? 0) > 0)
          ? [chatId]
          : [];
      })
      .sort()
      .join("\u0000")
  );
  const attachments = composerSession.attachments;
  const backgroundMode = useComposerControlStore((state) => state.backgroundMode);
  const draft = composerSession.draft;
  const editingMessageId = composerSession.editingMessageId;
  const editingMessagePending = Boolean(composerSession.pendingEdit);
  const maxOutputTokens = useComposerControlStore((state) => state.maxOutputTokens);
  const reasoningEffort = useComposerControlStore((state) => state.reasoningEffort);
  const reasoningMode = useComposerControlStore((state) => state.reasoningMode);
  const selectedAssistant = useComposerControlStore((state) => state.selectedAssistant);
  const selectedKnowledgeBaseIds = useComposerControlStore((state) => state.selectedKnowledgeBaseIds);
  const assistantRemovedNotice = useComposerControlStore((state) => state.assistantRemovedNotice);
  const selectedModelId = useComposerControlStore((state) => state.selectedModelId);
  const selectedProvider = useComposerControlStore((state) => state.selectedProvider);
  const selectedSearchOptionIds = useComposerControlStore((state) => state.selectedSearchOptionIds);
  const searchPlanMode = useComposerControlStore((state) => state.searchPlanMode);
  const showCitations = useComposerControlStore((state) => state.showCitations);
  const showReasoningBlocks = useComposerControlStore((state) => state.showReasoningBlocks);
  const streamMode = useComposerControlStore((state) => state.streamMode);
  const temperature = useComposerControlStore((state) => state.temperature);
  const applyControlDefaults = useComposerControlStore((state) => state.applyControlDefaults);
  const setDraft = useComposerSessionStore((state) => state.setDraft);
  const setSelectedModelId = useComposerControlStore((state) => state.setSelectedModelId);
  const setSelectedKnowledgePlan = useComposerControlStore((state) => state.setSelectedKnowledgePlan);
  const setSelectedProvider = useComposerControlStore((state) => state.setSelectedProvider);
  const setSelectedSearchPlan = useComposerControlStore((state) => state.setSelectedSearchPlan);
  const setShowCitations = useComposerControlStore((state) => state.setShowCitations);
  const setShowReasoningBlocks = useComposerControlStore((state) => state.setShowReasoningBlocks);
  const settingsOpen = useSettingsDestinationStore((state) => state.settingsOpen);
  const settingsSection = useSettingsDestinationStore((state) => state.settingsSection);
  const memoryOpen = useSettingsDestinationStore((state) => state.memoryOpen);
  const closeMemoryWorkspace = useSettingsDestinationStore((state) => state.closeMemory);
  const openMemorySettings = useSettingsDestinationStore((state) => state.openMemorySettings);
  const openMcpSettings = useSettingsDestinationStore((state) => state.openMcpSettings);
  const openGeneralSettings = useSettingsDestinationStore((state) => state.openSettings);
  const closeGeneralSettings = useSettingsDestinationStore((state) => state.closeSettings);
  const librarySnapshot = useAssistantLibraryStore();
  const knowledgeSnapshot = useKnowledgeLibraryStore();
  const appearance = useShellAppearanceController();
  const { change: changeTheme, id: themeId } = appearance.theme;
  const workspaceInteraction = useWorkspaceInteractionController();
  const projectSettingsFolderId = workspaceInteraction.projectSettings.folderId;
  const projectMemoryDraft = workspaceInteraction.projectSettings.draft;
  const projectKnowledgeBaseIds = workspaceInteraction.projectSettings.knowledgeBaseIds;
  const shellOverlays = useShellOverlayController({
    blockers: {
      projectSettingsOpen: Boolean(projectSettingsFolderId),
      settingsOpen: settingsOpen || memoryOpen || librarySnapshot.open || knowledgeSnapshot.open
    }
  });
  const uploading = composerSession.pendingUploadGenerations.length > 0;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<Notice | null>(null);
  const [shareDialogTarget, setShareDialogTarget] = useState<ShareDialogTarget | null>(null);
  const activeChatStream = useRunLifecycleStore((state) =>
    activeChatId ? state.activeStreams[activeChatId] : undefined
  );
  // Recorded genuine transport loss for the active chat (stream ended or
  // errored without a terminal frame); presentation shows the honest
  // "Connection lost · Refresh" strip from this record alone.
  const activeChatInterruptedRun = useRunLifecycleStore((state) =>
    activeChatId ? state.ambiguousFailures[activeChatId] ?? null : null
  );
  const activeRunChatIdsKey = useRunLifecycleStore((state) => Object.keys(state.activeStreams).sort().join("\u0000"));
  const currentRunId = activeChatStream?.runId ?? null;
  const { notificationSoundEnabled, notifyAnswerReady, primeAnswerSound, toggleNotificationSound } =
    useAnswerNotification();

  useEffect(() => {
    const url = new URL(window.location.href);
    const shouldOpenMcp = url.searchParams.get("settings") === "mcp";
    consumeMcpOAuthReturn(url);
    if (shouldOpenMcp) {
      openMcpSettings();
      void refreshMcpSettings(true).catch(() => undefined);
    }
  }, [openMcpSettings]);
  const activeChatIdRef = useRef<string | null>(null);
  const activeStreamAbortRef = useRef<Map<string, AbortController>>(new Map());
  const memorySourceMutationIdsRef = useRef(new Set<string>());
  const chatDetailRequestsRef = useRef<Map<string, Promise<ChatDetail | null>>>(new Map());
  const loadingChatDetailIdRef = useRef<string | null>(null);
  const [pendingBranchCheckouts] = useState(
    () => new Map<string, Promise<BranchCheckoutSettlement>>()
  );
  const [pendingThreadMutations] = useState(() => new Set<string>());
  const pendingControlDefaultsRef = useRef<{ draft: SavedControlDraft; model: CatalogModel } | null>(null);
  const pendingControlDefaultsTimerRef = useRef<number | null>(null);
  const settingsMutationCoordinatorRef = useRef<SettingsMutationCoordinator | null>(null);
  const catalogLoadPromiseRef = useRef<Promise<Catalog | null> | null>(null);
  const shellMountedRef = useRef(true);
  const workspaceRefreshPromiseRef = useRef<Promise<ChatDetail | null> | null>(null);
  const sessionExpiredHandledRef = useRef(false);

  useEffect(() => subscribeToSessionExpired(() => {
    if (sessionExpiredHandledRef.current) {
      return;
    }

    sessionExpiredHandledRef.current = true;
    const composerState = useComposerSessionStore.getState();
    const session = selectComposerSession(composerState, composerState.activeSessionKey);
    const draft = session.pendingSend?.draft ?? session.draft;
    if (accountEmail) {
      rememberSessionExpiredDraft({
        accountEmail,
        draft,
        savedAt: Date.now(),
        sessionKey: composerState.activeSessionKey
      });
    } else {
      clearSessionExpiredDraft();
    }

    setNotice({
      kind: "error",
      persistent: true,
      text: "Your session ended. Sign in again to continue."
    });
    const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(sessionExpiredLoginHref(destination));
  }), [accountEmail]);

  useEffect(
    () => () => {
      abortActiveStreamControllers(activeStreamAbortRef.current);
    },
    []
  );

  const {
    activeChat,
    activeChatStreaming,
    activeChatTitle,
    commandChatGroups,
    composerDisabledHint,
    composerContextStats,
    composerUsageStats,
    currentModel,
    currentParameterControls,
    liveArtifactSummary,
    projectSettingsFolder,
    searchOptions,
    threadFollowKey,
    threadReadingAnchorKey,
  } = usePowerAppShellViewModel({
    activeChatId,
    activeChatStreaming: Boolean(activeChatStream),
    activeThreadContextStats: activeThread.contextStats ?? null,
    activeThreadUsageStats: activeThread.usageStats,
    attachments,
    catalog,
    chats,
    draft,
    folders,
    maxOutputTokens,
    pendingChatFolderId,
    projectSettingsFolderId,
    renderActiveLeafId,
    runSurface: activeRunSurface,
    selectedAssistantPromptCharacterCount: selectedAssistant?.promptCharacterCount ?? null,
    selectedModelId,
    selectedProvider,
    visibleMessages
  });

  const composerTemporary = activeChat
    ? activeChat.memoryMode === "TEMPORARY" ||
      activeChat.pendingInitialMemoryMode === "TEMPORARY"
    : composerSessionModeFromKey(activeComposerSessionKey) === "TEMPORARY";
  const canToggleTemporary = Boolean(memorySettings?.capabilities.temporaryChats) &&
    !activeChat &&
    !composerSession.pendingSend &&
    !activeChatStreaming;

  useEffect(() => {
    if (!workspaceReady || memorySettings) return;
    void refreshMemorySettings().catch(() => undefined);
  }, [memorySettings, workspaceReady]);

  function toggleTemporaryComposer(): void {
    if (!canToggleTemporary) return;
    useComposerSessionStore.getState().activateSession(composerSessionKey(
      null,
      pendingChatFolderId,
      composerTemporary ? "NORMAL" : "TEMPORARY"
    ));
  }

  const attachmentLimitContextsRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!currentModel) {
      return;
    }

    if (uploading) {
      return;
    }

    const attachmentLimits = catalog?.attachmentLimits;
    const contextFingerprint = [
      currentModel.provider,
      currentModel.modelId,
      currentModel.capabilities.documentInputMode,
      currentModel.capabilities.imageInput ? "images" : "no-images",
      attachmentLimits?.maxCount ?? "default-count",
      attachmentLimits?.maxMaterializedBytes ?? "default-source",
      attachmentLimits?.maxEncodedBytes ?? "default-encoded"
    ].join("\u0000");
    const previousContext = attachmentLimitContextsRef.current.get(
      activeComposerSessionKey
    );
    const clearResolvedLimitFeedback =
      previousContext !== undefined && previousContext !== contextFingerprint;

    reconcileCurrentComposerAttachments(activeComposerSessionKey, currentModel, {
      clearResolvedLimitFeedback
    });
    attachmentLimitContextsRef.current.set(
      activeComposerSessionKey,
      contextFingerprint
    );
  }, [activeComposerSessionKey, attachments, catalog?.attachmentLimits, currentModel, uploading]);

  const {
    containerRef: threadScrollRef,
    handleScroll: handleThreadScroll,
    jumpToLatest,
    resetToLatest: resetThreadToLatest,
    showJumpToLatest
  } = usePinnedScroll<HTMLDivElement>({
    followKey: threadFollowKey,
    hasContent: visibleMessages.length > 0,
    readingAnchorKey: threadReadingAnchorKey,
    resetKey: activeChatId ?? "blank"
  });
  const {
    applyAssistantToComposer,
    applyModelControlDefaults,
    buildControlDraft,
    buildParams,
    changeBackgroundMode,
    changeMaxOutputTokens,
    changeReasoningEffort,
    changeReasoningMode,
    changeStreamMode,
    changeTemperature,
    flushPendingModelControlDefaults,
    makeModelDefault,
    removeAssistantFromComposer,
    selectModel,
    selectSearchPlan,
    selectSearchStrategy,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    useOrganizationModelDefault,
    useOrganizationSearchDefault
  } = useRunControlsActions({
    catalog,
    currentModel,
    pendingControlDefaultsRef,
    pendingControlDefaultsTimerRef,
    settingsMutationCoordinatorRef,
    setCatalog,
    setNotice,
    setSettingsNotice
  });
  const flushPendingModelControlDefaultsEvent = useEventCallback(flushPendingModelControlDefaults);

  useEffect(
    () => () => {
      flushPendingModelControlDefaultsEvent();
    },
    [flushPendingModelControlDefaultsEvent]
  );

  useEffect(() => {
    function flushBeforePageLeaves() {
      flushPendingModelControlDefaultsEvent();
    }

    function flushWhenHidden() {
      if (document.visibilityState === "hidden") {
        flushPendingModelControlDefaultsEvent();
      }
    }

    window.addEventListener("pagehide", flushBeforePageLeaves);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      window.removeEventListener("pagehide", flushBeforePageLeaves);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushPendingModelControlDefaultsEvent]);

  const {
    createFolder,
    deleteFolder,
    renameFolder,
    saveProjectSettings,
    updateFolderParent
  } = createFolderActions({
    activeChat,
    activeChatId,
    confirmDeleteFolder: shellOverlays.confirmations.folder.request,
    folderMutation: workspaceInteraction.folderMutation,
    setNotice
  });

  function resumeChatRun(chat: WorkspaceChatSummary) {
    void runLifecycleActions.resumeChatRun(chat);
  }

  const {
    activateBlankWorkspace,
    activateChat,
    applyChatUpdate,
    createChat,
    deleteChat,
    exportChat,
    loadCompleteActiveBranch,
    loadEarlierMessages: loadEarlierMessagesPage,
    pruneThreadCache,
    reapplyActiveChatDefaults,
    refreshActiveChat,
    refreshWorkspace,
    renameChat,
    toggleChatFavorite,
    updateChatFolder
  } = useWorkspaceActions({
    activeChatIdRef,
    applyModelControlDefaults,
    chatDetailRequestsRef,
    chatHasActiveStream: (chatId) => Boolean(useRunLifecycleStore.getState().activeStreams[chatId]),
    chatHasPendingThreadMutation: (chatId) =>
      pendingBranchCheckouts.has(chatId) || pendingThreadMutations.has(chatId),
    chatMutation: workspaceInteraction.chatMutation,
    loadingChatDetailIdRef,
    resumeChatRun,
    setNotice,
    setSelectedModelId,
    setSelectedKnowledgePlan,
    setSelectedProvider,
    setSelectedSearchPlan,
    workspaceRefreshPromiseRef
  });
  const pruneThreadCacheEvent = useEventCallback(pruneThreadCache);

  useEffect(() => {
    pruneThreadCacheEvent();
  }, [activeRunChatIdsKey, pendingComposerChatIdsKey, pruneThreadCacheEvent]);

  const reconcilePermanentChatDeletion = useEventCallback(async (chatId: string) => {
    const workspace = useWorkspaceStore.getState();
    const wasActive = workspace.activeChatId === chatId;
    const remaining = workspace.chats.filter((chat) => chat.id !== chatId);
    workspace.updateChats((current) => current.filter((chat) => chat.id !== chatId));
    useThreadStore.getState().removeThread(chatId);
    useRunSurfaceStore.getState().removeSurface(chatId);
    useComposerSessionStore.getState().removeSession(composerSessionKey(chatId));
    chatDetailRequestsRef.current.delete(chatId);
    removePermanentlyDeletedArchivedChat(chatId);
    if (shareDialogTarget?.chat.id === chatId) setShareDialogTarget(null);
    if (!wasActive) return;
    const next = remaining[0] ?? null;
    if (next) await activateChat(next, { preserveControls: true });
    else activateBlankWorkspace();
  });

  useEffect(() => {
    void activatePermanentChatDeletionAccount(
      accountId,
      reconcilePermanentChatDeletion
    );
    return () => deactivatePermanentChatDeletionAccount(accountId);
  }, [accountId, reconcilePermanentChatDeletion]);

  const loadEarlierMessages = useEventCallback(async () => {
    const sourceChatId = activeChatId;
    if (!sourceChatId) return;
    await loadEarlierMessagesPage(sourceChatId);
  });

  const loadBranchGraph = useEventCallback(async () => {
    const chatId = activeChatId;
    if (!chatId) return;
    const requestGeneration = ++branchGraphRequestRef.current;
    setBranchGraph({
      activeLeafId: null,
      chatId,
      error: null,
      graph: null,
      loading: true,
      messages: null,
      snapshotUpdatedAt: null
    });
    try {
      const response = await shellFetch(`/api/chats/${chatId}/branches`);
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, `chat_branches_failed_${response.status}`)
        );
      }
      const decoded = decodeChatBranchesResponse(await response.json());
      if (!decoded) throw new Error("chat_branches_malformed");
      if (
        branchGraphRequestRef.current !== requestGeneration ||
        useWorkspaceStore.getState().activeChatId !== chatId
      ) return;
      setBranchGraph({
        activeLeafId: decoded.branchGraph.activeLeafMessageId,
        chatId,
        error: null,
        graph: decoded.branchGraph,
        loading: false,
        messages: decoded.branchGraph.nodes.map((node) => ({
          content: node.preview,
          id: node.id,
          parentMessageId: node.parentMessageId,
          role: node.role,
          status: normalizeThreadStatus(node.status)
        })),
        snapshotUpdatedAt: decoded.branchGraph.snapshotUpdatedAt
      });
    } catch (error) {
      if (
        branchGraphRequestRef.current === requestGeneration &&
        useWorkspaceStore.getState().activeChatId === chatId
      ) {
        setBranchGraph({
          activeLeafId: null,
          chatId,
          error: errorMessage(error),
          graph: null,
          loading: false,
          messages: null,
          snapshotUpdatedAt: null
        });
      }
    }
  });

  useEffect(() => {
    if (!activeChatId) return;
    const summary = chats.find((chat) => chat.id === activeChatId);
    if (!summary) return;
    const branchDrawerOpen = shellOverlays.branches.open;
    // Beyond the explicit Branch drawer, the per-message ‹N/M› version pager
    // needs the compact branch graph for any saved chat with committed
    // messages, so the graph stays current per (chat, updatedAt) revision.
    // A live stream defers background refresh until settlement bumps
    // `updatedAt`.
    if (!branchDrawerOpen && (summary.messageCount === 0 || activeChatStreaming)) {
      return;
    }
    const current = branchGraph?.chatId === activeChatId ? branchGraph : null;
    if (current?.loading || current?.error || (
      current?.messages &&
      current.snapshotUpdatedAt === summary.updatedAt
    )) {
      return;
    }
    void loadBranchGraph();
  }, [
    activeChatId,
    activeChatStreaming,
    branchGraph,
    chats,
    loadBranchGraph,
    shellOverlays.branches.open
  ]);

  const retryActiveChatDetail = useEventCallback(() => {
    const chat = chats.find((candidate) => candidate.id === activeChatId);
    if (chat) {
      void activateChat(chat, { preserveControls: true });
    }
  });

  const loadCatalog = useEventCallback((): Promise<Catalog | null> => {
    return runCatalogLoadDeduped({
      getLoadedCatalog: () => useWorkspaceStore.getState().catalog,
      load: async () => {
        setCatalogError(null);
        try {
          const response = await shellFetch("/api/me/catalog");
          if (!response.ok) {
            throw new Error("catalog_unavailable");
          }

          const nextCatalog = decodeCatalogResponse(await response.json());
          if (!nextCatalog) {
            throw new Error("catalog_malformed");
          }

          if (!shellMountedRef.current) {
            return null;
          }

          const defaultModel =
            nextCatalog.models.find(
              (model) =>
                model.provider === nextCatalog.defaults.provider && model.modelId === nextCatalog.defaults.modelId
            );
          setCatalog(nextCatalog);
          setCatalogError(null);
          setSelectedProvider(defaultModel?.provider ?? "", "system");
          setSelectedModelId(defaultModel?.modelId ?? "", "system");
          const defaultSearchPlan = resolvePreferredSearchPlan(
            nextCatalog.defaults.searchPlan,
            nextCatalog.searchStrategies
          );
          setSelectedSearchPlan(defaultSearchPlan.optionIds, defaultSearchPlan.mode, "system");
          setShowCitations(nextCatalog.defaults.showCitations);
          setShowReasoningBlocks(nextCatalog.defaults.showReasoningBlocks);
          if (defaultModel) {
            const defaults = resolveModelControlDefaults(defaultModel, nextCatalog.defaults.controlValues);
            applyControlDefaults(defaults);
          }
          return nextCatalog;
        } catch (error) {
          if (shellMountedRef.current) {
            setCatalogError(errorMessage(error));
          }
          return null;
        }
      },
      requestRef: catalogLoadPromiseRef
    });
  });
  const refreshWorkspaceEvent = useEventCallback(refreshWorkspace);
  const activateBlankWorkspaceEvent = useEventCallback(activateBlankWorkspace);
  const retryWorkspace = useEventCallback(() =>
    refreshWorkspaceEvent(useWorkspaceStore.getState().activeChatId, {
      catalogOverride: useWorkspaceStore.getState().catalog
    })
  );
  const retryCatalog = useEventCallback(async () => {
    if (useWorkspaceStore.getState().catalog) {
      return;
    }

    const loadedCatalog = await loadCatalog();
    if (!loadedCatalog || !shellMountedRef.current) {
      return;
    }

    const activeChatIdBeforeRefresh = useWorkspaceStore.getState().activeChatId;
    const controlsBeforeRefresh = workspaceDefaultControlsFingerprint(useComposerControlStore.getState());
    const pendingWorkspaceRefresh = workspaceRefreshPromiseRef.current;
    await refreshWorkspaceEvent(activeChatIdBeforeRefresh, {
      catalogOverride: loadedCatalog
    });
    if (
      pendingWorkspaceRefresh &&
      shellMountedRef.current &&
      useWorkspaceStore.getState().activeChatId === activeChatIdBeforeRefresh &&
      workspaceDefaultControlsFingerprint(useComposerControlStore.getState()) === controlsBeforeRefresh
    ) {
      reapplyActiveChatDefaults(loadedCatalog);
    }
  });

  const knowledgeLibraryActions = useMemo(() => createKnowledgeLibraryActions(), []);
  const assistantLibraryActions = createAssistantLibraryActions({
    activateBlankWorkspace: () => activateBlankWorkspaceEvent(),
    applyAssistantToComposer,
    catalog,
    catalogError,
    knowledgeBases: (knowledgeSnapshot.data?.knowledgeBases ?? []).map((base) => ({
      available: !base.archived,
      id: base.id,
      name: base.name
    })),
    knowledgeDataError: knowledgeSnapshot.dataError,
    knowledgeDataState: knowledgeSnapshot.dataState,
    retryCatalog: () => void retryCatalog(),
    retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
    setShellNotice: setNotice
  });
  const openAssistantLibrary = () => {
    closeMemoryWorkspace();
    closeGeneralSettings();
    knowledgeLibraryActions.closeLibrary();
    assistantLibraryActions.openLibrary("discover");
  };
  const openKnowledgeLibrary = () => {
    closeMemoryWorkspace();
    closeGeneralSettings();
    assistantLibraryActions.closeLibrary();
    knowledgeLibraryActions.openLibrary();
  };
  const openMemoryWorkspace = () => {
    assistantLibraryActions.closeLibrary();
    knowledgeLibraryActions.closeLibrary();
    openMemorySettings();
  };
  const openSettingsDestination = () => {
    assistantLibraryActions.closeLibrary();
    knowledgeLibraryActions.closeLibrary();
    openGeneralSettings();
  };
  const [assistantPickerOpen, setAssistantPickerOpen] = useState(false);
  const [recentAssistantIds, setRecentAssistantIds] = useState<string[]>([]);
  const setAssistantPickerOpenEvent = useEventCallback((open: boolean) => {
    setAssistantPickerOpen(open);
    if (open) {
      setRecentAssistantIds(readRecentAssistantIds());
      void assistantLibraryActions.refreshList();
    }
  });

  useEffect(() => {
    void knowledgeLibraryActions.refreshList();
  }, [knowledgeLibraryActions]);

  useEffect(() => {
    shellMountedRef.current = true;

    async function bootstrap() {
      const recoveredDraft = storedSessionExpiredDraft();
      const ownedRecoveredDraft = recoveredDraft?.accountEmail === accountEmail
        ? recoveredDraft
        : null;
      if (recoveredDraft && !ownedRecoveredDraft) {
        clearSessionExpiredDraft();
      }
      const recoveredChatId = ownedRecoveredDraft
        ? chatIdFromComposerSessionKey(ownedRecoveredDraft.sessionKey)
        : null;
      const loadedCatalog = await loadCatalog();
      if (shellMountedRef.current) {
        await refreshWorkspaceEvent(
          recoveredChatId ?? useWorkspaceStore.getState().activeChatId,
          {
            catalogOverride: loadedCatalog
          }
        );
      }
      if (!shellMountedRef.current || !ownedRecoveredDraft) {
        return;
      }

      const recoveredFolderId = folderIdFromComposerSessionKey(ownedRecoveredDraft.sessionKey);
      if (recoveredFolderId) {
        if (!useWorkspaceStore.getState().folders.some((folder) => folder.id === recoveredFolderId)) {
          clearSessionExpiredDraft();
          return;
        }
        activateBlankWorkspaceEvent(recoveredFolderId);
      } else if (!recoveredChatId) {
        activateBlankWorkspaceEvent();
      } else if (!useWorkspaceStore.getState().chats.some((chat) => chat.id === recoveredChatId)) {
        clearSessionExpiredDraft();
        return;
      }

      const composerState = useComposerSessionStore.getState();
      const target = selectComposerSession(composerState, ownedRecoveredDraft.sessionKey);
      if (!target.draft && !target.pendingSend && !target.pendingEdit) {
        composerState.updateSession(ownedRecoveredDraft.sessionKey, {
          draft: ownedRecoveredDraft.draft
        });
      }
      clearSessionExpiredDraft();
    }

    void bootstrap();

    return () => {
      shellMountedRef.current = false;
    };
  }, [accountEmail, activateBlankWorkspaceEvent, loadCatalog, refreshWorkspaceEvent]);

  const { commandItems, runCommand } = useCommandPaletteActions({
    activateChat,
    activateBlankWorkspace,
    activeChatId,
    assistantLibraryOpen: librarySnapshot.open,
    branchesOpen: shellOverlays.branches.open,
    catalog,
    chatGroups: commandChatGroups,
    chats,
    closePalette: shellOverlays.palette.close,
    knowledgeOpen: knowledgeSnapshot.open,
    memoryOpen,
    openKnowledge: openKnowledgeLibrary,
    openLibrary: openAssistantLibrary,
    openMemory: openMemoryWorkspace,
    openSettings: openSettingsDestination,
    searchOptions,
    selectModel,
    selectSearchStrategy,
    selectedModelId,
    selectedProvider,
    selectedSearchOptionIds,
    settingsOpen,
    toggleBranches: shellOverlays.branches.toggle,
    workspaceReady
  });

  const { consumeRunStream, createStreamTokenBuffer } = useRunStreaming({
    applyChatUpdate
  });

  const runLifecycleActions = useRunLifecycleActions({
    activeChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    notifyAnswerReady,
    refreshActiveChat,
    setNotice
  });
  const { fetchRun, retryAttachment, stopCurrentRun, uploadFiles } = runLifecycleActions;

  const {
    branchChatFromMessage,
    checkoutBranch,
    copyMessage,
    copyVisibleThread,
    deleteMessage,
    persistActiveLeaf,
    shareActiveBranch,
    shareChat
  } = createThreadActions({
    activeChat,
    activeChatId,
    activeChatTitle,
    activateChat,
    confirmDeleteMessage: shellOverlays.confirmations.message.request,
    loadCompleteActiveBranch,
    openShareDialog(target) {
      setShareDialogTarget(target);
    },
    onThreadMutationSettled: pruneThreadCacheEvent,
    pendingBranchCheckouts,
    pendingThreadMutations,
    refreshActiveChat,
    resetThreadToLatest,
    setNotice,
    activeChatStreaming
  });

  const {
    refreshInterruptedRun,
    regenerateMessage,
    sendStarterPrompt,
    submitComposer
  } = useMessageRunActions({
    activeChat,
    activeChatDetailLoading,
    activeChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    buildControlDraft,
    buildParams,
    consumeRunStream,
    createChat,
    createStreamTokenBuffer,
    currentModel,
    fetchRun,
    notifyAnswerReady,
    openMemorySettings: openMemoryWorkspace,
    persistActiveLeaf,
    primeAnswerSound,
    refreshActiveChat,
    resetThreadToLatest,
    setNotice,
    activeChatStreaming,
  });

  const {
    handleBranchFromMessage,
    handleCopyMessage,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage
  } = useShellUiActions({
    branchChatFromMessage,
    copyMessage,
    deleteMessage,
    regenerateMessage
  });

  const composerActions = {
    cancelMessageEdit() {
      const sessionStore = useComposerSessionStore.getState();
      sessionStore.cancelEdit(sessionStore.activeSessionKey);
    },
    changeDraft: setDraft,
    rejectAttachmentCount(input: {
      attemptedCount: number;
      currentCount: number;
      maxCount: number;
    }) {
      const store = useComposerSessionStore.getState();
      const session = selectComposerSession(store, store.activeSessionKey);
      store.updateSession(store.activeSessionKey, {
        operationError: withAttachmentLimitFeedbackMessage(
          session.operationError,
          attachmentCountSelectionLimitMessage(input)
        )
      });
    },
    rejectAttachments(fileNames: readonly string[]) {
      const store = useComposerSessionStore.getState();
      store.updateSession(store.activeSessionKey, {
        operationError: unsupportedAttachmentMessage(fileNames, currentModel)
      });
    },
    removeAttachment(attachmentId: string) {
      const store = useComposerSessionStore.getState();
      const session = selectComposerSession(store, store.activeSessionKey);
      store.updateSession(store.activeSessionKey, {
        attachments: session.attachments.filter(
          (attachment) => attachment.id !== attachmentId
        ),
        operationError: withoutAttachmentLimitFeedbackMessage(session.operationError)
      });
    },
    retryAttachment(attachmentId: string) {
      void retryAttachment(attachmentId);
    }
  };

  const sessionView = {
    accountId,
    accountEmail,
    activeChatId,
    activeChatTitle,
    adminEntryVisible,
    dismissNotice: () => setNotice(null),
    notice,
    shareActiveBranch
  } satisfies ShellSessionView;

  async function toggleChatMemorySource(chat: WorkspaceChatSummary): Promise<void> {
    if (memorySourceMutationIdsRef.current.has(chat.id)) return;
    memorySourceMutationIdsRef.current.add(chat.id);
    try {
      const [source, settings] = await Promise.all([
        loadChatMemoryState(chat.id),
        refreshMemorySettings(true)
      ]);
      if (source.chat.mode === "TEMPORARY") {
        throw new Error("memory_temporary_chat_forbidden");
      }
      const mode = source.chat.mode === "EXCLUDED" ? "NORMAL" : "EXCLUDED";
      const response = await patchChatMemoryMode({
        chatId: chat.id,
        expectedChatRevision: source.chat.sourceRevision,
        mode,
        settings
      });
      useWorkspaceStore.getState().updateChats((current) => current.map((candidate) =>
        candidate.id === chat.id
          ? {
              ...candidate,
              memoryMode: response.mode,
              memorySourceRevision: response.sourceRevision
            }
          : candidate
      ));
      useMemorySettingsStore.setState((current) => current.data
        ? {
            data: {
              ...current.data,
              settings: {
                ...current.data.settings,
                memoryGeneration: response.memoryGeneration,
                memoryRevision: response.memoryRevision
              }
            }
          }
        : {});
      setNotice({
        kind: "success",
        text: resolveMemoryCopy(
          response.mode === "EXCLUDED" ? "exclude.action" : "resume.action"
        )
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      memorySourceMutationIdsRef.current.delete(chat.id);
    }
  }

  /**
   * Direct "Delete…" entry: fetch the fresh server snapshot, then open the
   * existing permanent-deletion confirm surface. `openPermanentChatDeletion`
   * keeps the `permanentChatDeletionAvailable` gate; nothing is deleted before
   * the surface's own confirmed authorization.
   */
  async function deleteChatPermanently(chat: WorkspaceChatSummary): Promise<void> {
    try {
      openPermanentChatDeletion(await loadPermanentChatDeletionSnapshot(chat.id));
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  const workspacePaneView = {
    actions: {
      ...workspaceInteraction.paneActions,
      activateChat,
      createChat: activateBlankWorkspace,
      createFolder,
      deleteChat,
      deleteChatPermanently,
      deleteFolder,
      exportChat,
      moveChat: updateChatFolder,
      moveFolder: updateFolderParent,
      openArchivedChats: () => {
        void openArchivedChats().catch(() => undefined);
      },
      retry: retryWorkspace,
      saveChatTitle: renameChat,
      saveFolder: renameFolder,
      shareChat,
      toggleChatMemorySource,
      toggleChatFavorite
    },
    state: {
      ...workspaceInteraction.paneState,
      workspaceLoading
    }
  } satisfies ShellWorkspacePaneView;

  const workspaceView = {
    archived: {
      onRestored: async (chatId: string) => {
        await refreshWorkspace(chatId, { preserveControls: true });
      },
      open: archivedChatsOpen
    },
    pane: workspacePaneView,
    projectSettings: {
      changeDraft: workspaceInteraction.projectSettings.changeDraft,
      changeKnowledgeBaseIds: workspaceInteraction.projectSettings.changeKnowledgeBaseIds,
      close: workspaceInteraction.projectSettings.close,
      draft: projectMemoryDraft,
      folder: projectSettingsFolder,
      knowledgeBaseIds: projectKnowledgeBaseIds,
      knowledgeBases: knowledgeSnapshot.data?.knowledgeBases ?? [],
      knowledgeDataError: knowledgeSnapshot.dataError,
      knowledgeDataState: knowledgeSnapshot.dataState,
      retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
      save: saveProjectSettings
    }
  } satisfies ShellWorkspaceView;

  async function navigateMemorySourceChat(
    chatId: string,
    fromSettings: boolean
  ): Promise<void> {
    let settingsClosed = false;
    try {
      await navigateMemorySource(chatId, {
        activateChat: (sourceChat) => activateChat(sourceChat, { preserveControls: true }),
        ...(fromSettings ? {
          closeResolvedOverlay: () => {
            closeMemoryWorkspace();
            settingsClosed = true;
          }
        } : {}),
        findActiveChat: (sourceChatId) =>
          useWorkspaceStore.getState().chats.find((chat) => chat.id === sourceChatId) ?? null,
        openArchivedPreview: openArchivedChatPreview,
        refreshWorkspace: (sourceChatId) =>
          refreshWorkspace(sourceChatId, { preserveControls: true }),
        resolveSource: resolveChatSource
      });
    } catch {
      const sourceNotice = {
        kind: "error" as const,
        text: memoryUiCopy("manager.sourceUnavailable")
      };
      if (fromSettings && !settingsClosed) setSettingsNotice(sourceNotice);
      else setNotice(sourceNotice);
    }
  }

  function openMemorySourceFromSettings(chatId: string): Promise<void> {
    return navigateMemorySourceChat(chatId, true);
  }

  const threadView = {
    activeChatDetailError,
    activeChatDetailLoading,
    activeChatStreaming,
    copyVisibleThread,
    currentRunId,
    editingMessageId,
    editingMessagePending,
    events: activeRunSurface.events,
    handleBranchFromMessage,
    handleCopyMessage,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleThreadScroll,
    interruptedRun: activeChatInterruptedRun,
    refreshInterruptedRun: () => refreshInterruptedRun(),
    jumpToLatest,
    hasOlderMessages: activeThreadHistory.hasOlder,
    liveArtifactSummary,
    loadEarlierMessages,
    loadingOlderMessages: activeThreadHistory.loading,
    olderMessagesError: activeThreadHistory.error,
    openMemorySourceChat: (chatId: string) => {
      void navigateMemorySourceChat(chatId, false);
    },
    retryActiveChatDetail,
    showJumpToLatest,
    threadScrollRef,
    visibleMessages
  } satisfies ShellThreadView;

  const composerView = {
    attachments,
    backgroundMode,
    catalog,
    catalogError,
    changeBackgroundMode,
    changeMaxOutputTokens,
    changeReasoningEffort,
    changeReasoningMode,
    changeStreamMode,
    changeTemperature,
    composerActions,
    assistant: {
      clearRemovedNotice: () => useComposerControlStore.getState().clearAssistantRemovedNotice(),
      openLibrary: openAssistantLibrary,
      openPicker: assistantPickerOpen,
      pickerItems: librarySnapshot.data?.assistants ?? [],
      pickerLoading: librarySnapshot.dataState === "loading" && !librarySnapshot.data,
      recentIds: recentAssistantIds,
      remove: removeAssistantFromComposer,
      removedNotice: assistantRemovedNotice,
      selectById: (assistantId: string) => {
        setAssistantPickerOpen(false);
        void assistantLibraryActions.useAssistant(assistantId, { navigate: false });
      },
      selected: selectedAssistant,
      sendStarter: (prompt: string) => void sendStarterPrompt(prompt),
      setPickerOpen: setAssistantPickerOpenEvent,
      startFromCurrentSetup: () => {
        setAssistantPickerOpen(false);
        assistantLibraryActions.openNewAssistantFromCurrentSetup();
      }
    },
    composerContextStats,
    composerDisabledHint,
    composerUsageStats,
    currentModel,
    currentParameterControls,
    draft,
    knowledge: {
      bases: knowledgeSnapshot.data?.knowledgeBases ?? [],
      select: (baseIds) => setSelectedKnowledgePlan(baseIds, "explicit", "user"),
      selectedBaseIds: selectedKnowledgeBaseIds
    },
    maxOutputTokens,
    memory: {
      canToggleTemporary,
      explanation: resolveMemoryCopy("temporary.explanation"),
      externalRetention: resolveMemoryCopy("temporary.externalRetention"),
      label: resolveMemoryCopy("temporary.label"),
      mode: composerTemporary ? "TEMPORARY" : "NORMAL",
      retention: resolveMemoryCopy("temporary.retention"),
      retentionDeadline: activeChat?.temporaryRetentionDeadline ?? null,
      toggleTemporary: toggleTemporaryComposer
    },
    makeModelDefault,
    notificationSoundEnabled,
    operationError: composerSession.operationError,
    operationErrorLive: composerSession.operationErrorLive,
    reasoningEffort,
    reasoningMode,
    retryCatalog,
    searchPlanMode,
    selectModel,
    selectSearchPlan,
    selectedModelId,
    selectedProvider,
    selectedSearchOptionIds,
    showCitations,
    showReasoningBlocks,
    stopCurrentRun,
    streamMode,
    submitComposer,
    temperature,
    toggleCitationsVisibility,
    toggleNotificationSound,
    toggleReasoningBlockVisibility,
    useOrganizationSearchDefault,
    useOrganizationModelDefault,
    uploadFiles,
    uploading
  } satisfies ShellComposerView;

  const branchesView = {
    close: shellOverlays.branches.close,
    checkoutBranch,
    error: branchGraph?.chatId === activeChatId ? branchGraph.error : null,
    graph: branchGraph?.chatId === activeChatId ? branchGraph.graph : null,
    loading: Boolean(activeChatId) &&
      (branchGraph?.chatId !== activeChatId || branchGraph.loading),
    open: shellOverlays.branches.open,
    retry: loadBranchGraph,
    show: shellOverlays.branches.show
  } satisfies ShellBranchesView;

  const settingsView = {
    closeMemory: closeMemoryWorkspace,
    closeSettings: closeGeneralSettings,
    dismissNotice: () => setSettingsNotice(null),
    knowledge: buildKnowledgeLibraryView(knowledgeLibraryActions, knowledgeSnapshot),
    library: buildAssistantLibraryView(
      {
        activateBlankWorkspace: () => activateBlankWorkspaceEvent(),
        applyAssistantToComposer,
        catalog,
        catalogError,
        knowledgeBases: (knowledgeSnapshot.data?.knowledgeBases ?? []).map((base) => ({
          available: !base.archived,
          id: base.id,
          name: base.name
        })),
        knowledgeDataError: knowledgeSnapshot.dataError,
        knowledgeDataState: knowledgeSnapshot.dataState,
        retryCatalog: () => void retryCatalog(),
        retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
        setShellNotice: setNotice
      },
      assistantLibraryActions,
      librarySnapshot
    ),
    notice: settingsNotice,
    memory: { open: memoryOpen },
    open: openSettingsDestination,
    openKnowledge: openKnowledgeLibrary,
    openLibrary: openAssistantLibrary,
    openMemory: openMemoryWorkspace,
    openMemorySourceChat: (chatId: string) => {
      void openMemorySourceFromSettings(chatId);
    },
    openMcp: openMcpSettings,
    settings: {
      open: settingsOpen,
      section: settingsSection,
      themeId
    },
    updateTheme: changeTheme
  } satisfies ShellSettingsView;

  const overlaysView = {
    confirmations: {
      cancelChat: shellOverlays.confirmations.chat.cancel,
      cancelFolder: shellOverlays.confirmations.folder.cancel,
      cancelMessage: shellOverlays.confirmations.message.cancel,
      chat: shellOverlays.confirmations.chat.target,
      confirmChat: shellOverlays.confirmations.chat.confirm,
      confirmFolder: shellOverlays.confirmations.folder.confirm,
      confirmMessage: shellOverlays.confirmations.message.confirm,
      folder: shellOverlays.confirmations.folder.target,
      message: shellOverlays.confirmations.message.target
    },
    palette: {
      close: shellOverlays.palette.close,
      items: commandItems,
      open: shellOverlays.palette.open,
      run: runCommand,
      show: shellOverlays.palette.show
    },
    share: {
      close: () => setShareDialogTarget(null),
      target: shareDialogTarget
    }
  } satisfies ShellOverlaysView;

  return (
    <PowerAppShellV2View
      branches={branchesView}
      composer={composerView}
      overlays={overlaysView}
      session={sessionView}
      settings={settingsView}
      thread={threadView}
      workspace={workspaceView}
    />
  );
}
