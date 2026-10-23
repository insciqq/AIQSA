"use client";

import { DisclosurePreferencesProvider } from "@/components/app-shell/disclosurePreferences";
import { fetchWorkspaceUploadConfig } from "@/components/app-shell/workspaceUploadClient";
import { releasePendingUpload, trackPendingUploads } from "@/components/app-shell/pendingUploads";
import type { WorkspaceUploadConfigWire } from "@/lib/contracts/workspaceUploads";
import type { GreetingPeriod } from "@/lib/domain/greeting";
import { createChatSearchPreferences } from "@/components/app-shell/chatSearchPreferences";

import { useStudioNavigation } from "@/features/library-v2/useStudioNavigation";
import { scheduledTaskResultNotice } from "@/features/scheduled-tasks/scheduledTaskPresentation";
import { requestScheduledTaskEdit, useScheduledTasksStore } from "@/features/scheduled-tasks/scheduledTasksStore";
import {
  renderedUnseenScheduledRuns,
  scheduledTaskContinuingIn,
  useScheduledTaskUpdates,
  type ScheduledTaskRenderedRun
} from "@/features/scheduled-tasks/useScheduledTaskUpdates";
import { useBrowserNotifications } from "@/features/browser-notifications/useBrowserNotifications";

import { removePermanentlyDeletedChat } from "@/components/app-shell/permanentChatDeletionReconciliation";
import { useComposerContextConfigurationKey } from "@/components/app-shell/composerContextConfiguration";
import { useChatTitleReconciliation } from "@/components/app-shell/useChatTitleReconciliation";

import { decodeAnswerSoundPreferences, DEFAULT_ANSWER_SOUND } from "@/lib/contracts/answerSound";

import {
  attachmentPolicyForModel,
  catalogWithImageEditing
} from "@/components/app-shell/attachmentCapabilities";
import { effectiveImageEditing } from "@/lib/contracts/imageModels";
import { partitionAttachmentSelection } from "@/components/app-shell/attachmentSelection";
import {
  attachmentCountSelectionLimitMessage,
  withAttachmentLimitFeedbackMessage,
  withoutAttachmentLimitFeedbackMessage
} from "@/components/app-shell/attachmentLimitUsage";
import { reconcileCurrentComposerAttachments, reportRejectedAttachments } from "@/components/app-shell/attachmentReconciliation";
import {
  useComposerControlStore,
  type ComposerControlSnapshot
} from "@/components/app-shell/composerControlStore";
import {
  composerAssistantChangedRows,
  composerAssistantRowValue,
  composerAssistantSendBlockReason,
  personalComposerAssistantDefaults
} from "@/components/app-shell/composerAssistantState";
import {
  createChatAssistantActions,
  type ChatAssistantActions,
  type ChatAssistantChooseScope
} from "@/components/app-shell/chatAssistantActions";
import { useChatAssistantProjectionStore } from "@/components/app-shell/chatAssistantProjectionStore";
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
import { PowerAppShellV2View } from "@/features/workspace-v2/PowerAppShellV2View";
import type {
  ShellComposerAssistant,
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
  createAssistantLibraryActions
} from "@/components/app-shell/assistantLibraryController";
import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import { useSkillLibraryStore } from "@/components/app-shell/skillLibraryStore";
import { loadImageModels, selectImageModel, useImageModelStore } from "@/components/app-shell/imageModelStore";
import { useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import { deactivateMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import { deactivatePersonalMcp } from "@/components/app-shell/personalMcpStore";
import { useMcpOAuthReturn } from "./useMcpOAuthReturn";
import { ASSISTANT_SEND_GATE_HINT } from "./AssistantBindingNoticeV2";
import { assistantStripItemsV2 } from "./AssistantStripV2";
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
import { useInterruptedRunRecovery } from "@/components/app-shell/useInterruptedRunRecovery";
import { useRefreshOnReturn, WORKSPACE_AVAILABILITY_RETURN_INTERVAL_MS } from "@/components/app-shell/useRefreshOnReturn";
import { useShellAppearanceController } from "@/components/app-shell/useShellAppearanceController";
import { useShellOverlayController } from "@/components/app-shell/useShellOverlayController";
import { useShellUiActions } from "@/components/app-shell/useShellUiActions";
import { useWorkspaceInteractionController } from "@/components/app-shell/useWorkspaceInteractionController";
import { useWorkspaceOutputReconciliation } from "@/components/app-shell/useWorkspaceOutputReconciliation";
import {
  useWorkspaceActions,
  type BlankDefaultAssistant
} from "@/components/app-shell/workspaceActions";
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveModelControlDefaults,
  type SavedControlDraft
} from "@/components/app-shell/powerAppShellData";
import { useBranchGraphController } from "./useBranchGraphController";
import { decodeChatBranchesResponse, type ChatBranchGraphWire } from "@/lib/contracts/chats";
import { highlightRevealedMessage, openMessageSearchMatch } from "./messageSearchMatch";
import {
  openPersonalChatMessage,
  revealPersonalChatDeepLinkMessage,
  usePersonalChatDeepLink,
  type PersonalChatDeepLinkTarget
} from "./usePersonalChatDeepLink";
import { useWorkspaceBootstrapController } from "./useWorkspaceBootstrapController";
import { composerDraftPersistenceAllowed, composerDraftRecoveryBoundary } from "@/components/app-shell/composerDraftPersistence";
import { buildComposerMessage } from "@/components/app-shell/composerComments";
import {
  beginChatRouteResolution,
  cancelChatRouteResolution,
  chatRouteForState,
  currentChatAddress,
  isAssistantEntry,
  isCurrentChatRouteResolution,
  navigateChatRoute,
  navigateToAssistantEntry,
  navigateToChatAddress,
  resolveChatRoute,
  settleChatRouteResolution,
  useChatRouteHistory,
  useShownChatRoute,
  type ChatAddress,
  type ChatRoute,
  type ChatRouteResolution,
  type ChatRouteTargets
} from "@/components/app-shell/chatRoute";
import { requestSkillDialogNavigation } from "@/components/skills/SkillLibraryDialog";
import { formatAssistantEntryPath } from "@/lib/domain/chatRoute";
import {
  ASSISTANT_ROW_KEYS,
  type AssistantRowKey,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";
import {
  archiveChatWorkspace,
  loadWorkspaceAvailability,
  resetChatWorkspace
} from "@/components/app-shell/workspaceClient";
import { ANSWER_REVIEW_AUTO_DEFAULT, type AnswerReviewAutoConfig } from "@/lib/contracts/answerReviews";
import { answerReviewReviewerCandidatesV2 } from "@/features/answer-review-v2/answerReviewModel";
import {
  stopAnswerReviewSessionV2,
  useAnswerReviewAutoV2,
  useAnswerReviewFollowV2
} from "@/features/answer-review-v2/useAnswerReviewAutoV2";

export {
  runCatalogLoadDeduped,
  workspaceDefaultControlsFingerprint
} from "./useWorkspaceBootstrapController";

const NO_SCHEDULED_RUNS: readonly ScheduledTaskRenderedRun[] = [];

const CHAT_ROUTE_UNAVAILABLE_COPY = {
  // One text for missing, foreign, archived and unusable Assistants alike.
  assistant: "This Assistant isn't available to you.",
  chat: "That chat is unavailable."
} as const;

/**
 * Why the composer cannot send. A chat Assistant that blocks sending comes
 * before any model hint, because the user's next step is choosing in its
 * notice, and the neutral gate hint never names the missing dependency
 * (PRD 10.7).
 */
export function effectiveComposerDisabledHint(input: Readonly<{
  assistantBlocked: boolean;
  personalHint: string | null;
}>): string | null {
  return input.assistantBlocked ? ASSISTANT_SEND_GATE_HINT : input.personalHint;
}

/** The chat's Assistant with each row's effective value, for the shell contract. */
export function shellComposerAssistant(
  state: ComposerControlSnapshot,
  input: Readonly<{
    model: CatalogModel | undefined;
    scope: "chat" | "composer";
    summary: AssistantSummary | undefined;
  }>
): ShellComposerAssistant | null {
  const assistant = state.assistant;
  if (!assistant) return null;
  const blockReason = composerAssistantSendBlockReason(state);
  if (assistant.state !== "bound") {
    return {
      blockReason: blockReason ?? "",
      ...(assistant.state === "unavailable" && assistant.reason ? { reason: assistant.reason } : {}),
      scope: input.scope,
      state: assistant.state
    };
  }
  return {
    availability: assistant.availability,
    avatar: assistant.avatar,
    blockReason,
    changedRows: composerAssistantChangedRows(state),
    description: assistant.description ?? input.summary?.description ?? "",
    id: assistant.id,
    includedSkills: assistant.includedSkills.map((skill) => ({ ...skill })),
    name: assistant.name,
    owned: assistant.owned,
    ownerDisplayName: assistant.ownerDisplayName,
    rows: Object.fromEntries(ASSISTANT_ROW_KEYS.map((row) => [row, {
      ...assistant.rows[row],
      value: composerAssistantRowValue(state, row, input.model)
    }])) as Extract<ShellComposerAssistant, { state: "bound" }>["rows"],
    scope: input.scope,
    starterPrompts: assistant.starterPrompts ?? input.summary?.starterPrompts ?? [],
    state: "bound"
  };
}

export function PowerAppShellV2({
  accountId,
  accountDisplayName,
  accountEmail,
  adminEntryVisible = false,
  connectEntryVisible = false,
  greetingPeriod = null,
  telegramAvailable = false
}: {
  accountId: string;
  accountDisplayName: string;
  accountEmail: string | null;
  adminEntryVisible?: boolean;
  connectEntryVisible?: boolean;
  greetingPeriod?: GreetingPeriod | null;
  /** Settings → Connections shows the Telegram block. */
  telegramAvailable?: boolean;
}) {
  const catalog = useWorkspaceStore((state) => state.catalogAccountId === accountId ? state.catalog : null);
  const settingsSession = useMemo(() => Symbol(accountId), [accountId]);
  const [uploadConfiguration, setUploadConfiguration] = useState<{ accountId: string; value: WorkspaceUploadConfigWire } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchWorkspaceUploadConfig(controller.signal).then(value => {
      if (!controller.signal.aborted) setUploadConfiguration({ accountId, value });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [accountId]);
  const uploadLimits = uploadConfiguration?.accountId === accountId ? uploadConfiguration.value : null;
  const activeSettingsSessionRef = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    activeSettingsSessionRef.current = settingsSession;
    return () => { activeSettingsSessionRef.current = null; };
  }, [settingsSession]);
  const [savedAccountName, setSavedAccountName] = useState<{
    session: symbol;
    displayName: string;
  } | null>(null);
  const updateAccountDisplayName = useCallback((displayName: string) => {
    if (activeSettingsSessionRef.current !== settingsSession) return;
    setSavedAccountName({ session: settingsSession, displayName });
  }, [settingsSession]);
  const catalogError = useWorkspaceStore((state) => state.catalogError);
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
    deactivatePersonalMcp();
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
  const composerAssistantState = useComposerControlStore((state) => state.assistant);
  const assistantUpdatePending = useChatAssistantProjectionStore((state) =>
    activeChatId ? Boolean(state.pendingChatIds[activeChatId]) : false
  );
  const mcpSelection = useComposerControlStore((state) => state.mcpSelection);
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
  const setSelectedProvider = useComposerControlStore((state) => state.setSelectedProvider);
  const setSelectedSearchPlan = useComposerControlStore((state) => state.setSelectedSearchPlan);
  const setShowCitations = useComposerControlStore((state) => state.setShowCitations);
  const setShowReasoningBlocks = useComposerControlStore((state) => state.setShowReasoningBlocks);
  const settingsOpen = useSettingsDestinationStore((state) => state.settingsOpen);
  const settingsSection = useSettingsDestinationStore((state) => state.settingsSection);
  const memoryOpen = useSettingsDestinationStore((state) => state.memoryOpen);
  const closeMemoryLibrary = useSettingsDestinationStore((state) => state.closeMemory);
  const openMemoryLibrary = useSettingsDestinationStore((state) => state.openMemoryLibrary);
  const openGeneralSettings = useSettingsDestinationStore((state) => state.openSettings);
  const closeGeneralSettings = useSettingsDestinationStore((state) => state.closeSettings);
  const librarySnapshot = useAssistantLibraryStore();
  const skillSnapshot = useSkillLibraryStore();
  const imageModelSnapshot = useImageModelStore();
  const appearance = useShellAppearanceController();
  const { change: changeTheme, id: themeId } = appearance.theme;
  const workspaceInteraction = useWorkspaceInteractionController();
  const shellOverlays = useShellOverlayController();
  const uploading = composerSession.pendingUploadGenerations.length > 0;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<Notice | null>(null);
  useEffect(() => useWorkspaceStore.subscribe((current, previous) => {
    if (current.activeChatId !== previous.activeChatId) {
      setNotice((shown) => shown?.chatId && shown.chatId !== current.activeChatId ? null : shown);
    }
  }), []);
  const [workspaceInstallation, setWorkspaceInstallation] =
    useState<ChatWorkspaceState | null>(null);
  // Sends read availability at dispatch; the reader keeps this beside the state.
  const workspaceInstallationRef = useRef<ChatWorkspaceState | null>(null);
  const [workspaceCapabilityBusy, setWorkspaceCapabilityBusy] = useState(false);
  const [shareDialogTarget, setShareDialogTarget] = useState<ShareDialogTarget | null>(null);
  const [memoryResumeTarget, setMemoryResumeTarget] = useState<WorkspaceChatSummary | null>(null);
  const [personalReadingAnchor, setPersonalReadingAnchor] = useState<Readonly<{
    chatId: string;
    messageId: string;
  }> | null>(null);
  // The message a sidebar search result opened: it stays expanded in its
  // chat and is highlighted once the reading anchor lands on it.
  const [searchRevealedMessage, setSearchRevealedMessage] = useState<Readonly<{
    chatId: string;
    messageId: string;
  }> | null>(null);
  const pendingSearchHighlightRef = useRef<Readonly<{ chatId: string; messageId: string }> | null>(null);
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
  const stoppingRunId = activeChatStream?.runId ?? activeChatInterruptedRun?.runId;
  const stopping = useRunLifecycleStore((state) => Boolean(stoppingRunId && state.stoppingRunIds.has(stoppingRunId)));
  const soundPreferences = catalog ? decodeAnswerSoundPreferences(catalog.defaults) : null;
  const { notifyAnswerReady, primeAnswerSound, previewAnswerSound } = useAnswerNotification({
    accountId,
    readPreferences() {
      const current = useWorkspaceStore.getState();
      return activeSettingsSessionRef.current === settingsSession && current.catalogAccountId === accountId && current.catalog
        ? decodeAnswerSoundPreferences(current.catalog.defaults)
        : null;
    }
  });

  // The latest read wins: a send refused for Workspace reads availability
  // again, so the next send goes without a Workspace that went away.
  const workspaceAvailabilityReadRef = useRef(0);
  const readWorkspaceAvailability = useCallback(() => {
    const read = ++workspaceAvailabilityReadRef.current;
    void loadWorkspaceAvailability()
      .catch((): ChatWorkspaceState => ({
        available: false,
        enabled: false,
        internetEnabled: null,
        sessionState: null,
        unavailableReason: "runtime_unavailable"
      }))
      .then((workspace) => {
        if (workspaceAvailabilityReadRef.current !== read) return;
        workspaceInstallationRef.current = workspace;
        setWorkspaceInstallation(workspace);
      });
  }, []);
  useEffect(() => {
    readWorkspaceAvailability();
    return () => {
      workspaceAvailabilityReadRef.current += 1;
    };
  }, [accountId, readWorkspaceAvailability]);
  // A runner that recovered or went away shows without a reload.
  useRefreshOnReturn(readWorkspaceAvailability, WORKSPACE_AVAILABILITY_RETURN_INTERVAL_MS);
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
  const settingsMutationCoordinatorRef = useMemo(() => ({
    current: null as SettingsMutationCoordinator | null,
    accountId
  }), [accountId]);
  const runCatalogRef = useRef<Catalog | null>(catalog);
  /** The chat's automatic review a send carries now; set from the composer's state below. */
  const answerReviewSendRef = useRef<() => AnswerReviewAutoConfig | null>(() => null);
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
    const draft = session.pendingSend
      ? [session.pendingSend.draft, session.draft].filter(Boolean).join("\n\n") : session.draft;
    const comments = [...(session.pendingSend?.comments ?? []), ...session.comments];
    // Without a readable fence (blocked or full localStorage) the handoff is
    // keyed by the account alone, as before browser draft persistence.
    const boundary = composerDraftRecoveryBoundary(accountId);
    if (boundary && composerDraftPersistenceAllowed(composerState.activeSessionKey)) {
      rememberSessionExpiredDraft({
        accountId,
        epoch: boundary.epoch,
        draft,
        comments,
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
  }), [accountId]);

  useEffect(
    () => () => {
      abortActiveStreamControllers(activeStreamAbortRef.current);
    },
    []
  );

  const consumePersonalReadingAnchor = useEventCallback((anchorKey: string, target: HTMLElement) => {
    // Read at the anchor's frame, which may precede this callback's refresh.
    const highlight = pendingSearchHighlightRef.current;
    if (
      highlight?.messageId === anchorKey &&
      highlight.chatId === useWorkspaceStore.getState().activeChatId
    ) {
      pendingSearchHighlightRef.current = null;
      highlightRevealedMessage(target);
    }
    setPersonalReadingAnchor((current) =>
      current?.chatId === activeChatId && current.messageId === anchorKey ? null : current
    );
  });
  const contextConfigurationKey = useComposerContextConfigurationKey({
    // Kept on the ambient value (installation and model) by the sync below.
    workspaceEnabled: composerSession.workspaceEnabled,
    memoryMode: chats.find(chat => chat.id === activeChatId)?.pendingInitialMemoryMode ??
      chats.find(chat => chat.id === activeChatId)?.memoryMode ?? composerSessionModeFromKey(activeComposerSessionKey)
  });
  const {
    activeChat,
    activeChatStreaming,
    activeChatTitle,
    composerDisabledHint,
    composerContextStats,
    currentModel,
    currentParameterControls,
    liveArtifactSummary,
    threadFollowKey,
    threadReadingAnchorKey,
  } = usePowerAppShellViewModel({
    activeChatId,
    activeChatStreaming: Boolean(activeChatStream),
    activeThreadContextStats: activeThread.contextStats ?? null,
    attachments,
    catalog,
    chats,
    draft: buildComposerMessage(draft, composerSession.comments),
    maxOutputTokens,
    pendingChatFolderId,
    renderActiveLeafId,
    runSurface: activeRunSurface,
    contextRejectionGeneration: composerSession.contextRejectionGeneration,
    contextConfigurationKey,
    selectedAssistantPromptCharacterCount: composerAssistantState?.state === "bound"
      ? composerAssistantState.promptCharacterCount
      : null,
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
    // A Temporary chat never starts with the personal default Assistant.
    reconcileBlankDefaultAssistant();
  }

  const {
    containerRef: threadScrollRef,
    handleScroll: handleThreadScroll,
    jumpToLatest,
    refreshLayout: refreshThreadLayout,
    resetToLatest: resetThreadToLatest,
    showJumpToLatest
  } = usePinnedScroll<HTMLDivElement>({
    followKey: threadFollowKey,
    hasContent: visibleMessages.length > 0,
    onReadingAnchorApplied: consumePersonalReadingAnchor,
    // A message link or search result scrolls even after the reader moved away.
    readingAnchorExplicit: personalReadingAnchor?.chatId === activeChatId,
    readingAnchorKey,
    resetKey: activeChatId ?? "blank"
  });
  const chatSearchPreferencesRef = useRef<ReturnType<typeof createChatSearchPreferences> | null>(null);
  const {
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
    selectMcpMode,
    selectModel,
    selectSearchPlan,
    setDefaultAnswerReview,
    setDefaultAssistant,
    setDefaultMcpMode,
    setDefaultSkillsMode,
    setDefaultSearchPlan,
    resetDefaultSearchPlan,
    setSendWithEnter,
    setAnswerSoundEnabled,
    setAnswerSoundId,
    setBrowserNotificationsEnabled,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    useOrganizationModelDefault,
    useOrganizationSearchDefault
  } = useRunControlsActions({
    chatSearchPreferencesRef,
    chatSearchSession: settingsSession,
    isSettingsSessionCurrent: () => activeSettingsSessionRef.current === settingsSession,
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
  const browserNotifications = useBrowserNotifications({
    accountId,
    activeChatId,
    enabled: catalog ? catalog.defaults.browserNotificationsEnabled ?? true : null,
    setEnabled: setBrowserNotificationsEnabled
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

  // The personal default Assistant of the open blank chat; the composer's
  // Assistant actions below choose it.
  const blankDefaultAssistantRef = useRef<BlankDefaultAssistant | null>(null);
  const chooseDefaultAssistantRef = useRef<ChatAssistantActions["chooseDefaultAssistant"]>(async () => false);
  const chooseDefaultAssistant = useEventCallback((assistantId: string, isCurrent: () => boolean) =>
    chooseDefaultAssistantRef.current(assistantId, isCurrent));
  const {
    activateBlankWorkspace,
    openContinuedChat,
    activateChat,
    activatePersonalChatById,
    applyChatAssistant,
    applyChatUpdate,
    applyPersonalBlankDefaults,
    createChat,
    createPersonalChatForSend,
    deleteChat,
    exportChat,
    loadCompleteActiveBranch,
    loadEarlierMessages: loadEarlierMessagesPage,
    pruneThreadCache,
    reapplyActiveChatDefaults,
    reconcileBlankDefaultAssistant,
    refreshActiveChat,
    refreshChatAssistant,
    refreshWorkspace,
    renameChat,
    skipBlankDefaultAssistant,
    toggleChatFavorite,
    updateChatFolder
  } = useWorkspaceActions({
    activeChatIdRef,
    applyModelControlDefaults,
    blankDefaultAssistantRef,
    chatDetailRequestsRef,
    chatHasActiveStream: (chatId) => Boolean(useRunLifecycleStore.getState().activeStreams[chatId]),
    chatHasPendingThreadMutation: (chatId) =>
      pendingBranchCheckouts.has(chatId) || pendingThreadMutations.has(chatId),
    chatMutation: workspaceInteraction.chatMutation,
    chooseDefaultAssistant,
    loadingChatDetailIdRef,
    resumeChatRun,
    setNotice,
    setSelectedModelId,
    setSelectedProvider,
    setSelectedSearchPlan,
    workspaceRefreshPromiseRef
  });
  // A page opened straight on the blank chat never "changes" into it, and the
  // catalog naming the default may arrive after the blank chat activates, so
  // the default Assistant is reconciled again once both are known. It is a
  // no-op outside an untouched personal blank chat.
  const blankDefaultAssistantId = catalog?.defaults.assistantId ?? null;
  const reconcileBlankDefaultAssistantEvent = useEventCallback(reconcileBlankDefaultAssistant);
  useEffect(() => {
    if (workspaceReady && blankDefaultAssistantId) reconcileBlankDefaultAssistantEvent();
  }, [blankDefaultAssistantId, reconcileBlankDefaultAssistantEvent, workspaceReady]);
  useChatTitleReconciliation({ accountId, chats });
  useWorkspaceOutputReconciliation({
    accountId, chatId: activeChatId, messages: visibleMessages,
    sessionState: activeChat?.workspace?.sessionState,
    streaming: Boolean(activeChatStream), refreshActiveChat
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
  const anchorSearchMatch = useEventCallback((chatId: string, messageId: string) => {
    pendingSearchHighlightRef.current = { chatId, messageId };
    setSearchRevealedMessage({ chatId, messageId });
    setPersonalReadingAnchor({ chatId, messageId });
  });
  const loadSearchMatchBranchGraph = useEventCallback(async (
    chatId: string
  ): Promise<ChatBranchGraphWire | null> => {
    const response = await shellFetch(`/api/chats/${encodeURIComponent(chatId)}/branches`);
    if (!response.ok) return null;
    return decodeChatBranchesResponse(await response.json())?.branchGraph ?? null;
  });
  const showUnavailableDeepLink = useEventCallback((target: PersonalChatDeepLinkTarget) => {
    // An unavailable Memory source simply opens the chat; only a plain
    // message link explains that its message is gone.
    if (target === "message") setNotice({ kind: "error", text: "This message is no longer available." });
  });
  usePersonalChatDeepLink({
    activeChatId,
    detailLoading: activeChatDetailLoading,
    onAnchor: anchorPersonalChatMessage,
    onUnavailable: showUnavailableDeepLink,
    ready: workspaceReady,
    revealMessage: revealPersonalChatMessage
  });
  // A local draft chat is addressable only while its first send is under
  // way and after the server admitted it: a failed or stopped first send
  // returns the address to the blank route it came from.
  useShownChatRoute();

  useEffect(() => {
    pruneThreadCacheEvent();
  }, [activeRunChatIdsKey, pendingComposerChatIdsKey, pruneThreadCacheEvent]);

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
    accountId,
    activateBlankWorkspace,
    applyControlDefaults,
    reapplyActiveChatDefaults,
    refreshWorkspace,
    resolveInitialRoute,
    setCatalog,
    setCatalogError,
    setSelectedModelId,
    setSelectedProvider,
    setSelectedSearchPlan,
    setShowCitations,
    setShowReasoningBlocks,
    workspaceRefreshPromiseRef
  });

  const refreshChatAssistantEvent = useEventCallback(refreshChatAssistant);
  // The scope is defined with the composer below.
  const chatAssistantChooseScopeRef = useRef<() => ChatAssistantChooseScope | null>(() => null);
  const chooseChatAssistantScope = useEventCallback(() => chatAssistantChooseScopeRef.current());
  const [chatAssistantActions] = useState(() => createChatAssistantActions({
    chooseScope: chooseChatAssistantScope,
    refreshChatAssistant: refreshChatAssistantEvent,
    setNotice: (next) => setNotice(next),
    clearNotice: (shown) => setNotice((current) => current === shown ? null : current)
  }));
  // Every row the user changes in an existing chat becomes that chat's value.
  useEffect(
    () => useComposerControlStore.subscribe(() => chatAssistantActions.syncChangedRows()),
    [chatAssistantActions]
  );
  useEffect(() => {
    chooseDefaultAssistantRef.current = chatAssistantActions.chooseDefaultAssistant;
  }, [chatAssistantActions]);

  // "Save & try" asks for a Temporary chat; it falls back to an ordinary one where they are off.
  const activateAssistantTrialWorkspace = (options?: { temporary?: boolean }) =>
    activateBlankWorkspaceEvent(null, options?.temporary && memorySettings?.capabilities.temporaryChats ? "TEMPORARY" : "NORMAL");
  const assistantLibraryActions = createAssistantLibraryActions({
    activateBlankWorkspace: activateAssistantTrialWorkspace,
    chooseAssistant: chatAssistantActions.chooseAssistant,
    catalog,
    catalogError,
    openMcpSettings,
    retryCatalog: () => void retryCatalog(),
    setShellNotice: setNotice,
    skills: skillSnapshot.data?.skills ?? []
  });

  // A removed active chat hands over to the next chat or the blank chat, so
  // the address is replaced rather than pushed.
  const reconcilePermanentChatDeletion = useEventCallback(async (chatId: string) => {
    const { nextChat, wasActive } = removePermanentlyDeletedChat(chatId);
    chatDetailRequestsRef.current.delete(chatId);
    removePermanentlyDeletedArchivedChat(chatId);
    if (shareDialogTarget?.chat.id === chatId) setShareDialogTarget(null);
    if (!wasActive) return;
    if (nextChat) await activateChat(nextChat, { preserveControls: true });
    else activateBlankWorkspace();
  });

  useEffect(() => {
    void activatePermanentChatDeletionAccount(
      accountId,
      reconcilePermanentChatDeletion
    );
    return () => deactivatePermanentChatDeletionAccount(accountId);
  }, [accountId, reconcilePermanentChatDeletion]);
  const routeResolutionRef = useRef<ChatRouteResolution | null>(null);
  useEffect(() => () => {
    cancelChatRouteResolution(routeResolutionRef.current);
  }, []);

  /** How an address becomes state: chats, Assistant entries and the blank chat. */
  function chatRouteTargets(
    catalogOverride: Catalog | null,
    resolution: ChatRouteResolution
  ): ChatRouteTargets {
    const isCurrent = () => isCurrentChatRouteResolution(resolution);
    return {
      async openChat(chatId) {
        const workspace = useWorkspaceStore.getState();
        const known = workspace.workspaceReady
          ? workspace.chats.find((chat) => chat.id === chatId)
          : undefined;
        if (known) {
          await activateChat(known);
          return "opened";
        }
        const pending = workspaceRefreshPromiseRef.current;
        if (pending) await pending;
        // Invisible and missing chats stay indistinguishable.
        const target: { outcome: "missing" | null } = { outcome: null };
        await refreshWorkspace(chatId, {
          catalogOverride,
          isCurrent,
          onTargetUnavailable: () => {
            target.outcome = "missing";
          }
        });
        if (useWorkspaceStore.getState().activeChatId === chatId) return "opened";
        return target.outcome ?? "failed";
      },
      async openAssistant(assistantId) {
        // The link decides this new chat's Assistant; the personal default does not compete.
        skipBlankDefaultAssistant();
        const outcome = await chatAssistantActions.chooseLinkedAssistant(assistantId, () => isCurrent() &&
          useWorkspaceStore.getState().activeChatId === null);
        return outcome === "unavailable" ? "unavailable" : "opened";
      },
      openBlank() {
        if (useWorkspaceStore.getState().activeChatId !== null) activateBlankWorkspace();
      },
      showUnavailable(target) {
        setNotice({ kind: "error", text: CHAT_ROUTE_UNAVAILABLE_COPY[target] });
      },
      stateRoute: chatRouteForState
    };
  }

  /** Resolves an address into state; a load failure keeps the address for a retry. */
  async function resolveChatAddress(
    route: ChatAddress,
    resolution: ChatRouteResolution,
    catalogOverride: Catalog | null
  ): Promise<ChatRoute | null> {
    routeResolutionRef.current = resolution;
    if (!isCurrentChatRouteResolution(resolution)) {
      // A navigation made while the shell loads supersedes this address, not
      // the personal workspace every address needs: load it, apply nothing.
      if (!useWorkspaceStore.getState().workspaceReady && !workspaceRefreshPromiseRef.current) {
        await refreshWorkspace(null, { catalogOverride, isCurrent: () => false });
      }
      return null;
    }
    if (
      (!route || isAssistantEntry(route) || !route.chatId) &&
      !useWorkspaceStore.getState().workspaceReady
    ) {
      // Blank and entry addresses still need the workspace first.
      const pending = workspaceRefreshPromiseRef.current;
      if (pending) await pending;
      if (!useWorkspaceStore.getState().workspaceReady && isCurrentChatRouteResolution(resolution)) {
        await refreshWorkspace(null, {
          catalogOverride,
          isCurrent: () => isCurrentChatRouteResolution(resolution)
        });
      }
      if (!useWorkspaceStore.getState().workspaceReady) {
        settleChatRouteResolution(resolution, null);
        return null;
      }
    }
    return resolveChatRoute(route, resolution, chatRouteTargets(catalogOverride, resolution));
  }

  /**
   * The page's address decides the first chat, identically for every entry
   * route. It is held from the start, so owners reconciling while the
   * workspace loads cannot rewrite it.
   */
  async function resolveInitialRoute(
    catalog: Catalog | null | Promise<Catalog | null>
  ): Promise<ChatRoute | null> {
    const resolution = beginChatRouteResolution();
    routeResolutionRef.current = resolution;
    const route = currentChatAddress();
    return resolveChatAddress(route, resolution, await catalog);
  }

  /**
   * Leaves Studio (through its draft and busy guards) before a navigation to
   * a chat, so the chat shows instead of only taking the address behind it.
   */
  function leaveStudioThen(proceed: () => void) {
    if (studio.busy) return;
    const studioOpen = Boolean(librarySnapshot.open || memoryOpen);
    // An open Skill dialog is keyed by the chat and would drop its unsaved draft.
    requestSkillDialogNavigation(() => {
      if (studioOpen) studio.exit(proceed);
      else proceed();
    });
  }

  useChatRouteHistory({
    currentRoute: chatRouteForState,
    requestNavigation: leaveStudioThen,
    resolve(route, resolution) {
      void resolveChatAddress(route, resolution, useWorkspaceStore.getState().catalog);
    }
  });
  const studio = useStudioNavigation({
    available: ["assistants", "instructions", "skills", "memory", "files", "artifacts", "scheduled", "mcp",
      "secrets", "defaults"],
    onExit() {
      assistantLibraryActions.closeLibrary();
      closeMemoryLibrary();
    },
    onSelect(tab) {
      closeGeneralSettings();
      if (tab !== "memory") closeMemoryLibrary();
      if (tab === "memory") {
        assistantLibraryActions.closeLibrary();
        openMemoryLibrary();
      } else if (!librarySnapshot.open) {
        assistantLibraryActions.openLibrary();
      }
    }
  });
  function openMcpSettings() { studio.open("mcp"); }
  const openConnectionsSettings = useEventCallback(() => {
    useSettingsDestinationStore.getState().openSettings("connections");
  });
  useMcpOAuthReturn(accountId, useEventCallback(openMcpSettings), openConnectionsSettings);
  const openAssistantLibrary = () => studio.open("assistants");
  const openMemoryLibraryDestination = () => studio.open("memory");
  const openSettingsDestination = () => openGeneralSettings();
  const [assistantPickerOpen, setAssistantPickerOpen] = useState(false);
  const setAssistantPickerOpenEvent = useEventCallback((open: boolean) => {
    setAssistantPickerOpen(open);
    // A loaded list may be stale and is reloaded; a first load in flight is shared.
    if (!open) return;
    if (useAssistantLibraryStore.getState().data) void assistantLibraryActions.refreshList();
    else assistantLibraryActions.ensureList();
  });
  const loadDefaultAssistantChoices = useEventCallback(() => assistantLibraryActions.ensureList());

  const { consumeRunStream, createStreamTokenBuffer } = useRunStreaming({
    applyChatUpdate
  });

  const runLifecycleActions = useRunLifecycleActions({
    activeChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    notifyAnswerReady,
    refreshActiveChat,
    refreshWorkspaceAvailability: readWorkspaceAvailability,
    setNotice
  });
  const { fetchRun, retryAttachment, reuseFile, stopCurrentRun, uploadFiles } = runLifecycleActions;

  // The blank chat becomes a server chat only with its first send.
  const createChatForSend = useEventCallback(async (
    folderId?: string | null,
    sourceSessionKey?: ComposerSessionKey
  ): Promise<WorkspaceChatSummary | null> => {
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

  // The existing branch checkout, addressed by chat: persist the leaf, then
  // reload the open chat on it.
  const showSearchMatchBranch = useEventCallback(async (
    chatId: string,
    leafId: string,
    currentLeafId: string | null
  ): Promise<boolean> => {
    try {
      await persistActiveLeaf(chatId, leafId, currentLeafId);
    } catch {
      return false;
    }
    return Boolean(await refreshActiveChat(chatId, {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    }));
  });
  const openSearchMatchEvent = useEventCallback((chatId: string, messageId: string): void => {
    // Opening the chat is one history entry, like choosing it in the list.
    navigateChatRoute(() => {
      void openMessageSearchMatch({
        activateChat: activatePersonalChatDeepLink,
        chatId,
        isCurrent: (candidate) => useWorkspaceStore.getState().activeChatId === candidate,
        loadBranchGraph: loadSearchMatchBranchGraph,
        messageId,
        onAnchor: anchorSearchMatch,
        revealMessage: revealPersonalChatMessage,
        showBranch: showSearchMatchBranch
      }).then((outcome) => {
        if (outcome === "message_unavailable") {
          setNotice({ kind: "error", text: "This message is no longer available." });
        } else if (outcome === "branch_unavailable") {
          setNotice({
            kind: "error",
            text: "This message is in another version of the chat, which could not be opened. Try again once the current answer finishes."
          });
        } else if (outcome === "chat_unavailable") {
          setNotice({ kind: "error", text: "This chat is no longer available." });
        }
      });
    });
  });

  const {
    continueAnswerReview,
    refreshInterruptedRun,
    regenerateMessage,
    sendContinueTurn,
    sendMcpApprovalContinuation,
    startAnswerReview,
    sendStarterPrompt,
    submitMessageEdit,
    submitComposer,
    submitComposerWithoutWorkspace,
    submitFollowup
  } = useMessageRunActions({
    activeChat,
    answerReviewForSend: () => answerReviewSendRef.current(),
    activeChatDetailLoading,
    activeChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    buildControlDraft,
    buildParams,
    chatAssistantUpdates: chatAssistantActions,
    consumeRunStream,
    createChat: createChatForSend,
    createStreamTokenBuffer,
    currentModel,
    clearNoticeForChat: (chatId) => setNotice((current) =>
      current?.chatId === chatId ? null : current
    ),
    fetchRun,
    notifyAnswerReady,
    openMemorySettings: openMemoryLibraryDestination,
    persistActiveLeaf,
    primeAnswerSound,
    refreshActiveChat,
    resolveCatalog: () => runCatalogRef.current,
    resolveWorkspaceInstallationAvailable: () => workspaceInstallationRef.current?.available === true,
    refreshWorkspaceAvailability: readWorkspaceAvailability,
    resetThreadToLatest,
    setNotice,
    activeChatStreaming,
  });
  useInterruptedRunRecovery({
    chatId: activeChatId,
    interrupted: Boolean(activeChatInterruptedRun) && !stopping,
    refresh: refreshInterruptedRun,
    async refreshOnReturn(chatId, signal) {
      // Let a foreground producer or branch mutation settle before reading its
      // replacement. The recovery owner retries without another message POST.
      if (stopping || activeStreamAbortRef.current.has(chatId) ||
        useRunLifecycleStore.getState().activeStreams[chatId] ||
        pendingBranchCheckouts.has(chatId) || pendingThreadMutations.has(chatId)) return false;
      return Boolean(await refreshActiveChat(chatId, {
        forceDetail: true, preserveControls: true, signal
      }));
    }
  });
  // Stable, so a caller that outlives its render (a Studio starter chip) sends from the current chat.
  const sendStarterEvent = useEventCallback((prompt: string) => void sendStarterPrompt(prompt));

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
      void reportRejectedAttachments(fileNames, currentModel, {
        workspaceAvailable: workspaceUsable
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
    accountDisplayName: savedAccountName?.session === settingsSession
      ? savedAccountName.displayName : accountDisplayName,
    accountEmail,
    greetingPeriod,
    updateAccountDisplayName,
    activeChatId,
    activeChatTitle,
    adminEntryVisible,
    connectEntryVisible,
    telegramAvailable,
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
    } catch {
      // Memory failures stay silent: the switch keeps its committed state.
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
    } catch {
      // Memory failures stay silent: the switch keeps its committed state.
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
      openContinuedChat,
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
      openSearchMatch: openSearchMatchEvent,
      openChat: activatePersonalChatDeepLink,
      openChatAddress: (chatId: string) => navigateToChatAddress(
        { chatId },
        (route, resolution) => {
          void resolveChatAddress(route, resolution, useWorkspaceStore.getState().catalog);
        }
      ),
      openAssistantAddress: (assistantId: string) => navigateToAssistantEntry(assistantId, (route, resolution) => {
        void resolveChatAddress(route, resolution, useWorkspaceStore.getState().catalog);
      }),
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
    pane: workspacePaneView
  } satisfies ShellWorkspaceView;

  // A task whose later runs continue in this chat: a quiet line says replies do not change it.
  const scheduledTasks = useScheduledTasksStore((state) => state.tasks);
  const scheduledChatTask = scheduledTaskContinuingIn(scheduledTasks, activeChatId);
  const scheduledTaskChat = scheduledChatTask ? {
    onEdit: () => studio.open("scheduled", () => requestScheduledTaskEdit(scheduledChatTask.id)),
    title: scheduledChatTask.title
  } : null;
  // Unread scheduled results this transcript renders; they become seen while the chat is shown.
  const renderedUnseenRuns = useMemo(
    () => activeChatDetailLoading || activeChatDetailError ? NO_SCHEDULED_RUNS : renderedUnseenScheduledRuns(visibleMessages),
    [activeChatDetailError, activeChatDetailLoading, visibleMessages]
  );

  const threadView = {
    usageStats: activeThread.usageStats,
    activeChatDetailError,
    activeChatDetailLoading,
    activeChatStreaming,
    answerComplete: activeChatStream?.answerComplete === true,
    backgroundRunWaiting: activeChatStream?.waitingInBackground === true,
    cancelMessageEdit(messageId: string) {
      const sessionStore = useComposerSessionStore.getState();
      sessionStore.cancelEdit(sessionStore.activeSessionKey, messageId);
    },
    changeEditingMessageDraft: setEditingDraft,
    checkBackgroundRun() {
      if (activeChatId) runLifecycleActions.checkBackgroundRun(activeChatId);
    },
    copyVisibleThread,
    currentRunId,
    editingMessageDraft,
    editingMessageError,
    editingMessageId,
    editingMessagePending,
    events: activeRunSurface.events,
    artifactDrafts: activeRunSurface.artifactDrafts,
    artifactDraftMessageId: activeRunSurface.contextMessageId,
    handleBranchFromMessage,
    handleCopyMessage,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleThreadScroll,
    interruptedRun: activeChatInterruptedRun,
    refreshInterruptedRun: () => refreshInterruptedRun(),
    continueAnswerReview,
    sendContinueTurn,
    sendMcpApprovalContinuation,
    startAnswerReview,
    stopAnswerReview: (sessionId: string) => activeChatId
      ? stopAnswerReviewSessionV2({ chatId: activeChatId, refreshActiveChat, sessionId, setNotice })
      : Promise.resolve(),
    problemReport: activeChatId ? {
      chatId: activeChatId,
      confirmSent: (outcome: "created" | "updated") => setNotice({
        chatId: activeChatId, kind: "success", text: outcome === "created" ? "Report sent. Thank you." : "Report updated."
      })
    } : null,
    jumpToLatest,
    refreshLayout: refreshThreadLayout,
    hasOlderMessages: activeThreadHistory.hasOlder,
    liveArtifactSummary,
    liveWorkDurationMs: liveWorkDurationMs(activeRunSurface),
    loadEarlierMessages,
    loadingOlderMessages: activeThreadHistory.loading,
    olderMessagesError: activeThreadHistory.error,
    retryActiveChatDetail,
    revealedMessageId: searchRevealedMessage?.chatId === activeChatId ? searchRevealedMessage.messageId : null,
    scheduledTaskChat,
    showJumpToLatest,
    submitMessageEdit,
    threadScrollRef,
    visibleMessages
  } satisfies ShellThreadView;

  useEffect(() => {
    runCatalogRef.current = catalog;
  }, [catalog]);
  // Scheduled results: unread rows, one notice per new result, seen on open.
  const scheduledChatVisible = !librarySnapshot.open && !memoryOpen && !settingsOpen;
  useScheduledTaskUpdates({
    accountId,
    activeChatId,
    chatVisible: scheduledChatVisible,
    onNewResult: (task) => {
      const result = scheduledTaskResultNotice(task);
      if (!result) return;
      const chatId = result.open === "chat" ? task.chatId : null;
      // The shown chat rereads its transcript itself; elsewhere the notice opens the chat or the task's runs.
      const open = chatId !== null && scheduledChatVisible && chatId === useWorkspaceStore.getState().activeChatId;
      setNotice({
        ...(open ? {} : {
          action: {
            label: "Open",
            onClick: () => {
              setNotice(null);
              // Like a chat row: Studio closes and the chat opens as one history entry.
              if (chatId) leaveStudioThen(() => navigateChatRoute(() => void activatePersonalChatDeepLink(chatId)));
              else studio.open("scheduled");
            }
          }
        }),
        ...(result.kind === "error" ? { autoDismiss: true } : {}),
        kind: result.kind,
        text: result.text
      });
    },
    async refreshOpenChat(chatId) {
      // Same guards as returning to the tab: never race a foreground send, stream or branch change.
      if (stopping || activeStreamAbortRef.current.has(chatId) ||
        useRunLifecycleStore.getState().activeStreams[chatId] ||
        pendingBranchCheckouts.has(chatId) || pendingThreadMutations.has(chatId)) return false;
      return Boolean(await refreshActiveChat(chatId, { forceDetail: true, preserveControls: true, resumeRuns: true }));
    },
    renderedUnseenRuns
  });
  // Workspace is ambient in interactive chats (operator, 2026-10-20): usable
  // exactly when the installation offers it and the model calls tools, with
  // no toggle; unknown while availability loads. A chat's stored flag and the
  // saved default never decide it. Runs decide their own value at dispatch
  // (`resolveWorkspaceInstallationAvailable`); uploads, attachment checks and
  // chat creation read the active session's flag kept here.
  const workspaceUsable = workspaceInstallation?.available === true &&
    currentModel?.capabilities.toolCalling === true;
  // Also re-syncs a session recreated under the same key.
  const activeSessionWorkspaceEnabled = composerSession.workspaceEnabled;
  useEffect(() => {
    if (activeSessionWorkspaceEnabled === workspaceUsable) return;
    useComposerSessionStore.getState().updateSession(activeComposerSessionKey, { workspaceEnabled: workspaceUsable });
  }, [activeComposerSessionKey, activeSessionWorkspaceEnabled, workspaceUsable]);
  // Automatic answer review of the chat: the next send's frozen choice, the header glyph and the picker's row.
  const answerReview = useAnswerReviewAutoV2({
    activeChat,
    assistantChat: Boolean(composerAssistantState),
    authorModel: currentModel,
    defaults: catalog?.defaults.answerReview ?? ANSWER_REVIEW_AUTO_DEFAULT,
    draftConfig: composerSession.answerReview,
    models: catalog?.models ?? [],
    sessionKey: activeComposerSessionKey
  });
  useEffect(() => {
    answerReviewSendRef.current = answerReview.forSend;
  });
  // A running automatic review shows live in the open chat and announces its end once. Like the other
  // background reads, it never races a foreground send, stream or branch change; it reads again later.
  useAnswerReviewFollowV2({
    chatId: activeChatId,
    notifyAnswerReady,
    refreshActiveChat: (chatId, options) => chatId && (stopping || activeStreamAbortRef.current.has(chatId) ||
      useRunLifecycleStore.getState().activeStreams[chatId] || pendingBranchCheckouts.has(chatId) ||
      pendingThreadMutations.has(chatId)) ? Promise.resolve(null) : refreshActiveChat(chatId, options)
  });

  const attachmentLimitContextsRef = useRef(new Map<string, string>());

  // Reconcile against the model this message will use.
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
      workspaceEnabled: workspaceUsable
    });
    attachmentLimitContextsRef.current.set(
      activeComposerSessionKey,
      contextFingerprint
    );
  }, [
    activeComposerSessionKey,
    attachments,
    catalog?.attachmentLimits,
    currentModel,
    uploading,
    workspaceUsable
  ]);

  const workspaceUnavailableReason = workspaceInstallation?.available === true
    ? currentModel?.capabilities.toolCalling === true ? undefined : "model_tools_required" as const
    : workspaceInstallation?.unavailableReason;
  const workspaceSessionState = activeChat?.workspace?.sessionState ??
    (workspaceUsable ? "not_started" as const : null);

  /** Files that only Workspace can take attach while it is usable; nothing turns it on. */
  function workspaceUsableForFiles(): boolean {
    if (workspaceUsable) return true;
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

  async function uploadComposerFiles(files: FileList | readonly File[]): Promise<void> {
    const selected = Array.from(files);
    const sourceKey = useComposerSessionStore.getState().activeSessionKey;
    // The chosen files show in the tray before the settings round trip.
    const pending = trackPendingUploads(sourceKey, selected);
    const stop = () => { pending.forEach(releasePendingUpload); };
    let limits: WorkspaceUploadConfigWire;
    try { limits = await fetchWorkspaceUploadConfig(); }
    catch { stop(); setNotice({ kind: "error", text: "Upload settings are unavailable. Try again shortly." }); return; }
    if (activeSettingsSessionRef.current !== settingsSession || useComposerSessionStore.getState().activeSessionKey !== sourceKey) {
      stop();
      return;
    }
    setUploadConfiguration({ accountId, value: limits });
    const ordinaryPolicy = attachmentPolicyForModel(currentModel);
    const workspaceFiles = selected.filter(file => file.size > limits.ordinaryMaxBytes ||
      partitionAttachmentSelection([file], ordinaryPolicy).rejected.length > 0);
    if (workspaceFiles.some(file => file.size > limits.maxBytes)) {
      stop();
      setNotice({ kind: "error", text: `Files must be no larger than ${Number((limits.maxBytes / 1024 / 1024).toFixed(1))} MiB.` });
      return;
    }
    const requiresWorkspace = workspaceFiles.length > 0;
    if ((requiresWorkspace && !workspaceUsableForFiles()) || activeSettingsSessionRef.current !== settingsSession ||
      useComposerSessionStore.getState().activeSessionKey !== sourceKey) {
      stop();
      return;
    }
    await uploadFiles(selected, { limits, pending });
  }

  async function reuseComposerFile(attachmentId: string, fileName: string): Promise<boolean> {
    if (activeChatStreaming) return false;
    const sourceKey = useComposerSessionStore.getState().activeSessionKey;
    const currentCount = composerSession.attachments.length;
    const maxCount = catalog?.attachmentLimits?.maxCount;
    if (maxCount !== undefined && currentCount >= maxCount) {
      composerActions.rejectAttachmentCount({ attemptedCount: currentCount + 1, currentCount, maxCount });
      return false;
    }
    const requiresWorkspace = partitionAttachmentSelection(
      [new File([], fileName)], attachmentPolicyForModel(currentModel)
    ).rejected.length > 0;
    if (requiresWorkspace && !workspaceUsableForFiles()) return false;
    if (useComposerSessionStore.getState().activeSessionKey !== sourceKey) return false;
    const used = await reuseFile(attachmentId, async (file) => {
      // A generated Office file can have a familiar extension but no extracted
      // text. Admit its actual bytes through Workspace before making it ready
      // to send, rather than attaching an unreadable document to an ordinary run.
      const needsWorkspace = file.kind === "file" || (file.kind !== "image" && !file.extractedText);
      if (!needsWorkspace || selectComposerSession(useComposerSessionStore.getState(), sourceKey).workspaceEnabled) return true;
      if (useComposerSessionStore.getState().activeSessionKey !== sourceKey) return false;
      return workspaceUsableForFiles();
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

  // Where the open composer resolves an Assistant it chooses before a chat
  // exists: the personal catalog and defaults.
  const chatAssistantChooseScope = useEventCallback((): ChatAssistantChooseScope | null => {
    const personalCatalog = useWorkspaceStore.getState().catalog;
    if (!personalCatalog) return null;
    return {
      context: {
        controlDefaults: (model) => resolveModelControlDefaults(model, personalCatalog.defaults.controlValues),
        models: personalCatalog.models,
        skill: (skillId) => useSkillLibraryStore.getState().data?.skills.find((skill) => skill.id === skillId) ?? null
      },
      defaults: personalComposerAssistantDefaults(personalCatalog),
      restoreDefaults: () => applyPersonalBlankDefaults()
    };
  });
  useEffect(() => {
    chatAssistantChooseScopeRef.current = chatAssistantChooseScope;
  }, [chatAssistantChooseScope]);

  const assistantSummaries = librarySnapshot.data?.assistants ?? [];
  // The blank chat's strip reads the personal list; it is loaded once when
  // that chat is first shown (a load already in flight is shared), and the
  // picker refreshes it later.
  const assistantStripItems = assistantStripItemsV2(assistantSummaries);
  const assistantStripListWanted = !activeChat &&
    !librarySnapshot.data && librarySnapshot.listRequestId === 0;
  const loadAssistantStripList = useEventCallback(() => assistantLibraryActions.ensureList());
  useEffect(() => {
    if (assistantStripListWanted) loadAssistantStripList();
  }, [assistantStripListWanted, loadAssistantStripList]);
  const currentAssistantSummary = composerAssistantState?.state === "bound"
    ? assistantSummaries.find((assistant) => assistant.id === composerAssistantState.id)
    : undefined;
  const currentAssistant = shellComposerAssistant(useComposerControlStore.getState(), {
    model: currentModel,
    scope: activeChat && !activeChat.pendingPersonalDraft ? "chat" : "composer",
    summary: currentAssistantSummary
  });
  const chooseComposerAssistant = (assistantId: string) => {
    setAssistantPickerOpen(false);
    // In an existing chat the choice is pending from its detail read on, so
    // a message sent meanwhile waits for it (a failed read blocks it).
    void chatAssistantActions.trackOpenChat(
      () => assistantLibraryActions.useAssistant(assistantId, { navigate: false }),
      (chosen) => chosen
    );
  };

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
      canSaveChatSetup: currentAssistant?.state === "bound" && currentAssistant.scope === "chat" &&
        currentAssistant.owned && currentAssistant.changedRows.length > 0,
      choose: chooseComposerAssistant,
      continueWithout: () => void chatAssistantActions.continueWithoutAssistant(),
      copyLink: (assistantId: string) => {
        const link = new URL(formatAssistantEntryPath(assistantId), window.location.origin).toString();
        void writeClipboardText(link).then(
          () => setNotice({ kind: "success", text: "Assistant link copied." }),
          (error: unknown) => setNotice({ kind: "error", text: `Could not copy the Assistant link: ${errorMessage(error)}` })
        );
      },
      current: currentAssistant,
      editById: (assistantId: string) => {
        setAssistantPickerOpen(false);
        studio.open("assistants", () => { void assistantLibraryActions.openAssistantEditor(assistantId); });
      },
      openLibrary: openAssistantLibrary,
      openPicker: assistantPickerOpen,
      pending: assistantUpdatePending,
      pickerItems: assistantSummaries,
      loadPickerItems: loadDefaultAssistantChoices,
      pickerLoading: librarySnapshot.dataState === "loading" && !librarySnapshot.data,
      recentIds: librarySnapshot.data?.recentAssistantIds ?? [],
      stripItems: assistantStripItems,
      remove: () => void chatAssistantActions.removeAssistant(),
      resetRow: (row: AssistantRowKey) => void chatAssistantActions.resetRow(row),
      restore: (assistantId: string) => {
        const chatId = currentAssistant?.scope === "chat" ? activeChat?.id ?? null : null;
        void chatAssistantActions.restoreArchivedAssistant(
          chatId,
          () => assistantLibraryActions.toggleArchived(assistantId, false),
          () => chooseComposerAssistant(assistantId)
        );
      },
      saveChatSetup: () => void chatAssistantActions.saveChatSetupToAssistant(),
      sendStarter: sendStarterEvent,
      setPickerOpen: setAssistantPickerOpenEvent,
      setRow: chatAssistantActions.setRow,
      startFromCurrentSetup: () => {
        setAssistantPickerOpen(false);
        studio.open("assistants", () => assistantLibraryActions.openNewAssistantFromCurrentSetup());
      }
    },
    composerContextStats,
    composerDisabledHint: effectiveComposerDisabledHint({
      assistantBlocked: Boolean(currentAssistant?.blockReason),
      personalHint: composerDisabledHint
    }),
    currentModel,
    currentParameterControls,
    draft,
    sending: Boolean(composerSession.pendingSend),
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
    answerReview: {
      save: answerReview.save,
      saving: answerReview.saving,
      state: answerReview.state
    },
    chatDefaults: !catalog ? undefined : {
      assistant: {
        assistantId: catalog.defaults.assistantId ?? null,
        assistants: librarySnapshot.data?.assistants ?? null,
        assistantsState: librarySnapshot.dataState,
        loadAssistants: loadDefaultAssistantChoices,
        set: setDefaultAssistant,
        unavailable: catalog.defaults.assistantUnavailable ?? false
      },
      imageModel: {
        ...imageModelSnapshot,
        load: () => void loadImageModels(),
        // The composer's editing route follows the saved effective model
        // without a reload, so it refuses an image exactly when admission would.
        select: (providerModelId) => void selectImageModel(providerModelId).then((saved) => {
          const settings = useImageModelStore.getState().settings;
          if (!saved || !settings || useWorkspaceStore.getState().catalogAccountId !== accountId) return;
          setCatalog((current) => current && catalogWithImageEditing(current, effectiveImageEditing(settings)));
        })
      },
      answerReview: {
        candidates: answerReviewReviewerCandidatesV2(catalog.models, []),
        config: catalog.defaults.answerReview ?? ANSWER_REVIEW_AUTO_DEFAULT,
        set: setDefaultAnswerReview
      },
      mcpMode: catalog.defaults.mcpMode ?? "auto",
      skillsMode: catalog.defaults.skillsMode ?? "auto",
      searchPlan: catalog.defaults.searchPlan,
      setMcpMode: setDefaultMcpMode,
      setSkillsMode: setDefaultSkillsMode,
      setSearchPlan: setDefaultSearchPlan,
      resetSearchPlan: resetDefaultSearchPlan,
      searchPreferenceSource: catalog.defaults.searchPreferenceSource
    },
    sendWithEnter: catalog?.defaults.sendWithEnter ?? true,
    setSendWithEnter,
    notificationSoundEnabled: soundPreferences?.answerSoundEnabled ?? false,
    notificationSoundId: soundPreferences?.answerSoundId ?? DEFAULT_ANSWER_SOUND.answerSoundId,
    notificationSoundReady: soundPreferences !== null,
    previewAnswerSound,
    selectAnswerSound: setAnswerSoundId,
    browserNotifications,
    operationError: composerSession.operationError,
    operationErrorLive: composerSession.operationErrorLive,
    operationErrorRetryable: composerSession.operationErrorRetryable,
    operationErrorRecoveries: composerSession.operationErrorRecoveries,
    reasoningEffort,
    reasoningMode,
    retryCatalog,
    searchPlanMode,
    selectMcpMode,
    selectModel,
    selectSearchPlan,
    selectedModelId,
    selectedProvider,
    selectedSearchOptionIds,
    showCitations,
    showReasoningBlocks,
    stopCurrentRun,
    stopping,
    streamMode,
    submitComposer,
    submitComposerWithoutWorkspace,
    submitFollowup,
    temperature,
    toggleCitationsVisibility,
    toggleNotificationSound: () => {
      const current = useWorkspaceStore.getState();
      if (current.catalogAccountId === accountId && current.catalog) {
        setAnswerSoundEnabled(!(current.catalog.defaults.answerSoundEnabled ?? true));
      }
    },
    toggleReasoningBlockVisibility,
    useOrganizationSearchDefault,
    useOrganizationModelDefault,
    uploadFiles: uploadComposerFiles,
    uploadLimitHint: uploadLimits ? workspaceUsable
      ? `Up to ${Number((uploadLimits.maxBytes / 1024 / 1024).toFixed(1))} MiB with Workspace`
      : `Up to ${Number((uploadLimits.ordinaryMaxBytes / 1024 / 1024).toFixed(1))} MiB per file` : undefined,
    reuseFile: reuseComposerFile,
    uploading,
    workspace: {
      archive: archiveWorkspace,
      available: workspaceUsable,
      busy: workspaceCapabilityBusy,
      enabled: workspaceUsable,
      loading: workspaceInstallation === null,
      reset: resetWorkspace,
      sessionState: workspaceSessionState,
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
    studio,
    closeMemory: closeMemoryLibrary,
    closeSettings: closeGeneralSettings,
    dismissNotice: () => setSettingsNotice(null),
    library: buildAssistantLibraryView(
      {
        activateBlankWorkspace: activateAssistantTrialWorkspace,
        chooseAssistant: chatAssistantActions.chooseAssistant,
        catalog,
        catalogError,
        openMcpSettings,
        retryCatalog: () => void retryCatalog(),
        setShellNotice: setNotice,
        skills: skillSnapshot.data?.skills ?? []
      },
      assistantLibraryActions,
      librarySnapshot
    ),
    notice: settingsNotice,
    memory: { open: memoryOpen },
    open: openSettingsDestination,
    openLibrary: openAssistantLibrary,
    openMemory: openMemoryLibraryDestination,
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
    <DisclosurePreferencesProvider accountId={accountId}>
      <PowerAppShellV2View
        branches={branchesView}
        composer={composerView}
        overlays={overlaysView}
        session={sessionView}
        settings={settingsView}
        thread={threadView}
        workspace={workspaceView}
      />
    </DisclosurePreferencesProvider>
  );
}
