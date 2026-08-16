"use client";

import { ArchivedChatsDialog } from "@/components/app-shell/ArchivedChatsDialog";
import {
  ChatDeleteConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MessageDeleteConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
import { MemoryWorkspace } from "@/components/app-shell/MemoryWorkspace";
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
import { refreshMemoryList } from "@/components/app-shell/memoryManagerStore";
import {
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import {
  refreshMcpSettings,
  useMcpSettingsStore
} from "@/components/app-shell/mcpSettingsStore";
import {
  refreshSkillLibrary,
  useSkillLibraryStore
} from "@/components/app-shell/skillLibraryStore";
import type { PowerAppShellV2Props } from "@/components/app-shell/powerAppShellV2Contracts";
import type {
  WorkspaceChatSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  attachmentBlocksFromThreadContent,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { UiV2IconSprite } from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { SkillLibraryDialog } from "@/components/skills/SkillLibraryDialog";
import {
  BranchDrawerV2,
  BranchPagerSlotV2,
  EditBranchStripV2
} from "@/features/branches-v2/BranchesV2";
import { AssistantPickerV2 } from "@/features/composer-v2/AssistantPickerV2";
import { ComposerV2 } from "@/features/composer-v2/ComposerV2";
import {
  ConversationTurnV2,
  ConversationV2,
  type ConversationMessageActionsV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import {
  AnswerOutputsV2
} from "@/features/answer-outputs-v2/AnswerOutputsV2";
import {
  ReadingRoomShellV2,
  type NavigationChatRowState,
  type NewChatMode
} from "@/features/navigation-v2/NavigationV2";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import {
  presentRunLifecycleV2,
  settledRunPresentationV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { documentTitleV2 } from "@/features/workspace-v2/documentTitle";
import {
  runTransportStateV2,
  transportLostForMessageV2
} from "@/features/workspace-v2/runTransportPresentation";
import { SettingsV2 } from "@/features/settings-v2/SettingsV2";
import { attachmentItemsForV2 } from "@/features/attachments-v2/attachmentPresentation";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import type {
  ChatNavigationFolderWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import { RunSetupV2 } from "./RunSetupV2";
import { WorkspaceHeaderV2 } from "./WorkspaceHeaderV2";
import {
  LibrarySurfaceV2,
  WelcomeOrientationV2,
  blankWelcomeStartersVisibleV2
} from "./WorkspaceWelcomeV2";
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
export {
  WELCOME_STARTER_PROMPTS,
  WelcomeOrientationV2,
  blankWelcomeStartersVisibleV2
} from "./WorkspaceWelcomeV2";

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
 * provider, adapter, raw model, and opaque ids never become answer chrome.
 */
export function answerIdentityV2(
  message: Pick<ThreadMessage, "assistantIdentity">
): AnswerIdentityV2 | null {
  if (message.assistantIdentity) {
    return {
      label: `${message.assistantIdentity.name} · revision ${message.assistantIdentity.revisionNumber}`,
      testId: "answer-assistant-identity"
    };
  }
  return null;
}


export function PowerAppShellV2View(props: PowerAppShellV2Props) {
  const { branches, composer, overlays, session, settings, thread, workspace } = props;
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [memoryOwnerOpen, setMemoryOwnerOpen] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [mcpKey, setMcpKey] = useState(0);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const mcpServers = useMcpSettingsStore((state) => state.servers);
  const mcpLoadState = useMcpSettingsStore((state) => state.loadState);
  const skillCatalog = useSkillLibraryStore((state) => state.data);
  const mcpSelection = useComposerControlStore((state) => state.mcpSelection);
  const selectedSkills = useComposerControlStore((state) => state.selectedSkills);
  const navigationFolders = useWorkspaceStore((state) => state.navigationFolders);
  // Server-verified capability gate for the direct "Delete…" entries; the
  // deletion confirm surface and its semantics stay unchanged.
  const permanentChatDeletionAvailable = useMemorySettingsStore(
    (state) => Boolean(state.data?.capabilities.permanentChatDeletion)
  );
  const composerDockRef = useRef<HTMLDivElement>(null);
  const libraryOpen = Boolean(settings.library || settings.knowledge || settings.memory.open);

  useEffect(() => {
    void refreshMcpSettings().catch(() => undefined);
    void refreshSkillLibrary().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!skillCatalog || selectedSkills.length === 0) return;
    const available = new Map(
      skillCatalog.skills.filter((skill) => !skill.archived).map((skill) => [skill.id, skill] as const)
    );
    const next = selectedSkills.flatMap((selected) => {
      const skill = available.get(selected.id);
      return skill ? [{
        description: skill.description,
        id: skill.id,
        name: skill.name,
        promptCharacterCount: skill.instructions.length
      }] : [];
    });
    if (next.length !== selectedSkills.length || next.some((skill, index) =>
      skill.name !== selectedSkills[index]?.name ||
      skill.description !== selectedSkills[index]?.description ||
      skill.promptCharacterCount !== selectedSkills[index]?.promptCharacterCount)) {
      useComposerControlStore.getState().setSelectedSkills(next);
    }
  }, [selectedSkills, skillCatalog]);
  useEffect(() => {
    if (mcpSelection.mode !== "selected" || mcpLoadState !== "ready") return;
    const enabledIds = new Set(mcpServers.filter((server) => server.enabled).map((server) => server.id));
    const serverIds = mcpSelection.serverIds.filter((id) => enabledIds.has(id));
    if (serverIds.length === mcpSelection.serverIds.length) return;
    useComposerControlStore.getState().setMcpSelection(
      serverIds.length > 0 ? { mode: "selected", serverIds } : { mode: "auto" }
    );
  }, [mcpLoadState, mcpSelection, mcpServers]);
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
    if (!settings.memory.open) return;
    void Promise.all([
      refreshMemorySettings().catch(() => null),
      refreshMemoryList().catch(() => undefined)
    ]);
  }, [settings.memory.open]);

  const config = useMemo<ComposerConfig | null>(() => composer.catalog ? ({
    assistants: composer.assistant.pickerItems,
    catalog: composer.catalog,
    knowledgeBases: composer.knowledge.bases.map((base) => ({
      archived: base.archived,
      description: base.description,
      id: base.id,
      name: base.name,
      owned: base.owned
    })),
    mcpServers: mcpServers.map((server) => ({
      description: server.description,
      enabled: server.enabled,
      id: server.id,
      knownToolCount: server.knownToolCount,
      name: server.name,
      readiness: server.readiness
    })),
    skills: skillCatalog?.skills ?? []
  }) : null, [composer.assistant.pickerItems, composer.catalog, composer.knowledge.bases, mcpServers, skillCatalog?.skills]);
  const attachmentItems = useMemo(
    () => attachmentItemsForV2(
      composer.attachments,
      attachmentWarningsForModel(composer.attachments, composer.currentModel)
    ),
    [composer.attachments, composer.currentModel]
  );
  const attachmentUsage = useMemo(
    () => calculateAttachmentLimitUsage(
      composer.attachments,
      composer.currentModel,
      composer.catalog?.attachmentLimits
    ),
    [composer.attachments, composer.catalog?.attachmentLimits, composer.currentModel]
  );
  const composerSurface = (
    <ComposerV2
      activeRun={thread.activeChatStreaming}
      assistantRemovedNotice={composer.assistant.removedNotice}
      attachmentItems={attachmentItems}
      attachmentLimitUsage={attachmentUsage}
      attachmentPolicy={attachmentPolicyForModel(composer.currentModel)}
      config={config}
      configError={Boolean(composer.catalogError)}
      contextStats={session.activeChatId ? composer.composerContextStats : null}
      disabledReason={composer.composerDisabledHint}
      draft={composer.draft}
      editStatusSlot={thread.editingMessageId ? (
        <EditBranchStripV2
          error={composer.operationError}
          pending={thread.editingMessagePending}
          onCancel={composer.composerActions.cancelMessageEdit}
        />
      ) : null}
      hasReadyAttachments={attachmentItems.some((item) => item.status === "ready")}
      onAttachmentCountLimitExceeded={composer.composerActions.rejectAttachmentCount}
      onDismissAssistantRemovedNotice={composer.assistant.clearRemovedNotice}
      onDraftChange={composer.composerActions.changeDraft}
      onMakeModelDefault={composer.makeModelDefault}
      onOpenAssistantPicker={() => composer.assistant.setPickerOpen(true)}
      onOpenMcpSettings={settings.openMcp}
      onOpenModelParameters={() => setRunSetupOpen(true)}
      onOpenSkillLibrary={() => setSkillLibraryOpen(true)}
      onRemoveAssistant={composer.assistant.remove}
      onRemoveAttachment={composer.composerActions.removeAttachment}
      onRejectedFiles={(files) => composer.composerActions.rejectAttachments(files.map((file) => file.name))}
      onRetryAttachment={composer.composerActions.retryAttachment}
      onRetryConfig={composer.retryCatalog}
      onSelectKnowledgeBaseIds={composer.knowledge.select}
      onSelectMcp={(selection) => useComposerControlStore.getState().setMcpSelection(selection)}
      onSelectModel={composer.selectModel}
      onSelectSearchOptionIds={(ids) => composer.selectSearchPlan(ids, composer.searchPlanMode)}
      onSelectSkillIds={(ids) => {
        const byId = new Map((skillCatalog?.skills ?? []).map((skill) => [skill.id, skill] as const));
        useComposerControlStore.getState().setSelectedSkills(ids.flatMap((id) => {
          const skill = byId.get(id);
          return skill && !skill.archived ? [{
            description: skill.description,
            id: skill.id,
            name: skill.name,
            promptCharacterCount: skill.instructions.length
          }] : [];
        }));
      }}
      onSend={() => void composer.submitComposer()}
      onStop={() => void composer.stopCurrentRun()}
      onUploadFiles={(files) => composer.uploadFiles(files)}
      runId={thread.currentRunId}
      selectedAssistant={composer.assistant.selected}
      mcpSelection={mcpSelection}
      selectedKnowledgeBaseIds={composer.knowledge.selectedBaseIds}
      selectedModelId={composer.selectedModelId}
      selectedProvider={composer.selectedProvider}
      selectedSearchOptionIds={composer.selectedSearchOptionIds}
      selectedSkillIds={selectedSkills.map((skill) => skill.id)}
      uploading={composer.uploading}
      usageStats={composer.composerUsageStats}
    />
  );
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
  const welcomeOrientation = blankWelcomeStartersVisibleV2({
    assistantSelected: Boolean(composer.assistant.selected),
    attachmentCount: composer.attachments.length,
    draft: composer.draft,
    uploading: composer.uploading
  }) ? (
    <WelcomeOrientationV2
      showAssistantEntry={composer.assistant.pickerItems.length > 0}
      onOpenAssistantPicker={() => composer.assistant.setPickerOpen(true)}
      onPickPrompt={(prompt) => composer.composerActions.changeDraft(prompt)}
    />
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
    const mutationBlocked = thread.activeChatStreaming;
    const disabledReason = mutationBlocked ? "Wait for the current answer to finish." : null;
    return {
      branchDisabled: mutationBlocked,
      deleteDisabled: mutationBlocked,
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
        disabledReason={thread.activeChatStreaming ? "Wait for the current answer to finish." : null}
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
              <SentAttachmentsV2 blocks={sentAttachments} />
              {pagerSlot}
            </>
          )}
          anchorId={source.id}
          content={messageText(source)}
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
    // A live run shows only its factual status and streamed content. A settled
    // answer adds only direct user outputs; it never grows a receipt row or
    // post-hoc execution surface.
    const settled = settledRunPresentationV2(presentation);
    const identity = answerIdentityV2(source);
    return (
      <RunAnswerV2
        actions={settled ? actions : undefined}
        actionsSlot={settled ? (
          <>
            <AnswerOutputsV2
              artifact={artifact}
              identitySlot={identity ? (
                <span data-testid={identity.testId}>{identity.label}</span>
              ) : null}
              showReasoning={composer.showReasoningBlocks}
            />
            {pagerSlot}
          </>
        ) : pagerSlot}
        anchorId={source.id}
        content={messageText(source)}
        onRefresh={transportLost ? () => thread.refreshInterruptedRun() : undefined}
        onRegenerate={() => thread.handleRegenerateMessage(source.id)}
        onRetry={() => thread.handleRegenerateMessage(source.id)}
        onSelectModel={() => setRunSetupOpen(true)}
        presentation={presentation}
      />
    );
  };

  const selectNavigationChat = (chat: ChatNavigationSummaryWire) => {
    const full = currentWorkspaceChat(chat.id);
    if (full) workspace.pane.actions.activateChat(full);
    else void workspace.pane.actions.retry();
  };
  const setNavigationMemoryMode = (chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL") => {
    const full = currentWorkspaceChat(chat.id);
    if (full && full.memoryMode !== mode) void workspace.pane.actions.toggleChatMemorySource(full);
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
  const activeChatSummary = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
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

  return (
    <main className="v2-live-root" data-testid="app-shell">
      <UiV2IconSprite />
      {libraryOpen ? (
        <LibrarySurfaceV2 composer={composer} props={props} onOpenMemoryOwner={() => setMemoryOwnerOpen(true)} />
      ) : (
        <ReadingRoomShellV2
          accountLabel={session.accountEmail}
          chatStateFor={navigationChatState}
          currentNewChatMode={currentNewChatMode}
          editingChatId={workspace.pane.state.editingChatId}
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
          onArchivedChats={workspace.pane.actions.openArchivedChats}
          onCancelChatRename={workspace.pane.actions.cancelChatEdit}
          onCancelFolderRename={workspace.pane.actions.cancelFolderEdit}
          onChangeChatRename={workspace.pane.actions.changeEditingChatTitle}
          onChangeFolderRename={workspace.pane.actions.changeEditingFolderName}
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
          onExport={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) workspace.pane.actions.exportChat(full);
          }}
          onFavorite={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.toggleChatFavorite(full);
          }}
          onFolderProjectSettings={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) workspace.pane.actions.openProjectSettings(full);
          }}
          onLibrary={settings.openLibrary}
          onMemoryMode={setNavigationMemoryMode}
          onMove={(chat, folderId) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.moveChat(full.id, folderId);
          }}
          onMoveFolder={(folder, folderId) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) void workspace.pane.actions.moveFolder(full, folderId);
          }}
          onNewChat={createNavigationChat}
          onOpenSearch={overlays.palette.show}
          onRenameChat={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) workspace.pane.actions.startChatEdit(full);
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
          onSettings={settings.open}
        >
          <section className="v2-live-workspace">
            <WorkspaceHeaderV2
              active={Boolean(session.activeChatId)}
              accountEmail={session.accountEmail}
              adminEntryVisible={session.adminEntryVisible}
              archiveDisabled={thread.activeChatStreaming || temporarySession}
              deleteDisabled={thread.activeChatStreaming || temporarySession}
              editingTitle={
                session.activeChatId &&
                workspace.pane.state.editingChatId === session.activeChatId
                  ? workspace.pane.state.editingChatTitle
                  : null
              }
              folders={navigationFolders}
              onArchive={withActiveChat((full) => void workspace.pane.actions.deleteChat(full))}
              onBranches={branches.show}
              onCommands={overlays.palette.show}
              onCopyThread={() => void thread.copyVisibleThread()}
              onDelete={deleteActiveChatPermanently}
              onExport={(format) => {
                const chatId = session.activeChatId;
                const full = chatId ? currentWorkspaceChat(chatId) : null;
                if (full) workspace.pane.actions.exportChat(full, format);
              }}
              onLibrary={settings.openLibrary}
              onMove={(folderId) => {
                const full = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
                if (full) void workspace.pane.actions.moveChat(full.id, folderId);
              }}
              onRenameCancel={workspace.pane.actions.cancelChatEdit}
              onRenameChange={workspace.pane.actions.changeEditingChatTitle}
              onRenameSave={withActiveChat((full) => void workspace.pane.actions.saveChatTitle(full))}
              onRenameStart={withActiveChat((full) => workspace.pane.actions.startChatEdit(full))}
              onSettings={settings.open}
              onShare={() => void session.shareActiveBranch()}
              shareDisabled={temporarySession}
              temporaryMemory={temporarySession ? composer.memory : null}
              title={session.activeChatTitle}
            />
            {session.notice ? (
              <div className="v2-live-notice">
                <ShellNotice notice={session.notice} onDismiss={session.dismissNotice} />
              </div>
            ) : null}
            <ConversationV2
              composerSlot={conversationMessages.length === 0 ? composerSurface : undefined}
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
              orientationSlot={assistantOrientation ?? welcomeOrientation}
              renderMessage={renderMessage}
              scrollRef={thread.threadScrollRef}
              showJumpToLatest={thread.showJumpToLatest}
              unavailable={Boolean(thread.activeChatDetailError && session.activeChatId && !thread.activeChatDetailLoading)}
            />
            {conversationMessages.length > 0 ? (
              <div className="v2-live-composer-dock" ref={composerDockRef}>
                {composer.operationError ? (
                  <p className="v2-live-composer-error" role={composer.operationErrorLive ? "alert" : "status"}>
                    {composer.operationError}
                  </p>
                ) : null}
                {composerSurface}
              </div>
            ) : null}
          </section>
        </ReadingRoomShellV2>
      )}

      {branches.open ? (
        <BranchDrawerV2
          checkoutDisabledReason={thread.activeChatStreaming ? "Wait for the current answer to finish." : null}
          error={branches.error}
          graph={branches.graph}
          loading={branches.loading}
          onCheckout={(leafId) => {
            branches.checkoutBranch(leafId);
            return true;
          }}
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
          onRemove={composer.assistant.selected ? () => {
            composer.assistant.setPickerOpen(false);
            composer.assistant.remove();
          } : null}
          onSelect={composer.assistant.selectById}
          recentIds={composer.assistant.recentIds}
          selectedAssistantId={composer.assistant.selected?.id ?? null}
        />
      ) : null}
      {skillLibraryOpen ? (
        <SkillLibraryDialog
          selectedIds={selectedSkills.map((skill) => skill.id)}
          onClose={() => setSkillLibraryOpen(false)}
          onSelectionChange={(skills) => {
            useComposerControlStore.getState().setSelectedSkills(skills.map((skill) => ({
              description: skill.description,
              id: skill.id,
              name: skill.name,
              promptCharacterCount: skill.instructions.length
            })));
          }}
        />
      ) : null}

      {settings.settings.open && !libraryOpen ? (
        <SettingsV2
          busy={mcpBusy}
          dirty={mcpDirty}
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
          themeId={settings.settings.themeId}
          onClose={() => {
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
      {memoryOwnerOpen ? (
        <MemoryWorkspace
          accountId={session.accountId}
          notice={settings.notice}
          onClose={() => setMemoryOwnerOpen(false)}
          onDismissNotice={settings.dismissNotice}
          onOpenMemorySource={settings.openMemorySourceChat}
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
          memoryDraft={workspace.projectSettings.draft}
          saving={workspace.pane.state.folderActionId === workspace.projectSettings.folder.id}
          onCancel={workspace.projectSettings.close}
          onKnowledgeBaseIdsChange={workspace.projectSettings.changeKnowledgeBaseIds}
          onMemoryDraftChange={workspace.projectSettings.changeDraft}
          onRetryKnowledge={workspace.projectSettings.retryKnowledge}
          onSave={() => {
            const folder = workspace.projectSettings.folder;
            if (folder) void workspace.projectSettings.save(folder);
          }}
        />
      ) : null}
      {workspace.archived.open ? (
        <ArchivedChatsDialog onRestored={workspace.archived.onRestored} />
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
      {overlays.confirmations.message ? (
        <MessageDeleteConfirmationDialog
          onCancel={overlays.confirmations.cancelMessage}
          onConfirm={overlays.confirmations.confirmMessage}
        />
      ) : null}
      <PermanentChatDeletionSurface />
      {overlays.palette.open ? (
        <CommandPalette items={overlays.palette.items} onClose={overlays.palette.close} onRun={overlays.palette.run} />
      ) : null}
    </main>
  );
}
