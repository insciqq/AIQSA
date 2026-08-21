"use client";

import { unsupportedAttachmentMessage } from "@/components/app-shell/attachmentCapabilities";
import {
  attachmentCountSelectionLimitMessage,
  withAttachmentLimitFeedbackMessage,
  withoutAttachmentLimitFeedbackMessage
} from "@/components/app-shell/attachmentLimitUsage";
import { reconcileCurrentComposerAttachments } from "@/components/app-shell/attachmentReconciliation";
import {
  useComposerControlStore
} from "@/components/app-shell/composerControlStore";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  composerSessionModeFromKey,
  selectActiveComposerSession,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import { createFolderActions } from "@/components/app-shell/folderActions";
import { useMessageRunActions } from "@/components/app-shell/messageRunActions";
import {
  activateMemorySettings,
  deactivateMemorySettings,
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { PowerAppShellV2View } from "@/features/workspace-v2/PowerAppShellV2View";
import { KnowledgeCitationViewerProvider } from "@/features/citations-v2/KnowledgeCitationViewer";
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
import { fetchKnowledgeSources } from "@/components/knowledge/knowledgeApi";
import {
  refreshSkillLibrary,
  useSkillLibraryStore
} from "@/components/app-shell/skillLibraryStore";
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
  sessionExpiredLoginHref,
  shellFetch,
  subscribeToSessionExpired
} from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import {
  clearSessionExpiredDraft,
  rememberSessionExpiredDraft
} from "@/components/app-shell/shellStorage";
import type { SettingsMutationCoordinator } from "@/components/app-shell/settingsMutationCoordinator";
import {
  createThreadActions,
  type BranchCheckoutSettlement
} from "@/components/app-shell/threadActions";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import { useAnswerNotification } from "@/components/app-shell/useAnswerNotification";
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
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import {
  deactivateArchivedChats,
  openArchivedChats,
  removePermanentlyDeletedArchivedChat,
  useArchivedChatsStore
} from "@/components/app-shell/archivedChatsStore";
import {
  activatePermanentChatDeletionAccount,
  deactivatePermanentChatDeletionAccount,
  openPermanentChatDeletion
} from "@/components/app-shell/permanentChatDeletionStore";
import {
  loadChatMemoryState,
  patchChatMemoryMode
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
  Notice
} from "@/components/app-shell/types";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memoryClient";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type SavedControlDraft
} from "@/components/app-shell/powerAppShellData";
import { useBranchGraphController } from "./useBranchGraphController";
import {
  revealPersonalChatDeepLinkMessage,
  usePersonalChatDeepLink
} from "./usePersonalChatDeepLink";
import { useWorkspaceBootstrapController } from "./useWorkspaceBootstrapController";
import { useProjectWorkspaceController } from "@/features/projects-v2/useProjectWorkspaceController";
import type { ProjectDetailWire } from "@/lib/contracts/projects";

export {
  runCatalogLoadDeduped,
  workspaceDefaultControlsFingerprint
} from "./useWorkspaceBootstrapController";

/** Project catalogs are server-authored authority projections, never a
 * filtered copy of the current member's personal catalog. */
export function effectiveProjectCatalog(
  catalog: Catalog | null,
  project: ProjectDetailWire | null
): Catalog | null {
  return project ? project.composer?.catalog ?? null : catalog;
}

export function effectiveComposerDisabledHint(input: Readonly<{
  personalHint: string | null;
  projectContext: boolean;
  projectHint: string | null;
}>): string | null {
  return input.projectContext ? input.projectHint : input.personalHint;
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
    activateMemorySettings(accountId);
    return () => {
    deactivateArchivedChats();
    deactivateMcpSettings();
    deactivateMemoryManager();
      deactivateMemorySettings(accountId);
    };
  }, [accountId]);
  const activeThread = useThreadStore((state) => selectThreadSnapshot(state, activeChatId));
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
  const knowledgeSelection = useComposerControlStore((state) => state.knowledgeSelection);
  const selectedKnowledgeBaseIds = useComposerControlStore((state) => state.selectedKnowledgeBaseIds);
  const assistantRemovedNotice = useComposerControlStore((state) => state.assistantRemovedNotice);
  const selectedModelId = useComposerControlStore((state) => state.selectedModelId);
  const selectedProvider = useComposerControlStore((state) => state.selectedProvider);
  const selectedSearchOptionIds = useComposerControlStore((state) => state.selectedSearchOptionIds);
  const selectedSkills = useComposerControlStore((state) => state.selectedSkills);
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
  const skillSnapshot = useSkillLibraryStore();
  const appearance = useShellAppearanceController();
  const { change: changeTheme, id: themeId } = appearance.theme;
  const workspaceInteraction = useWorkspaceInteractionController();
  const projectSettingsFolderId = workspaceInteraction.projectSettings.folderId;
  const projectKnowledgeBaseIds = workspaceInteraction.projectSettings.knowledgeBaseIds;
  const shellOverlays = useShellOverlayController();
  const uploading = composerSession.pendingUploadGenerations.length > 0;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<Notice | null>(null);
  const [shareDialogTarget, setShareDialogTarget] = useState<ShareDialogTarget | null>(null);
  const [memoryResumeTarget, setMemoryResumeTarget] = useState<WorkspaceChatSummary | null>(null);
  const [personalReadingAnchor, setPersonalReadingAnchor] = useState<Readonly<{
    chatId: string;
    messageId: string;
  }> | null>(null);
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
  const runCatalogRef = useRef<Catalog | null>(catalog);
  const projectRunContextRef = useRef(false);
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

  const consumePersonalReadingAnchor = useEventCallback((anchorKey: string) => {
    setPersonalReadingAnchor((current) =>
      current?.chatId === activeChatId && current.messageId === anchorKey ? null : current
    );
  });
  const {
    activeChat,
    activeChatStreaming,
    activeChatTitle,
    composerDisabledHint,
    composerContextStats,
    composerUsageStats,
    currentModel,
    currentParameterControls,
    liveArtifactSummary,
    projectSettingsFolder,
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
    selectedSkillPromptCharacterCount: selectedSkills.reduce(
      (total, skill) => total + skill.promptCharacterCount,
      0
    ),
    selectedModelId,
    selectedProvider,
    visibleMessages
  });
  const readingAnchorKey = personalReadingAnchor?.chatId === activeChatId
    ? personalReadingAnchor.messageId
    : threadReadingAnchorKey;
  const { branchGraph, loadBranchGraph } = useBranchGraphController({
    activeChatId,
    activeChatStreaming,
    branchDrawerOpen: shellOverlays.branches.open,
    chats
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
    onReadingAnchorApplied: consumePersonalReadingAnchor,
    readingAnchorKey,
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
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    useOrganizationModelDefault,
    useOrganizationSearchDefault
  } = useRunControlsActions({
    allowPersonalPersistence: () => !projectRunContextRef.current,
    catalog,
    currentModel,
    pendingControlDefaultsRef,
    pendingControlDefaultsTimerRef,
    resolveCatalog: () => runCatalogRef.current,
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
    activatePersonalChatById,
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
  const activatePersonalChatDeepLink = useEventCallback(async (chatId: string) =>
    Boolean(await activatePersonalChatById(chatId))
  );
  const revealPersonalChatMessage = useEventCallback(async (
    chatId: string,
    messageId: string
  ): Promise<boolean> => revealPersonalChatDeepLinkMessage({
    current: () => {
      const snapshot = selectThreadSnapshot(useThreadStore.getState(), chatId);
      const history = threadHistoryState(snapshot);
      return {
        beforeCursor: history.beforeCursor,
        hasOlder: history.hasOlder,
        messageIds: selectThreadVisibleMessages(snapshot).map((message) => message.id)
      };
    },
    loadEarlier: async () => await loadEarlierMessagesPage(chatId) !== "failed",
    messageId
  }));
  const anchorPersonalChatMessage = useEventCallback((chatId: string, messageId: string) => {
    setPersonalReadingAnchor({ chatId, messageId });
  });
  const showUnavailableMemorySource = useEventCallback(() => {
    setNotice({ kind: "error", text: memoryUiCopy("source.unavailableBody") });
  });
  usePersonalChatDeepLink({
    activateChat: activatePersonalChatDeepLink,
    onAnchor: anchorPersonalChatMessage,
    onUnavailable: showUnavailableMemorySource,
    ready: workspaceReady,
    revealMessage: revealPersonalChatMessage
  });

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


  const retryActiveChatDetail = useEventCallback(() => {
    const chat = chats.find((candidate) => candidate.id === activeChatId);
    if (chat) {
      void activateChat(chat, { preserveControls: true });
    }
  });

  const {
    activateBlankWorkspaceEvent,
    retryCatalog,
    retryWorkspace
  } = useWorkspaceBootstrapController({
    accountEmail,
    activateBlankWorkspace,
    applyControlDefaults,
    reapplyActiveChatDefaults,
    refreshWorkspace,
    setCatalog,
    setCatalogError,
    setSelectedModelId,
    setSelectedProvider,
    setSelectedSearchPlan,
    setShowCitations,
    setShowReasoningBlocks,
    workspaceRefreshPromiseRef
  });

  const knowledgeLibraryActions = useMemo(() => createKnowledgeLibraryActions(), []);
  useEffect(() => {
    if (!knowledgeSnapshot.sourceData) {
      void knowledgeLibraryActions.refreshSources();
    }
  }, [knowledgeLibraryActions, knowledgeSnapshot.sourceData]);
  const searchComposerKnowledgeSources = useEventCallback(async (query: string) => {
    const result = await fetchKnowledgeSources({ filter: "all", page: 1, pageSize: 100, query });
    if (!result.ok) return [];
    return result.data.sources.map((source) => ({
      description: source.description,
      id: source.id,
      name: source.name,
      owned: source.owned,
      readiness: source.readiness.state
    }));
  });
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
    knowledgeSources: (knowledgeSnapshot.sourceData?.sources ?? []).map((source) => ({
      available: source.readiness.state === "ready",
      id: source.id,
      name: source.name
    })),
    knowledgeDataError: knowledgeSnapshot.dataError,
    knowledgeDataState: knowledgeSnapshot.dataState,
    retryCatalog: () => void retryCatalog(),
    retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
    retrySkills: () => void refreshSkillLibrary(true).catch(() => undefined),
    setShellNotice: setNotice,
    skillDataError: skillSnapshot.error,
    skillDataState: skillSnapshot.loadState === "error"
      ? "error"
      : skillSnapshot.loadState === "ready" ? "ready" : "loading",
    skills: skillSnapshot.data?.skills ?? []
  });

  const applyProjectAssistant = useEventCallback((
    project: ProjectDetailWire,
    assistantId: string | null
  ): boolean => {
    if (!assistantId) {
      removeAssistantFromComposer();
      return true;
    }
    const projectAssistant = project.composer?.assistants.find(
      (assistant) => assistant.summary.id === assistantId
    );
    const skillsById = new Map(project.resources.flatMap((resource) =>
      resource.type === "skill"
        ? [[resource.resourceId, resource.label] as const]
        : []
    ));
    if (!projectAssistant || !applyAssistantToComposer({
      assistant: {
        avatar: projectAssistant.summary.avatar,
        description: projectAssistant.summary.description,
        id: projectAssistant.summary.id,
        includedSkills: projectAssistant.revision.skillIds.map((id) => ({
          id,
          name: skillsById.get(id) ?? "Project Skill"
        })),
        name: projectAssistant.summary.name,
        promptCharacterCount: projectAssistant.promptCharacterCount,
        starterPrompts: projectAssistant.summary.starterPrompts
      },
      revision: projectAssistant.revision
    })) {
      removeAssistantFromComposer();
      return false;
    }
    return true;
  });

  const applyProjectDefaults = useEventCallback((
    project: ProjectDetailWire,
    chat: WorkspaceChatSummary
  ) => {
    const model = (project.composer?.catalog ?? catalog)?.models.find((candidate) =>
      candidate.provider === chat.defaultProvider && candidate.modelId === chat.defaultModelId
    );
    setSelectedProvider(model?.provider ?? chat.defaultProvider, "system");
    setSelectedModelId(model?.modelId ?? chat.defaultModelId, "system");
    setSelectedSearchPlan(
      project.defaults.searchPlan.optionIds,
      project.defaults.searchPlan.mode,
      "system"
    );
    setSelectedKnowledgePlan(
      chat.defaultKnowledgePlan ?? project.defaults.knowledgePlan,
      "project",
      "system"
    );
    applyModelControlDefaults(model, model ? {
      [`${model.provider}:${model.modelId}`]: project.defaults.controlValues
    } : {});
    useComposerControlStore.getState().setSelectedSkills([]);
    useComposerControlStore.getState().setMcpSelection({
      mode: project.policy.externalToolsEnabled ? project.defaults.mcpMode : "off"
    });
    applyProjectAssistant(project, project.defaults.assistantId);
  });

  const onProjectAccessLost = useEventCallback((chatIds: readonly string[]) => {
    for (const chatId of chatIds) {
      activeStreamAbortRef.current.get(chatId)?.abort();
      activeStreamAbortRef.current.delete(chatId);
      chatDetailRequestsRef.current.delete(chatId);
      useRunLifecycleStore.getState().streamFinished({ chatId });
      useRunLifecycleStore.getState().ambiguityCleared({ chatId });
      useThreadStore.getState().removeThread(chatId);
      useRunSurfaceStore.getState().removeSurface(chatId);
      useComposerSessionStore.getState().removeSession(composerSessionKey(chatId));
    }
  });

  const projectWorkspace = useProjectWorkspaceController({
    accountId,
    activeChatId,
    activateBlankWorkspace,
    activateChat,
    applyProjectDefaults,
    isLocallyStreaming: (chatId) => Boolean(useRunLifecycleStore.getState().activeStreams[chatId]),
    onProjectAccessLost,
    preferredModelId: selectedModelId || undefined,
    refreshActiveChat,
    setNotice
  });
  const selectProject = projectWorkspace.actions.selectProject;
  const selectProjectChat = projectWorkspace.actions.selectChat;
  const projectDeepLinkRef = useRef<{ key: string; phase: "handled" | "opening" | "selecting" | "waiting" } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || projectWorkspace.listLoading) return;
    const url = new URL(window.location.href);
    const projectId = url.searchParams.get("project");
    const chatId = url.searchParams.get("chat");
    if (!projectId || !chatId) return;
    const key = `${projectId}:${chatId}`;
    if (projectDeepLinkRef.current?.key !== key) {
      projectDeepLinkRef.current = { key, phase: "waiting" };
    }
    const request = projectDeepLinkRef.current;
    if (!request || request.phase === "handled" || request.phase === "opening" || request.phase === "selecting") {
      return;
    }
    if (projectWorkspace.selectedProjectId !== projectId) {
      request.phase = "selecting";
      void selectProject(projectId).then((selected) => {
        request.phase = selected ? "waiting" : "handled";
        if (!selected) {
          setNotice({ kind: "error", text: "That Project chat is unavailable." });
        }
      });
      return;
    }
    if (!projectWorkspace.detail || !projectWorkspace.workspace) return;
    if (!projectWorkspace.workspace.chats.some((chat) => chat.id === chatId)) {
      request.phase = "handled";
      queueMicrotask(() => setNotice({ kind: "error", text: "That Project chat is unavailable." }));
      return;
    }
    request.phase = "opening";
    void selectProjectChat(chatId).then((opened) => {
      request.phase = "handled";
      if (!opened) setNotice({ kind: "error", text: "That Project chat is unavailable." });
    });
  }, [
    projectWorkspace.detail,
    projectWorkspace.listLoading,
    projectWorkspace.selectedProjectId,
    projectWorkspace.workspace,
    selectProject,
    selectProjectChat
  ]);
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
    // Personal Memory is not a Project capability. This callback is also
    // passed to answer actions, so guard it even when a stale action arrives
    // after navigation into a shared Project.
    if (activeChat?.projectId || (!activeChat && projectWorkspace.selectedProjectId)) {
      closeMemoryWorkspace();
      return;
    }
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

  const { consumeRunStream, createStreamTokenBuffer } = useRunStreaming({
    applyChatUpdate
  });

  const runLifecycleActions = useRunLifecycleActions({
    activeChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    notifyAnswerReady,
    projectIdForChat: (chatId) => chatId
      ? useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId)?.projectId ?? null
      : null,
    refreshActiveChat,
    setNotice
  });
  const { fetchRun, retryAttachment, stopCurrentRun, uploadFiles } = runLifecycleActions;

  // A selected Project is a local blank context until the first send.  Route
  // that send through the Project chat endpoint so opening the Project never
  // creates an empty server chat or accidentally creates a personal chat.
  const createChatForSend = useEventCallback(async (
    folderId?: string | null,
    sourceSessionKey?: ComposerSessionKey
  ): Promise<WorkspaceChatSummary | null> => {
    if (projectWorkspace.selectedProjectId && !activeChatId) {
      return projectWorkspace.actions.createChatForSend(folderId);
    }
    return createChat(folderId, sourceSessionKey);
  });

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
    createChat: createChatForSend,
    createStreamTokenBuffer,
    currentModel,
    fetchRun,
    notifyAnswerReady,
    openMemorySettings: openMemoryWorkspace,
    persistActiveLeaf,
    primeAnswerSound,
    refreshActiveChat,
    resolveCatalog: () => runCatalogRef.current,
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
    copyProjectChatLink: async () => {
      const workspace = useWorkspaceStore.getState();
      const chat = workspace.activeChatId
        ? workspace.chats.find((candidate) => candidate.id === workspace.activeChatId)
        : null;
      if (!chat?.projectId) {
        setNotice({ kind: "error", text: "No Project chat is open." });
        return;
      }
      try {
        const destination = new URL("/", window.location.origin);
        destination.searchParams.set("project", chat.projectId);
        destination.searchParams.set("chat", chat.id);
        await writeClipboardText(destination.toString());
        setNotice({ kind: "success", text: "Project chat link copied." });
      } catch (error) {
        setNotice({ kind: "error", text: `Could not copy the Project chat link: ${errorMessage(error)}` });
      }
    },
    dismissNotice: () => setNotice(null),
    notice,
    shareActiveBranch
  } satisfies ShellSessionView;

  function updateChatMemoryMode(chatId: string, mode: "EXCLUDED" | "NORMAL"): void {
    useWorkspaceStore.getState().updateChats((current) => current.map((candidate) =>
      candidate.id === chatId
        ? {
            ...candidate,
            memoryMode: mode
          }
        : candidate
    ));
  }

  async function commitChatMemoryMode(
    chat: WorkspaceChatSummary,
    patch: Readonly<{ mode: "EXCLUDED" }> | Readonly<{
      mode: "NORMAL";
      resumeDisclosureCopyVersion: typeof MEMORY_CONFIRMATION_COPY_VERSION;
    }>
  ): Promise<void> {
    if (memorySourceMutationIdsRef.current.has(chat.id)) return;
    memorySourceMutationIdsRef.current.add(chat.id);
    try {
      const source = await loadChatMemoryState(chat.id);
      if (source.mode === "TEMPORARY") {
        throw new Error("memory_temporary_chat_forbidden");
      }
      if (source.mode === patch.mode) {
        updateChatMemoryMode(chat.id, source.mode);
        return;
      }
      const response = patch.mode === "NORMAL"
        ? await patchChatMemoryMode({
            chatId: chat.id,
            mode: "NORMAL",
            resumeDisclosureCopyVersion: patch.resumeDisclosureCopyVersion
          })
        : await patchChatMemoryMode({
            chatId: chat.id,
            mode: "EXCLUDED"
          });
      if (response.mode === "TEMPORARY") {
        throw new Error("memory_temporary_chat_forbidden");
      }
      updateChatMemoryMode(chat.id, response.mode);
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

  async function toggleChatMemorySource(
    chat: WorkspaceChatSummary,
    mode: "EXCLUDED" | "NORMAL"
  ): Promise<void> {
    if (mode === "EXCLUDED") {
      await commitChatMemoryMode(chat, { mode: "EXCLUDED" });
      return;
    }
    if (memorySourceMutationIdsRef.current.has(chat.id)) return;
    memorySourceMutationIdsRef.current.add(chat.id);
    try {
      const source = await loadChatMemoryState(chat.id);
      if (source.mode === "TEMPORARY") {
        throw new Error("memory_temporary_chat_forbidden");
      }
      if (source.mode === "NORMAL") {
        updateChatMemoryMode(chat.id, source.mode);
        return;
      }
      setMemoryResumeTarget(chat);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      memorySourceMutationIdsRef.current.delete(chat.id);
    }
  }

  /**
   * Direct "Delete…" entry opens the confirmation surface. The confirmed POST
   * reads and fences the authoritative chat snapshot on the server; the browser
   * never carries deletion authorization or lifecycle identifiers.
   */
  function deleteChatPermanently(chat: WorkspaceChatSummary): void {
    openPermanentChatDeletion({
      chatId: chat.id,
      location: "WORKSPACE",
      title: chat.title
    });
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
    projects: projectWorkspace,
    projectSettings: {
      changeKnowledgeBaseIds: workspaceInteraction.projectSettings.changeKnowledgeBaseIds,
      close: workspaceInteraction.projectSettings.close,
      folder: projectSettingsFolder,
      knowledgeBaseIds: projectKnowledgeBaseIds,
      knowledgeBases: knowledgeSnapshot.data?.knowledgeBases ?? [],
      knowledgeDataError: knowledgeSnapshot.dataError,
      knowledgeDataState: knowledgeSnapshot.dataState,
      retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
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
    retryActiveChatDetail,
    showJumpToLatest,
    threadScrollRef,
    visibleMessages
  } satisfies ShellThreadView;

  // Keep the selected Project context alive while the user is on its local
  // blank-chat composer.  The previous projection only considered an active
  // server chat, which made a freshly selected Project fall back to the
  // personal catalog until an empty chat was created.
  const activeProject = projectWorkspace.detail && (
    activeChat?.projectId === projectWorkspace.detail.id ||
    (!activeChat && projectWorkspace.selectedProjectId === projectWorkspace.detail.id)
  )
    ? projectWorkspace.detail
    : null;
  const activeProjectChat = activeProject && activeChat
    ? projectWorkspace.workspace?.chats.find((chat) => chat.id === activeChat.id) ?? null
    : null;
  const activeProjectModels = activeProject?.resources.filter((resource) =>
    resource.type === "model" && resource.available
  ) ?? [];
  const projectContext = Boolean(
    activeChat?.projectId || (!activeChat && projectWorkspace.selectedProjectId)
  );
  const projectCatalog = activeProject
    ? effectiveProjectCatalog(catalog, activeProject)
    : projectContext ? null : catalog;
  useEffect(() => {
    runCatalogRef.current = projectCatalog;
    projectRunContextRef.current = projectContext;
  }, [projectCatalog, projectContext]);
  const projectCurrentModel = projectContext
    ? projectCatalog?.models.find((model) =>
        model.provider === selectedProvider && model.modelId === selectedModelId
      )
    : undefined;
  const effectiveCurrentModel = projectContext ? projectCurrentModel : currentModel;
  const effectiveParameterControls = projectContext
    ? defaultParameterControls(projectCurrentModel)
    : currentParameterControls;
  const projectAssistantItems = activeProject?.composer?.assistants ?? [];
  const projectBlankDefaultsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProject || activeChat) {
      if (!activeProject) projectBlankDefaultsRef.current = null;
      return;
    }
    const defaultsKey = `${activeProject.id}:${activeProject.policyRevision}`;
    if (projectBlankDefaultsRef.current === defaultsKey) return;
    projectBlankDefaultsRef.current = defaultsKey;
    const defaultResource = activeProject.resources.find((resource) =>
      resource.type === "model" && resource.available &&
      resource.resourceId === activeProject.defaults.providerModelId
    );
    if (defaultResource?.provider && defaultResource.modelId) {
      const model = projectCatalog?.models.find((candidate) =>
        candidate.provider === defaultResource.provider && candidate.modelId === defaultResource.modelId
      );
      setSelectedProvider(defaultResource.provider, "system");
      setSelectedModelId(defaultResource.modelId, "system");
      applyModelControlDefaults(model, model ? {
        [`${model.provider}:${model.modelId}`]: activeProject.defaults.controlValues
      } : {});
    }
    setSelectedSearchPlan(
      activeProject.defaults.searchPlan.optionIds,
      activeProject.defaults.searchPlan.mode,
      "system"
    );
    setSelectedKnowledgePlan(activeProject.defaults.knowledgePlan, "project", "system");
    useComposerControlStore.getState().setSelectedSkills([]);
    useComposerControlStore.getState().setMcpSelection({
      mode: activeProject.policy.externalToolsEnabled ? activeProject.defaults.mcpMode : "off"
    });
    applyProjectAssistant(activeProject, activeProject.defaults.assistantId);
  }, [
    activeChat,
    activeProject,
    applyModelControlDefaults,
    applyProjectAssistant,
    projectCatalog,
    setSelectedKnowledgePlan,
    setSelectedModelId,
    setSelectedProvider,
    setSelectedSearchPlan
  ]);
  const activeModelLinkedToProject = !activeProject || Boolean(effectiveCurrentModel && activeProjectModels.some(
    (resource) => resource.provider === effectiveCurrentModel.provider &&
      (resource.modelId ?? resource.resourceId) === effectiveCurrentModel.modelId
  ));
  const projectComposerDisabledHint = projectContext
    ? !activeProject
      ? "Project access is being revalidated."
      : activeProject.status !== "ACTIVE"
        ? "This project is archived and read-only."
        : activeProjectChat?.archived
          ? "This shared chat is archived and read-only."
        : !activeProject.capabilities.mutateChats
          ? "Viewer access is read-only. Ask a project manager for Contributor access."
          : activeProjectModels.length === 0
            ? activeProject.capabilities.manageProject
              ? "No model is linked to this project. Add a model in Project Settings."
              : "This project needs a model before contributors can send messages."
            : !activeModelLinkedToProject
              ? "Choose a model linked to this project."
              : null
    : null;

  const composerView = {
    attachments,
    backgroundMode,
    catalog: projectCatalog,
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
      openLibrary: projectContext ? projectWorkspace.actions.openSettings : openAssistantLibrary,
      openPicker: assistantPickerOpen,
      pickerItems: projectContext
        ? activeProject ? projectAssistantItems.map((assistant) => assistant.summary) : []
        : librarySnapshot.data?.assistants ?? [],
      pickerLoading: projectContext
        ? !activeProject
        : librarySnapshot.dataState === "loading" && !librarySnapshot.data,
      recentIds: recentAssistantIds,
      remove: removeAssistantFromComposer,
      removedNotice: assistantRemovedNotice,
      selectById: (assistantId: string) => {
        setAssistantPickerOpen(false);
        if (projectContext) {
          if (!activeProject) {
            setNotice({ kind: "error", text: "Project access is still being revalidated." });
            return;
          }
          const applied = applyProjectAssistant(activeProject, assistantId);
          if (!applied) setNotice({ kind: "error", text: "This Project Assistant is no longer available." });
          return;
        }
        void assistantLibraryActions.useAssistant(assistantId, { navigate: false });
      },
      selected: selectedAssistant,
      sendStarter: (prompt: string) => void sendStarterPrompt(prompt),
      setPickerOpen: setAssistantPickerOpenEvent,
      startFromCurrentSetup: () => {
        setAssistantPickerOpen(false);
        if (projectContext) projectWorkspace.actions.openSettings();
        else assistantLibraryActions.openNewAssistantFromCurrentSetup();
      }
    },
    composerContextStats,
    composerDisabledHint: effectiveComposerDisabledHint({
      personalHint: composerDisabledHint,
      projectContext,
      projectHint: projectComposerDisabledHint
    }),
    composerUsageStats,
    currentModel: effectiveCurrentModel,
    currentParameterControls: effectiveParameterControls,
    draft,
    knowledge: {
      bases: projectContext
        ? activeProject?.composer?.knowledgeBases ?? []
        : knowledgeSnapshot.data?.knowledgeBases ?? [],
      searchSources: projectContext ? undefined : searchComposerKnowledgeSources,
      select: (selection) => setSelectedKnowledgePlan(selection, "explicit", "user"),
      selection: knowledgeSelection,
      sources: projectContext
        ? activeProject?.composer?.knowledgeSources ?? []
        : (knowledgeSnapshot.sourceData?.sources ?? []).map((source) => ({
            description: source.description,
            id: source.id,
            name: source.name,
            owned: source.owned,
            readiness: source.readiness.state
          }))
    },
    // Project Skills are a separate publication boundary.  The personal
    // library remains available only after leaving Project context.
    maxOutputTokens,
    memory: {
      canToggleTemporary: projectContext ? false : canToggleTemporary,
      explanation: resolveMemoryCopy("temporary.explanation"),
      externalRetention: resolveMemoryCopy("temporary.externalRetention"),
      label: resolveMemoryCopy("temporary.label"),
      mode: projectContext ? "NORMAL" : composerTemporary ? "TEMPORARY" : "NORMAL",
      retention: resolveMemoryCopy("temporary.retention"),
      retentionDeadline: activeChat?.temporaryRetentionDeadline ?? null,
      toggleTemporary: projectContext ? () => undefined : toggleTemporaryComposer
    },
    makeModelDefault: projectContext ? undefined : makeModelDefault,
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
        knowledgeSources: (knowledgeSnapshot.sourceData?.sources ?? []).map((source) => ({
          available: source.readiness.state === "ready",
          id: source.id,
          name: source.name
        })),
        knowledgeDataError: knowledgeSnapshot.dataError,
        knowledgeDataState: knowledgeSnapshot.dataState,
        retryCatalog: () => void retryCatalog(),
        retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
        retrySkills: () => void refreshSkillLibrary(true).catch(() => undefined),
        setShellNotice: setNotice,
        skillDataError: skillSnapshot.error,
        skillDataState: skillSnapshot.loadState === "error"
          ? "error"
          : skillSnapshot.loadState === "ready" ? "ready" : "loading",
        skills: skillSnapshot.data?.skills ?? []
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
      cancelMemoryResume: () => setMemoryResumeTarget(null),
      cancelMessage: shellOverlays.confirmations.message.cancel,
      chat: shellOverlays.confirmations.chat.target,
      confirmChat: shellOverlays.confirmations.chat.confirm,
      confirmFolder: shellOverlays.confirmations.folder.confirm,
      confirmMemoryResume: () => {
        const target = memoryResumeTarget;
        setMemoryResumeTarget(null);
        if (target) {
          void commitChatMemoryMode(target, {
            mode: "NORMAL",
            resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
          });
        }
      },
      confirmMessage: shellOverlays.confirmations.message.confirm,
      folder: shellOverlays.confirmations.folder.target,
      memoryResume: memoryResumeTarget,
      message: shellOverlays.confirmations.message.target
    },
    share: {
      close: () => setShareDialogTarget(null),
      target: shareDialogTarget
    }
  } satisfies ShellOverlaysView;

  return (
    <KnowledgeCitationViewerProvider>
      <PowerAppShellV2View
        branches={branchesView}
        composer={composerView}
        overlays={overlaysView}
        session={sessionView}
        settings={settingsView}
        thread={threadView}
        workspace={workspaceView}
      />
    </KnowledgeCitationViewerProvider>
  );
}
