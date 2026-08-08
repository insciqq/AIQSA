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
  folderIdFromComposerSessionKey,
  selectActiveComposerSession,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { createFolderActions } from "@/components/app-shell/folderActions";
import { useMessageRunActions } from "@/components/app-shell/messageRunActions";
import { PowerAppShellView } from "@/components/app-shell/PowerAppShellView";
import type {
  ShellComposerView,
  ShellDetailsView,
  ShellOverlaysView,
  ShellSessionView,
  ShellSettingsView,
  ShellThreadView,
  ShellWorkspacePaneView,
  ShellWorkspaceView
} from "@/components/app-shell/powerAppShellViewContracts";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions,
  readRecentAssistantIds
} from "@/components/app-shell/assistantLibraryController";
import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import { useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import { consumeMcpOAuthReturn, refreshMcpSettings } from "@/components/app-shell/mcpSettingsStore";
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
  sessionExpiredLoginHref,
  shellFetch,
  subscribeToSessionExpired
} from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
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
import { useChatContentSearch } from "@/components/app-shell/useChatContentSearch";
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
  selectThreadRenderActiveLeafId,
  selectThreadSnapshot,
  selectThreadVisibleMessages,
  useThreadStore
} from "@/components/app-shell/threadStore";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  ChatSummary,
  Notice
} from "@/components/app-shell/types";
import { decodeCatalogResponse } from "@/lib/contracts/catalog";
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
    reasoningEffort: state.reasoningEffort,
    reasoningMode: state.reasoningMode,
    selectedAssistantId: state.selectedAssistant?.id ?? null,
    selectedModelId: state.selectedModelId,
    selectedProvider: state.selectedProvider,
    selectedSearchOptionIds: state.selectedSearchOptionIds,
    searchPlanMode: state.searchPlanMode,
    selectedSearchStrategy: state.selectedSearchStrategy,
    streamMode: state.streamMode,
    temperature: state.temperature
  });
}

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

export function PowerAppShell({
  accountEmail,
  adminEntryVisible = false
}: {
  accountEmail: string | null;
  adminEntryVisible?: boolean;
}) {
  const catalog = useWorkspaceStore((state) => state.catalog);
  const catalogError = useWorkspaceStore((state) => state.catalogError);
  const folders = useWorkspaceStore((state) => state.folders);
  const chats = useWorkspaceStore((state) => state.chats);
  const workspaceLoading = useWorkspaceStore((state) => state.workspaceLoading);
  const workspaceError = useWorkspaceStore((state) => state.workspaceError);
  const workspaceReady = useWorkspaceStore((state) => state.workspaceReady);
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const pendingChatFolderId = useWorkspaceStore((state) => state.pendingChatFolderId);
  const creatingChat = useWorkspaceStore((state) => state.creatingChat);
  const activeChatDetailLoading = useWorkspaceStore((state) => state.activeChatDetailLoading);
  const activeChatDetailError = useWorkspaceStore((state) => state.activeChatDetailError);
  const setCatalog = useWorkspaceStore((state) => state.setCatalog);
  const setCatalogError = useWorkspaceStore((state) => state.setCatalogError);
  const activeThread = useThreadStore((state) => selectThreadSnapshot(state, activeChatId));
  const activeRunSurface = useRunSurfaceStore((state) => selectRunSurface(state, activeChatId));
  const messages = activeThread.messages;
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
  const attachments = composerSession.attachments;
  const backgroundMode = useComposerControlStore((state) => state.backgroundMode);
  const draft = composerSession.draft;
  const editingMessageId = composerSession.editingMessageId;
  const editingMessagePending = Boolean(composerSession.pendingEdit);
  const maxOutputTokens = useComposerControlStore((state) => state.maxOutputTokens);
  const reasoningEffort = useComposerControlStore((state) => state.reasoningEffort);
  const reasoningMode = useComposerControlStore((state) => state.reasoningMode);
  const selectedAssistant = useComposerControlStore((state) => state.selectedAssistant);
  const assistantRemovedNotice = useComposerControlStore((state) => state.assistantRemovedNotice);
  const selectedModelId = useComposerControlStore((state) => state.selectedModelId);
  const selectedProvider = useComposerControlStore((state) => state.selectedProvider);
  const selectedSearchOptionIds = useComposerControlStore((state) => state.selectedSearchOptionIds);
  const searchPlanMode = useComposerControlStore((state) => state.searchPlanMode);
  const selectedSearchStrategy = useComposerControlStore((state) => state.selectedSearchStrategy);
  const showCitations = useComposerControlStore((state) => state.showCitations);
  const showReasoningBlocks = useComposerControlStore((state) => state.showReasoningBlocks);
  const showToolActivity = useComposerControlStore((state) => state.showToolActivity);
  const streamMode = useComposerControlStore((state) => state.streamMode);
  const temperature = useComposerControlStore((state) => state.temperature);
  const applyControlDefaults = useComposerControlStore((state) => state.applyControlDefaults);
  const setAttachments = useComposerSessionStore((state) => state.setAttachments);
  const setDraft = useComposerSessionStore((state) => state.setDraft);
  const setSelectedModelId = useComposerControlStore((state) => state.setSelectedModelId);
  const setSelectedProvider = useComposerControlStore((state) => state.setSelectedProvider);
  const setSelectedSearchPlan = useComposerControlStore((state) => state.setSelectedSearchPlan);
  const setShowCitations = useComposerControlStore((state) => state.setShowCitations);
  const setShowReasoningBlocks = useComposerControlStore((state) => state.setShowReasoningBlocks);
  const setShowToolActivity = useComposerControlStore((state) => state.setShowToolActivity);
  const settingsOpen = useSettingsDestinationStore((state) => state.settingsOpen);
  const settingsSection = useSettingsDestinationStore((state) => state.settingsSection);
  const openMcpSettings = useSettingsDestinationStore((state) => state.openMcpSettings);
  const openGeneralSettings = useSettingsDestinationStore((state) => state.openSettings);
  const closeGeneralSettings = useSettingsDestinationStore((state) => state.closeSettings);
  const librarySnapshot = useAssistantLibraryStore();
  const appearance = useShellAppearanceController();
  const {
    activeTab: inspectorActiveTab,
    changeActiveTab: setInspectorActiveTabManually,
    changeMode: setInspectorModeManually,
    mode: inspectorMode,
    pinningAvailable: inspectorPinningAvailable
  } = appearance.details;
  const { change: changeTheme, id: themeId } = appearance.theme;
  const workspaceInteraction = useWorkspaceInteractionController();
  const projectSettingsFolderId = workspaceInteraction.projectSettings.folderId;
  const projectMemoryDraft = workspaceInteraction.projectSettings.draft;
  const shellOverlays = useShellOverlayController({
    appearance: {
      changeMode: setInspectorModeManually,
      mode: inspectorMode
    },
    blockers: {
      projectSettingsOpen: Boolean(projectSettingsFolderId),
      settingsOpen: settingsOpen || librarySnapshot.open
    },
    onMobileWorkspaceClosed: workspaceInteraction.mobileWorkspaceClosed
  });
  const uploading = composerSession.pendingUploadGenerations.length > 0;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<Notice | null>(null);
  const { chatContentMatchIds, chatContentSearchError, chatContentSearchLoading, chatQuery, setChatQuery } =
    useChatContentSearch(setNotice);
  const [shareDialogTarget, setShareDialogTarget] = useState<ShareDialogTarget | null>(null);
  const activeChatStream = useRunLifecycleStore((state) =>
    activeChatId ? state.activeStreams[activeChatId] : undefined
  );
  const activeRunChatIdsKey = useRunLifecycleStore((state) => Object.keys(state.activeStreams).sort().join("\u0000"));
  const activeRunChatIds = useMemo(
    () => new Set(activeRunChatIdsKey ? activeRunChatIdsKey.split("\u0000") : []),
    [activeRunChatIdsKey]
  );
  const currentRunId = activeChatStream?.runId ?? activeRunSurface.lastRun?.id ?? null;
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
  const chatDetailRequestsRef = useRef<Map<string, Promise<ChatDetail | null>>>(new Map());
  const loadingChatDetailIdRef = useRef<string | null>(null);
  const [pendingBranchCheckouts] = useState(
    () => new Map<string, Promise<BranchCheckoutSettlement>>()
  );
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
    chatGroups,
    commandChatGroups,
    composerDisabledHint,
    composerContextStats,
    composerUsageStats,
    compatibleSearchOptionIds,
    currentErrorText,
    currentModel,
    currentParameterControls,
    liveArtifactSummary,
    projectSettingsFolder,
    searchOptions,
    selectedProviderName,
    threadFollowKey,
    threadReadingAnchorKey,
  } = usePowerAppShellViewModel({
    activeChatId,
    activeChatStreaming: Boolean(activeChatStream),
    activeThreadUsageStats: activeThread.usageStats,
    attachments,
    catalog,
    chatContentMatchIds,
    chatQuery,
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
    selectedSearchStrategy,
    visibleMessages
  });

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
    makeCurrentModelDefault,
    removeAssistantFromComposer,
    selectModel,
    selectSearchPlan,
    selectSearchStrategy,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    toggleToolActivityVisibility,
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

  function resumeChatRun(chat: ChatSummary) {
    void runLifecycleActions.resumeChatRun(chat);
  }

  const {
    activateBlankWorkspace,
    activateChat,
    applyChatUpdate,
    createChat,
    deleteChat,
    exportChat,
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
    chatMutation: workspaceInteraction.chatMutation,
    confirmDeleteChat: shellOverlays.confirmations.chat.request,
    loadingChatDetailIdRef,
    resumeChatRun,
    setNotice,
    setSelectedModelId,
    setSelectedProvider,
    setSelectedSearchPlan,
    workspaceRefreshPromiseRef
  });

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
            nextCatalog.defaults.searchStrategyId,
            nextCatalog.searchStrategies
          );
          setSelectedSearchPlan(defaultSearchPlan.optionIds, defaultSearchPlan.mode, "system");
          setShowCitations(nextCatalog.defaults.showCitations);
          setShowReasoningBlocks(nextCatalog.defaults.showReasoningBlocks);
          setShowToolActivity(nextCatalog.defaults.showToolActivity);
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

  const assistantLibraryActions = createAssistantLibraryActions({
    activateBlankWorkspace: () => activateBlankWorkspaceEvent(),
    applyAssistantToComposer,
    catalog,
    catalogError,
    retryCatalog: () => void retryCatalog(),
    setShellNotice: setNotice
  });
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
    catalog,
    chatGroups: commandChatGroups,
    chats,
    changeInspectorMode: setInspectorModeManually,
    closePalette: shellOverlays.palette.close,
    inspectorMode,
    inspectorPinningAvailable,
    openLibrary: () => assistantLibraryActions.openLibrary("discover"),
    openSettings: openGeneralSettings,
    searchOptions,
    selectModel,
    selectSearchStrategy,
    selectedModelId,
    selectedProvider,
    selectedSearchStrategy,
    settingsOpen: settingsOpen || librarySnapshot.open,
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
    closeChatActions: workspaceInteraction.chatMutation.closeActions,
    confirmDeleteMessage: shellOverlays.confirmations.message.request,
    openShareDialog(target) {
      shellOverlays.mobileWorkspace.close();
      setShareDialogTarget(target);
    },
    pendingBranchCheckouts,
    refreshActiveChat,
    resetThreadToLatest,
    setNotice,
    activeChatStreaming
  });

  const { regenerateMessage, sendStarterPrompt, submitComposer } = useMessageRunActions({
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
    handleRegenerateMessage,
    openDetails
  } = useShellUiActions({
    branchChatFromMessage,
    copyMessage,
    deleteMessage,
    regenerateMessage,
    setInspectorActiveTab: setInspectorActiveTabManually,
    setInspectorMode: setInspectorModeManually
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
    accountEmail,
    activeChatId,
    activeChatTitle,
    adminEntryVisible,
    dismissNotice: () => setNotice(null),
    notice,
    shareActiveBranch
  } satisfies ShellSessionView;

  const workspacePaneView = {
    actions: {
      ...workspaceInteraction.paneActions,
      activateChat,
      changeChatQuery: setChatQuery,
      createChat: activateBlankWorkspace,
      createFolder,
      deleteChat,
      deleteFolder,
      exportChat,
      moveChat: updateChatFolder,
      moveFolder: updateFolderParent,
      retry: retryWorkspace,
      saveChatTitle: renameChat,
      saveFolder: renameFolder,
      shareChat,
      toggleChatFavorite
    },
    state: {
      ...workspaceInteraction.paneState,
      activeRunChatIds,
      chatContentMatchIds,
      chatContentSearchError,
      chatContentSearchLoading,
      chatGroups,
      chatQuery,
      creatingChat,
      folders,
      workspaceError,
      workspaceLoading,
      workspaceReady
    }
  } satisfies ShellWorkspacePaneView;

  const workspaceView = {
    mobile: {
      close: shellOverlays.mobileWorkspace.close,
      dialogRef: shellOverlays.mobileWorkspace.dialogRef,
      open: shellOverlays.mobileWorkspace.open,
      show: shellOverlays.mobileWorkspace.show
    },
    pane: workspacePaneView,
    projectSettings: {
      changeDraft: workspaceInteraction.projectSettings.changeDraft,
      close: workspaceInteraction.projectSettings.close,
      draft: projectMemoryDraft,
      folder: projectSettingsFolder,
      save: saveProjectSettings
    }
  } satisfies ShellWorkspaceView;

  const threadView = {
    activeChatDetailError,
    activeChatDetailLoading,
    activeChatStreaming,
    copyVisibleThread,
    currentRunId,
    editingMessageId,
    editingMessagePending,
    handleBranchFromMessage,
    handleCopyMessage,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleThreadScroll,
    jumpToLatest,
    lastRun: activeRunSurface.lastRun,
    liveArtifactSummary,
    retryActiveChatDetail,
    showJumpToLatest,
    threadScrollRef,
    visibleMessages
  } satisfies ShellThreadView;

  const composerView = {
    attachments,
    backgroundMode,
    compatibleSearchOptionIds,
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
      openLibrary: () => assistantLibraryActions.openLibrary("discover"),
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
    flushPendingModelControlDefaults: flushPendingModelControlDefaultsEvent,
    maxOutputTokens,
    makeCurrentModelDefault,
    notificationSoundEnabled,
    operationError: composerSession.operationError,
    operationErrorLive: composerSession.operationErrorLive,
    reasoningEffort,
    reasoningMode,
    retryCatalog,
    searchOptions,
    searchPreferenceSource: catalog?.defaults.searchPreferenceSource ?? "personal",
    searchPlanMode,
    selectModel,
    selectSearchPlan,
    selectSearchStrategy,
    selectedModelId,
    selectedProvider,
    selectedProviderName,
    selectedSearchOptionIds,
    selectedSearchStrategy,
    showCitations,
    showReasoningBlocks,
    showToolActivity,
    stopCurrentRun,
    streamMode,
    submitComposer,
    temperature,
    toggleCitationsVisibility,
    toggleNotificationSound,
    toggleReasoningBlockVisibility,
    toggleToolActivityVisibility,
    useOrganizationSearchDefault,
    useOrganizationModelDefault,
    uploadFiles,
    uploading
  } satisfies ShellComposerView;

  const detailsView = {
    activeLeafId: renderActiveLeafId,
    activeTab: inspectorActiveTab,
    changeActiveTab: setInspectorActiveTabManually,
    changeMode: setInspectorModeManually,
    checkoutBranch,
    errorText: currentErrorText,
    events: activeRunSurface.events,
    messages,
    mode: inspectorMode,
    open: openDetails,
    pinningAvailable: inspectorPinningAvailable
  } satisfies ShellDetailsView;

  const settingsView = {
    closeSettings: closeGeneralSettings,
    dismissNotice: () => setSettingsNotice(null),
    library: buildAssistantLibraryView(
      {
        activateBlankWorkspace: () => activateBlankWorkspaceEvent(),
        applyAssistantToComposer,
        catalog,
        catalogError,
        retryCatalog: () => void retryCatalog(),
        setShellNotice: setNotice
      },
      assistantLibraryActions,
      librarySnapshot
    ),
    notice: settingsNotice,
    open: openGeneralSettings,
    openLibrary: () => assistantLibraryActions.openLibrary("discover"),
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
    <PowerAppShellView
      composer={composerView}
      details={detailsView}
      overlays={overlaysView}
      session={sessionView}
      settings={settingsView}
      thread={threadView}
      workspace={workspaceView}
    />
  );
}
