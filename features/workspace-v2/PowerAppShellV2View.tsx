"use client";

import { WorkspaceExportHistoryV2 } from "./WorkspaceExportHistoryV2";

import {
  ChatDeleteConfirmationDialog,
  ConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MemoryResumeConfirmationDialog,
  MessageDeleteConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { ConnectedAppsSection } from "@/components/app-shell/ConnectedAppsSection";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
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
  refreshMcpSettings,
  useMcpSettingsStore
} from "@/components/app-shell/mcpSettingsStore";
import {
  useSkillLibraryStore
} from "@/components/app-shell/skillLibraryStore";
import type { PowerAppShellV2Props, ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import type {
  WorkspaceChatSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  attachmentBlocksFromThreadContent,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { UiV2Button, UiV2Icon, UiV2IconSprite } from "@/components/ui-v2";
import type { MarkdownHrefResolver } from "@/components/chat/MarkdownMessage";
import { presentWorkspaceActivityV2 } from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import { resolveWorkspaceOutputLink } from "@/lib/domain/workspaceLinks";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { SkillLibraryDialog } from "@/components/skills/SkillLibraryDialog";
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
  AnswerOutputsV2
} from "@/features/answer-outputs-v2/AnswerOutputsV2";
import { MemoryActionConfirmationV2 } from "@/features/answer-outputs-v2/MemoryActionConfirmationV2";
import {
  ReadingRoomShellV2,
  type NavigationChatRowState,
  type NewChatMode
} from "@/features/navigation-v2/NavigationV2";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { KnowledgeCitationControl } from "@/features/citations-v2/KnowledgeCitationViewer";
import {
  presentRunLifecycleV2,
  presentToolActivityV2,
  settledRunPresentationV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { documentTitleV2 } from "@/features/workspace-v2/documentTitle";
import {
  runTransportStateV2,
  transportLostForMessageV2
} from "@/features/workspace-v2/runTransportPresentation";
import { AccountSettingsRowsV2 } from "@/features/settings-v2/AccountSettingsRowsV2";
import { ArchivedChatsPanelV2 } from "@/features/settings-v2/ArchivedChatsPanelV2";
import { ChatDefaultsRowsV2 } from "@/features/settings-v2/ChatDefaultsRowsV2";
import { DataSettingsRowsV2 } from "@/features/settings-v2/DataSettingsRowsV2";
import { MemorySettingsRowsV2 } from "@/features/settings-v2/MemorySettingsRowsV2";
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
import { attachmentItemsForV2 } from "@/features/attachments-v2/attachmentPresentation";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import { MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE } from "@/lib/contracts/runs";
import type {
  ChatNavigationFolderWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import { RunSetupV2 } from "./RunSetupV2";
import {
  WorkspaceHeaderV2,
  type HeaderOverflowActionV2,
  type WorkspaceHeaderModelSelectorV2
} from "./WorkspaceHeaderV2";
import { LibrarySurfaceV2 } from "./WorkspaceWelcomeV2";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
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

function messageText(message: ThreadMessage): string {
  return textFromThreadContent(message.content);
}

function currentWorkspaceChat(chatId: string): WorkspaceChatSummary | null {
  return useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId) ?? null;
}

function currentWorkspaceFolder(folderId: string) {
  return useWorkspaceStore.getState().folders.find((folder) => folder.id === folderId) ?? null;
}


export type AnswerIdentityV2 = Readonly<{
  label: string;
  testId: "answer-assistant-identity";
}>;

/**
 * Optional quiet accepted Assistant identity. Ordinary answers stay neutral:
 * provider, adapter, raw model, revision numbers, and opaque ids never become
 * answer chrome — the label is the Assistant's name alone.
 */
export function answerIdentityV2(
  message: Pick<ThreadMessage, "assistantIdentity">
): AnswerIdentityV2 | null {
  if (message.assistantIdentity) {
    return {
      label: message.assistantIdentity.name,
      testId: "answer-assistant-identity"
    };
  }
  return null;
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

export function retryAutoMcpDiscoveryV2(regenerate: () => void): void {
  useComposerControlStore.getState().setMcpSelection({ mode: "auto" });
  regenerate();
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
  const names = projectMatches ? [input.project!.name, ...folderNames] : folderNames;
  return names.length > 0 ? names.join(" / ") : null;
}

export function SkillLibraryOverlayV2({
  onClose,
  onSelectionChange,
  open,
  selectedIds
}: Readonly<{
  onClose(): void;
  onSelectionChange(skillIds: readonly string[]): void;
  open: boolean;
  selectedIds: readonly string[];
}>) {
  return open ? (
    <SkillLibraryDialog
      onClose={onClose}
      onSelectionChange={onSelectionChange}
      selectedIds={selectedIds}
    />
  ) : null;
}


export function PowerAppShellV2View(props: PowerAppShellV2Props) {
  const { branches, composer, overlays, session, settings, thread, workspace } = props;
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [connectedAppsBusy, setConnectedAppsBusy] = useState(false);
  const [projectsSurfaceOpen, setProjectsSurfaceOpen] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [mcpKey, setMcpKey] = useState(0);
  const [dataSubview, setDataSubview] = useState<null | "archived">(null);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [composerLayer, setComposerLayer] = useState<ComposerV2Layer>(null);
  const [workspaceResetOpen, setWorkspaceResetOpen] = useState(false);
  const [exportHistoryChatId, setExportHistoryChatId] = useState<string | null>(null);
  const mcpServers = useMcpSettingsStore((state) => state.servers);
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
  const composerLayerController = useRef<ComposerV2LayerController | null>(null);
  const previousActiveChatIdRef = useRef(session.activeChatId);
  const personalMemoryOpen = settings.memory.open;
  const closePersonalMemory = settings.closeMemory;
  const libraryOpen = Boolean(settings.library || settings.knowledge || personalMemoryOpen);

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
  const activeProjectChat = activeChatSummary?.projectId
    ? workspace.projects.workspace?.chats.find((chat) => chat.id === activeChatSummary.id) ?? null
    : null;
  const activeProject = activeChatSummary?.projectId === workspace.projects.detail?.id ||
    (selectedProjectContext && !activeChatSummary)
    ? workspace.projects.detail
    : null;
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
  // Project chat locations use the Project-owned folder tree and keep the
  // Project name as the first crumb. Personal chats retain their folder-only
  // path. The cycle guard makes older malformed parent data harmless.
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
    void refreshMcpSettings().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (projectContext) {
      const available = new Map((activeProject?.resources ?? []).flatMap((resource) =>
        resource.type === "skill" && resource.available
          ? [[resource.resourceId, {
              description: resource.description ?? "",
              id: resource.resourceId,
              name: resource.label,
              promptCharacterCount: resource.promptCharacterCount ?? 0
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
        promptCharacterCount: skill.instructionCharacterCount
      }] : [];
    });
    if (next.length !== selectedSkills.length || next.some((skill, index) =>
      skill.name !== selectedSkills[index]?.name ||
      skill.description !== selectedSkills[index]?.description ||
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
      libraryOpen
    });
    if (document.title !== desired) document.title = desired;
    const titleNode = document.head.querySelector("title");
    if (!titleNode) return;
    const observer = new MutationObserver(() => {
      if (document.title !== desired) document.title = desired;
    });
    observer.observe(titleNode, { characterData: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, [libraryOpen, session.activeChatId, session.activeChatTitle]);
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
      : mcpServers.map((server) => ({
          description: server.description,
          enabled: server.enabled,
          id: server.id,
          knownToolCount: server.knownToolCount,
          name: server.name,
          readiness: server.readiness
        })),
    skills: projectContext
      ? (activeProject?.resources ?? []).flatMap((resource) =>
          resource.type === "skill" && resource.available
            ? [{
                archived: false,
                description: resource.description ?? "",
                id: resource.resourceId,
                instructionCharacterCount: resource.promptCharacterCount ?? 0,
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
  }) : null, [activeProject, composer.assistant.pickerItems, composer.catalog, composer.knowledge.bases, composer.knowledge.documentTotal, composer.knowledge.sources, mcpServers, projectContext, skillCatalog?.skills]);
  const attachmentItems = useMemo(
    () => attachmentItemsForV2(
      composer.attachments,
      attachmentWarningsForModel(
        composer.attachments,
        composer.currentModel,
        composer.workspace.enabled
      ),
      composer.currentModel,
      composer.workspace.enabled
    ),
    [composer.attachments, composer.currentModel, composer.workspace.enabled]
  );
  const attachmentUsage = useMemo(
    () => calculateAttachmentLimitUsage(
      composer.attachments,
      composer.currentModel,
      composer.catalog?.attachmentLimits
    ),
    [composer.attachments, composer.catalog?.attachmentLimits, composer.currentModel]
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
  // in the header on every width and anchors the composer-owned picker; the
  // selected Assistant locks it, an absent catalog or a live answer disables it.
  const headerModelSelector = useMemo<WorkspaceHeaderModelSelectorV2>(() => {
    const catalog = composer.catalog;
    const model = composer.currentModel;
    const provider = catalog?.providers.find((candidate) => candidate.id === model?.provider);
    const assistant = composer.assistant.selected;
    const noModels = Boolean(catalog && catalog.models.length === 0);
    const modelName = model?.displayName ?? (noModels ? "No models available" : "Choose model");
    return {
      disabled: !catalog || Boolean(composer.catalogError) || noModels || thread.activeChatStreaming,
      expanded: composerLayer === "model",
      family: provider?.family ?? null,
      label: provider?.name ?? model?.provider ?? "",
      locked: Boolean(assistant),
      lockedReason: "Managed by the Assistant",
      name: assistant ? `${assistant.name} · ${modelName}` : modelName,
      onToggle: (anchor) => composerLayerController.current?.toggle("model", anchor)
    };
  }, [
    composer.assistant.selected,
    composer.catalog,
    composer.catalogError,
    composer.currentModel,
    composerLayer,
    thread.activeChatStreaming
  ]);
  const composerSurface = (
    <ComposerV2
      activeRun={thread.activeChatStreaming}
      assistantRemovedNotice={composer.assistant.removedNotice}
      attachmentItems={attachmentItems}
      attachmentLimitUsage={attachmentUsage}
      attachmentPolicy={attachmentPolicyForModel(
        composer.currentModel,
        composer.workspace.available
      )}
      config={config}
      configError={Boolean(composer.catalogError)}
      contextStats={session.activeChatId ? composer.composerContextStats : null}
      disabledReason={thread.editingMessageId
        ? "Finish or cancel the inline edit first."
        : composer.composerDisabledHint}
      draft={composer.draft}
      hasReadyAttachments={attachmentItems.some((item) => !item.blocksSend)}
      layerController={composerLayerController}
      modelParametersSummary={modelParametersSummary}
      onAttachmentCountLimitExceeded={composer.composerActions.rejectAttachmentCount}
      onDismissAssistantRemovedNotice={composer.assistant.clearRemovedNotice}
      onDraftChange={composer.composerActions.changeDraft}
      onLayerChange={setComposerLayer}
      onMakeModelDefault={composer.makeModelDefault}
      onOpenAssistantPicker={() => composer.assistant.setPickerOpen(true)}
      onOpenKnowledgeLibrary={projectContext ? undefined : settings.openKnowledge}
      onOpenMcpSettings={projectContext ? workspace.projects.actions.openSettings : settings.openMcp}
      onOpenModelParameters={() => setRunSetupOpen(true)}
      onOpenSkillLibrary={() => {
        if (!projectContext) setSkillLibraryOpen(true);
      }}
      onOverrideKnowledgePlan={composer.knowledge.override}
      onRemoveAssistant={composer.assistant.remove}
      onRemoveAttachment={composer.composerActions.removeAttachment}
      onRejectedFiles={(files) => composer.composerActions.rejectAttachments(files.map((file) => file.name))}
      onRetryAttachment={composer.composerActions.retryAttachment}
      onRetryConfig={composer.retryCatalog}
      onSearchKnowledgeSources={composer.knowledge.searchSources}
      onSelectKnowledgeSelection={composer.knowledge.select}
      onSelectMcp={(selection) => useComposerControlStore.getState().setMcpSelection(selection)}
      onSelectModel={composer.selectModel}
      onSelectSearchOptionIds={(ids) => composer.selectSearchPlan(ids, composer.searchPlanMode)}
      onSelectSkillIds={(ids) => {
        const byId = new Map((config?.skills ?? []).map((skill) => [skill.id, skill] as const));
        const selectedById = new Map(selectedSkills.map((skill) => [skill.id, skill] as const));
        useComposerControlStore.getState().setSelectedSkills(ids.flatMap((id) => {
          const skill = byId.get(id);
          if (skill) {
            return !skill.archived ? [{
              description: skill.description,
              id: skill.id,
              name: skill.name,
              promptCharacterCount: skill.instructionCharacterCount
            }] : [];
          }
          const selected = selectedById.get(id);
          return selected ? [selected] : [];
        }));
      }}
      onSend={() => void composer.submitComposer()}
      onStop={() => void composer.stopCurrentRun()}
      onUploadFiles={(files) => composer.uploadFiles(files)}
      onReuseFile={composer.reuseFile}
      runId={thread.currentRunId}
      selectedAssistant={composer.assistant.selected}
      knowledgePlanSource={composer.knowledge.planSource}
      mcpSelection={mcpSelection}
      selectedKnowledgeSelection={composer.knowledge.selection}
      selectedModelId={composer.selectedModelId}
      selectedProvider={composer.selectedProvider}
      selectedSearchOptionIds={composer.selectedSearchOptionIds}
      sendWithEnter={composer.sendWithEnter}
      selectedSkillIds={selectedSkills.map((skill) => skill.id)}
      selectedSkills={selectedSkills.map(({ id, name }) => ({ id, name }))}
      sharedProject={projectContext}
      uploading={composer.uploading}
      usageStats={composer.composerUsageStats}
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
  const composerOperationError = (
    <ComposerOperationErrorV2
      error={composer.operationError}
      live={composer.operationErrorLive}
      onRetry={() => void composer.submitComposer()}
      retryable={Boolean(composer.operationErrorRetryable)}
    />
  );
  const shellNotice = session.notice ? (
    <div className="v2-live-notice">
      <ShellNotice notice={session.notice} onDismiss={session.dismissNotice} />
    </div>
  ) : null;
  const assistantOrientation = composer.assistant.selected &&
    !composer.draft.trim() &&
    composer.attachments.length === 0 &&
    !composer.uploading ? (
      <div className="v2-live-assistant-intro" data-testid="assistant-blank-intro">
        <AssistantAvatarV2 recipe={composer.assistant.selected.avatar} size={64} />
        <p>Assistant</p>
        <h1>{composer.assistant.selected.name}</h1>
        {composer.assistant.selected.description ? (
          <span>{composer.assistant.selected.description}</span>
        ) : null}
        {composer.assistant.selected.starterPrompts.length > 0 ? (
          <div
            className="v2-live-assistant-starters"
            data-testid="assistant-starter-prompts"
            aria-label="Starter prompts"
          >
            {composer.assistant.selected.starterPrompts.slice(0, 4).map((prompt) => (
              <button
                className="v2-focusable"
                key={prompt}
                type="button"
                onClick={() => composer.assistant.sendStarter(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ) : undefined;
  const messageById = new Map(thread.visibleMessages.map((message) => [message.id, message]));
  const liveTail = thread.visibleMessages.at(-1);
  const readingAnchorMessageId = liveTail?.role === "assistant"
    ? liveTail.parentMessageId
    : null;
  const conversationMessages: ConversationMessageV2[] = thread.visibleMessages.map((message) => ({
    content: messageText(message),
    id: message.id,
    role: message.role,
    streaming: message.status === "streaming"
  }));

  useEffect(() => {
    const dock = composerDockRef.current;
    if (!dock) {
      setComposerDockHeight(0);
      return;
    }
    const updateHeight = () => setComposerDockHeight(Math.ceil(dock.getBoundingClientRect().height));
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [conversationMessages.length]);

  const actionsFor = (message: ThreadMessage): ConversationMessageActionsV2 => {
    const editMutationReason = thread.editingMessageId
      ? "Finish or cancel the inline edit first."
      : null;
    const mutationBlocked = thread.activeChatStreaming ||
      Boolean(projectMutationReason) || Boolean(editMutationReason);
    const disabledReason = thread.activeChatStreaming
      ? "Wait for the current answer to finish."
      : projectMutationReason ?? editMutationReason;
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
        onRegenerate: () => thread.handleRegenerateMessage(message.id),
        regenerateDisabled: mutationBlocked
      })
    };
  };

  const renderMessage = (message: ConversationMessageV2): ReactNode => {
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
          ) : undefined}
          content={messageText(source)}
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
          expandForReadingAnchor={source.id === readingAnchorMessageId}
          role="user"
        />
      );
    }
    const events = source.runId === thread.currentRunId ? thread.events : [];
    const artifact = source.runId === thread.currentRunId
      ? thread.liveArtifactSummary ?? source.artifactSummary ?? null
      : source.artifactSummary ?? null;
    // A genuinely lost stream transport (reader error / end without a
    // terminal frame, recorded by the run-lifecycle store) presents as the
    // honest connection-lost strip; the transport slice suppresses the
    // locally invented post-loss "error" status until refresh reconciles.
    const transportLost = transportLostForMessageV2(thread.interruptedRun, source);
    const presentation = presentRunLifecycleV2({
      ...runTransportStateV2({
        activeChatStreaming: thread.activeChatStreaming,
        interruptedRun: thread.interruptedRun,
        message: { id: source.id, runId: source.runId ?? null, status: source.status },
        persistedRunStatus: null
      }),
      content: messageText(source),
      events,
      runId: source.runId ?? null
    });
    const toolActivity = presentToolActivityV2(events, source.toolActivity ?? null);
    const workspaceActivity = presentWorkspaceActivityV2(events, source.workspaceActivity ?? null);
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
    const identity = answerIdentityV2(source);
    // Answer anatomy: identity leads; the process fold (Thinking → Steps →
    // Memory) sits above the text with the memory-saved notice under it; the
    // actions row below carries the pager, the Sources chip and the verbs.
    const leadingSlot = identity && source.assistantIdentity ? (
      <div className="v2-answer-lead">
        <span className="v2-answer-identity" data-testid={identity.testId}>
          <AssistantAvatarV2 recipe={source.assistantIdentity.avatar} size={20} />
          <span>{identity.label}</span>
        </span>
      </div>
    ) : null;
    const noticeSlot = settled && artifact?.memoryAction ? (
      <MemoryActionConfirmationV2
        action={artifact.memoryAction}
        onOpenMemoryReset={settings.openMemorySettingsTab}
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
      (source.runId === thread.currentRunId ? thread.liveWorkDurationMs : null);
    return (
      <RunAnswerV2
        actions={settled ? actions : undefined}
        actionsSlot={settled
          ? <AnswerOutputsV2 artifact={artifact} canSaveFiles={!projectContext && !temporarySession} workspaceOutputStatus={workspaceActivity?.outputStatus ?? null} />
          : null}
        anchorId={source.id}
        artifact={artifact}
        content={messageText(source)}
        knowledgeReference={knowledgeReference}
        leadingSlot={leadingSlot}
        noticeSlot={noticeSlot}
        onRefresh={transportLost ? () => thread.refreshInterruptedRun() : undefined}
        onRegenerate={() => thread.handleRegenerateMessage(source.id)}
        onRetry={() => {
          if (presentation.failure?.code === MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE) {
            retryAutoMcpDiscoveryV2(() => thread.handleRegenerateMessage(source.id));
            return;
          }
          thread.handleRegenerateMessage(source.id);
        }}
        onSelectModel={() => setRunSetupOpen(true)}
        onUseLoadAll={() => applyLoadAllAfterMcpDiscoveryFailureV2(
          () => thread.handleRegenerateMessage(source.id)
        )}
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
    );
  };

  const selectNavigationChat = (chat: ChatNavigationSummaryWire) => {
    const full = currentWorkspaceChat(chat.id);
    if (full) {
      workspace.projects.actions.leave();
      workspace.pane.actions.activateChat(full);
    }
    else void workspace.pane.actions.retry();
  };
  const setNavigationMemoryMode = (chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL") => {
    const full = currentWorkspaceChat(chat.id);
    if (full && full.memoryMode !== mode) {
      void workspace.pane.actions.toggleChatMemorySource(full, mode);
    }
  };
  const createNavigationChat = (mode: NewChatMode) => {
    void workspace.pane.actions.createChat(null, mode);
  };
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
    <main className="v2-live-root" data-testid="app-shell">
      <UiV2IconSprite />
      {/* The Library renders inside the same shell as a rail section: the
          rail stays, the chat list column yields to the Library's section
          column (PRD §4.1/§4.10, FRONTEND "Chat Composition"). */}
      {(
        <ReadingRoomShellV2
          accountLabel={session.accountEmail}
          adminEntryVisible={session.adminEntryVisible}
          chatActive={Boolean(session.activeChatId)}
          projectsSectionOpen={projectsSurfaceOpen}
          section={libraryOpen && !projectContext ? "library" : "chats"}
          onProjectsSectionChange={setProjectsSurfaceOpen}
          onChats={() => {
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
          onLibrary={settings.openLibrary}
          onMemoryMode={projectContext ? undefined : setNavigationMemoryMode}
          onMove={(chat, folderId) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.moveChat(full.id, folderId);
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
          onShare={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.shareChat(full);
          }}
          onSettings={projectContext && workspace.projects.detail
            ? () => workspace.projects.actions.openSettings("general")
            : () => {
                setDataSubview(null);
                settings.open();
              }}
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
              props={props}
            />
          ) : projectsSurfaceOpen ? (
            <ProjectsSurfaceV2
              composerSlot={(
                <div className="v2-project-page-composer-stack" ref={composerDockRef}>
                  {shellNotice}
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
          <section className="v2-live-workspace" data-project-context={projectContext || undefined}>
            <WorkspaceHeaderV2
              active={Boolean(session.activeChatId)}
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
              memoryUsed={projectContext || !session.activeChatId
                ? null
                : (currentWorkspaceChat(session.activeChatId)?.memoryMode ?? "NORMAL") !== "EXCLUDED"}
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
              onRenameSave={withActiveChat((full) => void workspace.pane.actions.saveChatTitle(full))}
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
                <div className="v2-live-empty-composer-stack" ref={composerDockRef}>
                  {shellNotice}
                  {composerOperationError}
                  {composerSurface}
                </div>
              ) : undefined}
              error={thread.activeChatDetailError}
              hasOlder={thread.hasOlderMessages}
              jumpToLatestBottomOffset={composerDockHeight}
              loading={thread.activeChatDetailLoading || workspace.pane.state.workspaceLoading}
              loadingEarlier={thread.loadingOlderMessages}
              messages={conversationMessages}
              olderError={thread.olderMessagesError}
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
            {conversationMessages.length > 0 ? (
              <div className="v2-live-composer-dock" data-thread-composer-dock="" ref={composerDockRef}>
                {shellNotice}
                {composerOperationError}
                {composerSurface}
              </div>
            ) : null}
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
      {runSetupOpen ? <RunSetupV2 composer={composer} onClose={() => setRunSetupOpen(false)} /> : null}
      {composer.assistant.openPicker ? (
        <AssistantPickerV2
          assistants={composer.assistant.pickerItems}
          loading={composer.assistant.pickerLoading}
          onClose={() => composer.assistant.setPickerOpen(false)}
          onCreateFromCurrentSetup={composer.assistant.startFromCurrentSetup}
          onManage={() => {
            composer.assistant.setPickerOpen(false);
            composer.assistant.openLibrary();
          }}
          onUnavailableAction={(assistantId, action) => {
            composer.assistant.setPickerOpen(false);
            if (action === "mcp-settings") settings.openMcp();
            else composer.assistant.editById(assistantId);
          }}
          onSelect={composer.assistant.selectById}
          recentIds={composer.assistant.recentIds}
          selectedAssistantId={composer.assistant.selected?.id ?? null}
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
      <SkillLibraryOverlayV2
        open={skillLibraryOpen && !projectContext}
        selectedIds={selectedSkills.map((skill) => skill.id)}
        onClose={() => setSkillLibraryOpen(false)}
        onSelectionChange={(ids) => {
            const catalogById = new Map(
              (skillCatalog?.skills ?? []).map((skill) => [skill.id, skill] as const)
            );
            const selectedById = new Map(selectedSkills.map((skill) => [skill.id, skill] as const));
            useComposerControlStore.getState().setSelectedSkills(ids.flatMap((id) => {
              const skill = catalogById.get(id);
              if (skill) {
                return !skill.archived ? [{
                  description: skill.description,
                  id: skill.id,
                  name: skill.name,
                  promptCharacterCount: skill.instructionCharacterCount
                }] : [];
              }
              const selected = selectedById.get(id);
              return selected ? [selected] : [];
            }));
        }}
      />

      <CreateProjectDialogV2 controller={workspace.projects} />
      <ProjectSettingsDialogV2 controller={workspace.projects} />

      {settings.settings.open && (!libraryOpen || personalMemoryOpen) ? (
        <SettingsV2
          busy={mcpBusy || connectedAppsBusy}
          busyMessage={connectedAppsBusy ? "Revoking app access…" : "Updating MCP…"}
          connectedAppsContent={(
            <ConnectedAppsSection
              accountId={session.accountId}
              onBusyChange={setConnectedAppsBusy}
            />
          )}
          dirty={mcpDirty}
          generalSlot={(
            <>
              <SettingsRowV2
                description="Play a short sound when an answer finishes in a background tab."
                title="Answer sound"
              >
                <SettingsSwitchV2
                  checked={composer.notificationSoundEnabled}
                  label="Answer sound"
                  onChange={() => composer.toggleNotificationSound()}
                />
              </SettingsRowV2>
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
          mcpContent={(
            <McpSettingsSection
              key={mcpKey}
              onBusyChange={setMcpBusy}
              onDirtyChange={setMcpDirty}
            />
          )}
          noticeSlot={settings.notice ? (
            <ShellNotice notice={settings.notice} onDismiss={settings.dismissNotice} />
          ) : null}
          obscured={permanentChatDeletionModalOpen}
          onSectionChange={() => setDataSubview(null)}
          panels={{
            account: (
              <SettingsAccountPanelV2
                accountEmail={session.accountEmail}
                adminEntryVisible={session.adminEntryVisible}
              />
            ),
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
                >
                  <UiV2Button
                    icon="chevron-right"
                    onClick={() => {
                      settings.closeSettings();
                      settings.openLibrary();
                    }}
                  >
                    Open Library
                  </UiV2Button>
                </SettingsRowV2>
                {projectContext ? null : (
                  <DataSettingsRowsV2
                    onDeleteAll={deleteAllPersonalChats}
                    onDeleted={() => {
                      void workspace.pane.actions.retry();
                      void loadChatNavigation();
                    }}
                  />
                )}
              </>
            ),
            defaults: (
              <>
                <SettingsDefaultModelRowV2 composer={composer} />
                {composer.chatDefaults ? (
                  <ChatDefaultsRowsV2
                    knowledgeBases={config?.knowledgeBases ?? []}
                    knowledgePlan={composer.chatDefaults.knowledgePlan}
                    mcpMode={composer.chatDefaults.mcpMode}
                    searchPlan={composer.chatDefaults.searchPlan}
                    searchStrategies={composer.catalog?.searchStrategies ?? []}
                    onKnowledgePlan={composer.chatDefaults.setKnowledgePlan}
                    onMcpMode={composer.chatDefaults.setMcpMode}
                    onSearchPlan={composer.chatDefaults.setSearchPlan}
                  />
                ) : null}
              </>
            ),
            memory: projectContext ? undefined : (
              <MemorySettingsRowsV2
                onOpenLibrary={() => {
                  settings.closeSettings();
                  settings.openMemory();
                }}
              />
            )
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
            setMcpDirty(false);
            setMcpKey((value) => value + 1);
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
  );
}


/* Chat defaults › Default model: the personal default from the picker, or the
   organization default; the catalog stays the server-filtered source. */
function SettingsDefaultModelRowV2({ composer }: Readonly<{ composer: ShellComposerView }>) {
  const catalog = composer.catalog;
  const personal = catalog?.defaults.personalModelDefault ?? null;
  const models = catalog?.models ?? [];
  const value = personal ? `${personal.provider}:${personal.modelId}` : "";
  return (
    <SettingsRowV2
      description="Used for new chats until you pick another model in the composer."
      title="Default model"
    >
      <SettingsSelectV2
        disabled={!catalog || models.length === 0}
        label="Default model"
        options={[
          {
            label: catalog?.defaults.organizationModelDefault ? "Organization default" : "Installation default",
            value: ""
          },
          ...models.map((model) => ({
            label: model.displayName,
            sub: model.provider,
            value: `${model.provider}:${model.modelId}`
          }))
        ]}
        value={value}
        onChange={(next) => {
          if (!next) {
            composer.useOrganizationModelDefault?.();
            return;
          }
          const model = models.find((candidate) => `${candidate.provider}:${candidate.modelId}` === next);
          if (model) composer.makeModelDefault?.(model);
        }}
      />
    </SettingsRowV2>
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
  adminEntryVisible
}: Readonly<{ accountEmail: string | null; adminEntryVisible: boolean }>) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  return (
    <>
      <AccountSettingsRowsV2 accountEmail={accountEmail} adminEntryVisible={adminEntryVisible} />
      {adminEntryVisible ? (
        <SettingsRowV2
          description="Installation resources, providers, users and policies."
          title="Control Center"
        >
          <a className="v2-button v2-focusable" data-tone="ghost" href="/admin">
            <UiV2Icon name="shield" />
            <span>Open</span>
          </a>
        </SettingsRowV2>
      ) : null}
      <SettingsGroupLabelV2>Session</SettingsGroupLabelV2>
      <SettingsRowV2
        description="Ends this browser session. Unsent drafts stay on this device."
        title="Sign out"
      >
        <UiV2Button
          busy={signingOut}
          onClick={() => {
            setSigningOut(true);
            setSignOutError(false);
            void signOutCurrentSession().then((result) => {
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
