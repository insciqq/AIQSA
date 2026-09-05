"use client";

import {
  attachmentPolicyForModel,
  unsupportedAttachmentMessage
} from "@/components/app-shell/attachmentCapabilities";
import { partitionAttachmentSelection } from "@/components/app-shell/attachmentSelection";
import {
  attachmentCountSelectionLimitMessage,
  withAttachmentLimitFeedbackMessage,
  withoutAttachmentLimitFeedbackMessage
} from "@/components/app-shell/attachmentLimitUsage";
import { reconcileCurrentComposerAttachments } from "@/components/app-shell/attachmentReconciliation";
import {
  initialComposerControlSnapshot,
  useComposerControlStore,
  type ComposerControlSnapshot
} from "@/components/app-shell/composerControlStore";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  composerSessionModeFromKey,
  projectComposerSessionKey,
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
  liveWorkDurationMs,
  selectRunSurface,
  useRunSurfaceStore
} from "@/components/app-shell/runSurfaceStore";
import {
  chatSummaryFromApi,
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
import { useWorkspaceOutputReconciliation } from "@/components/app-shell/useWorkspaceOutputReconciliation";
import { useWorkspaceActions } from "@/components/app-shell/workspaceActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import {
  deactivateArchivedChats,
  removePermanentlyDeletedArchivedChat
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
  openPersonalChatMessage,
  revealPersonalChatDeepLinkMessage,
  usePersonalChatDeepLink
} from "./usePersonalChatDeepLink";
import { useWorkspaceBootstrapController } from "./useWorkspaceBootstrapController";
import { useProjectWorkspaceController } from "@/features/projects-v2/useProjectWorkspaceController";
import type { ProjectDetailWire } from "@/lib/contracts/projects";
import type { ComposerConfigKnowledgeBase } from "@/lib/contracts/composerConfig";
import type {
  KnowledgeBaseSummary,
  KnowledgeSourceListResponse
} from "@/lib/contracts/knowledge";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";
import type { RunEventView } from "@/lib/contracts/runs";
import {
  archiveChatWorkspace,
  loadWorkspaceAvailability,
  resetChatWorkspace,
  updateChatWorkspaceEnabled
} from "@/components/app-shell/workspaceClient";

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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A generic active model run is not enough to claim command execution. The
 * existing safe live tool events delimit the real Workspace tool phase. */
export function workspaceCommandRunning(events: readonly RunEventView[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    // A finished stream (Stop, error, completion) ends the tool phase even
    // when the last artifact was a transient `tool_call requested`.
    if (event.type === "done" || event.type === "error") return false;
    if (event.type !== "artifact") continue;
    const data = record(event.data);
    const payload = record(data?.payload);
    if (data?.artifactType === "summary" && payload?.stage === "model") return false;
    if (
      data?.artifactType === "tool_call" &&
      payload?.status === "requested" &&
      payload?.serverName === "Workspace"
    ) return true;
  }
  return false;
}

function personalComposerKnowledgeBase(
  base: KnowledgeBaseSummary
): ComposerConfigKnowledgeBase {
  return {
    archived: base.archived,
    attentionDocumentCount: base.readiness.attentionSources,
    description: base.description,
    documentCount: base.sourceCount,
    id: base.id,
    name: base.name,
    owned: base.owned,
    processingDocumentCount: base.readiness.processingSources,
    readinessState: base.readiness.state,
    readyDocumentCount: base.readiness.readySources
  };
}

function cloneComposerControlSnapshot(
  state: ComposerControlSnapshot
): ComposerControlSnapshot {
  return {
    ...state,
    assistantManualBackup: state.assistantManualBackup ? {
      ...state.assistantManualBackup,
      knowledgeSelection: {
        ...state.assistantManualBackup.knowledgeSelection,
        baseIds: [...state.assistantManualBackup.knowledgeSelection.baseIds],
        sourceIds: [...state.assistantManualBackup.knowledgeSelection.sourceIds]
      },
      mcpSelection: { ...state.assistantManualBackup.mcpSelection },
      selectedKnowledgeBaseIds: [...state.assistantManualBackup.selectedKnowledgeBaseIds],
      selectedSearchOptionIds: [...state.assistantManualBackup.selectedSearchOptionIds],
      selectedSkills: state.assistantManualBackup.selectedSkills.map((skill) => ({ ...skill }))
    } : null,
    knowledgeSelection: {
      ...state.knowledgeSelection,
      baseIds: [...state.knowledgeSelection.baseIds],
      sourceIds: [...state.knowledgeSelection.sourceIds]
    },
    mcpSelection: { ...state.mcpSelection },
    selectedAssistant: state.selectedAssistant ? {
      ...state.selectedAssistant,
      includedSkills: state.selectedAssistant.includedSkills?.map((skill) => ({ ...skill })),
      starterPrompts: [...state.selectedAssistant.starterPrompts]
    } : null,
    selectedKnowledgeBaseIds: [...state.selectedKnowledgeBaseIds],
    selectedSearchOptionIds: [...state.selectedSearchOptionIds],
    selectedSkills: state.selectedSkills.map((skill) => ({ ...skill }))
  };
}

export function capturePersonalComposerControls(
  ref: { current: ComposerControlSnapshot | null }
): void {
  if (ref.current) return;
  ref.current = cloneComposerControlSnapshot(useComposerControlStore.getState());
}

/**
 * Entering or switching Project authority is synchronous even though its
 * canonical defaults load asynchronously. Preserve the personal snapshot once,
 * then replace every run-scoped selection with a neutral disabled projection so
 * neither personal controls nor Project A can appear inside Project B.
 */
export function enterProjectComposerControlBoundary(
  ref: { current: ComposerControlSnapshot | null }
): void {
  capturePersonalComposerControls(ref);
  const current = useComposerControlStore.getState();
  const neutral = cloneComposerControlSnapshot(initialComposerControlSnapshot);
  useComposerControlStore.setState({
    ...neutral,
    mcpSelection: { mode: "off" },
    selectedModelId: "",
    selectedProvider: "",
    selectedSearchOptionIds: [],
    // Citation/reasoning visibility are local presentation preferences rather
    // than Project run authority, so do not flicker them during revalidation.
    showCitations: current.showCitations,
    showReasoningBlocks: current.showReasoningBlocks
  });
}

export function restorePersonalComposerControls(
  ref: { current: ComposerControlSnapshot | null }
): void {
  if (!ref.current) return;
  const current = useComposerControlStore.getState();
  useComposerControlStore.setState({
    ...cloneComposerControlSnapshot(ref.current),
    // These are account-level presentation preferences, not Project run
    // authority. Keep changes made while a Project was open.
    showCitations: current.showCitations,
    showReasoningBlocks: current.showReasoningBlocks
  });
  ref.current = null;
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
  const editingMessageDraft = composerSession.editingDraft;
  const editingMessageError = composerSession.editingError;
  const editingMessageId = composerSession.editingMessageId;
  const editingMessagePending = Boolean(composerSession.pendingEdit);
  const maxOutputTokens = useComposerControlStore((state) => state.maxOutputTokens);
  const reasoningEffort = useComposerControlStore((state) => state.reasoningEffort);
  const reasoningMode = useComposerControlStore((state) => state.reasoningMode);
  const selectedAssistant = useComposerControlStore((state) => state.selectedAssistant);
  const knowledgeSelection = useComposerControlStore((state) => state.knowledgeSelection);
  const knowledgePlanSource = useComposerControlStore((state) => state.knowledgePlanSource);
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
  const setEditingDraft = useComposerSessionStore((state) => state.setEditingDraft);
  const setSelectedModelId = useComposerControlStore((state) => state.setSelectedModelId);
  const setSelectedKnowledgePlan = useComposerControlStore((state) => state.setSelectedKnowledgePlan);
  const setSelectedProvider = useComposerControlStore((state) => state.setSelectedProvider);
  const setSelectedSearchPlan = useComposerControlStore((state) => state.setSelectedSearchPlan);
  const setShowCitations = useComposerControlStore((state) => state.setShowCitations);
  const setShowReasoningBlocks = useComposerControlStore((state) => state.setShowReasoningBlocks);
  const settingsOpen = useSettingsDestinationStore((state) => state.settingsOpen);
  const settingsSection = useSettingsDestinationStore((state) => state.settingsSection);
  const memoryOpen = useSettingsDestinationStore((state) => state.memoryOpen);
  const closeMemoryLibrary = useSettingsDestinationStore((state) => state.closeMemory);
  const openMemoryLibrary = useSettingsDestinationStore((state) => state.openMemoryLibrary);
  const openMemoryTab = useSettingsDestinationStore((state) => state.openMemoryTab);
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
  const [workspaceInstallation, setWorkspaceInstallation] =
    useState<ChatWorkspaceState | null>(null);
  const [workspaceCapabilityBusy, setWorkspaceCapabilityBusy] = useState(false);
  // The composer owns an unfiltered, first-page snapshot. Reusing the
  // Library's mutable query/page state would make its "All" total and recent
  // documents silently change after browsing the Library.
  const [composerKnowledgeData, setComposerKnowledgeData] =
    useState<KnowledgeSourceListResponse | null>(null);
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

  useEffect(() => {
    let current = true;
    void loadWorkspaceAvailability()
      .then((workspace) => {
        if (current) setWorkspaceInstallation(workspace);
      })
      .catch(() => {
        if (current) {
          setWorkspaceInstallation({
            available: false,
            enabled: false,
            internetEnabled: null,
            sessionState: null,
            unavailableReason: "runtime_unavailable"
          });
        }
      });
    return () => {
      current = false;
    };
  }, [accountId]);
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
  const personalComposerControlsRef = useRef<ComposerControlSnapshot | null>(null);
  const workspaceRefreshPromiseRef = useRef<Promise<ChatDetail | null> | null>(null);
  const workspaceCapabilityMutationRef = useRef(false);
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
      clearResolvedLimitFeedback,
      workspaceEnabled: activeChat?.workspace?.enabled ?? composerSession.workspaceEnabled
    });
    attachmentLimitContextsRef.current.set(
      activeComposerSessionKey,
      contextFingerprint
    );
  }, [
    activeChat?.workspace?.enabled,
    activeComposerSessionKey,
    attachments,
    catalog?.attachmentLimits,
    composerSession.workspaceEnabled,
    currentModel,
    uploading
  ]);

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
    setDefaultKnowledgePlan,
    setDefaultMcpMode,
    setDefaultSearchPlan,
    setSendWithEnter,
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
    createPersonalChatForSend,
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
  useWorkspaceOutputReconciliation({
    accountId, chatId: activeChatId, messages: visibleMessages,
    projectId: activeChat?.projectId, streaming: Boolean(activeChatStream), refreshActiveChat
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
  const openPersonalChatMessageEvent = useEventCallback(async (
    chatId: string,
    messageId: string
  ): Promise<boolean> => {
    const opened = await openPersonalChatMessage({
      activateChat: activatePersonalChatDeepLink,
      chatId,
      messageId,
      onAnchor: anchorPersonalChatMessage,
      revealMessage: revealPersonalChatMessage
    });
    if (!opened) {
      setSettingsNotice({ kind: "error", text: "This file's source message is no longer available." });
    }
    return opened;
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
  useEffect(() => {
    let cancelled = false;
    void fetchKnowledgeSources({ filter: "all", page: 1, pageSize: 100 }).then((result) => {
      if (!cancelled && result.ok) setComposerKnowledgeData(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [knowledgeSnapshot.sourceData]);
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
    openMcpSettings: () => {
      useAssistantLibraryStore.getState().patch({ editor: null, history: null, open: false, task: "list" });
      openMcpSettings();
    },
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
        knowledgeLabel: projectAssistant.summary.fingerprint.knowledgeLabel,
        knowledgeResourceCount: projectAssistant.summary.fingerprint.knowledgeResourceCount,
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

  const activateProjectBlankWorkspace = useEventCallback((projectId: string) => {
    activateBlankWorkspace();
    // Personal blank activation intentionally resolves personal defaults when
    // no Assistant is selected. Re-apply the already-captured Project fence so
    // those defaults cannot become the loading projection for this Project.
    enterProjectComposerControlBoundary(personalComposerControlsRef);
    useComposerSessionStore.getState().activateSession(projectComposerSessionKey(projectId));
  });
  const onProjectContextEntered = useEventCallback(() => {
    enterProjectComposerControlBoundary(personalComposerControlsRef);
  });
  const onProjectContextLeft = useEventCallback(() => {
    restorePersonalComposerControls(personalComposerControlsRef);
  });

  const projectWorkspace = useProjectWorkspaceController({
    accountId,
    activeChatId,
    activateBlankWorkspace,
    activateProjectBlankWorkspace,
    activateChat,
    applyProjectDefaults,
    isLocallyStreaming: (chatId) => Boolean(useRunLifecycleStore.getState().activeStreams[chatId]),
    onProjectContextEntered,
    onProjectContextLeft,
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
    if (!request || request.phase === "handled" || request.phase === "opening") {
      return;
    }
    // Selecting a Project updates selectedProjectId before its detail and
    // workspace requests settle. Let that render advance the deep link back
    // to "waiting" so the later workspace render can open the target chat;
    // mutating the ref only from the completed promise would not itself cause
    // another render.
    if (request.phase === "selecting") {
      if (projectWorkspace.selectedProjectId !== projectId) return;
      request.phase = "waiting";
    }
    if (projectWorkspace.selectedProjectId !== projectId) {
      request.phase = "selecting";
      void selectProject(projectId).then((selected) => {
        if (selected) {
          if (request.phase === "selecting") request.phase = "waiting";
          return;
        }
        request.phase = "handled";
        setNotice({ kind: "error", text: "That Project chat is unavailable." });
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
    closeMemoryLibrary();
    closeGeneralSettings();
    knowledgeLibraryActions.closeLibrary();
    assistantLibraryActions.openLibrary("discover");
  };
  const openKnowledgeLibrary = () => {
    closeMemoryLibrary();
    closeGeneralSettings();
    assistantLibraryActions.closeLibrary();
    knowledgeLibraryActions.openLibrary();
  };
  const openKnowledgeLibrarySource = (sourceId: string) => {
    openKnowledgeLibrary();
    knowledgeLibraryActions.openSourceDetail(sourceId);
  };
  const openMemoryLibraryDestination = () => {
    // Personal Memory is not a Project capability. This callback is also
    // passed to answer actions, so guard it even when a stale action arrives
    // after navigation into a shared Project.
    if (activeChat?.projectId || (!activeChat && projectWorkspace.selectedProjectId)) {
      closeMemoryLibrary();
      return;
    }
    assistantLibraryActions.closeLibrary();
    knowledgeLibraryActions.closeLibrary();
    openMemoryLibrary();
  };
  const openMemorySettingsTab = () => {
    if (activeChat?.projectId || (!activeChat && projectWorkspace.selectedProjectId)) return;
    openMemoryTab();
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
  const { fetchRun, retryAttachment, reuseFile, stopCurrentRun, uploadFiles } = runLifecycleActions;

  // A selected Project is a local blank context until the first send.  Route
  // that send through the Project chat endpoint so opening the Project never
  // creates an empty server chat or accidentally creates a personal chat.
  const createChatForSend = useEventCallback(async (
    folderId?: string | null,
    sourceSessionKey?: ComposerSessionKey
  ): Promise<WorkspaceChatSummary | null> => {
    if (projectWorkspace.selectedProjectId && !activeChatId) {
      return projectWorkspace.actions.createChatForSend(folderId, sourceSessionKey);
    }
    if (!activeChatId && sourceSessionKey) {
      return createPersonalChatForSend(folderId ?? null, sourceSessionKey);
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
    submitMessageEdit,
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
    openMemorySettings: openMemoryLibraryDestination,
    persistActiveLeaf,
    primeAnswerSound,
    refreshActiveChat,
    refreshProjectWorkspace: projectWorkspace.actions.refresh,
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
      openChatMessage: openPersonalChatMessageEvent,
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
      }
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
    cancelMessageEdit(messageId: string) {
      const sessionStore = useComposerSessionStore.getState();
      sessionStore.cancelEdit(sessionStore.activeSessionKey, messageId);
    },
    changeEditingMessageDraft: setEditingDraft,
    copyVisibleThread,
    currentRunId,
    editingMessageDraft,
    editingMessageError,
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
    liveWorkDurationMs: liveWorkDurationMs(activeRunSurface),
    loadEarlierMessages,
    loadingOlderMessages: activeThreadHistory.loading,
    olderMessagesError: activeThreadHistory.error,
    retryActiveChatDetail,
    showJumpToLatest,
    submitMessageEdit,
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

  const workspaceEnabled = activeChat?.workspace?.enabled ?? composerSession.workspaceEnabled;
  const workspaceModelSupportsTools = effectiveCurrentModel?.capabilities.toolCalling === true;
  const workspaceAvailable = workspaceInstallation?.available === true &&
    workspaceModelSupportsTools;
  const workspaceUnavailableReason = workspaceInstallation?.available === true
    ? workspaceModelSupportsTools ? undefined : "model_tools_required" as const
    : workspaceInstallation?.unavailableReason;
  const workspaceInternetEnabled = activeChat?.workspace?.internetEnabled ??
    workspaceInstallation?.internetEnabled ?? null;
  const workspaceSessionState = activeChat?.workspace?.sessionState ??
    (workspaceEnabled ? "not_started" as const : null);

  async function setWorkspaceEnabled(
    value: boolean,
    reason: "file_selection" | "user" = "user"
  ): Promise<boolean> {
    if (workspaceCapabilityMutationRef.current || activeChatStreaming) return false;
    if (value && !workspaceAvailable) {
      setNotice({
        kind: "error",
        text: workspaceUnavailableReason === "model_tools_required"
          ? "Workspace requires a model with tool support."
          : workspaceUnavailableReason === "installation_disabled"
            ? "Workspace is disabled by the administrator."
            : "Workspace runtime is unavailable."
      });
      return false;
    }

    workspaceCapabilityMutationRef.current = true;
    setWorkspaceCapabilityBusy(true);
    const sessionKey = useComposerSessionStore.getState().activeSessionKey;
    try {
      if (activeChat && !activeChat.pendingProjectDraft && !activeChat.pendingPersonalDraft) {
        const wire = await updateChatWorkspaceEnabled(activeChat.id, value);
        const summary = chatSummaryFromApi(wire);
        useWorkspaceStore.getState().upsertChat(summary);
        useComposerSessionStore.getState().updateSession(sessionKey, {
          workspaceEnabled: summary.workspace?.enabled ?? value
        });
        if (activeChat.projectId) void projectWorkspace.actions.refresh();
      } else {
        useComposerSessionStore.getState().updateSession(sessionKey, {
          workspaceEnabled: value
        });
      }
      if (reason === "file_selection" && value) {
        setNotice({
          autoDismiss: true,
          kind: "success",
          text: "Workspace was enabled so every selected file can be used."
        });
      }
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
      return false;
    } finally {
      workspaceCapabilityMutationRef.current = false;
      setWorkspaceCapabilityBusy(false);
    }
  }

  async function uploadComposerFiles(files: FileList | readonly File[]): Promise<void> {
    const selected = Array.from(files);
    const ordinaryPolicy = attachmentPolicyForModel(effectiveCurrentModel);
    const requiresWorkspace = partitionAttachmentSelection(selected, ordinaryPolicy).rejected.length > 0;
    if (requiresWorkspace && !workspaceEnabled) {
      if (!(await setWorkspaceEnabled(true, "file_selection"))) return;
    }
    await uploadFiles(selected);
  }

  async function reuseComposerFile(attachmentId: string, fileName: string): Promise<boolean> {
    if (projectContext || activeChatStreaming) return false;
    const sourceKey = useComposerSessionStore.getState().activeSessionKey;
    const currentCount = composerSession.attachments.length;
    const maxCount = catalog?.attachmentLimits?.maxCount;
    if (maxCount !== undefined && currentCount >= maxCount) {
      composerActions.rejectAttachmentCount({ attemptedCount: currentCount + 1, currentCount, maxCount });
      return false;
    }
    const requiresWorkspace = partitionAttachmentSelection(
      [new File([], fileName)], attachmentPolicyForModel(effectiveCurrentModel)
    ).rejected.length > 0;
    if (requiresWorkspace && !workspaceEnabled && !(await setWorkspaceEnabled(true, "file_selection"))) return false;
    if (useComposerSessionStore.getState().activeSessionKey !== sourceKey) return false;
    const used = await reuseFile(attachmentId, async (file) => {
      // A generated Office file can have a familiar extension but no extracted
      // text. Admit its actual bytes through Workspace before making it ready
      // to send, rather than attaching an unreadable document to an ordinary run.
      const needsWorkspace = file.kind === "file" || (file.kind !== "image" && !file.extractedText);
      if (!needsWorkspace || selectComposerSession(useComposerSessionStore.getState(), sourceKey).workspaceEnabled) return true;
      if (useComposerSessionStore.getState().activeSessionKey !== sourceKey) return false;
      return await setWorkspaceEnabled(true, "file_selection") && useComposerSessionStore.getState().activeSessionKey === sourceKey;
    });
    return used && useComposerSessionStore.getState().activeSessionKey === sourceKey;
  }

  async function resetWorkspace(): Promise<boolean> {
    if (!activeChat || workspaceCapabilityMutationRef.current || activeChatStreaming) return false;
    workspaceCapabilityMutationRef.current = true;
    setWorkspaceCapabilityBusy(true);
    try {
      const state = await resetChatWorkspace(activeChat.id);
      useWorkspaceStore.getState().updateChats((current) => current.map((chat) =>
        chat.id === activeChat.id ? { ...chat, workspace: state } : chat
      ));
      setNotice({ kind: "success", text: "Workspace reset. The next tool call starts clean." });
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
      return false;
    } finally {
      workspaceCapabilityMutationRef.current = false;
      setWorkspaceCapabilityBusy(false);
    }
  }

  async function archiveWorkspace() {
    if (!activeChat || workspaceCapabilityMutationRef.current || activeChatStreaming) return null;
    workspaceCapabilityMutationRef.current = true;
    setWorkspaceCapabilityBusy(true);
    try {
      const file = await archiveChatWorkspace(activeChat.id);
      setNotice({ kind: "success", text: "Workspace archive is ready to download." });
      return file;
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
      return null;
    } finally {
      workspaceCapabilityMutationRef.current = false;
      setWorkspaceCapabilityBusy(false);
    }
  }

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
      editById: (assistantId: string) => {
        setAssistantPickerOpen(false);
        if (projectContext) {
          projectWorkspace.actions.openSettings();
          return;
        }
        closeMemoryLibrary();
        closeGeneralSettings();
        knowledgeLibraryActions.closeLibrary();
        void assistantLibraryActions.openAssistantEditor(assistantId);
      },
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
        : (knowledgeSnapshot.data?.knowledgeBases ?? []).map(personalComposerKnowledgeBase),
      documentTotal: projectContext
        ? activeProject?.composer?.knowledgeDocumentTotal ?? null
        : composerKnowledgeData?.pagination.totalItems ?? null,
      override: () => {
        const controls = useComposerControlStore.getState();
        // A Knowledge override is an ordinary governed-control edit: detach
        // Assistant identity while preserving its other resolved controls.
        // Privacy-hidden inherited plans normalize to Off in the store.
        controls.setSelectedKnowledgePlan(
          controls.knowledgeSelection,
          "explicit",
          "user"
        );
      },
      planSource: knowledgePlanSource,
      searchSources: projectContext ? undefined : searchComposerKnowledgeSources,
      select: (selection) => setSelectedKnowledgePlan(selection, "explicit", "user"),
      selection: knowledgeSelection,
      sources: projectContext
        ? activeProject?.composer?.knowledgeSources ?? []
        : (composerKnowledgeData?.sources ?? []).map((source) => ({
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
    chatDefaults: projectContext || !catalog ? undefined : {
      knowledgePlan: catalog.defaults.knowledgePlan ?? null,
      mcpMode: catalog.defaults.mcpMode ?? "auto",
      searchPlan: catalog.defaults.searchPlan,
      setKnowledgePlan: setDefaultKnowledgePlan,
      setMcpMode: setDefaultMcpMode,
      setSearchPlan: setDefaultSearchPlan
    },
    sendWithEnter: catalog?.defaults.sendWithEnter ?? true,
    setSendWithEnter,
    notificationSoundEnabled,
    operationError: composerSession.operationError,
    operationErrorLive: composerSession.operationErrorLive,
    operationErrorRetryable: composerSession.operationErrorRetryable,
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
    uploadFiles: uploadComposerFiles,
    reuseFile: projectContext ? undefined : reuseComposerFile,
    uploading,
    workspace: {
      archive: archiveWorkspace,
      available: workspaceAvailable,
      busy: workspaceCapabilityBusy,
      commandRunning: activeChatStreaming && workspaceCommandRunning(activeRunSurface.events),
      enabled: workspaceEnabled,
      internetEnabled: workspaceInternetEnabled,
      loading: workspaceInstallation === null,
      reset: resetWorkspace,
      sessionState: workspaceSessionState,
      setEnabled: setWorkspaceEnabled,
      ...(workspaceUnavailableReason ? { unavailableReason: workspaceUnavailableReason } : {})
    }
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
    closeMemory: closeMemoryLibrary,
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
        openMcpSettings: () => {
          useAssistantLibraryStore.getState().patch({ editor: null, history: null, open: false, task: "list" });
          openMcpSettings();
        },
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
    openMemory: openMemoryLibraryDestination,
    openMemorySettingsTab,
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
    <KnowledgeCitationViewerProvider onOpenLibrarySource={openKnowledgeLibrarySource}>
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
