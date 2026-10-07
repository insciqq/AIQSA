"use client";

import { libraryTabGroups } from "@/features/library-v2/LibraryV2";
import type { LibraryTabIdV2 } from "@/features/library-v2/contracts";
import { ScheduledChecksRowV2 } from "@/features/scheduled-tasks/ScheduledChecksRowV2";
import { ScheduledMessageChipV2 } from "@/features/scheduled-tasks/ScheduledMessageChipV2";
import { groupScheduledChecks } from "@/features/scheduled-tasks/scheduledCheckGroups";
import { ScheduledTaskChatHintV2 } from "@/features/scheduled-tasks/ScheduledTaskChatHintV2";
import { BrowserNotificationsBannerV2, BrowserNotificationsSettingsRowV2 } from "@/features/browser-notifications/BrowserNotificationsV2";
import { openAssistantDetail } from "@/components/app-shell/assistantGalleryActions";

import { setArtifactEditSession } from "@/components/artifacts/artifactEditSession";
import { artifactUnavailableReason } from "@/components/artifacts/artifactAvailability";
import type { ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import { prepareArtifactEdit } from "@/components/artifacts/artifactClient";
import { ArtifactPanelV2 } from "@/components/artifacts/ArtifactPanelV2";
import { closeArtifactPanel, openArtifactPanel, useArtifactPanelStore } from "@/components/artifacts/artifactPanelStore";
import { activateArtifactLibraryAccount } from "@/components/app-shell/artifactLibraryStore";
import type { ThreadGeneratedArtifact } from "@/lib/contracts/chats";
import { composerSessionKey, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { quoteSelectionInComposer } from "@/components/app-shell/composerQuoteSelection";
import { composerCommentRefusalMessage } from "@/components/app-shell/composerComments";
import { composerDraftTooLargeToStore, subscribeComposerDraftRefusals } from "@/components/app-shell/composerDraftStorage";
import { navigateChatRoute, useChatRoutePath, useControlCenterHref } from "@/components/app-shell/chatRoute";
import { boundedRouteId, parseChatRoutePath } from "@/lib/domain/chatRoute";
import { cancelWorkspaceUpload, retryWorkspaceUpload, useWorkspaceUploadProgress } from "@/components/app-shell/workspaceUploadClient";
import { AnnouncementsProvider } from "@/components/announcements/AnnouncementsProvider";

import { ANSWER_SOUNDS } from "@/lib/contracts/answerSound";

import { useChatPdfRoutePreview } from "@/components/app-shell/useChatPdfRoutePreview";
import { useChatContinuation } from "@/components/app-shell/useChatContinuation";
import { composerContextGauge } from "@/components/app-shell/composerContextStats";
import { WorkspaceExportHistoryV2 } from "./WorkspaceExportHistoryV2";
import { useArtifactEditAddress } from "./useArtifactEditAddress";

import {
  ChatDeleteConfirmationDialog,
  ConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MemoryResumeConfirmationDialog,
  MessageDeleteConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { ConnectedAppsSection } from "@/components/app-shell/ConnectedAppsSection";
import { PersonalMcpConnectionsSection } from "@/components/app-shell/PersonalMcpConnectionsSection";
import { PermanentChatDeletionSurface } from "@/components/app-shell/PermanentChatDeletionSurface";
import { ProjectSettingsDialog } from "@/components/app-shell/ProjectSettingsDialog";
import { ShareDialog } from "@/components/app-shell/ShareDialog";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import {
  attachmentPolicyForModel,
  attachmentWarningsForModel
} from "@/components/app-shell/attachmentCapabilities";
import { calculateAttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  openMemoryManager,
  refreshMemoryList,
  useMemoryManagerStore
} from "@/components/app-shell/memoryManagerStore";
import {
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import {
  observeMcpSettings,
  useMcpSettingsStore
} from "@/components/app-shell/mcpSettingsStore";
import { mcpSetupAttention } from "@/components/app-shell/mcpReadiness";
import type { PersonalMcpConnection } from "@/components/app-shell/personalMcpApi";
import { ensurePersonalMcpLoaded, usePersonalMcpStore } from "@/components/app-shell/personalMcpStore";
import { useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import {
  useSkillLibraryStore
} from "@/components/app-shell/skillLibraryStore";
import { resolveEffectiveSkillIds } from "@/lib/contracts/skills";
import { pinSkillForNextTurn } from "@/components/app-shell/skillPinActions";
import type { PowerAppShellV2Props, ShellComposerView, ShellWorkspacePaneActions } from "@/components/app-shell/powerAppShellV2Contracts";
import type {
  RunEventView,
  ThreadArtifactSummary,
  WorkspaceChatSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  attachmentBlocksFromThreadContent,
  mergeLiveThreadArtifacts,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { UiV2Button, UiV2Icon, UiV2IconSprite } from "@/components/ui-v2";
import type { MarkdownHrefResolver } from "@/components/chat/MarkdownMessage";
import { RunFollowupHistoryV2 } from "@/features/conversation-v2/RunFollowupHistoryV2";
import { useAnswerReadAloud } from "@/features/read-aloud/useAnswerReadAloud";
import { presentWorkspaceActivityV2 } from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import { resolveWorkspaceOutputLink } from "@/lib/domain/workspaceLinks";
import { SkillLibraryDialog } from "@/components/skills/SkillLibraryDialog";
import { ProjectSkillPicker } from "@/components/skills/ProjectSkillPicker";
import type { SelectedSkillName } from "@/components/skills/SkillSelectionSummary";
import {
  BranchDrawerV2,
  BranchPagerSlotV2
} from "@/features/branches-v2/BranchesV2";
import { branchPagerForMessageV2 } from "@/features/branches-v2/branchModel";
import { AssistantPickerV2 } from "@/features/composer-v2/AssistantPickerV2";
import {
  ComposerV2,
  type ComposerV2Layer,
  type ComposerV2LayerController
} from "@/features/composer-v2/ComposerV2";
import {
  ConversationTurnV2,
  ConversationV2,
  type ConversationMessageActionsV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import {
  AnswerOutputsV2,
  ArtifactGenerationCardsV2
} from "@/features/answer-outputs-v2/AnswerOutputsV2";
import {
  AnswerIdentityChipV2,
  answerIdentityV2,
  previousVisibleAnswersV2
} from "@/features/answer-outputs-v2/AnswerIdentityV2";
import { MemoryActionConfirmationV2 } from "@/features/answer-outputs-v2/MemoryActionConfirmationV2";
import { openScheduledTaskEditorV2 } from "@/features/answer-outputs-v2/ScheduledTaskCardV2";
import { MemoryCommandStatusV2, memoryCommandIsVisible } from "@/features/answer-outputs-v2/MemoryCommandStatusV2";
import { useMemoryCommands } from "@/components/app-shell/useMemoryCommands";
import {
  ReadingRoomShellV2,
  type NavigationChatRowState,
  type NewChatMode
} from "@/features/navigation-v2/NavigationV2";
import { RunAnswerV2, RunLifecycleAnnouncerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { KnowledgeCitationControl } from "@/features/citations-v2/KnowledgeCitationViewer";
import {
  presentRunLifecycleV2,
  presentToolActivityV2,
  settledRunPresentationV2,
  type AnnouncedRunPresentationV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { documentTitleV2 } from "@/features/workspace-v2/documentTitle";
import {
  runTransportStateV2,
  transportLostForMessageV2,
  type InterruptedRunV2
} from "@/features/workspace-v2/runTransportPresentation";
import { AccountSettingsRowsV2 } from "@/features/settings-v2/AccountSettingsRowsV2";
import { ArchivedChatsPanelV2 } from "@/features/settings-v2/ArchivedChatsPanelV2";
import { DataSettingsRowsV2 } from "@/features/settings-v2/DataSettingsRowsV2";
import { importedFromLabel } from "@/features/chat-import/importLabels";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import { SettingsSelectV2 } from "@/features/settings-v2/SettingsSelectV2";
import { deleteAllPersonalChats } from "@/components/app-shell/accountApi";
import { loadChatNavigation } from "@/components/app-shell/chatNavigationActions";
import {
  SettingsGroupLabelV2,
  SettingsRowV2,
  SettingsSwitchV2,
  SettingsV2
} from "@/features/settings-v2/SettingsV2";
import { accountInitialsV2 } from "@/features/navigation-v2/AccountMenuV2";
import { signOutCurrentSession } from "@/components/app-shell/sessionActions";
import {
  openPermanentChatDeletionStatus,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import { ProjectNavigationV2 } from "@/features/projects-v2/ProjectNavigationV2";
import { ProjectMobileWorkspaceV2 } from "@/features/projects-v2/ProjectMobileWorkspaceV2";
import { ProjectsSurfaceV2 } from "@/features/projects-v2/ProjectsSurfaceV2";
import {
  CreateProjectDialogV2,
  ProjectBlankOrientationV2,
  ProjectContextRailV2,
  ProjectSettingsDialogV2
} from "@/features/projects-v2/ProjectWorkspaceSurfacesV2";
import { attachmentItemsForV2, uploadProgressBytes } from "@/features/attachments-v2/attachmentPresentation";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import type { ComposerConfig, ComposerConfigMcpServer } from "@/lib/contracts/composerConfig";
import type { McpRuntimeErrorCode, UserMcpServer } from "@/lib/contracts/mcp";
import { isMcpAutoDiscoveryFailureCode } from "@/lib/contracts/runs";
import type {
  ChatNavigationFolderWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import { RunSetupV2 } from "./RunSetupV2";
import { AssistantBindingNoticeV2 } from "./AssistantBindingNoticeV2";
import { AssistantIntroV2, AssistantStartersV2 } from "./AssistantIntroV2";
import { AssistantStripV2 } from "./AssistantStripV2";
import { HeaderAssistantSelectorV2, headerModelProvenanceV2 } from "./HeaderAssistantSelectorV2";
import {
  WorkspaceHeaderV2,
  type HeaderOverflowActionV2,
  type WorkspaceHeaderModelSelectorV2
} from "./WorkspaceHeaderV2";
import { LibrarySurfaceV2 } from "./WorkspaceWelcomeV2";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode
} from "react";

export { RunSetupV2, type RunSetupComposerV2 } from "./RunSetupV2";
export {
  HeaderOverflowMenuV2,
  TemporaryChatIndicatorV2,
  WorkspaceHeaderV2,
  type HeaderOverflowActionV2,
  type HeaderOverflowSubmenuItemV2,
  type TemporaryChatHeaderMemoryV2,
  type WorkspaceHeaderFolderV2
} from "./WorkspaceHeaderV2";

export function ComposerOperationErrorV2({
  error,
  live,
  onRetry,
  retryable
}: Readonly<{
  error: string | null;
  live: boolean;
  onRetry(): void;
  retryable: boolean;
}>) {
  return error ? (
    <div className="v2-live-composer-error" role={live ? "alert" : "status"}>
      <span>{error}</span>
      {retryable ? <UiV2Button onClick={onRetry}>Retry</UiV2Button> : null}
    </div>
  ) : null;
}

/**
 * Persistent state of a resumed run that outlived frequent polling. It stays
 * beside the composer (whose Stop remains available) until the run is
 * terminal, independent of transient shell notices.
 */
export function BackgroundRunStatusV2({
  onCheck,
  waiting
}: Readonly<{
  onCheck?(): void;
  waiting: boolean;
}>) {
  return waiting ? (
    <div className="v2-live-composer-error v2-live-background-run" role="status">
      <span>Run is still active in the background.</span>
      {onCheck ? <UiV2Button onClick={onCheck}>Check run</UiV2Button> : null}
    </div>
  ) : null;
}

function messageText(message: ThreadMessage): string {
  return textFromThreadContent(message.content);
}

function currentWorkspaceChat(chatId: string): WorkspaceChatSummary | null {
  return useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId) ?? null;
}

/**
 * Opens a navigation row as one history entry. The navigation list can arrive
 * before the workspace list; a row the workspace does not hold yet opens by
 * its address, exactly as `/c/<id>` does, instead of losing the click.
 */
export function selectNavigationChatV2(
  chatId: string,
  actions: Pick<ShellWorkspacePaneActions, "activateChat" | "openChatAddress">,
  leaveProject: () => void
): void {
  navigateChatRoute(() => {
    const full = currentWorkspaceChat(chatId);
    if (full) {
      leaveProject();
      actions.activateChat(full);
    } else {
      actions.openChatAddress(chatId);
    }
  });
}

function currentWorkspaceFolder(folderId: string) {
  return useWorkspaceStore.getState().folders.find((folder) => folder.id === folderId) ?? null;
}


export function knowledgeReferenceForMessageV2(
  message: Pick<ThreadMessage, "citationMessageId" | "id" | "runId">,
  artifact: ThreadMessage["artifactSummary"] | null,
  settled: boolean
): Readonly<{ messageId: string; runId: string }> | undefined {
  return settled && message.runId && (artifact?.knowledgeCitations?.length ?? 0) > 0
    ? {
        messageId: message.citationMessageId ?? message.id,
        runId: message.runId
      }
    : undefined;
}

/**
 * Live run events, the live artifact summary and the live work clock belong
 * only to the answer whose accepted run id is the current run. An answer
 * without a run id never adopts them, even while no run is current.
 */
export function liveAnswerSourceV2(
  message: Pick<ThreadMessage, "artifactSummary" | "runId">,
  live: Readonly<{
    currentRunId: string | null;
    events: readonly RunEventView[];
    liveArtifactSummary: ThreadArtifactSummary | null;
  }>
): Readonly<{ artifact: ThreadArtifactSummary | null; events: readonly RunEventView[]; ownsLiveRun: boolean }> {
  const ownsLiveRun = Boolean(message.runId) && message.runId === live.currentRunId;
  return ownsLiveRun
    ? { artifact: mergeLiveThreadArtifacts(message.artifactSummary, live.liveArtifactSummary), events: live.events, ownsLiveRun }
    : { artifact: message.artifactSummary ?? null, events: [], ownsLiveRun };
}

type AnswerPresentationThreadV2 = Readonly<{
  activeChatStreaming: boolean;
  currentRunId: string | null;
  events: readonly RunEventView[];
  interruptedRun: InterruptedRunV2 | null;
  liveArtifactSummary: ThreadArtifactSummary | null;
}>;

/** One lifecycle projection per answer, shared by the answer and the announcer. */
export function presentAnswerV2(source: ThreadMessage, thread: AnswerPresentationThreadV2) {
  const live = liveAnswerSourceV2(source, thread);
  // A genuinely lost stream transport (reader error / end without a
  // terminal frame, recorded by the run-lifecycle store) presents as the
  // honest connection-lost strip; the transport slice suppresses the
  // locally invented post-loss "error" status until refresh reconciles.
  const transportLost = transportLostForMessageV2(thread.interruptedRun, source);
  const presentation = presentRunLifecycleV2({
    workspacePreparation: source.workspacePreparation,
    pdfPreparation: source.pdfPreparation,
    ...runTransportStateV2({
      activeChatStreaming: thread.activeChatStreaming,
      interruptedRun: thread.interruptedRun,
      message: { errorMessage: source.errorMessage, id: source.id, runId: source.runId ?? null, status: source.status },
      persistedRunStatus: null
    }),
    content: messageText(source),
    contextCompaction: live.artifact?.contextCompaction,
    events: live.events,
    runId: source.runId ?? null
  });
  return { ...live, presentation, transportLost };
}

/**
 * The announcer follows the tail answer by id; an empty or loading chat is idle without a run.
 * The id tells a rolled-back answer's older settled predecessor from its own settlement.
 */
export function announcedPresentationV2(
  tail: ThreadMessage | undefined,
  thread: AnswerPresentationThreadV2
): AnnouncedRunPresentationV2 {
  return tail?.role === "assistant"
    ? { ...presentAnswerV2(tail, thread).presentation, answerId: tail.id }
    : { kind: "idle", runId: null };
}

export function retryAutoMcpDiscoveryV2(regenerate: () => void): void {
  useComposerControlStore.getState().setMcpSelection({ mode: "auto" });
  regenerate();
}

/**
 * Settings blocks closing and navigation while an owner reports busy. The
 * connections section reports only create, OAuth start and delete, each with
 * its own message.
 */
export function settingsBusyMessageV2(input: Readonly<{
  accountBusy: boolean;
  connectedAppsBusy: boolean;
  connectionsBusyMessage: string | null;
}>): string | null {
  if (input.connectionsBusyMessage) return input.connectionsBusyMessage;
  if (input.connectedAppsBusy) return "Revoking app access…";
  return input.accountBusy ? "Updating account…" : null;
}

/**
 * The personal chat composer's MCP disclosure: installation servers, then the
 * account's enabled personal connections. A snapshot; Settings owns polling.
 */
export function composerMcpServersV2(
  installation: readonly UserMcpServer[],
  personal: readonly PersonalMcpConnection[]
): ComposerConfigMcpServer[] {
  return [
    ...installation.map((server) => ({
      attention: mcpSetupAttention(server),
      description: server.description,
      enabled: server.enabled,
      id: server.id,
      knownToolCount: server.knownToolCount,
      name: server.name,
      readiness: server.readiness,
      runtimeErrorCode: server.runtimeErrorCode,
      source: "installation" as const
    })),
    ...personal.filter((connection) => connection.enabled).map((connection) => ({
      attention: mcpSetupAttention(connection),
      description: connection.description,
      enabled: true,
      id: connection.id,
      knownToolCount: connection.knownToolCount,
      name: connection.name,
      readiness: connection.readiness,
      // The registry codes join `McpRuntimeErrorCode` with the server contract.
      runtimeErrorCode: connection.runtimeErrorCode as McpRuntimeErrorCode | null,
      source: "personal" as const
    }))
  ];
}

export function openPersonalConnectionsSettingsV2(): void {
  useSettingsDestinationStore.getState().openSettings("connections");
}

export function applyLoadAllAfterMcpDiscoveryFailureV2(regenerate: () => void): void {
  useComposerControlStore.getState().setMcpSelection({ mode: "load_all" });
  regenerate();
}

/**
 * The blank canvas shows a selected Assistant's own intro when there is one;
 * a Project shows its shared orientation; the personal blank chat returns
 * `undefined` so the conversation renders only its quiet greeting above the
 * composer — no generic starter prompts.
 */
export function blankConversationOrientationV2(input: Readonly<{
  assistantOrientation?: ReactNode;
  projectOrientation?: ReactNode;
  projectSelected: boolean;
}>): ReactNode {
  return input.projectSelected
    ? input.assistantOrientation ?? input.projectOrientation
    : input.assistantOrientation;
}

type ChatLocationFolderV2 = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
}>;

/** Resolves the visible chat breadcrumb from the authority that owns it. */
export function chatLocationCrumbV2(input: Readonly<{
  chat: Readonly<{ folderId: string | null; projectId?: string | null }> | null;
  personalFolders: readonly ChatLocationFolderV2[];
  project: Readonly<{ id: string; name: string }> | null;
  /** The header's Project chip already names the Project. */
  projectNamed?: boolean;
  projectFolders: readonly ChatLocationFolderV2[];
}>): string | null {
  const projectId = input.chat?.projectId ?? null;
  const projectMatches = Boolean(projectId && input.project?.id === projectId);
  const folders = projectId
    ? projectMatches ? input.projectFolders : []
    : input.personalFolders;
  const folderNames: string[] = [];
  let cursor: string | null = input.chat?.folderId ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = folders.find((candidate) => candidate.id === cursor);
    if (!folder) break;
    folderNames.unshift(folder.name);
    cursor = folder.parentId;
  }
  const names = projectMatches && !input.projectNamed ? [input.project!.name, ...folderNames] : folderNames;
  return names.length > 0 ? names.join(" / ") : null;
}

export function SkillLibraryOverlayV2({
  onClose,
  onSelectionChange,
  open,
  selectedIds,
  selectedSkills,
  includedSkills,
  restoreFocus,
  modelContextWindow, skillsMode, availableCount
}: Readonly<{
  skillsMode?: "auto" | "off";
  availableCount?: number;
  modelContextWindow?: number;
  selectedSkills?: readonly SelectedSkillName[];
  includedSkills?: readonly SelectedSkillName[];
  restoreFocus?(): HTMLElement | null;
  onClose(): void;
  onSelectionChange(skillIds: readonly string[]): void;
  open: boolean;
  selectedIds: readonly string[];
}>) {
  return open ? (
    <SkillLibraryDialog
      modelContextWindow={modelContextWindow}
      skillsMode={skillsMode} availableCount={availableCount}
      includedSkills={includedSkills}
      selectedSkills={selectedSkills}
      restoreFocus={restoreFocus}
      onClose={onClose}
      onSelectionChange={onSelectionChange}
      selectedIds={selectedIds}
    />
  ) : null;
}

/** Defaults & roles > PDF processing in chats, where the PDF reader is assigned. */
const PDF_PROCESSING_SETTINGS = { resource: "chat_pdf", section: "roles" } as const;

export function PowerAppShellV2View(props: PowerAppShellV2Props) {
  const { branches, composer, overlays, session, settings, thread, workspace } = props;
  const refreshThreadLayout = thread.refreshLayout;
  const [libraryInitialTab, setLibraryInitialTab] = useState<LibraryTabIdV2 | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const target = new URL(window.location.href).searchParams.get("library");
    return libraryTabGroups.flatMap(group => group.tabs).find(id => id === target);
  });
  const artifactPanel = useArtifactPanelStore(state => state.open);
  const composerArtifactEdit = useComposerSessionStore(state => state.sessionsByKey[state.activeSessionKey]?.artifactEdit ?? null);
  const composerArtifactCreate = useComposerSessionStore(state => state.sessionsByKey[state.activeSessionKey]?.artifactCreate ?? null);
  const followupSubmission = useComposerSessionStore(state => state.sessionsByKey[state.activeSessionKey]?.followupSubmission ?? null);
  const uploadSourceKey = useComposerSessionStore(state => state.activeSessionKey);
  const composerComments = useComposerSessionStore(state => state.sessionsByKey[state.activeSessionKey]?.comments);
  const composerDraftTooLarge = useSyncExternalStore(subscribeComposerDraftRefusals,
    () => composerDraftTooLargeToStore(session.accountId, uploadSourceKey), () => false);
  const uploadProgress = useWorkspaceUploadProgress(state => state.items);
  const pendingUploads = useMemo(() => uploadProgress.filter(item => item.sourceKey === uploadSourceKey), [uploadProgress, uploadSourceKey]);
  const skillsMode = useComposerControlStore(state => state.skillsMode);
  const liveWorkspaceRef = useRef<HTMLElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const setLiveWorkspaceRef = useCallback((node: HTMLElement | null) => {
    liveWorkspaceRef.current = node;
    if (!node) return;
    const measure = () => setWorkspaceWidth(node.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    activateArtifactLibraryAccount(session.accountId);
    closeArtifactPanel(false);
  }, [session.accountId]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("library")) return;
    // The account-scoped OAuth owner consumes the destination with its outcome.
    if (url.searchParams.get("library") === "mcp" && url.searchParams.has("oauth")) return;
    const target = libraryTabGroups.flatMap(group => group.tabs).find(id => id === url.searchParams.get("library"));
    // `?library=assistants&assistant=<id>` opens that Assistant's detail sheet; both are consumed together.
    const assistantLink = url.searchParams.has("assistant") ? boundedRouteId(url.searchParams.get("assistant")) : undefined;
    url.searchParams.delete("library");
    url.searchParams.delete("assistant");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (!target) return;
    if (settings.studio) {
      if (target === "assistants" && assistantLink !== undefined) settings.studio.open(target, () => openAssistantDetail(assistantLink));
      else settings.studio.open(target);
    } else settings.openLibrary();
  }, [settings]);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  /** Groups of monitoring checks with no update the reader opened, by group id. */
  const [openScheduledChecks, setOpenScheduledChecks] = useState<ReadonlySet<string>>(() => new Set());
  const [connectedAppsBusy, setConnectedAppsBusy] = useState(false);
  const [connectionsBusyMessage, setConnectionsBusyMessage] = useState<string | null>(null);
  const [projectsSurfaceOpen, setProjectsSurfaceOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const settingsBusyMessage = settingsBusyMessageV2({ accountBusy, connectedAppsBusy, connectionsBusyMessage });
  const [accountDirty, setAccountDirty] = useState(false);
  const [accountKey, setAccountKey] = useState(0);
  const [dataSubview, setDataSubview] = useState<null | "archived">(null);
  const [skillLibraryScope, setSkillLibraryScope] = useState<string | null>(null);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [composerLayer, setComposerLayer] = useState<ComposerV2Layer>(null);
  const [workspaceResetOpen, setWorkspaceResetOpen] = useState(false);
  const [exportHistoryChatId, setExportHistoryChatId] = useState<string | null>(null);
  useArtifactEditAddress({
    activeChatId: session.activeChatId,
    detailLoading: thread.activeChatDetailLoading,
    panelFits: () => (liveWorkspaceRef.current?.getBoundingClientRect().width ?? 0) >= 896
  });
  const mcpServers = useMcpSettingsStore((state) => state.servers);
  const personalConnections = usePersonalMcpStore((state) => state.connections);
  const skillCatalog = useSkillLibraryStore((state) => state.data);
  const mcpSelection = useComposerControlStore((state) => state.mcpSelection);
  const selectedSkills = useComposerControlStore((state) => state.selectedSkills);
  const navigationFolders = useWorkspaceStore((state) => state.navigationFolders);
  // Server-verified capability gate for the direct "Delete…" entries; the
  // deletion confirm surface and its semantics stay unchanged.
  const permanentChatDeletionAvailable = useMemorySettingsStore(
    (state) => Boolean(state.data?.capabilities.permanentChatDeletion)
  );
  const permanentChatDeletionModalOpen = usePermanentChatDeletionStore(
    (state) => Boolean(state.target) || state.statusOpen
  );
  const archivedManageRef = useRef<HTMLButtonElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const setComposerDockRef = useCallback((dock: HTMLDivElement | null) => {
    composerDockRef.current = dock;
    if (!dock) {
      setComposerDockHeight(0);
      return;
    }
    const updateHeight = () => {
      if (composerDockRef.current === dock) {
        setComposerDockHeight(Math.ceil(dock.getBoundingClientRect().height));
      }
    };
    updateHeight();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateHeight);
    observer?.observe(dock, { box: "border-box" });
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", updateHeight);
    viewport?.addEventListener("scroll", updateHeight);
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener("resize", updateHeight);
      viewport?.removeEventListener("scroll", updateHeight);
      if (composerDockRef.current === dock) {
        composerDockRef.current = null;
        setComposerDockHeight(0);
      }
    };
  }, []);
  useLayoutEffect(() => {
    refreshThreadLayout();
  }, [composerDockHeight, refreshThreadLayout]);
  const composerLayerController = useRef<ComposerV2LayerController | null>(null);
  // The header opens a layer of the composer. While no composer is mounted (a
  // conversation or the workspace still loading renders none) its trigger is
  // not actionable, so a click is never silently dropped.
  const [composerLayerHost, setComposerLayerHost] = useState(false);
  const attachComposerLayerController = useCallback((controller: ComposerV2LayerController | null) => {
    composerLayerController.current = controller;
    setComposerLayerHost(controller !== null);
  }, []);
  const assistantSelectorRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousActiveChatIdRef = useRef(session.activeChatId);
  const personalMemoryOpen = settings.memory.open;
  const closePersonalMemory = settings.closeMemory;
  const libraryOpen = Boolean(settings.library || settings.knowledge || personalMemoryOpen);
  const routeChatId = parseChatRoutePath(useChatRoutePath())?.chatId ?? null;

  const closeDataSubview = () => {
    setDataSubview(null);
    window.requestAnimationFrame(() => archivedManageRef.current?.focus());
  };
  const activeChatSummary = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
  const selectedProjectContext = Boolean(
    workspace.projects.detail &&
    workspace.projects.selectedProjectId === workspace.projects.detail.id
  );
  const projectContext = Boolean(
    activeChatSummary?.projectId || (!activeChatSummary && workspace.projects.selectedProjectId)
  );
  const memoryCommands = useMemoryCommands({
    accountId: session.accountId,
    chatId: session.activeChatId,
    enabled: !projectContext && composer.memory.mode === "NORMAL",
    messageKey: thread.visibleMessages.filter((message) => message.role === "user")
      .map((message) => message.id).join(",")
  });
  const artifactPanelAllowed = !projectContext && composer.memory.mode !== "TEMPORARY" && !libraryOpen && !projectsSurfaceOpen && !settings.settings.open;
  const visibleArtifactPanel = artifactPanelAllowed && artifactPanel?.chatId === session.activeChatId ? artifactPanel : null;
  useEffect(() => {
    if (artifactPanel && (!artifactPanelAllowed || artifactPanel.chatId !== session.activeChatId)) closeArtifactPanel(false);
  }, [artifactPanel, artifactPanelAllowed, session.activeChatId]);
  useLayoutEffect(() => { refreshThreadLayout(); }, [visibleArtifactPanel, workspaceWidth, refreshThreadLayout]);
  useEffect(() => {
    if (!visibleArtifactPanel?.draftId) return;
    const draft = thread.artifactDrafts?.find(draft => draft.draftId === visibleArtifactPanel.draftId);
    if (draft?.status !== "interrupted") return;
    const saved = thread.visibleMessages.find(message => message.id === thread.artifactDraftMessageId)?.artifactSummary?.generatedArtifacts ?? [];
    const matching = draft.title ? saved.filter(artifact => artifact.title === draft.title && (!draft.kind || artifact.kind === draft.kind)) : saved;
    if (matching.length === 1) useArtifactPanelStore.setState({ open: { chatId: visibleArtifactPanel.chatId, artifactId: matching[0].artifactId, versionId: matching[0].versionId } });
  }, [visibleArtifactPanel, thread.artifactDrafts, thread.artifactDraftMessageId, thread.visibleMessages]);
  const latestPanelArtifact = useMemo(() => {
    if (!visibleArtifactPanel) return null;
    return [...thread.visibleMessages.flatMap(message => message.artifactSummary?.generatedArtifacts ?? []),
      ...(thread.liveArtifactSummary?.generatedArtifacts ?? [])]
      .filter(artifact => artifact.artifactId === visibleArtifactPanel.artifactId)
      .sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null;
  }, [thread.liveArtifactSummary, thread.visibleMessages, visibleArtifactPanel]);
  const editArtifact = async (generated: ThreadGeneratedArtifact, intent: "edit" | "runtime_error" = "edit", error?: ArtifactRuntimeError) => {
    const chatId = session.activeChatId;
    if (!chatId || !artifactPanelAllowed) return;
    await prepareArtifactEdit(generated.artifactId, generated.versionId, chatId);
    if (useWorkspaceStore.getState().activeChatId !== chatId) return;
    setArtifactEditSession(chatId, generated, intent, error);
    if (workspaceWidth >= 896) openArtifactPanel({ chatId, artifactId: generated.artifactId, versionId: generated.versionId });
    else closeArtifactPanel(false);
    requestAnimationFrame(() => composerDockRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }));
  };
  const activeProjectChat = activeChatSummary?.projectId
    ? workspace.projects.workspace?.chats.find((chat) => chat.id === activeChatSummary.id) ?? null
    : null;
  const activeProject = activeChatSummary?.projectId === workspace.projects.detail?.id ||
    (selectedProjectContext && !activeChatSummary)
    ? workspace.projects.detail
    : null;
  // Deletion status survives direct entry/reload independently of the local
  // overview toggle. The owner must keep a reachable status and retry action.
  const projectsSurfaceVisible = projectsSurfaceOpen || activeProject?.status === "DELETING";
  const skillScopeKey = `${session.accountId}:${projectContext ? activeChatSummary?.projectId ?? workspace.projects.selectedProjectId : "personal"}:${session.activeChatId ?? "new"}`;
  const skillScopeRef = useRef(skillScopeKey);
  useLayoutEffect(() => { skillScopeRef.current = skillScopeKey; }, [skillScopeKey]);
  const [previousSkillScopeKey, setPreviousSkillScopeKey] = useState(skillScopeKey);
  if (previousSkillScopeKey !== skillScopeKey) {
    setPreviousSkillScopeKey(skillScopeKey);
    setSkillLibraryScope(null);
  }
  const restoreSkillFocus = () =>
    composerDockRef.current?.querySelector<HTMLElement>('[aria-label="Change Skills mode"]') ??
    composerDockRef.current?.querySelector<HTMLElement>('[aria-label="Add"]') ?? null;
  function selectManualSkills(ids: readonly string[]) {
    if (skillScopeRef.current !== skillScopeKey) return;
    const byId = new Map((projectContext
      ? (activeProject?.resources ?? []).flatMap((resource) => resource.type === "skill" && resource.available
        ? [{ id: resource.resourceId, name: resource.label, description: resource.description ?? "", promptCharacterCount: resource.promptCharacterCount ?? 0,
          instructionApproxTokens: resource.instructionApproxTokens }] : [])
      : (skillCatalog?.skills ?? []).filter((skill) => !skill.archived).map((skill) => ({
        id: skill.id, name: skill.name, description: skill.description, promptCharacterCount: skill.instructionCharacterCount,
        instructionApproxTokens: skill.instructionApproxTokens
      }))).map((skill) => [skill.id, skill]));
    const previous = new Map(useComposerControlStore.getState().selectedSkills.map((skill) => [skill.id, skill]));
    useComposerControlStore.getState().setSelectedSkills(ids.flatMap((id) => {
      const skill = byId.get(id) ?? (!projectContext ? previous.get(id) : undefined);
      return skill ? [skill] : [];
    }));
  }
  // The chat Assistant's Skill links: undefined without an Assistant, empty
  // while it is unavailable or deleted.
  const assistantIncludedSkills = composer.assistant.current
    ? composer.assistant.current.state === "bound" ? composer.assistant.current.includedSkills : []
    : undefined;
  const pinnedSkillIds = resolveEffectiveSkillIds((assistantIncludedSkills ?? []).filter(skill => skill.mode !== "available").map(skill => skill.id), selectedSkills.map(skill => skill.id));
  const pinLoadedSkill = (skillId: string) => pinSkillForNextTurn({
    skillId, isCurrentScope: () => skillScopeRef.current === skillScopeKey,
    ...(projectContext ? { projectSkills: (activeProject?.resources ?? []).flatMap(resource => resource.type === "skill"
      ? [{ id: resource.resourceId, name: resource.label, description: resource.description ?? "", promptCharacterCount: resource.promptCharacterCount ?? 0,
        instructionApproxTokens: resource.instructionApproxTokens, available: resource.available }] : []) } : {})
  });
  const latestMessage = thread.visibleMessages.at(-1);
  function openSkillLibrary() { setSkillLibraryScope(skillScopeKey); }
  const assistantAvailableSkills = assistantIncludedSkills ? assistantIncludedSkills.filter(skill => skill.mode === "available" && !selectedSkills.some(selected => selected.id === skill.id)).length : undefined;
  const continuationEligible = Boolean(workspace.pane.actions.openContinuedChat && session.activeChatId && latestMessage?.role === "assistant" &&
    latestMessage.status === "complete" && !thread.activeChatStreaming && !thread.activeChatDetailLoading &&
    !thread.activeChatDetailError && !activeProjectChat?.archived &&
    (!projectContext || activeProject?.capabilities.mutateChats));
  const continuation = useChatContinuation({
    accountId: session.accountId, chatId: session.activeChatId,
    leafMessageId: latestMessage?.id ?? null, eligible: continuationEligible,
    modelSelection: composer.selectedProvider && composer.selectedModelId
      ? { provider: composer.selectedProvider, modelId: composer.selectedModelId } : undefined,
    uploading: composer.uploading,
    recommended: Boolean(composer.composerContextStats?.snapshotSource === "live" &&
      composer.composerContextStats.session?.phase === "after_answer" &&
      ((composer.composerContextStats.session.droppedMessages > 0) ||
        (composerContextGauge(composer.composerContextStats).inputBudgetFraction ?? 0) >= 0.7)),
    onOpen: async (chat, sourceKey) => {
      const opened = await workspace.pane.actions.openContinuedChat?.(chat, sourceKey);
      if (!opened) return;
      requestAnimationFrame(() => {
        if (useWorkspaceStore.getState().activeChatId !== chat.id) return;
        const textarea = composerDockRef.current?.querySelector<HTMLTextAreaElement>("textarea");
        textarea?.focus({ preventScroll: true });
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    }
  });
  const projectHeaderFolders = useMemo(
    () => (workspace.projects.workspace?.folders ?? []).map((folder) => ({
      ...folder,
      // The current Project UI is deliberately one level. Legacy parent
      // links remain useful for the location crumb, but never mint a nested
      // movement target in the header.
      parentId: null
    })),
    [workspace.projects.workspace?.folders]
  );
  const headerFolders = projectContext ? projectHeaderFolders : navigationFolders;
  // Project chat locations use the Project-owned folder tree. The Project name
  // leads the crumb only while the header's Project chip, which names the
  // loaded Project, is absent. Personal chats retain their folder-only path.
  // The cycle guard makes older malformed parent data harmless.
  const activeChatCrumb = useMemo(() => {
    const projectId = activeChatSummary?.projectId ?? null;
    const project = projectId
      ? workspace.projects.detail?.id === projectId
        ? workspace.projects.detail
        : workspace.projects.projects.find((candidate) => candidate.id === projectId) ?? null
      : null;
    return chatLocationCrumbV2({
      chat: activeChatSummary,
      personalFolders: navigationFolders,
      project,
      projectNamed: Boolean(projectId && workspace.projects.detail?.id === projectId),
      projectFolders: projectId === workspace.projects.selectedProjectId
        ? workspace.projects.workspace?.folders ?? []
        : []
    });
  }, [
    activeChatSummary,
    navigationFolders,
    workspace.projects.detail,
    workspace.projects.projects,
    workspace.projects.selectedProjectId,
    workspace.projects.workspace?.folders
  ]);

  useEffect(() => {
    const previousChatId = previousActiveChatIdRef.current;
    previousActiveChatIdRef.current = session.activeChatId;
    if (
      projectsSurfaceOpen && session.activeChatId &&
      session.activeChatId !== previousChatId
    ) {
      setProjectsSurfaceOpen(false);
    }
    if (session.activeChatId !== previousChatId) {
      setWorkspaceResetOpen(false);
      setExportHistoryChatId(null);
    }
  }, [projectsSurfaceOpen, session.activeChatId]);

  useEffect(() => {
    if (!projectContext) return observeMcpSettings();
  }, [projectContext]);
  // Personal connections join the composer disclosure of personal chats only;
  // Settings mutations and OAuth returns update the same store.
  useEffect(() => {
    if (!projectContext) ensurePersonalMcpLoaded();
  }, [projectContext]);
  useEffect(() => {
    if (projectContext) {
      const available = new Map((activeProject?.resources ?? []).flatMap((resource) =>
        resource.type === "skill" && resource.available
          ? [[resource.resourceId, {
              description: resource.description ?? "",
              id: resource.resourceId,
              name: resource.label,
              promptCharacterCount: resource.promptCharacterCount ?? 0,
              instructionApproxTokens: resource.instructionApproxTokens
            }] as const]
          : []
      ));
      const next = selectedSkills.flatMap((skill) => {
        const published = available.get(skill.id);
        return published ? [published] : [];
      });
      if (next.length !== selectedSkills.length || next.some((skill, index) =>
        skill.id !== selectedSkills[index]?.id ||
        skill.name !== selectedSkills[index]?.name ||
        skill.description !== selectedSkills[index]?.description ||
        skill.instructionApproxTokens !== selectedSkills[index]?.instructionApproxTokens ||
        skill.promptCharacterCount !== selectedSkills[index]?.promptCharacterCount
      )) {
        useComposerControlStore.getState().setSelectedSkills(next);
      }
      return;
    }
    if (!skillCatalog || selectedSkills.length === 0) return;
    const catalogById = new Map(skillCatalog.skills.map((skill) => [skill.id, skill] as const));
    const next = selectedSkills.flatMap((selected) => {
      const skill = catalogById.get(selected.id);
      if (!skill) return [selected];
      return !skill.archived ? [{
        description: skill.description,
        id: skill.id,
        name: skill.name,
        instructionApproxTokens: skill.instructionApproxTokens,
        promptCharacterCount: skill.instructionCharacterCount
      }] : [];
    });
    if (next.length !== selectedSkills.length || next.some((skill, index) =>
      skill.name !== selectedSkills[index]?.name ||
      skill.description !== selectedSkills[index]?.description ||
      skill.instructionApproxTokens !== selectedSkills[index]?.instructionApproxTokens ||
      skill.promptCharacterCount !== selectedSkills[index]?.promptCharacterCount)) {
      useComposerControlStore.getState().setSelectedSkills(next);
    }
  }, [activeProject, projectContext, selectedSkills, skillCatalog]);
  // The tab title follows the visible active chat (rename/switch included);
  // the Library replaces it while it owns the workspace. Next.js re-applies
  // its static route metadata after hydration, so the effect also watches the
  // <title> node and re-asserts the shell-owned value when something else
  // overwrites it.
  useEffect(() => {
    const desired = documentTitleV2({
      activeChatId: session.activeChatId,
      activeChatTitle: session.activeChatTitle,
      libraryOpen,
      routeChatId
    });
    if (document.title !== desired) document.title = desired;
    const titleNode = document.head.querySelector("title");
    if (!titleNode) return;
    const observer = new MutationObserver(() => {
      if (document.title !== desired) document.title = desired;
    });
    observer.observe(titleNode, { characterData: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, [libraryOpen, routeChatId, session.activeChatId, session.activeChatTitle]);
  useEffect(() => {
    // A personal Memory overlay must not survive navigation into a shared
    // Project. Apart from hiding the surface, this prevents a stale overlay
    // from triggering a personal Memory read in Project context.
    if (projectContext) {
      if (personalMemoryOpen) closePersonalMemory();
      return;
    }
    if (!personalMemoryOpen) return;
    const bound = useMemoryManagerStore.getState().accountId === session.accountId;
    void Promise.all([
      refreshMemorySettings().catch(() => null),
      (bound ? refreshMemoryList() : openMemoryManager(session.accountId)).catch(() => undefined)
    ]);
  }, [closePersonalMemory, personalMemoryOpen, projectContext, session.accountId]);

  const config = useMemo<ComposerConfig | null>(() => composer.catalog ? ({
    assistants: composer.assistant.pickerItems,
    catalog: composer.catalog,
    knowledgeBases: composer.knowledge.bases,
    ...(composer.knowledge.documentTotal === null
      ? {}
      : { knowledgeDocumentTotal: composer.knowledge.documentTotal }),
    knowledgeSources: composer.knowledge.sources,
    mcpServers: projectContext
      ? activeProject?.policy.externalToolsEnabled
        ? activeProject.composer?.mcpServers ?? []
        : []
      : composerMcpServersV2(mcpServers, personalConnections),
    skills: projectContext
      ? (activeProject?.resources ?? []).flatMap((resource) =>
          resource.type === "skill" && resource.available
            ? [{
                archived: false,
                description: resource.description ?? "",
                id: resource.resourceId,
                instructionCharacterCount: resource.promptCharacterCount ?? 0,
                instructionApproxTokens: resource.instructionApproxTokens,
                name: resource.label,
                owned: false,
                ownerDisplayName: "Project",
                scope: { kind: "workspace", workspaceNames: [activeProject?.name ?? "Project"] },
                updatedAt: activeProject?.updatedAt ?? new Date(0).toISOString(),
                version: 1
              }]
            : []
        )
      : skillCatalog?.skills ?? []
  }) : null, [activeProject, composer.assistant.pickerItems, composer.catalog, composer.knowledge.bases, composer.knowledge.documentTotal, composer.knowledge.sources, mcpServers, personalConnections, projectContext, skillCatalog?.skills]);
  const pdfSettingsHref = useControlCenterHref(PDF_PROCESSING_SETTINGS);
  const pdfRoutePreview = useChatPdfRoutePreview(composer.currentModel && composer.attachments.some((item) => item.kind === "pdf") ? {
    projectId: activeProject?.id ?? null, providerConnectionId: composer.currentModel.provider, providerModelId: composer.currentModel.modelId
  } : null);
  const attachmentItems = useMemo(
    () => [...attachmentItemsForV2(
      composer.attachments,
      attachmentWarningsForModel(
        composer.attachments,
        composer.currentModel,
        composer.workspace.enabled,
        pdfRoutePreview
      ),
      composer.currentModel,
      composer.workspace.enabled,
      pdfRoutePreview,
      session.adminEntryVisible ? pdfSettingsHref : null
    ), ...pendingUploads.map(item => ({
      id: item.id, fileName: item.fileName, byteSize: item.byteSize, blocksSend: true, upload: true,
      status: item.state === "verifying" ? "processing" as const : item.state,
      progress: item.sentBytes / item.byteSize * 100, retryable: item.retryable,
      statusLabel: item.state === "verifying" ? "Verifying file…" : item.state === "failed" ? "Upload interrupted" : undefined,
      detail: item.message ?? uploadProgressBytes(item.sentBytes, item.byteSize)
    }))],
    [composer.attachments, composer.currentModel, composer.workspace.enabled, pdfRoutePreview, pdfSettingsHref, pendingUploads, session.adminEntryVisible]
  );
  const attachmentUsage = useMemo(
    () => calculateAttachmentLimitUsage(
      [...composer.attachments, ...pendingUploads.map(item => ({
        id: item.id, fileName: item.fileName, byteSize: item.byteSize, kind: "file" as const
      }))],
      composer.currentModel,
      composer.catalog?.attachmentLimits
    ),
    [composer.attachments, composer.catalog?.attachmentLimits, composer.currentModel, pendingUploads]
  );
  // Picker footer summary ("Reasoning medium · Temp 1.0") from the controls
  // the current model actually supports.
  const modelParametersSummary = useMemo(() => {
    const controls = composer.currentParameterControls;
    const parts: string[] = [];
    if (controls.reasoningEffort.supported) parts.push(`Reasoning ${composer.reasoningEffort}`);
    if (controls.temperature.supported) parts.push(`Temp ${composer.temperature}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [composer.currentParameterControls, composer.reasoningEffort, composer.temperature]);
  // Header model selector (operator decision 2026-09-02): the trigger lives
  // in the header on every width and anchors the composer-owned picker. It
  // shows the model name only; the chat Assistant's provenance is the dot and
  // the tooltip, a fixed model locks it (PRD 10.6). An absent catalog or a
  // live answer disables it.
  const chatAssistant = composer.assistant.current;
  const headerModelSelector = useMemo<WorkspaceHeaderModelSelectorV2>(() => {
    const catalog = composer.catalog;
    const model = composer.currentModel;
    const provider = catalog?.providers.find((candidate) => candidate.id === model?.provider);
    const noModels = Boolean(catalog && catalog.models.length === 0);
    const modelName = model?.displayName ?? (noModels ? "No models available" : "Choose model");
    const provenance = headerModelProvenanceV2(chatAssistant, modelName, catalog?.models ?? []);
    // A fixed model still opens the picker for its Parameters row,
    // except while the Assistant blocks sending.
    return {
      disabled: !catalog || Boolean(composer.catalogError) || noModels || thread.activeChatStreaming ||
        Boolean(provenance.blocked) || !composerLayerHost,
      expanded: composerLayer === "model",
      family: provider?.family ?? null,
      fromAssistant: provenance.fromAssistant,
      label: provider?.name ?? model?.provider ?? "",
      locked: provenance.locked,
      name: modelName,
      onToggle: (anchor) => composerLayerController.current?.toggle("model", anchor),
      title: provenance.title
    };
  }, [
    chatAssistant,
    composer.catalog,
    composer.catalogError,
    composer.currentModel,
    composerLayer,
    composerLayerHost,
    thread.activeChatStreaming
  ]);
  const canSubmitFollowup = Boolean(latestMessage?.runId === thread.currentRunId && latestMessage?.followups?.available &&
    !activeProjectChat?.archived && (!projectContext || activeProject?.status === "ACTIVE" && activeProject.capabilities.mutateChats) && composer.submitFollowup);
  const composerSurface = (
    <ComposerV2
      sessionKey={skillScopeKey}
      usageLimitsAccountId={session.accountId}
      activeRun={thread.activeChatStreaming && !thread.answerComplete}
      skillsMode={skillsMode}
      onSelectSkillsMode={mode => useComposerControlStore.getState().setSkillsMode(mode)}
      artifactEdit={composerArtifactEdit}
      artifactCreate={Boolean(composerArtifactCreate)}
      artifactUnavailableReason={artifactUnavailableReason({ agent: Boolean(composer.agent?.enabled), project: projectContext, temporary: composer.memory.mode === "TEMPORARY" })}
      onCreateArtifact={() => {
        const store = useComposerSessionStore.getState();
        store.updateSession(store.activeSessionKey, { artifactCreate: { intent: "create" }, artifactEdit: null });
      }}
      onRemoveArtifactCreate={() => {
        const store = useComposerSessionStore.getState();
        store.updateSession(store.activeSessionKey, { artifactCreate: null });
      }}
      onRemoveArtifactEdit={() => {
        const store = useComposerSessionStore.getState();
        store.updateSession(store.activeSessionKey, { artifactEdit: null });
      }}
      assistant={composer.assistant}
      attachmentItems={attachmentItems}
      attachmentLimitUsage={attachmentUsage}
      attachmentPolicy={attachmentPolicyForModel(
        composer.currentModel,
        composer.workspace.available
      )}
      config={config}
      configError={Boolean(composer.catalogError)}
      disabledReason={thread.editingMessageId
        ? "Finish or cancel the inline edit first."
        : composer.composerDisabledHint}
      draft={composer.draft}
      comments={composerComments}
      draftTooLargeToKeep={composerDraftTooLarge}
      onUpdateComment={(id, text) => {
        const refusal = useComposerSessionStore.getState().updateComment(uploadSourceKey, id, text);
        return refusal ? composerCommentRefusalMessage(refusal, "edit") : null;
      }}
      onRemoveComment={id => useComposerSessionStore.getState().removeComment(uploadSourceKey, id)}
      hasReadyAttachments={attachmentItems.some((item) => !item.blocksSend)}
      layerController={attachComposerLayerController}
      modelParametersSummary={modelParametersSummary}
      reasoningEffort={composer.currentModel && composer.currentParameterControls.reasoningEffort.supported ? {
        onChange: composer.changeReasoningEffort,
        options: composer.currentParameterControls.reasoningEffort.options,
        value: composer.reasoningEffort
      } : null}
      onAttachmentCountLimitExceeded={composer.composerActions.rejectAttachmentCount}
      onDraftChange={composer.composerActions.changeDraft}
      onLayerChange={setComposerLayer}
      onMakeModelDefault={composer.makeModelDefault}
      onOpenKnowledgeLibrary={projectContext ? undefined : settings.openKnowledge}
      onOpenMcpSettings={projectContext ? workspace.projects.actions.openSettings : settings.openMcp}
      onOpenPersonalMcpSettings={projectContext ? undefined : openPersonalConnectionsSettingsV2}
      onOpenModelParameters={() => setRunSetupOpen(true)}
      onOpenSkillLibrary={openSkillLibrary}
      onOverrideKnowledgePlan={composer.knowledge.override}
      onRemoveAttachment={id => { if (!cancelWorkspaceUpload(id)) composer.composerActions.removeAttachment(id); }}
      onRejectedFiles={(files) => composer.composerActions.rejectAttachments(files.map((file) => file.name))}
      onRetryAttachment={id => { if (!retryWorkspaceUpload(id)) composer.composerActions.retryAttachment?.(id); }}
      onRetryConfig={composer.retryCatalog}
      onSearchKnowledgeSources={composer.knowledge.searchSources}
      onSelectKnowledgeSelection={composer.knowledge.select}
      onSelectMcp={composer.selectMcpMode}
      onSelectModel={composer.selectModel}
      onSelectSearchOptionIds={(ids) => composer.selectSearchPlan(ids, composer.searchPlanMode)}
      searchPlanMode={composer.searchPlanMode}
      onSelectSearchPlanMode={mode => composer.selectSearchPlan(composer.selectedSearchOptionIds, mode)}
      onResetSearchPlan={composer.useOrganizationSearchDefault}
      onSend={() => void composer.submitComposer()}
      onFollowup={canSubmitFollowup
          ? runId => void composer.submitFollowup?.(runId) : undefined}
      followupSending={Boolean(followupSubmission?.inFlight)}
      onStop={() => void composer.stopCurrentRun(thread.currentRunId)}
      stopping={composer.stopping}
      onUploadFiles={(files) => composer.uploadFiles(files)}
      onReuseFile={composer.reuseFile}
      runId={thread.currentRunId}
      knowledgePlanSource={composer.knowledge.planSource}
      mcpSelection={mcpSelection}
      selectedKnowledgeSelection={composer.knowledge.selection}
      selectedModelId={composer.selectedModelId}
      selectedProvider={composer.selectedProvider}
      selectedSearchOptionIds={composer.selectedSearchOptionIds}
      sendWithEnter={composer.sendWithEnter}
      sending={composer.sending}
      selectedSkillIds={selectedSkills.map((skill) => skill.id)}
      selectedSkills={selectedSkills.map(({ id, name }) => ({ id, name }))}
      sharedProject={projectContext}
      agent={composer.agent ? { ...composer.agent, onToggle: composer.agent.setEnabled } : undefined}
      uploading={composer.uploading}
      uploadLimitHint={composer.uploadLimitHint}
      workspace={{
        available: composer.workspace.available,
        busy: composer.workspace.busy,
        commandRunning: composer.workspace.commandRunning,
        enabled: composer.workspace.enabled,
        internetEnabled: composer.workspace.internetEnabled,
        loading: composer.workspace.loading,
        onToggle: (value) => void composer.workspace.setEnabled(value),
        sessionState: composer.workspace.sessionState,
        ...(composer.workspace.unavailableReason
          ? { unavailableReason: composer.workspace.unavailableReason }
          : {})
      }}
    />
  );
  const focusComposerInput = () => {
    composerDockRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
  };
  const composerOperationError = (
    <>
      <BackgroundRunStatusV2 onCheck={thread.checkBackgroundRun} waiting={Boolean(thread.backgroundRunWaiting)} />
      <ComposerOperationErrorV2
        error={composer.operationError}
        live={composer.operationErrorLive}
        onRetry={() => followupSubmission ? void composer.submitFollowup?.(followupSubmission.runId) : void composer.submitComposer()}
        retryable={Boolean(composer.operationErrorRetryable || followupSubmission && !followupSubmission.inFlight)}
      />
      {/* Every composer stack shows the unavailable Assistant right above the composer. */}
      <AssistantBindingNoticeV2
        current={composer.assistant.current}
        onChooseAnother={() => composer.assistant.setPickerOpen(true)}
        onContinueWithout={composer.assistant.continueWithout}
        onOpenInStudio={projectContext ? null : composer.assistant.editById}
        onRestore={composer.assistant.restore}
        pending={composer.assistant.pending}
        restoreFocus={focusComposerInput}
      />
    </>
  );
  // Run rejections can belong to one chat. Keep them out of the shared shell
  // while navigation is settling; the owner discards them on a chat change.
  const shellNotice = session.notice &&
    (!session.notice.chatId || session.notice.chatId === session.activeChatId) ? (
    <div className="v2-live-notice">
      <ShellNotice notice={session.notice} onDismiss={session.dismissNotice} />
    </div>
  ) : null;
  const browserNotificationsBanner = composer.browserNotifications ? (
    <BrowserNotificationsBannerV2 notifications={composer.browserNotifications} />
  ) : null;
  const scheduledTaskHint = thread.scheduledTaskChat && !projectContext ? (
    <ScheduledTaskChatHintV2 onEdit={thread.scheduledTaskChat.onEdit} title={thread.scheduledTaskChat.title} />
  ) : null;
  // A blank chat with an Assistant opens with its quiet intro; the intro stays
  // while the user types so the composer below it never moves.
  const assistantOrientation = chatAssistant?.state === "bound" ? (
    <AssistantIntroV2
      avatar={chatAssistant.avatar}
      description={chatAssistant.description}
      name={chatAssistant.name}
      owned={chatAssistant.owned}
      ownerDisplayName={chatAssistant.ownerDisplayName}
      projectName={chatAssistant.project ? chatAssistant.projectName ?? null : undefined}
    />
  ) : undefined;
  // Quiet rows under the blank composer (PRD 10.5, 10.6): the Assistant strip
  // of a blank personal or temporary chat, or the chosen Assistant's starters
  // while it can send. Both reserve their space while a draft exists.
  const blankComposerIdle = !composer.draft.trim() && !composerComments?.length && composer.attachments.length === 0 &&
    !composer.uploading && !composer.sending;
  // The picker's Parameters row closes with the picker, so the parameters
  // layer returns focus to the header model selector, or to the Assistant
  // selector beside it while the model selector is disabled.
  const restoreRunSetupFocus = () => [modelTriggerRef.current, assistantSelectorRef.current]
    .find((trigger) => trigger && !trigger.disabled) ?? null;
  const assistantStripItems = !projectContext && !session.activeChatId && !chatAssistant
    ? composer.assistant.stripItems
    : [];
  const blankComposerRow = assistantStripItems.length > 0 ? (
    <AssistantStripV2
      idle={blankComposerIdle}
      items={assistantStripItems}
      onChoose={composer.assistant.choose}
      onOpenPicker={() => composer.assistant.setPickerOpen(true)}
      restoreFocus={focusComposerInput}
    />
  ) : chatAssistant?.state === "bound" && !chatAssistant.blockReason && chatAssistant.starterPrompts.length > 0 ? (
    <AssistantStartersV2
      key={chatAssistant.id}
      idle={blankComposerIdle}
      onSend={composer.assistant.sendStarter}
      prompts={chatAssistant.starterPrompts}
      restoreFocus={focusComposerInput}
    />
  ) : null;
  const messageById = new Map(thread.visibleMessages.map((message) => [message.id, message]));
  const readAloud = useAnswerReadAloud({
    chatKey: session.activeChatId,
    hasMessage: (id) => messageById.has(id),
    runActive: thread.activeChatStreaming
  });
  const previousAnswerById = previousVisibleAnswersV2(thread.visibleMessages);
  const liveTail = thread.visibleMessages.at(-1);
  const readingAnchorMessageId = liveTail?.role === "assistant"
    ? liveTail.parentMessageId
    : null;
  const conversationMessage = (message: ThreadMessage): ConversationMessageV2 => ({
    content: messageText(message),
    id: message.id,
    role: message.role,
    streaming: message.status === "streaming"
  });
  // Consecutive monitoring checks with no update fold into one quiet row; opening it shows them unchanged below.
  const scheduledCheckGroups = new Map<string, number>();
  const conversationMessages: ConversationMessageV2[] = groupScheduledChecks(thread.visibleMessages).flatMap((item) => {
    if (item.kind === "message") return [conversationMessage(item.message)];
    scheduledCheckGroups.set(item.id, item.checks);
    const row: ConversationMessageV2 = { content: "", id: item.id, role: "assistant" };
    return openScheduledChecks.has(item.id) ? [row, ...item.messages.map(conversationMessage)] : [row];
  });
  const toggleScheduledChecks = (id: string) => setOpenScheduledChecks((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const presentAnswer = (source: ThreadMessage) => presentAnswerV2(source, thread);
  const announcedPresentation = announcedPresentationV2(liveTail, thread);

  const actionsFor = (message: ThreadMessage): ConversationMessageActionsV2 => {
    const editMutationReason = thread.editingMessageId
      ? "Finish or cancel the inline edit first."
      : null;
    const mutationBlocked = thread.activeChatStreaming ||
      Boolean(projectMutationReason) || Boolean(editMutationReason);
    // Regeneration answers the question before an answer again. A converted
    // import can hold an answer with no question before it (a root, or an
    // answer after an answer); a parent outside the loaded page stays allowed.
    const question = message.parentMessageId ? messageById.get(message.parentMessageId) : null;
    const regenerateUnavailable = message.role === "assistant" &&
      (question === null || (question !== undefined && question.role !== "user"));
    const disabledReason = thread.activeChatStreaming
      ? "Wait for the current answer to finish."
      : projectMutationReason ?? editMutationReason ??
        (regenerateUnavailable ? "There is no question before this answer to answer again." : null);
    return {
      branchDisabled: mutationBlocked,
      deleteDisabled: mutationBlocked || projectContext,
      disabledReason,
      editDisabled: mutationBlocked,
      onBranchFromHere: () => thread.handleBranchFromMessage(message.id),
      onCopy: () => thread.handleCopyMessage(message),
      onDelete: () => thread.handleDeleteMessage(message.id),
      ...(message.role === "user" ? {
        onEdit: () => thread.handleEditMessage(message)
      } : {
        ...(readAloud && messageText(message).trim() ? {
          onReadAloud: () => readAloud.toggle(message.id, messageText(message)),
          readingAloud: readAloud.activeId === message.id
        } : {}),
        onRegenerate: () => thread.handleRegenerateMessage(message.id),
        regenerateDisabled: mutationBlocked || regenerateUnavailable
      })
    };
  };

  const renderMessage = (message: ConversationMessageV2): ReactNode => {
    const checks = scheduledCheckGroups.get(message.id);
    if (checks !== undefined) {
      return (
        <ScheduledChecksRowV2
          checks={checks}
          expanded={openScheduledChecks.has(message.id)}
          onToggle={() => toggleScheduledChecks(message.id)}
        />
      );
    }
    const source = messageById.get(message.id);
    if (!source) return null;
    const actions = actionsFor(source);
    // Always-visible ‹N/M› version pager beside the action dock for any
    // message with committed siblings; switching versions is a checkout of the
    // existing branch model, never a history edit.
    const pagerSlot = (
      <BranchPagerSlotV2
        disabledReason={thread.activeChatStreaming
          ? "Wait for the current answer to finish."
          : projectMutationReason ?? (thread.editingMessageId
              ? "Finish or cancel the inline edit first."
              : null)}
        graph={branches.graph}
        messageId={source.id}
        onCheckout={branches.checkoutBranch}
      />
    );
    if (source.role === "user") {
      // Owner-only quiet line of the files sent with this exact message,
      // rendered from the labels the thread snapshot already exposes.
      const sentAttachments = attachmentBlocksFromThreadContent(source.content);
      return (
        <ConversationTurnV2
          actions={actions}
          afterContent={(
            <>
              <SentAttachmentsV2 blocks={sentAttachments} canSave={!projectContext && !temporarySession} />
              {pagerSlot}
            </>
          )}
          anchorId={source.id}
          ariaLabel={activeProject && source.author
            ? `Question from ${source.author.displayName}`
            : undefined}
          beforeContent={activeProject && source.author ? (
            <span className="v2-project-message-author">{source.author.displayName}</span>
          ) : source.scheduledTask && !projectContext ? (
            <ScheduledMessageChipV2
              title={source.scheduledTask.title}
              onOpen={settings.studio ? () => settings.studio?.open("scheduled") : undefined}
            />
          ) : undefined}
          content={messageText(source)}
          quoteEligible={source.status === "complete"}
          edit={thread.editingMessageId === source.id ? {
            attachmentSlot: <SentAttachmentsV2 blocks={sentAttachments} />,
            draft: thread.editingMessageDraft,
            error: thread.editingMessageError,
            onCancel: () => thread.cancelMessageEdit(source.id),
            onChange: thread.changeEditingMessageDraft,
            onSubmit: () => void thread.submitMessageEdit(),
            pending: thread.editingMessagePending,
            sendWithEnter: composer.sendWithEnter
          } : undefined}
          expandForReadingAnchor={source.id === readingAnchorMessageId || source.id === thread.revealedMessageId}
          role="user"
        />
      );
    }
    const { artifact, events, ownsLiveRun, presentation, transportLost } = presentAnswer(source);
    const toolActivity = presentToolActivityV2(events, source.toolActivity ?? null,
      !transportLost && (source.status === "complete" || source.status === "error" || source.status === "cancelled"));
    const workspaceActivity = presentWorkspaceActivityV2(events, source.workspaceActivity ?? null,
      !transportLost && (source.status === "complete" || source.status === "error" || source.status === "cancelled"));
    // Model-written `sandbox:` links resolve only against this run's own
    // settled generated files; anything else renders as inert text.
    const generatedFiles = artifact?.generatedFiles ?? [];
    const resolveHref: MarkdownHrefResolver = (href) => {
      const resolution = resolveWorkspaceOutputLink({ generatedFiles, href, runId: source.runId ?? null });
      if (!resolution) return null;
      return resolution.kind === "download"
        ? { download: resolution.file.fileName, href: attachmentDownloadHref(resolution.file.attachmentId) }
        : "text";
    };
    // A live run shows only its factual status and streamed content. A settled
    // answer adds only direct user outputs; it never grows a receipt row or
    // post-hoc execution surface.
    const settled = settledRunPresentationV2(presentation);
    const identity = answerIdentityV2(source, previousAnswerById.get(source.id) ?? null);
    // Answer anatomy: identity leads where the Assistant changes; the process
    // fold (Thinking → Steps → Memory) sits above the text with the
    // memory-saved notice under it; the actions row below carries the pager,
    // the Sources chip and the verbs.
    const leadingSlot = activeChatSummary?.hasContinuationSource && !source.runId &&
      source.parentMessageId === thread.visibleMessages[0]?.id && thread.visibleMessages[0]?.parentMessageId === null ? (
      <a className="v2-chat-continuation-source v2-focusable"
        href={`/api/chats/${encodeURIComponent(activeChatSummary.id)}/continuation-source`}>Previous chat</a>
    ) : identity ? <AnswerIdentityChipV2 identity={identity} /> : null;
    const command = source.parentMessageId ? memoryCommands.get(source.parentMessageId) : undefined;
    // A background command owns the notice slot; its failed, unknown, stale
    // and rejected outcomes stay silent instead of reviving older feedback.
    const noticeSlot = command && memoryCommandIsVisible(command) ? (
      <MemoryCommandStatusV2 command={command} onOpenMemory={settings.openMemory} />
    ) : command && (command.operation !== "UNKNOWN" ||
      ["FAILED", "UNKNOWN", "STALE"].includes(command.status)) ? null
    : settled && artifact?.memoryAction ? (
      <MemoryActionConfirmationV2
        action={artifact.memoryAction}
        onOpenMemoryReset={settings.openMemory}
        onOpenMemorySettings={settings.openMemory}
      />
    ) : null;
    const knowledgeHandles = new Set(
      artifact?.knowledgeCitations?.map((citation) => citation.handle) ?? []
    );
    const knowledgeReference = knowledgeReferenceForMessageV2(source, artifact, settled);
    // The persisted work duration wins once the run settles; while it streams
    // the client clock (send → first token) fills the same slot.
    const workDurationMs = artifact?.workDurationMs ??
      (ownsLiveRun ? thread.liveWorkDurationMs : null);
    const copiedAttachments = attachmentBlocksFromThreadContent(source.content)
      .filter((block) => !artifact?.generatedImages?.some((image) => image.attachmentId === block.attachmentId));
    return (
      <>
      <RunFollowupHistoryV2 entries={source.followups?.entries ?? []}
        waitingForStep={toolActivity?.calls.some(call => call.status === "running") ||
          workspaceActivity?.entries.some(entry => entry.phase === "requested" || entry.phase === "running")} />
      <RunAnswerV2
        processDisclosureId={source.runId ?? source.id}
        actions={settled ? actions : undefined}
        actionsSlot={<>
              {settled ? <SentAttachmentsV2 blocks={copiedAttachments} canSave={!projectContext && !temporarySession} /> : null}
              <AnswerOutputsV2
                artifact={artifact}
                live={!settled}
                canSaveFiles={!projectContext && !temporarySession}
                onEditArtifact={projectContext || temporarySession ? undefined : generated => editArtifact(generated)}
                onEditScheduledTask={projectContext || temporarySession || !settings.studio ? undefined
                  : (taskId) => openScheduledTaskEditorV2(taskId, (after) => settings.studio?.open("scheduled", after))}
                onOpenArtifact={projectContext || temporarySession ? undefined : (generated, source) => {
                  if (session.activeChatId) openArtifactPanel({ chatId: session.activeChatId, artifactId: generated.artifactId, versionId: generated.versionId }, source);
                }}
                onUseImageInArtifact={projectContext || temporarySession || !composer.reuseFile ? undefined : async (attachmentId) => {
                  const chatId = session.activeChatId;
                  if (chatId && await composer.reuseFile?.(attachmentId, "Generated image.png")) {
                    useComposerSessionStore.getState().updateSession(composerSessionKey(chatId), current => ({
                      draft: [current.draft, "Create an artifact using the attached image."].filter(Boolean).join("\n\n")
                    }));
                  }
                }}
                workspaceOutputStatus={workspaceActivity?.outputStatus ?? null}
              />
              {source.id === thread.artifactDraftMessageId && thread.artifactDrafts?.length ? <ArtifactGenerationCardsV2
                drafts={thread.artifactDrafts} savedArtifacts={settled ? artifact?.generatedArtifacts ?? [] : []}
                onOpen={(draftId, source) => { if (session.activeChatId) openArtifactPanel({ chatId: session.activeChatId, draftId }, source); }}
                onOpenArtifact={(generated, source) => { if (session.activeChatId) openArtifactPanel({ chatId: session.activeChatId, artifactId: generated.artifactId, versionId: generated.versionId }, source); }}
              /> : null}
            </>}
        anchorId={source.id}
        artifact={artifact}
        onPinSkill={composer.agent?.enabled ? undefined : pinLoadedSkill}
        pinnedSkillIds={pinnedSkillIds}
        content={messageText(source)}
        knowledgeReference={knowledgeReference}
        leadingSlot={leadingSlot}
        noticeSlot={noticeSlot}
        onRefresh={transportLost ? () => thread.refreshInterruptedRun() : undefined}
        onRegenerate={() => thread.handleRegenerateMessage(source.id)}
        onRetry={() => {
          if (isMcpAutoDiscoveryFailureCode(presentation.failure?.code)) {
            retryAutoMcpDiscoveryV2(() => thread.handleRegenerateMessage(source.id));
            return;
          }
          thread.handleRegenerateMessage(source.id);
        }}
        onSelectModel={() => setRunSetupOpen(true)}
        onUseLoadAll={() => applyLoadAllAfterMcpDiscoveryFailureV2(
          () => thread.handleRegenerateMessage(source.id)
        )}
        pdfPreparation={source.pdfPreparation}
        onStop={() => void composer.stopCurrentRun(presentation.runId)}
        stopping={composer.stopping}
        presentation={presentation}
        resolveHref={resolveHref}
        renderCitation={knowledgeReference
          ? (handle, key) => knowledgeHandles.has(handle) ? (
              <KnowledgeCitationControl
                key={key}
                reference={{ ...knowledgeReference, handle }}
              />
            ) : null
          : undefined}
        showReasoning={composer.showReasoningBlocks}
        toolbarLeading={branches.graph && branchPagerForMessageV2(branches.graph, source.id)
          ? pagerSlot
          : null}
        toolActivity={toolActivity}
        workDurationMs={workDurationMs}
        workspaceActivity={workspaceActivity}
      />
      </>
    );
  };

  // The account menu always opens the account's own Settings, also in a Project.
  const openAccountSettings = () => {
    setDataSubview(null);
    settings.open();
  };
  // Choosing a chat or a new chat in navigation adds one history entry.
  const selectNavigationChat = (chat: ChatNavigationSummaryWire) =>
    selectNavigationChatV2(chat.id, workspace.pane.actions, workspace.projects.actions.leave);
  const setNavigationMemoryMode = (chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL") => {
    const full = currentWorkspaceChat(chat.id);
    if (full && full.memoryMode !== mode) {
      void workspace.pane.actions.toggleChatMemorySource(full, mode);
    }
  };
  const createNavigationChat = (mode: NewChatMode) => navigateChatRoute(() => {
    void workspace.pane.actions.createChat(null, mode);
  });
  const navigationChatState = (chat: ChatNavigationSummaryWire): NavigationChatRowState | null => {
    const full = currentWorkspaceChat(chat.id);
    return full
      ? { favorite: Boolean(full.pinned), memoryMode: full.memoryMode ?? "NORMAL" }
      : null;
  };
  const projectMutationReason = projectContext
    ? !activeProject
      ? "Project access is being revalidated."
      : activeProject.status !== "ACTIVE"
      ? "This project is archived and read-only."
      : activeProjectChat?.archived
        ? "This shared chat is archived and read-only."
        : !activeProject.capabilities.mutateChats
          ? "Viewer access is read-only."
          : null
    : null;
  const canRenameActiveProjectChat = !projectContext || Boolean(
    activeProject && activeProjectChat && (
      activeProject.capabilities.manageProject || activeProjectChat.createdByUserId === session.accountId
    )
  );
  const currentNewChatMode: NewChatMode = composer.memory.mode === "TEMPORARY"
    ? "TEMPORARY"
    : activeChatSummary?.memoryMode === "EXCLUDED" ? "EXCLUDED" : "NORMAL";
  const withActiveChat = (action: (chat: WorkspaceChatSummary) => void) => () => {
    const full = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
    if (full) action(full);
    else void workspace.pane.actions.retry();
  };
  const temporarySession = composer.memory.mode === "TEMPORARY";
  const deleteActiveChatPermanently = permanentChatDeletionAvailable
    ? withActiveChat((full) => void workspace.pane.actions.deleteChatPermanently(full))
    : null;
  const workspaceStarted = composer.workspace.sessionState !== null &&
    composer.workspace.sessionState !== "not_started";
  const workspaceLifecycleDisabled = thread.activeChatStreaming ||
    composer.workspace.busy || Boolean(projectMutationReason);
  const workspaceMenuActions: HeaderOverflowActionV2[] = session.activeChatId ? [
    {
      icon: "file",
      label: "Export history",
      onSelect: () => setExportHistoryChatId(session.activeChatId)
    },
    {
      disabled: workspaceLifecycleDisabled || !workspaceStarted,
      icon: "download",
      label: "Download workspace",
      onSelect: () => {
        void composer.workspace.archive().then((file) => {
          if (!file) return;
          const link = document.createElement("a");
          link.href = attachmentDownloadHref(file.attachmentId);
          link.download = file.fileName;
          document.body.append(link);
          link.click();
          link.remove();
        });
      }
    },
    {
      disabled: workspaceLifecycleDisabled || !workspaceStarted,
      icon: "tool",
      label: "Reset workspace…",
      onSelect: () => setWorkspaceResetOpen(true)
    },
    {
      disabled: true,
      label: "Shared by this chat; branch changes do not roll it back"
    }
  ] : [];

  return (
    <AnnouncementsProvider accountId={session.accountId}>
    <main className="v2-live-root" data-testid="app-shell">
      <UiV2IconSprite />
      {/* The Library renders inside the same shell as a rail section: the
          rail stays, the chat list column yields to the Library's section
          column (PRD §4.1/§4.10, FRONTEND "Chat Composition"). */}
      {(
        <ReadingRoomShellV2
          accountId={session.accountId}
          accountLabel={session.accountDisplayName.trim() || session.accountEmail}
          adminEntryVisible={session.adminEntryVisible}
          chatActive={Boolean(session.activeChatId)}
          projectsSectionOpen={projectsSurfaceVisible}
          section={libraryOpen && !projectContext ? "library" : "chats"}
          onProjectsSectionChange={setProjectsSurfaceOpen}
          navigationBusy={settings.studio?.busy}
          onRequestNavigation={settings.studio?.exit}
          onChats={() => {
            if (settings.studio) return;
            settings.library?.onBackToChat();
            settings.knowledge?.onBackToChat();
            settings.closeMemory();
          }}
          chatStateFor={navigationChatState}
          currentNewChatMode={currentNewChatMode}
          editingChatId={workspace.pane.state.editingChatOrigin === "row" ? workspace.pane.state.editingChatId : null}
          editingChatTitle={workspace.pane.state.editingChatTitle}
          editingFolderId={workspace.pane.state.editingFolderId}
          editingFolderName={workspace.pane.state.editingFolderName}
          onArchive={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            // A stale workspace projection must resync instead of silently
            // ignoring the requested archive.
            if (full) void workspace.pane.actions.deleteChat(full);
            else void workspace.pane.actions.retry();
          }}
          onCancelChatRename={workspace.pane.actions.cancelChatEdit}
          onCancelFolderRename={workspace.pane.actions.cancelFolderEdit}
          onChangeChatRename={workspace.pane.actions.changeEditingChatTitle}
          onChangeFolderRename={workspace.pane.actions.changeEditingFolderName}
          onBranches={(chat) => {
            selectNavigationChat(chat);
            branches.show();
          }}
          onCopyThread={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void thread.copyVisibleThread(full);
          }}
          onCreateFolder={(parentId, name) => workspace.pane.actions.createFolder(parentId, name)}
          onDelete={permanentChatDeletionAvailable ? (chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.deleteChatPermanently(full);
            else void workspace.pane.actions.retry();
          } : undefined}
          onDeleteFolder={(folder: ChatNavigationFolderWire) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) void workspace.pane.actions.deleteFolder(full);
            else void workspace.pane.actions.retry();
          }}
          onExport={(chat, format) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) workspace.pane.actions.exportChat(full, format);
          }}
          onFavorite={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.toggleChatFavorite(full);
          }}
          onFolderProjectSettings={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) workspace.pane.actions.openProjectSettings(full);
          }}
          onLeaveProject={projectContext ? workspace.projects.actions.leave : undefined}
          onLibrary={() => {
            if (settings.studio) settings.studio.open();
            else { setLibraryInitialTab(undefined); settings.openLibrary(); }
          }}
          onMemoryMode={projectContext ? undefined : setNavigationMemoryMode}
          onMove={(chat, folderId) => {
            void workspace.pane.actions.moveChat(chat.id, folderId);
          }}
          onMoveFolder={(folder, folderId) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) void workspace.pane.actions.moveFolder(full, folderId);
          }}
          onNewChat={createNavigationChat}
          onRenameChat={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) workspace.pane.actions.startChatEdit(full, "row");
          }}
          onRenameFolder={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) workspace.pane.actions.startFolderEdit(full);
          }}
          onSaveChatRename={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            return full ? workspace.pane.actions.saveChatTitle(full) : undefined;
          }}
          onSaveFolderRename={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            return full ? workspace.pane.actions.saveFolder(full) : undefined;
          }}
          onSelectChat={selectNavigationChat}
          onOpenMessageMatch={(match) => {
            // A found message is always a personal chat's.
            if (workspace.projects.selectedProjectId) workspace.projects.actions.leave();
            workspace.pane.actions.openSearchMatch(match.chatId, match.messageId);
          }}
          onShare={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.shareChat(full);
          }}
          onSettings={projectContext && workspace.projects.detail
            ? () => workspace.projects.actions.openSettings("general")
            : openAccountSettings}
          onAccountSettings={openAccountSettings}
          projectComposerAvailable={Boolean(
            workspace.projects.detail &&
            workspace.projects.detail.status === "ACTIVE" &&
            workspace.projects.detail.capabilities.mutateChats &&
            workspace.projects.detail.readiness !== "SETUP_REQUIRED"
          )}
          projectContextActive={Boolean(workspace.projects.selectedProjectId)}
          projectTitle={workspace.projects.detail ? (
            <span className="v2-project-column-identity">
              <span className="v2-project-mark" aria-hidden="true">
                {workspace.projects.detail.name.slice(0, 1).toUpperCase()}
              </span>
              <span>{workspace.projects.detail.name}</span>
            </span>
          ) : "Projects"}
          projectsSlot={(onNavigate, { landing }) => (
            <ProjectNavigationV2
              activeChatId={session.activeChatId}
              controller={workspace.projects}
              landing={landing}
              onNavigate={onNavigate}
            />
          )}
        >
          {libraryOpen && !projectContext ? (
            <LibrarySurfaceV2
              composer={composer}
              initialTab={libraryInitialTab}
              props={props}
            />
          ) : projectsSurfaceVisible ? (
            <ProjectsSurfaceV2
              composerSlot={(
                <div className="v2-project-page-composer-stack" ref={setComposerDockRef}>
                  {shellNotice}
                  {browserNotificationsBanner}
                  {composerOperationError}
                  {composerSurface}
                </div>
              )}
              controller={workspace.projects}
              mobileNavigationSlot={workspace.projects.selectedProjectId ? (
                <ProjectMobileWorkspaceV2
                  activeChatId={session.activeChatId}
                  controller={workspace.projects}
                  onNavigate={() => setProjectsSurfaceOpen(false)}
                />
              ) : null}
              onBackToChat={() => {
                setProjectsSurfaceOpen(false);
                if (workspace.projects.selectedProjectId && !session.activeChatId) {
                  workspace.projects.actions.leave();
                }
              }}
              onStartChat={() => {
                void workspace.projects.actions.createChat().then((created) => {
                  if (!created) return;
                  setProjectsSurfaceOpen(false);
                  window.requestAnimationFrame(() => {
                    document.querySelector<HTMLTextAreaElement>(
                      '[data-testid="composer-v2"] textarea:not(:disabled)'
                    )?.focus();
                  });
                });
              }}
            />
          ) : (
          <section className="v2-live-workspace" ref={setLiveWorkspaceRef} data-project-context={projectContext || undefined}
            data-artifact-docked={Boolean(visibleArtifactPanel && workspaceWidth >= 896) || undefined}
            data-streaming={thread.activeChatStreaming || undefined}
            style={conversationMessages.length > 0 && composerDockHeight > 0
              ? { "--v2-live-dock-height": `${composerDockHeight}px` } as CSSProperties : undefined}>
            <div className="v2-live-conversation">
            <WorkspaceHeaderV2
              active={Boolean(session.activeChatId)}
              chatKey={session.activeChatId}
              assistantSelector={(
                <HeaderAssistantSelectorV2
                  assistant={composer.assistant}
                  focusComposer={focusComposerInput}
                  triggerRef={assistantSelectorRef}
                />
              )}
              contextStats={composer.composerContextStats}
              usageStats={thread.usageStats}
              continuation={continuationEligible ? continuation : null}
              continuationFiles={activeChatSummary?.workspace?.continuationFiles}
              crumb={activeChatCrumb}
              archiveDisabled={thread.activeChatStreaming || temporarySession || Boolean(
                projectContext && (
                  !activeProject || !activeProject.capabilities.archiveChats || activeProjectChat?.archived
                )
              )}
              deleteDisabled={thread.activeChatStreaming || temporarySession || projectContext}
              editingTitle={
                session.activeChatId &&
                workspace.pane.state.editingChatId === session.activeChatId &&
                workspace.pane.state.editingChatOrigin === "header"
                  ? workspace.pane.state.editingChatTitle
                  : null
              }
              folders={headerFolders}
              leadingSlot={(
                <ProjectContextRailV2
                  activeChatProjectId={activeProject?.id ?? activeChatSummary?.projectId ?? null}
                  controller={workspace.projects}
                />
              )}
              modelSelector={headerModelSelector}
              modelTriggerRef={modelTriggerRef}
              moveDisabled={Boolean(
                projectContext && (
                  workspace.projects.busy ||
                  projectMutationReason ||
                  !activeProjectChat
                )
              )}
              moveRootLabel={projectContext ? "Project root" : undefined}
              onArchive={withActiveChat((full) => {
                if (projectContext) {
                  if (activeProject) void workspace.projects.actions.archiveChat(full.id, true);
                }
                else void workspace.pane.actions.deleteChat(full);
              })}
              onBranches={branches.show}
              onCopyLink={activeProjectChat ? () => void session.copyProjectChatLink() : null}
              onCopyThread={() => void thread.copyVisibleThread()}
              onDelete={projectContext ? null : deleteActiveChatPermanently}
              onExport={(format) => {
                const chatId = session.activeChatId;
                const full = chatId ? currentWorkspaceChat(chatId) : null;
                if (full) workspace.pane.actions.exportChat(full, format);
              }}
              favorite={Boolean(session.activeChatId && currentWorkspaceChat(session.activeChatId)?.pinned)}
              importLabel={activeChatSummary?.importSource ? importedFromLabel(activeChatSummary.importSource) : null}
              importTitle={activeChatSummary?.importSource && activeChatSummary.importSourceModel
                ? `${importedFromLabel(activeChatSummary.importSource)} (${activeChatSummary.importSourceModel})`
                : undefined}
              memoryLockedReason={!projectContext && activeChatSummary?.importSource
                ? resolveMemoryCopy("imported.unavailable")
                : null}
              memoryUsed={projectContext || !session.activeChatId
                ? null
                : !activeChatSummary?.importSource &&
                  (currentWorkspaceChat(session.activeChatId)?.memoryMode ?? "NORMAL") !== "EXCLUDED"}
              onFavorite={projectContext
                ? null
                : withActiveChat((full) => void workspace.pane.actions.toggleChatFavorite(full))}
              onMemoryMode={projectContext
                ? null
                : (mode) => {
                    const full = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
                    if (full && full.memoryMode !== mode) {
                      void workspace.pane.actions.toggleChatMemorySource(full, mode);
                    }
                  }}
              onMove={projectContext
                ? activeProject?.capabilities.manageProject && activeProjectChat
                  ? (folderId) => void workspace.projects.actions.moveChat(activeProjectChat.id, folderId)
                  : null
                : (folderId) => {
                    const full = session.activeChatId
                      ? currentWorkspaceChat(session.activeChatId)
                      : null;
                    if (full) void workspace.pane.actions.moveChat(full.id, folderId);
                  }}
              onRenameCancel={workspace.pane.actions.cancelChatEdit}
              onRenameChange={workspace.pane.actions.changeEditingChatTitle}
              onRenameSave={() => {
                const full = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
                if (full) return workspace.pane.actions.saveChatTitle(full);
                void workspace.pane.actions.retry();
                return undefined;
              }}
              onRenameStart={withActiveChat((full) => workspace.pane.actions.startChatEdit(full, "header"))}
              renameDisabled={!canRenameActiveProjectChat || Boolean(projectMutationReason)}
              onShare={() => void session.shareActiveBranch()}
              shareDisabled={temporarySession || Boolean(projectMutationReason) || Boolean(projectContext && (
                !activeProject || !activeProject.publicSharingEnabled || !activeProject.capabilities.archiveChats
              ))}
              supplementalActions={workspaceMenuActions}
              temporaryMemory={projectContext || !temporarySession ? null : composer.memory}
              title={session.activeChatTitle}
            />
            <ConversationV2
              composerSlot={conversationMessages.length === 0 ? (
                <div className="v2-live-empty-composer-stack" ref={setComposerDockRef}>
                  {shellNotice}
                  {browserNotificationsBanner}
                  {scheduledTaskHint}
                  {composerOperationError}
                  {composerSurface}
                  {blankComposerRow}
                </div>
              ) : undefined}
              error={thread.activeChatDetailError}
              hasOlder={thread.hasOlderMessages}
              jumpToLatestBottomOffset={composerDockHeight}
              loading={thread.activeChatDetailLoading || workspace.pane.state.workspaceLoading}
              loadingEarlier={thread.loadingOlderMessages}
              messages={conversationMessages}
              olderError={thread.olderMessagesError}
              quote={{
                comments: composerComments,
                disabled: Boolean(thread.editingMessageId), dockRef: composerDockRef, scopeKey: uploadSourceKey,
                suppressed: composerLayer !== null,
                onComment: (quote, text, _touch, anchor) => {
                  const store = useComposerSessionStore.getState();
                  if (store.activeSessionKey !== uploadSourceKey) return "Return to this conversation before adding its comment.";
                  const refusal = store.addComment(uploadSourceKey, { anchor, quote, text });
                  return refusal ? composerCommentRefusalMessage(refusal, "add") : null;
                },
                onCommentStart: (quote, anchor) => {
                  const store = useComposerSessionStore.getState();
                  if (store.activeSessionKey !== uploadSourceKey) return "Return to this conversation before adding its comment.";
                  const refusal = store.commentRefusal(uploadSourceKey, quote, anchor);
                  return refusal ? composerCommentRefusalMessage(refusal, "start") : null;
                },
                onCommentUpdate: (id, text) => {
                  const refusal = useComposerSessionStore.getState().updateComment(uploadSourceKey, id, text);
                  return refusal ? composerCommentRefusalMessage(refusal, "edit") : null;
                },
                onCommentRemove: id => { useComposerSessionStore.getState().removeComment(uploadSourceKey, id); },
                onQuote: (markdown, touch) => {
                  const error = quoteSelectionInComposer({ markdown, sessionKey: uploadSourceKey,
                    followup: thread.activeChatStreaming && !thread.answerComplete && canSubmitFollowup });
                  if (!error && !touch) requestAnimationFrame(() => {
                    if (useComposerSessionStore.getState().activeSessionKey !== uploadSourceKey) return;
                    const input = composerDockRef.current?.querySelector<HTMLTextAreaElement>("textarea");
                    input?.focus({ preventScroll: true });
                    input?.setSelectionRange(input.value.length, input.value.length);
                  });
                  return error;
                }
              }}
              onJumpToLatest={thread.jumpToLatest}
              onLoadEarlier={thread.loadEarlierMessages}
              onRetry={thread.retryActiveChatDetail}
              onScroll={thread.handleThreadScroll}
              orientationSlot={blankConversationOrientationV2({
                assistantOrientation,
                projectOrientation: (
                  <ProjectBlankOrientationV2
                    activeChat={Boolean(activeProjectChat)}
                    controller={workspace.projects}
                  />
                ),
                projectSelected: Boolean(workspace.projects.selectedProjectId)
              })}
              renderMessage={renderMessage}
              scrollRef={thread.threadScrollRef}
              showJumpToLatest={thread.showJumpToLatest}
              unavailable={Boolean(
                session.activeChatId && !thread.activeChatDetailLoading &&
                /\(chat_detail_failed_(401|403|404)\)$/u.test(thread.activeChatDetailError ?? "")
              )}
            />
            {session.activeChatId ? (
              <RunLifecycleAnnouncerV2
                activeChatId={session.activeChatId}
                presentation={announcedPresentation}
                sourceChatId={session.activeChatId}
              />
            ) : null}
            {conversationMessages.length > 0 ? (
              <div className="v2-live-composer-dock" data-thread-composer-dock="" ref={setComposerDockRef}>
                {shellNotice}
                {browserNotificationsBanner}
                {scheduledTaskHint}
                {composerOperationError}
                {composerSurface}
              </div>
            ) : null}
            </div>
            {visibleArtifactPanel ? <ArtifactPanelV2 key={`${visibleArtifactPanel.chatId}:${visibleArtifactPanel.draftId ?? visibleArtifactPanel.artifactId}`}
              target={visibleArtifactPanel} compact={workspaceWidth < 896} latest={latestPanelArtifact} onEdit={editArtifact}
              draft={thread.artifactDrafts?.find(draft => draft.draftId === visibleArtifactPanel.draftId)} /> : null}
          </section>
          )}
        </ReadingRoomShellV2>
      )}

      {branches.open ? (
        <BranchDrawerV2
          checkoutDisabledReason={thread.activeChatStreaming ? "Wait for the current answer to finish." : null}
          error={branches.error}
          graph={branches.graph}
          loading={branches.loading}
          onCheckout={branches.checkoutBranch}
          onClose={branches.close}
          onRetry={branches.retry}
        />
      ) : null}
      {runSetupOpen ? (
        <RunSetupV2 composer={composer} onClose={() => setRunSetupOpen(false)} restoreFocus={restoreRunSetupFocus} />
      ) : null}
      {composer.assistant.openPicker ? (
        <AssistantPickerV2
          anchorRef={assistantSelectorRef}
          assistants={composer.assistant.pickerItems}
          currentAssistantId={composer.assistant.current?.state === "bound" ? composer.assistant.current.id : null}
          loading={composer.assistant.pickerLoading}
          onBrowse={() => {
            composer.assistant.setPickerOpen(false);
            composer.assistant.openLibrary();
          }}
          onClose={() => composer.assistant.setPickerOpen(false)}
          onSelect={composer.assistant.choose}
          projectScoped={projectContext}
          recentIds={composer.assistant.recentIds}
        />
      ) : null}
      {exportHistoryChatId && exportHistoryChatId === session.activeChatId ? (
        <WorkspaceExportHistoryV2
          key={exportHistoryChatId}
          branchKey={thread.visibleMessages.at(-1)?.id ?? null}
          canSave={!projectContext && !temporarySession}
          chatId={exportHistoryChatId}
          onClose={() => setExportHistoryChatId(null)}
          onMessage={(messageId) => {
            setExportHistoryChatId(null);
            void workspace.pane.actions.openChatMessage(exportHistoryChatId, messageId);
          }}
          onUse={temporarySession || thread.activeChatStreaming || composer.uploading ? undefined : composer.reuseFile}
        />
      ) : null}
      {skillLibraryScope === skillScopeKey && projectContext ? (
        <ProjectSkillPicker key={`project:${skillScopeKey}`}
          skillsMode={skillsMode} availableCount={assistantAvailableSkills} modelContextWindow={composer.currentModel?.contextWindow ?? undefined}
          resources={(activeProject?.resources ?? []).flatMap((resource) => resource.type === "skill" ? [{
            id: resource.resourceId, name: resource.label, description: resource.description ?? "", available: resource.available,
            instructionApproxTokens: resource.instructionApproxTokens
          }] : [])}
          includedSkills={assistantIncludedSkills ?? []}
          selectedSkills={selectedSkills}
          state={workspace.projects.syncState === "error" ? "error" : activeProject
            ? "ready" : workspace.projects.syncState === "syncing" ? "loading" : "unavailable"}
          onRetry={() => void workspace.projects.actions.retrySync()}
          onClose={() => setSkillLibraryScope(null)} onSelectionChange={selectManualSkills} restoreFocus={restoreSkillFocus}
        />
      ) : null}
      <SkillLibraryOverlayV2 key={`personal:${skillScopeKey}`}
        skillsMode={skillsMode} availableCount={assistantAvailableSkills}
        modelContextWindow={composer.currentModel?.contextWindow ?? undefined}
        open={skillLibraryScope === skillScopeKey && !projectContext}
        includedSkills={assistantIncludedSkills}
        selectedSkills={selectedSkills}
        selectedIds={selectedSkills.map((skill) => skill.id)}
        onClose={() => setSkillLibraryScope(null)}
        onSelectionChange={selectManualSkills} restoreFocus={restoreSkillFocus}
      />

      <CreateProjectDialogV2 controller={workspace.projects} />
      <ProjectSettingsDialogV2 controller={workspace.projects} />

      {settings.settings.open ? (
        <SettingsV2
          busy={settingsBusyMessage !== null}
          busyMessage={settingsBusyMessage ?? undefined}
          connectedAppsContent={(
            <ConnectedAppsSection
              accountId={session.accountId}
              onBusyChange={setConnectedAppsBusy}
            />
          )}
          dirty={accountDirty}
          generalSlot={(
            <>
              <AnswerSoundSettingsRowV2 composer={composer} />
              {composer.browserNotifications ? (
                <BrowserNotificationsSettingsRowV2 notifications={composer.browserNotifications} />
              ) : null}
              <SettingsRowV2
                description="Show numbered source citations inside answers."
                title="Citations"
              >
                <SettingsSwitchV2
                  checked={composer.showCitations}
                  label="Citations"
                  onChange={() => composer.toggleCitationsVisibility()}
                />
              </SettingsRowV2>
              <SettingsRowV2
                description="Show the model's reasoning as a disclosure above the answer."
                title="Reasoning blocks"
              >
                <SettingsSwitchV2
                  checked={composer.showReasoningBlocks}
                  label="Reasoning blocks"
                  onChange={() => composer.toggleReasoningBlockVisibility()}
                />
              </SettingsRowV2>
              <SettingsRowV2
                description="Shift+Enter inserts a new line. Off: Enter inserts a new line, Ctrl+Enter sends."
                testId="settings-send-with-enter"
                title="Send with Enter"
              >
                <SettingsSwitchV2
                  checked={composer.sendWithEnter}
                  label="Send with Enter"
                  onChange={(next) => composer.setSendWithEnter(next)}
                />
              </SettingsRowV2>
            </>
          )}
          initialSection={settings.settings.section}
          noticeSlot={settings.notice ? (
            <ShellNotice notice={settings.notice} onDismiss={settings.dismissNotice} />
          ) : null}
          obscured={permanentChatDeletionModalOpen}
          onSectionChange={() => setDataSubview(null)}
          panels={{
            account: (
              <SettingsAccountPanelV2
                key={`${session.accountId}:${accountKey}`}
                onBusyChange={setAccountBusy}
                onDirtyChange={setAccountDirty}
                accountEmail={session.accountEmail}
                accountId={session.accountId}
                adminEntryVisible={session.adminEntryVisible}
                onDisplayNameChange={session.updateAccountDisplayName}
              />
            ),
            connections: <PersonalMcpConnectionsSection onBusyChange={setConnectionsBusyMessage} />,
            data: dataSubview === "archived" ? (
              <ArchivedChatsPanelV2 onRestored={workspace.archived.onRestored} />
            ) : (
              <>
                <SettingsRowV2
                  description="Restore or permanently delete chats you archived."
                  title="Archived chats"
                >
                  <UiV2Button
                    ref={archivedManageRef}
                    icon="chevron-right"
                    onClick={() => setDataSubview("archived")}
                  >
                    Manage
                  </UiV2Button>
                </SettingsRowV2>
                <SettingsPendingDeletionRowV2 />
                <SettingsRowV2
                  description="Uploads stay bound to the messages where they were added."
                  title="Files"
                />
                {projectContext ? null : (
                  <DataSettingsRowsV2
                    accountId={session.accountId}
                    onDeleteAll={deleteAllPersonalChats}
                    onDeleted={() => {
                      void workspace.pane.actions.retry();
                      void loadChatNavigation();
                    }}
                    onImported={() => {
                      void workspace.pane.actions.retry();
                      void loadChatNavigation();
                    }}
                  />
                )}
              </>
            ),
          }}
          subview={dataSubview === "archived"
            ? { label: "Archived chats", onBack: closeDataSubview }
            : undefined}
          themeId={settings.settings.themeId}
          onClose={() => {
            setDataSubview(null);
            settings.dismissNotice();
            settings.closeSettings();
          }}
          onDiscard={() => {
            setAccountDirty(false);
            setAccountKey(value => value + 1);
          }}
          onThemeChange={settings.updateTheme}
        />
      ) : null}
      {overlays.share.target ? (
        <ShareDialog key={overlays.share.target.chat.id} target={overlays.share.target} onClose={overlays.share.close} />
      ) : null}
      {workspace.projectSettings.folder ? (
        <ProjectSettingsDialog
          folder={workspace.projectSettings.folder}
          knowledgeBaseIds={workspace.projectSettings.knowledgeBaseIds}
          knowledgeBases={workspace.projectSettings.knowledgeBases}
          knowledgeDataError={workspace.projectSettings.knowledgeDataError}
          knowledgeDataState={workspace.projectSettings.knowledgeDataState}
          saving={workspace.pane.state.folderActionId === workspace.projectSettings.folder.id}
          onCancel={workspace.projectSettings.close}
          onKnowledgeBaseIdsChange={workspace.projectSettings.changeKnowledgeBaseIds}
          onRetryKnowledge={workspace.projectSettings.retryKnowledge}
          onSave={() => {
            const folder = workspace.projectSettings.folder;
            if (folder) void workspace.projectSettings.save(folder);
          }}
        />
      ) : null}
      {overlays.confirmations.chat ? (
        <ChatDeleteConfirmationDialog
          chatTitle={overlays.confirmations.chat.title}
          onCancel={overlays.confirmations.cancelChat}
          onConfirm={overlays.confirmations.confirmChat}
        />
      ) : null}
      {overlays.confirmations.folder ? (
        <FolderDeleteConfirmationDialog
          folderName={overlays.confirmations.folder.name}
          onCancel={overlays.confirmations.cancelFolder}
          onConfirm={overlays.confirmations.confirmFolder}
        />
      ) : null}
      {overlays.confirmations.memoryResume ? (
        <MemoryResumeConfirmationDialog
          chatTitle={overlays.confirmations.memoryResume.title}
          onCancel={overlays.confirmations.cancelMemoryResume}
          onConfirm={overlays.confirmations.confirmMemoryResume}
        />
      ) : null}
      {overlays.confirmations.message ? (
        <MessageDeleteConfirmationDialog
          onCancel={overlays.confirmations.cancelMessage}
          onConfirm={overlays.confirmations.confirmMessage}
        />
      ) : null}
      {workspaceResetOpen ? (
        <ConfirmationDialog
          busy={composer.workspace.busy}
          cancelLabel="Keep workspace"
          confirmLabel="Reset workspace"
          dialogLabel="Reset workspace"
          icon="resume"
          onCancel={() => setWorkspaceResetOpen(false)}
          onConfirm={() => {
            void composer.workspace.reset().then((reset) => {
              if (reset) setWorkspaceResetOpen(false);
            });
          }}
          testId="reset-workspace-confirmation"
          title="Reset this workspace?"
          tone="warning"
        >
          Unsaved changes and installed dependencies inside this workspace will be lost. Messages, original attachments, and already exported files stay available.
        </ConfirmationDialog>
      ) : null}
      <PermanentChatDeletionSurface />
    </main>
    </AnnouncementsProvider>
  );
}


function SettingsPendingDeletionRowV2() {
  const reviewRef = useRef<HTMLButtonElement>(null);
  const reference = usePermanentChatDeletionStore((state) => state.reference);
  const status = usePermanentChatDeletionStore((state) => state.status?.status ?? null);
  const pending = Boolean(reference && status && status !== "COMPLETE");
  return (
    <SettingsRowV2
      description={pending
        ? "A permanent deletion is still in progress."
        : "Nothing is waiting for permanent deletion."}
      title="Pending permanent deletion"
    >
      {pending ? (
        <UiV2Button
          ref={reviewRef}
          icon="chevron-right"
          onClick={() => openPermanentChatDeletionStatus(() => reviewRef.current)}
        >
          Review
        </UiV2Button>
      ) : null}
    </SettingsRowV2>
  );
}

function SettingsAccountPanelV2({
  accountEmail,
  accountId,
  adminEntryVisible,
  onDisplayNameChange,
  onDirtyChange,
  onBusyChange
}: Readonly<{ accountEmail: string | null; accountId: string; adminEntryVisible: boolean;
  onDisplayNameChange(displayName: string): void;
  onDirtyChange(dirty: boolean): void; onBusyChange(busy: boolean): void;
}>) {
  const [signingOut, setSigningOut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const controlCenterHref = useControlCenterHref();
  useEffect(() => { onBusyChange(saving || signingOut); return () => onBusyChange(false); }, [onBusyChange, saving, signingOut]);
  return (
    <>
      <AccountSettingsRowsV2 accountEmail={accountEmail} adminEntryVisible={adminEntryVisible}
        onDisplayNameChange={onDisplayNameChange} onDirtyChange={onDirtyChange} onBusyChange={setSaving} />
      {adminEntryVisible ? (
        <SettingsRowV2
          description="Installation resources, providers, users and policies."
          title="Control Center"
        >
          <a className="v2-button v2-focusable" data-tone="ghost" href={controlCenterHref}>
            <UiV2Icon name="shield" />
            <span>Open</span>
          </a>
        </SettingsRowV2>
      ) : null}
      <SettingsGroupLabelV2>Session</SettingsGroupLabelV2>
      <SettingsRowV2
        description="Ends this browser session and removes unsent drafts from this device."
        title="Sign out"
      >
        <UiV2Button
          busy={signingOut}
          disabled={saving}
          onClick={() => {
            setSigningOut(true);
            setSignOutError(false);
            void signOutCurrentSession({ accountId }).then((result) => {
              if (!result.ok) {
                setSignOutError(true);
                setSigningOut(false);
              }
            });
          }}
        >
          Sign out
        </UiV2Button>
        {signOutError ? <span className="v2-live-menu-error" role="alert">Could not sign out.</span> : null}
      </SettingsRowV2>
    </>
  );
}

export function AnswerSoundSettingsRowV2({ composer }: Readonly<{
  composer: Pick<ShellComposerView, "notificationSoundEnabled" | "notificationSoundId" |
    "notificationSoundReady" | "toggleNotificationSound" | "selectAnswerSound" | "previewAnswerSound">;
}>) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSequence = useRef(0);
  useEffect(() => () => { previewSequence.current += 1; }, []);
  return (
    <SettingsRowV2
      description={previewFailed
        ? <span role="status">Preview could not play. Try Play again or check your browser’s audio settings.</span>
        : "Play a short sound when an answer finishes. Preview also works with sound off."}
      title="Answer sound"
    >
      <SettingsSwitchV2
        checked={composer.notificationSoundEnabled}
        disabled={!composer.notificationSoundReady}
        label="Answer sound"
        onChange={() => composer.toggleNotificationSound()}
      />
      <SettingsSelectV2
        disabled={!composer.notificationSoundReady}
        label="Completion sound"
        options={ANSWER_SOUNDS}
        value={composer.notificationSoundId}
        onChange={(sound) => {
          setPreviewFailed(false);
          composer.selectAnswerSound(sound);
        }}
      />
      <UiV2Button
        aria-label="Play preview"
        disabled={!composer.notificationSoundReady}
        onClick={() => {
          const sequence = ++previewSequence.current;
          setPreviewFailed(false);
          void composer.previewAnswerSound(composer.notificationSoundId).then((played) => {
            if (sequence === previewSequence.current) setPreviewFailed(!played);
          });
        }}
      >Play</UiV2Button>
    </SettingsRowV2>
  );
}
