"use client";

import { DisclosurePreferencesProvider } from "@/components/app-shell/disclosurePreferences";
import { fetchWorkspaceUploadConfig } from "@/components/app-shell/workspaceUploadClient";
import type { WorkspaceUploadConfigWire } from "@/lib/contracts/workspaceUploads";
import { createChatSearchPreferences } from "@/components/app-shell/chatSearchPreferences";

import { useStudioNavigation } from "@/features/library-v2/useStudioNavigation";

import { removePermanentlyDeletedChat } from "@/components/app-shell/permanentChatDeletionReconciliation";
import { useComposerContextConfigurationKey } from "@/components/app-shell/composerContextConfiguration";
import { useChatTitleReconciliation } from "@/components/app-shell/useChatTitleReconciliation";

import { decodeAnswerSoundPreferences, DEFAULT_ANSWER_SOUND } from "@/lib/contracts/answerSound";

import { toolActivityOriginV2 } from "@/features/run-lifecycle-v2/runPresentation";
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
import {
  composerAssistantChangedRows,
  composerAssistantFromDefinition,
  composerAssistantRowValue,
  composerAssistantSendBlockReason,
  personalComposerAssistantDefaults,
  type ComposerAssistantContext,
  type ComposerAssistantDefaults,
  type ComposerAssistantDefinition
} from "@/components/app-shell/composerAssistantState";
import {
  createChatAssistantActions,
  type ChatAssistantActions,
  type ChatAssistantChooseScope
} from "@/components/app-shell/chatAssistantActions";
import {
  cachedChatAssistantProjection,
  useChatAssistantProjectionStore
} from "@/components/app-shell/chatAssistantProjectionStore";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import {
  chatIdFromComposerSessionKey,
  composerSessionKey,
  composerSessionModeFromKey,
  projectComposerSessionKey,
  projectIdFromComposerSessionKey,
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
import {
  buildKnowledgeLibraryView,
  createKnowledgeLibraryActions
} from "@/components/app-shell/knowledgeLibraryController";
import { useKnowledgeLibraryStore } from "@/components/app-shell/knowledgeLibraryStore";
import { fetchKnowledgeSources } from "@/components/knowledge/knowledgeApi";
import { useSkillLibraryStore } from "@/components/app-shell/skillLibraryStore";
import { useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import { deactivateMcpSettings } from "@/components/app-shell/mcpSettingsStore";
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
import {
  useWorkspaceActions,
  type BlankDefaultAssistant,
  type ChatAssistantScope
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
  modelControlKey,
  resolveModelControlDefaults,
  type SavedControlDraft
} from "@/components/app-shell/powerAppShellData";
import { useBranchGraphController } from "./useBranchGraphController";
import {
  openPersonalChatMessage,
  revealPersonalChatDeepLinkMessage,
  usePersonalChatDeepLink
} from "./usePersonalChatDeepLink";
import { useWorkspaceBootstrapController } from "./useWorkspaceBootstrapController";
import {
  useProjectWorkspaceController,
  type ProjectWorkspaceController
} from "@/features/projects-v2/useProjectWorkspaceController";
import {
  beginChatRouteResolution,
  cancelChatRouteResolution,
  chatRouteForState,
  currentChatAddress,
  isAssistantEntry,
  isCurrentChatRouteResolution,
  navigateChatRoute,
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
import { formatAssistantEntryPath, formatChatRoutePath } from "@/lib/domain/chatRoute";
import type { ProjectDetailWire } from "@/lib/contracts/projects";
import {
  ASSISTANT_ROW_KEYS,
  type AssistantRowKey,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { ComposerConfigKnowledgeBase } from "@/lib/contracts/composerConfig";
import type {
  KnowledgeBaseSummary,
  KnowledgeSourceListResponse
} from "@/lib/contracts/knowledge";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";
import type { McpRunSelection } from "@/lib/contracts/mcp";
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

type ProjectRouteOutcome = Awaited<ReturnType<ChatRouteTargets["openProject"]>>;

/** One Project address being opened across the renders that load its Project. */
type ProjectRouteRequest = {
  readonly chatId: string | null;
  finish(outcome: ProjectRouteOutcome): void;
  phase: "opening" | "selecting" | "waiting";
  readonly projectId: string;
  readonly resolution: ChatRouteResolution;
};

const CHAT_ROUTE_UNAVAILABLE_COPY = {
  // One text for missing, foreign, archived and unusable Assistants alike.
  assistant: "This Assistant isn't available to you.",
  chat: "That chat is unavailable.",
  project: "That Project is unavailable.",
  projectChat: "That Project chat is unavailable."
} as const;

/**
 * Why the composer cannot send. Project access and lifecycle come first; a
 * chat Assistant that blocks sending comes before any model hint, because the
 * user's next step is choosing in its notice, and the neutral gate hint never
 * names the missing dependency (PRD 10.7).
 */
export function effectiveComposerDisabledHint(input: Readonly<{
  assistantBlocked: boolean;
  personalHint: string | null;
  projectAccessHint: string | null;
  projectContext: boolean;
  projectModelHint: string | null;
}>): string | null {
  if (input.projectContext && input.projectAccessHint) return input.projectAccessHint;
  if (input.assistantBlocked) return ASSISTANT_SEND_GATE_HINT;
  return input.projectContext ? input.projectModelHint : input.personalHint;
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
      toolActivityOriginV2({
        origin: payload.origin,
        serverName: payload.serverName,
        toolName: payload.name ?? payload.toolName
      }) === "workspace"
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

function projectMcpSelection(project: ProjectDetailWire): McpRunSelection {
  return { mode: project.policy.externalToolsEnabled ? project.defaults.mcpMode : "off" };
}

function projectDefaultModel(project: ProjectDetailWire): { modelId: string; provider: string } | null {
  const resource = project.resources.find((candidate) =>
    candidate.type === "model" && candidate.available &&
    candidate.resourceId === project.defaults.providerModelId
  );
  return resource?.provider && resource.modelId
    ? { modelId: resource.modelId, provider: resource.provider }
    : null;
}

/** A Project's Assistants resolve in the Project catalog with the Project's parameters. */
function projectAssistantContext(project: ProjectDetailWire): ComposerAssistantContext {
  return {
    controlDefaults: (model) => resolveModelControlDefaults(model, {
      [modelControlKey(model)]: project.defaults.controlValues
    }),
    models: project.composer?.catalog.models ?? [],
    skill: (skillId) => {
      const resource = project.resources.find((candidate) =>
        candidate.type === "skill" && candidate.resourceId === skillId
      );
      return resource
        ? {
            name: resource.label,
            ...(resource.instructionApproxTokens !== undefined
              ? { instructionApproxTokens: resource.instructionApproxTokens }
              : {})
          }
        : null;
    }
  };
}

/** In a Project, inherit means the Project's defaults, not personal ones. */
function projectAssistantDefaults(project: ProjectDetailWire): ComposerAssistantDefaults {
  return {
    knowledge: { selection: project.defaults.knowledgePlan, source: "project" },
    model: projectDefaultModel(project),
    search: {
      mode: project.defaults.searchPlan.mode,
      optionIds: [...project.defaults.searchPlan.optionIds]
    },
    skillsMode: "auto",
    tools: projectMcpSelection(project)
  };
}

function projectAssistantDefinition(
  project: ProjectDetailWire,
  assistantId: string
): ComposerAssistantDefinition | null {
  const entry = project.composer?.assistants.find((assistant) => assistant.summary.id === assistantId);
  return entry
    ? {
        availability: entry.summary.availability,
        avatar: entry.summary.avatar,
        description: entry.summary.description,
        id: entry.summary.id,
        name: entry.summary.name,
        owned: entry.summary.owned,
        ownerDisplayName: entry.summary.ownerDisplayName,
        promptCharacterCount: entry.promptCharacterCount,
        rowAvailability: entry.summary.rowAvailability,
        rows: entry.content.rows,
        starterPrompts: [...entry.summary.starterPrompts]
      }
    : null;
}

/** The chat's Assistant with each row's effective value, for the shell contract. */
export function shellComposerAssistant(
  state: ComposerControlSnapshot,
  input: Readonly<{
    model: CatalogModel | undefined;
    /** A Project chat: inherit and fallback rows read the Project's defaults. */
    project?: boolean;
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
    ...(input.project ? { project: true } : {}),
    ...(input.project && input.summary?.scope.kind === "project" ? { projectName: input.summary.scope.projectName } : {}),
    rows: Object.fromEntries(ASSISTANT_ROW_KEYS.map((row) => [row, {
      ...assistant.rows[row],
      value: composerAssistantRowValue(state, row, input.model)
    }])) as Extract<ShellComposerAssistant, { state: "bound" }>["rows"],
    scope: input.scope,
    starterPrompts: assistant.starterPrompts ?? input.summary?.starterPrompts ?? [],
    state: "bound"
  };
}

function cloneComposerControlSnapshot(
  state: ComposerControlSnapshot
): ComposerControlSnapshot {
  return {
    ...state,
    // The chat's Assistant with its rows, baselines and unsynced changes.
    assistant: structuredClone(state.assistant),
    knowledgeSelection: {
      ...state.knowledgeSelection,
      baseIds: [...state.knowledgeSelection.baseIds],
      sourceIds: [...state.knowledgeSelection.sourceIds]
    },
    mcpSelection: structuredClone(state.mcpSelection),
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

/**
 * The Project Assistant a new Project chat starts with, resolved in the
 * Project, or null. Only an Assistant the Project composer lists as usable
 * starts a chat; any other starts it without an Assistant, and nothing is
 * said about it (Project settings show the default's state).
 */
export function projectStartingAssistant(
  project: ProjectDetailWire,
  assistantId: string
): ReturnType<typeof composerAssistantFromDefinition> {
  const definition = projectAssistantDefinition(project, assistantId);
  return definition?.availability.ok
    ? composerAssistantFromDefinition(definition, projectAssistantContext(project), projectAssistantDefaults(project))
    : null;
}

/**
 * Where a Project chat's Assistant comes from when the chat opens: only a new
 * chat starts with the Project default; an existing chat shows the Assistant
 * the server projects for it, and none until that projection is read.
 */
export function projectChatAssistantSource(
  chat: Pick<WorkspaceChatSummary, "pendingProjectDraft">,
  projectionKnown: boolean
): "none" | "project_default" | "projection" {
  if (chat.pendingProjectDraft) return "project_default";
  return projectionKnown ? "projection" : "none";
}

/** The personal state a Project leaves exactly as it found it. */
type PersonalComposerContextRefs = Readonly<{
  /** The open personal blank chat's default Assistant mark (see `BlankDefaultAssistant`). */
  blankDefaultAssistant: { current: BlankDefaultAssistant | null };
  controls: { current: ComposerControlSnapshot | null };
  /** That mark as it was when the Project was entered. */
  personalBlankDefaultAssistant: { current: BlankDefaultAssistant | null };
}>;

export function enterProjectComposerContext(refs: PersonalComposerContextRefs): void {
  if (!refs.controls.current) refs.personalBlankDefaultAssistant.current = refs.blankDefaultAssistant.current;
  enterProjectComposerControlBoundary(refs.controls);
}

/**
 * Leaving a Project restores the personal composer exactly, including
 * whether the personal default Assistant was taken or removed; a default the
 * personal blank chat began to load on the way out is dropped. Access loss
 * leaves no Assistant at all: not the Project's, not a personal one and not
 * the personal default.
 */
export function leaveProjectComposerContext(input: PersonalComposerContextRefs & Readonly<{
  accessLost: boolean;
  applyPersonalBlankDefaults(): void;
  skipBlankDefaultAssistant(): void;
}>): void {
  if (input.controls.current) {
    restorePersonalComposerControls(input.controls);
    // A default still loading when the Project opened never finished for
    // the personal blank chat; the load started on the way out replaces it.
    const entered = input.personalBlankDefaultAssistant.current;
    if (entered?.state !== "loading") input.blankDefaultAssistant.current = entered;
    input.personalBlankDefaultAssistant.current = null;
  }
  if (!input.accessLost) return;
  input.skipBlankDefaultAssistant();
  if (useComposerControlStore.getState().assistant) input.applyPersonalBlankDefaults();
}

export function PowerAppShellV2({
  accountId,
  accountDisplayName,
  accountEmail,
  adminEntryVisible = false
}: {
  accountId: string;
  accountDisplayName: string;
  accountEmail: string | null;
  adminEntryVisible?: boolean;
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
  const composerAssistantState = useComposerControlStore((state) => state.assistant);
  const assistantUpdatePending = useChatAssistantProjectionStore((state) =>
    activeChatId ? Boolean(state.pendingChatIds[activeChatId]) : false
  );
  const mcpSelection = useComposerControlStore((state) => state.mcpSelection);
  const knowledgeSelection = useComposerControlStore((state) => state.knowledgeSelection);
  const knowledgePlanSource = useComposerControlStore((state) => state.knowledgePlanSource);
  const selectedKnowledgeBaseIds = useComposerControlStore((state) => state.selectedKnowledgeBaseIds);
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
  const settingsMutationCoordinatorRef = useMemo(() => ({
    current: null as SettingsMutationCoordinator | null,
    accountId
  }), [accountId]);
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
  const contextConfigurationKey = useComposerContextConfigurationKey({
    agentEnabled: composerSession.agentEnabled,
    workspaceEnabled: chats.find(chat => chat.id === activeChatId)?.workspace?.enabled ?? composerSession.workspaceEnabled,
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
    projectSettingsFolder,
    threadFollowKey,
    threadReadingAnchorKey,
  } = usePowerAppShellViewModel({
    activeChatId,
    activeChatStreaming: Boolean(activeChatStream),
    activeThreadContextStats: activeThread.contextStats ?? null,
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
    refreshLayout: refreshThreadLayout,
    resetToLatest: resetThreadToLatest,
    showJumpToLatest
  } = usePinnedScroll<HTMLDivElement>({
    followKey: threadFollowKey,
    hasContent: visibleMessages.length > 0,
    onReadingAnchorApplied: consumePersonalReadingAnchor,
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
    selectModel,
    selectSearchPlan,
    setDefaultAssistant,
    setDefaultKnowledgePlan,
    setDefaultMcpMode,
    setDefaultSkillsMode,
    setDefaultSearchPlan,
    resetDefaultSearchPlan,
    setSendWithEnter,
    setAnswerSoundEnabled,
    setAnswerSoundId,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    useOrganizationModelDefault,
    useOrganizationSearchDefault
  } = useRunControlsActions({
    chatSearchPreferencesRef,
    chatSearchSession: settingsSession,
    allowPersonalPersistence: () => !projectRunContextRef.current,
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

  /** A Project chat's values without an Assistant. */
  const applyProjectChatControls = useEventCallback((
    project: ProjectDetailWire,
    chat: WorkspaceChatSummary
  ) => {
    const model = (project.composer?.catalog ?? catalog)?.models.find((candidate) =>
      candidate.provider === chat.defaultProvider && candidate.modelId === chat.defaultModelId
    );
    setSelectedProvider(model?.provider ?? chat.defaultProvider, "system");
    setSelectedModelId(model?.modelId ?? chat.defaultModelId, "system");
    const searchPlan = chat.defaultSearchPlan ?? project.defaults.searchPlan;
    setSelectedSearchPlan(
      searchPlan.optionIds,
      searchPlan.mode,
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
    useComposerControlStore.getState().setMcpSelection(projectMcpSelection(project), "system");
  });

  // A Project chat's Assistant resolves in its Project; the Project owner
  // below supplies the scope once the Project is loaded.
  const projectDetailRef = useRef<ProjectDetailWire | null>(null);
  const projectChatAssistantScope = useEventCallback((chat: WorkspaceChatSummary): ChatAssistantScope | null => {
    const project = projectDetailRef.current;
    if (!project || project.id !== chat.projectId) return null;
    return {
      applyChatDefaults: (projectChat) => applyProjectChatControls(project, projectChat),
      clearFallback: { mcpSelection: projectMcpSelection(project), skillsMode: "auto" },
      context: projectAssistantContext(project),
      known: (assistantId) => {
        const known = project.composer?.assistants.find((assistant) => assistant.summary.id === assistantId);
        return known
          ? {
              description: known.summary.description,
              promptCharacterCount: known.promptCharacterCount,
              starterPrompts: known.summary.starterPrompts
            }
          : {};
      }
    };
  });

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
    projectChatAssistantScope,
    resumeChatRun,
    setNotice,
    setSelectedModelId,
    setSelectedKnowledgePlan,
    setSelectedProvider,
    setSelectedSearchPlan,
    workspaceRefreshPromiseRef
  });
  useChatTitleReconciliation({ accountId, chats });
  useWorkspaceOutputReconciliation({
    accountId, chatId: activeChatId, messages: visibleMessages,
    projectId: activeChat?.projectId, sessionState: activeChat?.workspace?.sessionState,
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
  const showUnavailableMemorySource = useEventCallback(() => {
    setNotice({ kind: "error", text: memoryUiCopy("source.unavailableBody") });
  });
  usePersonalChatDeepLink({
    activeChatId,
    detailLoading: activeChatDetailLoading,
    onAnchor: anchorPersonalChatMessage,
    onUnavailable: showUnavailableMemorySource,
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
  const refreshChatAssistantEvent = useEventCallback(refreshChatAssistant);
  // The scope is defined with the Project context below.
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
    openMcpSettings,
    retryCatalog: () => void retryCatalog(),
    retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
    setShellNotice: setNotice,
    skills: skillSnapshot.data?.skills ?? []
  });

  /** Applies a Project Assistant as a new Project chat's starting value, or none. */
  const applyProjectAssistant = useEventCallback((
    project: ProjectDetailWire,
    assistantId: string | null
  ) => {
    const applied = assistantId ? projectStartingAssistant(project, assistantId) : null;
    if (applied) useComposerControlStore.getState().applyAssistantState(applied);
    else useComposerControlStore.getState().clearAssistant({ mcpSelection: projectMcpSelection(project), skillsMode: "auto" });
  });

  const applyProjectDefaults = useEventCallback((
    project: ProjectDetailWire,
    chat: WorkspaceChatSummary
  ) => {
    applyProjectChatControls(project, chat);
    switch (projectChatAssistantSource(chat, cachedChatAssistantProjection(chat.id) !== undefined)) {
      case "project_default":
        applyProjectAssistant(project, project.defaults.assistantId);
        break;
      case "projection":
        applyChatAssistant(chat);
        break;
      default:
        applyProjectAssistant(project, null);
    }
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

  // The Project and policy revision whose defaults the Project's blank chat
  // started from; a blank chat opened again starts from them again.
  const projectBlankDefaultsRef = useRef<string | null>(null);
  const activateProjectBlankWorkspace = useEventCallback((projectId: string) => {
    projectBlankDefaultsRef.current = null;
    activateBlankWorkspace(null, "NORMAL", projectId);
    // Personal blank activation intentionally resolves personal defaults when
    // no Assistant is selected. Re-apply the already-captured Project fence so
    // those defaults cannot become the loading projection for this Project.
    enterProjectComposerControlBoundary(personalComposerControlsRef);
    useComposerSessionStore.getState().activateSession(projectComposerSessionKey(projectId));
  });
  const personalBlankDefaultAssistantRef = useRef<BlankDefaultAssistant | null>(null);
  const onProjectContextEntered = useEventCallback(() => {
    enterProjectComposerContext({
      blankDefaultAssistant: blankDefaultAssistantRef,
      controls: personalComposerControlsRef,
      personalBlankDefaultAssistant: personalBlankDefaultAssistantRef
    });
  });
  const onProjectContextLeft = useEventCallback((options?: { accessLost?: boolean }) => {
    leaveProjectComposerContext({
      accessLost: options?.accessLost ?? false,
      applyPersonalBlankDefaults: () => applyPersonalBlankDefaults(),
      blankDefaultAssistant: blankDefaultAssistantRef,
      controls: personalComposerControlsRef,
      personalBlankDefaultAssistant: personalBlankDefaultAssistantRef,
      skipBlankDefaultAssistant
    });
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
  useEffect(() => {
    projectDetailRef.current = projectWorkspace.detail;
  });
  const selectProject = projectWorkspace.actions.selectProject;
  const selectProjectChat = projectWorkspace.actions.selectChat;

  /**
   * A removed active chat hands over within its own scope, through the
   * owners' direct actions so the address is replaced rather than pushed.
   * A Project chat outside its open Project falls back to the personal blank chat.
   */
  const activateRemovedChatFallback = useEventCallback(async (
    scopeProjectId: string | null,
    next: WorkspaceChatSummary | null,
    preserveControls: boolean = false
  ) => {
    if (scopeProjectId === null) {
      if (projectWorkspace.selectedProjectId) projectWorkspace.actions.leave();
      if (next) await activateChat(next, { preserveControls });
      else activateBlankWorkspace();
      return;
    }
    if (projectWorkspace.selectedProjectId !== scopeProjectId) {
      if (projectWorkspace.selectedProjectId) projectWorkspace.actions.leave();
      activateBlankWorkspace();
      return;
    }
    if (next && await selectProjectChat(next.id)) return;
    activateProjectBlankWorkspace(scopeProjectId);
  });

  const reconcilePermanentChatDeletion = useEventCallback(async (chatId: string) => {
    const { nextChat, scopeProjectId, wasActive } = removePermanentlyDeletedChat(chatId);
    chatDetailRequestsRef.current.delete(chatId);
    removePermanentlyDeletedArchivedChat(chatId);
    if (shareDialogTarget?.chat.id === chatId) setShareDialogTarget(null);
    if (wasActive) await activateRemovedChatFallback(scopeProjectId, nextChat, true);
  });

  useEffect(() => {
    void activatePermanentChatDeletionAccount(
      accountId,
      reconcilePermanentChatDeletion
    );
    return () => deactivatePermanentChatDeletionAccount(accountId);
  }, [accountId, reconcilePermanentChatDeletion]);
  // A Project address opens through the Project owner. Selecting a Project
  // updates selectedProjectId before its detail and workspace requests
  // settle; that render moves the request back to "waiting" so the later
  // workspace render can open the target chat. Mutating the request only
  // from a completed promise would not itself cause another render.
  const projectRouteRef = useRef<ProjectRouteRequest | null>(null);
  const routeResolutionRef = useRef<ChatRouteResolution | null>(null);
  const [projectRouteGeneration, setProjectRouteGeneration] = useState(0);
  useEffect(() => {
    const request = projectRouteRef.current;
    if (!request || request.phase === "opening") return;
    if (!isCurrentChatRouteResolution(request.resolution)) {
      request.finish("superseded");
      return;
    }
    if (projectWorkspace.listLoading) return;
    if (request.phase === "selecting") {
      if (projectWorkspace.selectedProjectId !== request.projectId) return;
      request.phase = "waiting";
    }
    if (projectWorkspace.selectedProjectId !== request.projectId) {
      request.phase = "selecting";
      void selectProject(request.projectId).then((selected) => {
        if (projectRouteRef.current !== request) return;
        if (!selected) {
          request.finish("unavailable");
          return;
        }
        if (request.phase === "selecting") request.phase = "waiting";
        setProjectRouteGeneration((generation) => generation + 1);
      });
      return;
    }
    if (!projectWorkspace.detail || !projectWorkspace.workspace) return;
    const chatId = request.chatId;
    if (!chatId || !projectWorkspace.workspace.chats.some((chat) => chat.id === chatId)) {
      // The accessible Project stays open on its blank chat.
      if (useWorkspaceStore.getState().activeChatId !== null) activateProjectBlankWorkspace(request.projectId);
      request.finish(chatId ? "project" : "opened");
      return;
    }
    if (useWorkspaceStore.getState().activeChatId === chatId) {
      request.finish("opened");
      return;
    }
    request.phase = "opening";
    void selectProjectChat(chatId).then((opened) => {
      if (!isCurrentChatRouteResolution(request.resolution)) {
        request.finish("superseded");
        return;
      }
      if (!opened && useWorkspaceStore.getState().activeChatId !== null) {
        activateProjectBlankWorkspace(request.projectId);
      }
      request.finish(opened ? "opened" : "project");
    });
  }, [
    activateProjectBlankWorkspace,
    projectRouteGeneration,
    projectWorkspace.detail,
    projectWorkspace.listLoading,
    projectWorkspace.selectedProjectId,
    projectWorkspace.workspace,
    selectProject,
    selectProjectChat
  ]);
  useEffect(() => () => {
    cancelChatRouteResolution(routeResolutionRef.current);
    projectRouteRef.current?.finish("superseded");
  }, []);

  function openProjectRoute(
    projectId: string,
    chatId: string | null,
    resolution: ChatRouteResolution
  ): Promise<ProjectRouteOutcome> {
    return new Promise((resolve) => {
      projectRouteRef.current?.finish("superseded");
      const request: ProjectRouteRequest = {
        chatId,
        finish(outcome) {
          if (projectRouteRef.current === request) projectRouteRef.current = null;
          resolve(outcome);
        },
        phase: "waiting",
        projectId,
        resolution
      };
      projectRouteRef.current = request;
      setProjectRouteGeneration((generation) => generation + 1);
    });
  }

  /** How an address becomes state: personal chats, Project routes and the blank chat. */
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
        if (known?.projectId) return { projectId: known.projectId };
        projectWorkspace.actions.leave();
        if (known) {
          await activateChat(known);
          return "opened";
        }
        const pending = workspaceRefreshPromiseRef.current;
        if (pending) await pending;
        // A readable Project chat opens in its Project; invisible and missing
        // chats stay indistinguishable.
        const target: { outcome: "missing" | Readonly<{ projectId: string }> | null } = { outcome: null };
        await refreshWorkspace(chatId, {
          catalogOverride,
          isCurrent,
          onTargetUnavailable: (projectId) => {
            target.outcome = projectId ? { projectId } : "missing";
          }
        });
        if (useWorkspaceStore.getState().activeChatId === chatId) return "opened";
        return target.outcome ?? "failed";
      },
      async openAssistant(assistantId) {
        // The link decides this new chat's Assistant; the personal default does not compete.
        skipBlankDefaultAssistant();
        const outcome = await chatAssistantActions.chooseLinkedAssistant(assistantId, () => isCurrent() &&
          useWorkspaceStore.getState().activeChatId === null &&
          projectIdFromComposerSessionKey(useComposerSessionStore.getState().activeSessionKey) === null);
        return outcome === "unavailable" ? "unavailable" : "opened";
      },
      openBlank() {
        projectWorkspace.actions.leave();
        if (
          useWorkspaceStore.getState().activeChatId !== null ||
          projectIdFromComposerSessionKey(useComposerSessionStore.getState().activeSessionKey)
        ) {
          activateBlankWorkspace();
        }
      },
      openProject: (projectId, chatId) => openProjectRoute(projectId, chatId, resolution),
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
    if (!isCurrentChatRouteResolution(resolution)) return null;
    if (
      (!route || isAssistantEntry(route) || !route.chatId || route.projectId) &&
      !useWorkspaceStore.getState().workspaceReady
    ) {
      // Blank, entry and Project addresses still need the personal workspace first.
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

  useChatRouteHistory({
    currentRoute: chatRouteForState,
    requestNavigation(proceed) {
      if (studio.busy) return;
      const studioOpen = !projectContext &&
        Boolean(librarySnapshot.open || knowledgeSnapshot.open || memoryOpen);
      // An open Skill dialog is keyed by the chat and would drop its unsaved draft.
      requestSkillDialogNavigation(() => {
        if (studioOpen) studio.exit(proceed);
        else proceed();
      });
    },
    resolve(route, resolution) {
      void resolveChatAddress(route, resolution, useWorkspaceStore.getState().catalog);
    }
  });
  const studio = useStudioNavigation({
    available: ["assistants", "instructions", "skills", "knowledge", "memory", "files", "artifacts", "mcp", "secrets", "defaults"],
    onExit() {
      assistantLibraryActions.closeLibrary();
      knowledgeLibraryActions.closeLibrary();
      closeMemoryLibrary();
    },
    onSelect(tab) {
      if (projectWorkspace.selectedProjectId) projectWorkspace.actions.leave();
      closeGeneralSettings();
      if (tab !== "memory") closeMemoryLibrary();
      if (tab === "knowledge") {
        assistantLibraryActions.closeLibrary();
        if (!knowledgeSnapshot.open) knowledgeLibraryActions.openLibrary();
      } else if (tab === "memory") {
        assistantLibraryActions.closeLibrary();
        knowledgeLibraryActions.closeLibrary();
        openMemoryLibrary();
      } else {
        knowledgeLibraryActions.closeLibrary();
        if (!librarySnapshot.open) assistantLibraryActions.openLibrary();
      }
    }
  });
  function openMcpSettings() { studio.open("mcp"); }
  useMcpOAuthReturn(accountId, useEventCallback(openMcpSettings));
  const openAssistantLibrary = () => studio.open("assistants");
  const openKnowledgeLibrary = () => studio.open("knowledge");
  const openKnowledgeLibrarySource = (sourceId: string) => {
    studio.open("knowledge", () => knowledgeLibraryActions.openSourceDetail(sourceId));
  };
  const openMemoryLibraryDestination = () => {
    // Personal Memory is never a Project capability, including stale callbacks.
    if (activeChat?.projectId || (!activeChat && projectWorkspace.selectedProjectId)) return;
    studio.open("memory");
  };
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
    submitComposer,
    submitFollowup
  } = useMessageRunActions({
    activeChat,
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
    accountDisplayName: savedAccountName?.session === settingsSession
      ? savedAccountName.displayName : accountDisplayName,
    accountEmail,
    updateAccountDisplayName,
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
        const destination = new URL(
          formatChatRoutePath({ chatId: chat.id, projectId: chat.projectId }),
          window.location.origin
        );
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
      openContinuedChat,
      activateChat,
      createChat: activateBlankWorkspace,
      createFolder,
      deleteChat: (chat: WorkspaceChatSummary) => deleteChat(chat, activateRemovedChatFallback),
      deleteChatPermanently,
      deleteFolder,
      exportChat,
      moveChat: updateChatFolder,
      moveFolder: updateFolderParent,
      openChatMessage: openPersonalChatMessageEvent,
      openChat: activatePersonalChatDeepLink,
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

  // Project navigation chosen by the user adds a history entry; the address
  // resolver and Studio use the owner's actions directly.
  const projectNavigation: ProjectWorkspaceController = {
    ...projectWorkspace,
    actions: {
      ...projectWorkspace.actions,
      createChat: (folderId) => navigateChatRoute(() => projectWorkspace.actions.createChat(folderId)),
      leave: () => navigateChatRoute(projectWorkspace.actions.leave),
      selectChat: (chatId) => navigateChatRoute(() => projectWorkspace.actions.selectChat(chatId)),
      selectProject: (projectId) => navigateChatRoute(() => projectWorkspace.actions.selectProject(projectId))
    }
  };

  const workspaceView = {
    archived: {
      onRestored: async (chatId: string) => {
        // A restored chat is personal: leave an open Project before it opens,
        // as an address of a personal chat does.
        if (projectWorkspace.selectedProjectId) projectWorkspace.actions.leave();
        await refreshWorkspace(chatId, { preserveControls: true });
      }
    },
    pane: workspacePaneView,
    projects: projectNavigation,
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
    jumpToLatest,
    refreshLayout: refreshThreadLayout,
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
  /** A blank Project chat's values without an Assistant. */
  const applyProjectBlankControls = useEventCallback((project: ProjectDetailWire) => {
    const defaultModel = projectDefaultModel(project);
    const model = defaultModel
      ? effectiveProjectCatalog(catalog, project)?.models.find((candidate) =>
          candidate.provider === defaultModel.provider && candidate.modelId === defaultModel.modelId
        )
      : undefined;
    if (defaultModel) {
      setSelectedProvider(defaultModel.provider, "system");
      setSelectedModelId(defaultModel.modelId, "system");
      applyModelControlDefaults(model, model ? {
        [`${model.provider}:${model.modelId}`]: project.defaults.controlValues
      } : {});
    }
    setSelectedSearchPlan(
      project.defaults.searchPlan.optionIds,
      project.defaults.searchPlan.mode,
      "system"
    );
    setSelectedKnowledgePlan(project.defaults.knowledgePlan, "project", "system");
    useComposerControlStore.getState().setSelectedSkills([]);
    useComposerControlStore.getState().setMcpSelection(projectMcpSelection(project), "system");
  });
  useEffect(() => {
    if (!activeProject || activeChat) {
      if (!activeProject) projectBlankDefaultsRef.current = null;
      return;
    }
    const defaultsKey = `${activeProject.id}:${activeProject.policyRevision}`;
    if (projectBlankDefaultsRef.current === defaultsKey) return;
    projectBlankDefaultsRef.current = defaultsKey;
    applyProjectBlankControls(activeProject);
    applyProjectAssistant(activeProject, activeProject.defaults.assistantId);
  }, [
    activeChat,
    activeProject,
    applyProjectAssistant,
    applyProjectBlankControls
  ]);
  const activeModelLinkedToProject = !activeProject || Boolean(effectiveCurrentModel && activeProjectModels.some(
    (resource) => resource.provider === effectiveCurrentModel.provider &&
      (resource.modelId ?? resource.resourceId) === effectiveCurrentModel.modelId
  ));
  const projectAccessHint = projectContext
    ? !activeProject
      ? "Project access is being revalidated."
      : activeProject.status !== "ACTIVE"
        ? "This project is archived and read-only."
        : activeProjectChat?.archived
          ? "This shared chat is archived and read-only."
        : !activeProject.capabilities.mutateChats
          ? "Viewer access is read-only. Ask a project manager for Contributor access."
          : null
    : null;
  const projectModelHint = projectContext && activeProject
    ? activeProjectModels.length === 0
      ? activeProject.capabilities.manageProject
        ? "No model is linked to this project. Add a model in Project Settings."
        : "This project needs a model before contributors can send messages."
      : !activeModelLinkedToProject
        ? "Choose a model linked to this project."
        : null
    : null;

  const workspaceEnabled = activeChat?.workspace?.enabled ?? composerSession.workspaceEnabled;
  const workspaceDefault = catalog ? catalog.defaults.workspaceEnabled ?? false : null;
  useEffect(() => {
    if (workspaceDefault === null) return;
    const sessions = useComposerSessionStore.getState();
    sessions.applyWorkspaceDefault(sessions.activeSessionKey, workspaceDefault);
  }, [workspaceDefault, activeChatId]);
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
    const rememberChoice = reason === "user" && !projectRunContextRef.current;
    const settingsCoordinator = settingsMutationCoordinatorRef.current;
    try {
      if (activeChat && !activeChat.pendingProjectDraft && !activeChat.pendingPersonalDraft) {
        const wire = await updateChatWorkspaceEnabled(activeChat.id, value);
        if (activeSettingsSessionRef.current !== settingsSession) return false;
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
      if (rememberChoice && settingsCoordinator) {
        await settingsCoordinator.enqueue({ workspaceEnabled: value });
        if (activeSettingsSessionRef.current !== settingsSession) return false;
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
    const sourceKey = useComposerSessionStore.getState().activeSessionKey;
    let limits: WorkspaceUploadConfigWire;
    try { limits = await fetchWorkspaceUploadConfig(); }
    catch { setNotice({ kind: "error", text: "Upload settings are unavailable. Try again shortly." }); return; }
    if (activeSettingsSessionRef.current !== settingsSession || useComposerSessionStore.getState().activeSessionKey !== sourceKey) return;
    setUploadConfiguration({ accountId, value: limits });
    const ordinaryPolicy = attachmentPolicyForModel(effectiveCurrentModel);
    const workspaceFiles = selected.filter(file => file.size > limits.ordinaryMaxBytes ||
      partitionAttachmentSelection([file], ordinaryPolicy).rejected.length > 0);
    if (workspaceFiles.some(file => file.size > limits.maxBytes)) {
      setNotice({ kind: "error", text: `Files must be no larger than ${Number((limits.maxBytes / 1024 / 1024).toFixed(1))} MiB.` });
      return;
    }
    const requiresWorkspace = workspaceFiles.length > 0;
    if (requiresWorkspace && !workspaceEnabled) {
      if (!(await setWorkspaceEnabled(true, "file_selection"))) return;
    }
    if (activeSettingsSessionRef.current !== settingsSession || useComposerSessionStore.getState().activeSessionKey !== sourceKey) return;
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

  // Where the open composer resolves an Assistant it chooses before a chat
  // exists: the Project's catalog and defaults, or the personal ones.
  const chatAssistantChooseScope = useEventCallback((): ChatAssistantChooseScope | null => {
    if (projectContext) {
      if (!activeProject) return null;
      return {
        context: projectAssistantContext(activeProject),
        defaults: projectAssistantDefaults(activeProject),
        restoreDefaults: () => {
          applyProjectBlankControls(activeProject);
          applyProjectAssistant(activeProject, null);
        }
      };
    }
    const personalCatalog = useWorkspaceStore.getState().catalog;
    if (!personalCatalog) return null;
    const folderPlan = pendingChatFolderId
      ? folders.find((folder) => folder.id === pendingChatFolderId)?.defaultKnowledgePlan ?? null
      : null;
    const defaults = personalComposerAssistantDefaults(personalCatalog);
    return {
      context: {
        controlDefaults: (model) => resolveModelControlDefaults(model, personalCatalog.defaults.controlValues),
        models: personalCatalog.models,
        skill: (skillId) => useSkillLibraryStore.getState().data?.skills.find((skill) => skill.id === skillId) ?? null
      },
      defaults: folderPlan ? { ...defaults, knowledge: { selection: folderPlan, source: "project" } } : defaults,
      restoreDefaults: () => applyPersonalBlankDefaults(pendingChatFolderId)
    };
  });
  useEffect(() => {
    chatAssistantChooseScopeRef.current = chatAssistantChooseScope;
  }, [chatAssistantChooseScope]);

  const assistantSummaries = projectContext
    ? activeProject ? projectAssistantItems.map((assistant) => assistant.summary) : []
    : librarySnapshot.data?.assistants ?? [];
  // The blank personal chat's strip reads the personal list; it is loaded
  // once when that chat is first shown (a load already in flight is
  // shared), and the picker refreshes it later.
  const assistantStripItems = projectContext ? [] : assistantStripItemsV2(librarySnapshot.data?.assistants ?? []);
  const assistantStripListWanted = !projectContext && !activeChat &&
    !librarySnapshot.data && librarySnapshot.listRequestId === 0;
  const loadAssistantStripList = useEventCallback(() => assistantLibraryActions.ensureList());
  useEffect(() => {
    if (assistantStripListWanted) loadAssistantStripList();
  }, [assistantStripListWanted, loadAssistantStripList]);
  const currentAssistantSummary = composerAssistantState?.state === "bound"
    ? assistantSummaries.find((assistant) => assistant.id === composerAssistantState.id)
    : undefined;
  const currentAssistant = shellComposerAssistant(useComposerControlStore.getState(), {
    model: effectiveCurrentModel,
    project: projectContext,
    scope: activeChat && !activeChat.pendingPersonalDraft && !activeChat.pendingProjectDraft
      ? "chat"
      : "composer",
    summary: currentAssistantSummary
  });
  const chooseComposerAssistant = (assistantId: string) => {
    setAssistantPickerOpen(false);
    if (projectContext) {
      if (!activeProject) {
        setNotice({ kind: "error", text: "Project access is still being revalidated." });
        return;
      }
      const definition = projectAssistantDefinition(activeProject, assistantId);
      if (!definition) {
        setNotice({ kind: "error", text: "This Project Assistant is no longer available." });
        return;
      }
      void chatAssistantActions.chooseDefinition(
        definition,
        projectAssistantContext(activeProject).skill
      ).then((failure) => {
        if (failure) setNotice({ kind: "error", text: failure });
      });
      return;
    }
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
        if (projectContext) {
          projectWorkspace.actions.openSettings();
          return;
        }
        studio.open("assistants", () => { void assistantLibraryActions.openAssistantEditor(assistantId); });
      },
      openLibrary: projectContext ? projectWorkspace.actions.openSettings : openAssistantLibrary,
      openPicker: assistantPickerOpen,
      pending: assistantUpdatePending,
      pickerItems: assistantSummaries,
      pickerLoading: projectContext
        ? !activeProject
        : librarySnapshot.dataState === "loading" && !librarySnapshot.data,
      recentIds: projectContext ? [] : librarySnapshot.data?.recentAssistantIds ?? [],
      stripItems: assistantStripItems,
      remove: () => void chatAssistantActions.removeAssistant(),
      resetRow: (row: AssistantRowKey) => void chatAssistantActions.resetRow(row),
      restore: projectContext ? undefined : (assistantId: string) => {
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
        if (projectContext) projectWorkspace.actions.openSettings();
        else studio.open("assistants", () => assistantLibraryActions.openNewAssistantFromCurrentSetup());
      }
    },
    composerContextStats,
    composerDisabledHint: effectiveComposerDisabledHint({
      assistantBlocked: Boolean(currentAssistant?.blockReason),
      personalHint: composerDisabledHint,
      projectAccessHint,
      projectContext,
      projectModelHint
    }),
    currentModel: effectiveCurrentModel,
    currentParameterControls: effectiveParameterControls,
    draft,
    sending: Boolean(composerSession.pendingSend),
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
      assistant: {
        assistantId: catalog.defaults.assistantId ?? null,
        assistants: librarySnapshot.data?.assistants ?? null,
        assistantsState: librarySnapshot.dataState,
        loadAssistants: loadDefaultAssistantChoices,
        set: setDefaultAssistant,
        unavailable: catalog.defaults.assistantUnavailable ?? false
      },
      knowledgePlan: catalog.defaults.knowledgePlan ?? null,
      mcpMode: catalog.defaults.mcpMode ?? "auto",
      skillsMode: catalog.defaults.skillsMode ?? "auto",
      searchPlan: catalog.defaults.searchPlan,
      setKnowledgePlan: setDefaultKnowledgePlan,
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
    stopping,
    streamMode,
    submitComposer,
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
    uploadLimitHint: uploadLimits ? workspaceAvailable
      ? `Up to ${Number((uploadLimits.maxBytes / 1024 / 1024).toFixed(1))} MiB with Workspace`
      : `Up to ${Number((uploadLimits.ordinaryMaxBytes / 1024 / 1024).toFixed(1))} MiB per file` : undefined,
    reuseFile: projectContext ? undefined : reuseComposerFile,
    uploading,
    agent: {
      enabled: composerSession.agentEnabled === true,
      unavailableReason: projectContext ? "Agent is available in personal chats."
        : !effectiveCurrentModel?.agentAvailable ? "Choose a model that supports Agent."
        : !workspaceEnabled ? "Turn on Workspace first."
        : !workspaceInternetEnabled ? "Agent requires Workspace Internet access, managed by the administrator."
        : !workspaceAvailable || workspaceInstallation?.agentAvailable !== true
          ? "Agent is unavailable. Ask an administrator to check the Workspace runner."
        : composerAssistantState ? "Remove the Assistant to use Agent." : undefined,
      setEnabled: (value: boolean) => {
        useComposerSessionStore.getState().updateSession(activeComposerSessionKey, { agentEnabled: value });
      }
    },
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
    studio,
    closeMemory: closeMemoryLibrary,
    closeSettings: closeGeneralSettings,
    dismissNotice: () => setSettingsNotice(null),
    knowledge: buildKnowledgeLibraryView(knowledgeLibraryActions, knowledgeSnapshot),
    library: buildAssistantLibraryView(
      {
        activateBlankWorkspace: activateAssistantTrialWorkspace,
        chooseAssistant: chatAssistantActions.chooseAssistant,
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
        openMcpSettings,
        retryCatalog: () => void retryCatalog(),
        retryKnowledge: () => void knowledgeLibraryActions.refreshList(),
        setShellNotice: setNotice,
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
    </DisclosurePreferencesProvider>
  );
}
