"use client";

import { navigateChatRoute } from "@/components/app-shell/chatRoute";
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { MEMORY_NOTE_COPY } from "@/components/app-shell/memoryNoteUiCopy";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import {
  refreshFileLibrary,
  loadMoreFileLibrary,
  removeFileFromLibrary,
  saveFileToLibrary,
  useFileLibraryStore
} from "@/components/app-shell/fileLibraryStore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useSkillLibraryStore } from "@/components/app-shell/skillLibraryStore";
import { activateArtifactLibraryAccount, mutateArtifactLibrary, refreshArtifactLibrary, useArtifactLibraryStore } from "@/components/app-shell/artifactLibraryStore";
import { ArtifactViewerV2 } from "@/components/artifacts/ArtifactViewerV2";
import { prepareArtifactEdit } from "@/components/artifacts/artifactClient";
import { openArtifactPanel } from "@/components/artifacts/artifactPanelStore";
import { setArtifactEditSession } from "@/components/artifacts/artifactEditSession";
import type { ArtifactDetail } from "@/lib/contracts/artifacts";
import { ArtifactsPanelV2, type ArtifactLibraryFilter } from "@/features/library-v2/ArtifactsPanelV2";
import type {
  PowerAppShellV2Props,
  ShellComposerView
} from "@/components/app-shell/powerAppShellV2Contracts";
import { SkillLibrarySection } from "@/components/skills/SkillLibraryDialog";
import { AssistantsTabV2, assistantsTabSubviewV2 } from "@/features/library-v2/assistants/AssistantsTabV2";
import {
  FilesPanelV2,
  LibraryV2
} from "@/features/library-v2/LibraryV2";
import type {
  FileSummaryV2,
  LibraryTabIdV2,
  LibraryTabV2,
  LibrarySubviewV2
} from "@/features/library-v2/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { ChatDefaultsPanelV2 } from "@/features/library-v2/ChatDefaultsPanelV2";
import { InstructionsSettingsPanel } from "@/features/settings-v2/InstructionsSettingsPanel";
import { WorkspaceSecretsPanel } from "@/features/settings-v2/WorkspaceSecretsPanel";
import { SubagentsPanelV2 } from "@/features/library-v2/subagents/SubagentsPanelV2";
import { ScheduledTasksPanel } from "@/features/scheduled-tasks/ScheduledTasksPanel";
import { requestBrowserSignIn } from "@/features/workspace-v2/browserSignInRequest";
import { scheduledTaskWorkspaceAvailability } from "@/features/scheduled-tasks/scheduledTaskDraft";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
import { mcpAttentionSignal } from "@/components/app-shell/mcpReadiness";
import { observeMcpSettings, useMcpSettingsStore } from "@/components/app-shell/mcpSettingsStore";
import { PersonalMcpConnectionsSection } from "@/components/app-shell/PersonalMcpConnectionsSection";
import { TelegramConnectionSection } from "@/components/app-shell/TelegramConnectionSection";
import { ConnectComputersSection } from "@/features/connect/ConnectComputersSection";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import { loadChatNavigation } from "@/components/app-shell/chatNavigationActions";
import { MemoryNoteSettingsV2 } from "@/features/settings-v2/MemoryNoteSettingsV2";
import {
  AccountSettingsSectionV2,
  ConnectedAppsSettingsSectionV2,
  DataSettingsSectionV2,
  GeneralSettingsSectionV2,
  ProxiesSettingsSectionV2
} from "@/features/settings-v2/SettingsSectionsV2";

/** Discard copy of the Settings forms that share the surface's one form guard. */
function formDiscardCopy(tab: LibraryTabIdV2) {
  const copy = (title: string, body: string, dialogLabel: string) =>
    ({ title, body, dialogLabel, cancelLabel: "Keep editing", confirmLabel: "Discard changes" });
  switch (tab) {
    case "subagents": return copy("Discard your unsaved sub-agent?", "Your unsaved changes to this sub-agent will be lost.",
      "Unsaved sub-agent");
    case "account": return copy("Discard your unsaved account changes?", "Your unsaved account changes will be lost.",
      "Unsaved account changes");
    case "proxies": return copy("Discard your unsaved proxy changes?", "Your unsaved proxy changes will be lost.",
      "Unsaved proxy changes");
    case "memory": return copy(MEMORY_NOTE_COPY.unsavedTitle, MEMORY_NOTE_COPY.unsavedBody, "Unsaved note");
    default: return copy("Discard your unsaved instructions?", "Your unsaved instructions will be lost.", "Unsaved instructions");
  }
}

function LibrarySurfaceV2({ composer, props, initialTab: requestedInitialTab }: Readonly<{
  composer: ShellComposerView;
  props: PowerAppShellV2Props;
  initialTab?: LibraryTabIdV2;
}>) {
  const { session, settings } = props;
  const fileData = useFileLibraryStore((state) => state.data);
  const fileLoadState = useFileLibraryStore((state) => state.loadState);
  const fileMutations = useFileLibraryStore((state) => state.mutations);
  const skillCatalog = useSkillLibraryStore((state) => state.data);
  const selectedSkills = useComposerControlStore((state) => state.selectedSkills);
  const skillsMode = useComposerControlStore(state => state.skillsMode);
  // The chat's Assistant links; an unavailable or deleted one links none.
  const currentAssistant = composer.assistant.current;
  const assistantSkills = currentAssistant
    ? currentAssistant.state === "bound" ? currentAssistant.includedSkills : []
    : undefined;
  const mcpAttention = useStudioMcpAttentionV2(session.accountId);
  const assistantView = settings.library;
  const initialTab: LibraryTabIdV2 = requestedInitialTab ?? (settings.memory.open ? "memory" : "general");
  const [localTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);
  const activeTab = settings.studio?.tab ?? localTab;
  const [localSectionShown, setLocalSectionShown] = useState(true);
  const [dataArchived, setDataArchived] = useState(false);
  const manageArchivedRef = useRef<HTMLButtonElement>(null);
  // Archived chats is Data's sub-view; another section closes it.
  if (dataArchived && activeTab !== "data") setDataArchived(false);
  const closeDataArchived = () => {
    setDataArchived(false);
    window.requestAnimationFrame(() => manageArchivedRef.current?.focus());
  };
  const artifactLibrary = useArtifactLibraryStore();
  const [artifactFilter, setArtifactFilter] = useState<ArtifactLibraryFilter>("recent");
  const artifactArchived = artifactFilter === "archived";
  const [artifactSubview, setArtifactSubview] = useState<{ id: string; title: string; versionId: string } | null>(null);
  const artifactDetailRef = useRef<ArtifactDetail | null>(null);
  const artifactNavigationEpoch = useRef(0);
  useEffect(() => () => { artifactNavigationEpoch.current += 1; }, [activeTab, artifactSubview?.id, artifactSubview?.versionId, session.accountId]);
  useEffect(() => { activateArtifactLibraryAccount(session.accountId); }, [session.accountId]);
  useEffect(() => {
    // Retain cached rows while checking for versions created since the user
    // last visited Settings. Recent and Published share this request.
    if (activeTab === "artifacts") void refreshArtifactLibrary(artifactArchived, true);
  }, [activeTab, artifactArchived, session.accountId]);
  const closeLibrary = () => {
    if (settings.studio) { settings.studio.exit(); return; }
    assistantView?.onBackToChat();
    settings.closeMemory();
  };
  const closeArtifactPreview = () => {
    setArtifactSubview(null);
    artifactDetailRef.current = null;
    void refreshArtifactLibrary(artifactArchived, true);
  };
  /** Opens a chat like a chat row does: one history entry, then Settings closes over it. */
  const openArtifactChat = async (chatId: string) => {
    if (!await navigateChatRoute(() => props.workspace.pane.actions.openChat?.(chatId))) {
      throw new Error("This chat is no longer available.");
    }
    closeLibrary();
  };
  /**
   * Sign in again from Settings: leaves for the chat it belongs in (an automation's chat) or a new chat, where the shell
   * sends the request once that chat is open (`browserSignInRequest.ts`). A chat that is gone throws, like opening it.
   */
  const signInAgain = async (chatId: string | null, host: string) => {
    if (chatId) {
      await openArtifactChat(chatId);
    } else {
      await props.workspace.pane.actions.createChat();
      closeLibrary();
    }
    requestBrowserSignIn(chatId, host);
  };
  const [assistantExit, setAssistantExit] = useState<(() => void) | null>(null);
  // The open section's form (only one section is mounted at a time) reports
  // unsaved and saving states here. Unsaved changes and the saves of the
  // forms Settings always had also guard leaving the page.
  const [formDirty, setFormDirty] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  // Busy states of Account, Proxies, Claude Code & Codex and the personal MCP
  // connections only lock navigation inside Settings: signing out and
  // starting an MCP sign-in end in the page's own navigation, which must not
  // ask to leave. Those forms guard their unsaved data themselves.
  const [sectionBusy, setSectionBusy] = useState(false);
  const [personalMcpBusy, setPersonalMcpBusy] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [formExit, setFormExit] = useState<{ proceed(): void; remount: boolean } | null>(null);
  const [instructionsSubview, setInstructionsSubview] = useState<LibrarySubviewV2 | null>(null);
  const [skillDirty, setSkillDirty] = useState(false);
  const [skillExit, setSkillExit] = useState<(() => void) | null>(null);
  // An administrator turned AIQSA Connect off while Computers was open: the
  // section leaves to General and is no longer listed until the next load.
  const [computersOff, setComputersOff] = useState(false);
  useBeforeUnloadGuard(formDirty || formBusy);
  const assistantDirty = Boolean(assistantView?.dirty);
  useBeforeUnloadGuard(assistantDirty);

  const closeAssistantSubview = () => {
    if (!assistantView || assistantView.busy) return;
    if (assistantView.task === "editor") assistantView.editor?.onCancel();
  };
  const requestAssistantSubviewClose = () => {
    if (assistantView?.busy || assistantView?.editor?.saving) return;
    if (assistantView?.task === "editor" && assistantDirty) {
      setAssistantExit(() => closeAssistantSubview);
      return;
    }
    closeAssistantSubview();
  };

  const navigationBusy = Boolean(
    assistantView?.busy || assistantView?.editor?.saving || formBusy || sectionBusy || personalMcpBusy
  );
  const requestNavigation = useEventCallback((proceed: () => void, remountForm: boolean = true) => {
    if (navigationBusy) return;
    if (activeTab === "assistants" && assistantDirty) {
      setAssistantExit(() => () => { assistantView?.onDiscardDrafts(); proceed(); });
    } else if (activeTab === "skills" && skillDirty) setSkillExit(() => proceed);
    else if (formDirty) setFormExit({ proceed, remount: remountForm });
    else proceed();
  });
  const requestInstructionsClose = useEventCallback((proceed: () => void) => requestNavigation(proceed, false));
  const navigateToSection = (tab: LibraryTabIdV2) => {
    if (settings.studio) settings.studio.open(tab);
    else requestNavigation(() => setActiveTab(tab));
  };
  const registerGuard = settings.studio?.registerGuard;
  useLayoutEffect(() => {
    registerGuard?.(requestNavigation, navigationBusy);
    return () => registerGuard?.(null, false);
  }, [navigationBusy, registerGuard, requestNavigation]);
  useEffect(() => {
    if (activeTab === "files") void refreshFileLibrary(true).catch(() => undefined);
  }, [activeTab]);

  const files: FileSummaryV2[] = (fileData?.files ?? []).map((file) => ({
    byteSize: file.byteSize,
    canOpenChat: Boolean(file.chatId && file.messageId),
    chatId: file.chatId,
    chatTitle: file.chatTitle,
    createdAt: file.createdAt,
    id: file.id,
    mutation: fileMutations[file.id],
    name: file.fileName,
    previewKind: file.previewKind,
    savedAt: file.savedAt,
    status: file.status
  }));
  const refreshChats = () => {
    void props.workspace.pane.actions.retry();
    void loadChatNavigation();
  };
  const tabs: LibraryTabV2[] = [
    { id: "general", label: "General", content: <GeneralSettingsSectionV2 composer={composer} onThemeChange={settings.updateTheme} themeId={settings.themeId} /> },
    {
      id: "account",
      label: "Account",
      content: (
        <AccountSettingsSectionV2 key={`${session.accountId}:${formKey}`} accountEmail={session.accountEmail}
          accountId={session.accountId} adminEntryVisible={session.adminEntryVisible} onBusyChange={setSectionBusy}
          onDirtyChange={setFormDirty} onDisplayNameChange={session.updateAccountDisplayName} />
      )
    },
    {
      id: "data",
      label: "Data",
      content: (
        <DataSettingsSectionV2 accountId={session.accountId} archived={dataArchived} manageArchivedRef={manageArchivedRef}
          onChatsChanged={refreshChats} onOpenArchived={() => setDataArchived(true)} onRestored={props.workspace.archived.onRestored} />
      )
    },
    { id: "proxies", label: "Proxies", content: <ProxiesSettingsSectionV2 key={`${session.accountId}:${formKey}`} onBusyChange={setSectionBusy} onDirtyChange={setFormDirty} /> },
    ...(session.connectEntryVisible && !computersOff ? [{
      id: "computers" as const,
      label: "Computers",
      content: (
        <ConnectComputersSection key={session.accountId} installOrigin={session.connectInstallOrigin ?? null}
          onDisabled={() => { setComputersOff(true); navigateToSection("general"); }} />
      )
    }] : []),
    ...(session.telegramAvailable ? [{ id: "telegram" as const, label: "Telegram", content: <TelegramConnectionSection /> }] : []),
    { id: "apps", label: "Claude Code & Codex", content: <ConnectedAppsSettingsSectionV2 accountId={session.accountId} onBusyChange={setSectionBusy} /> },
    { id: "defaults", label: "Chat defaults", content: <ChatDefaultsPanelV2 composer={composer} onNavigate={navigateToSection} /> },
    { id: "instructions", label: "Instructions", content: <InstructionsSettingsPanel key={`${session.accountId}:${formKey}`} onDirtyChange={setFormDirty} onBusyChange={setFormBusy} onSubviewChange={setInstructionsSubview} onRequestExit={requestInstructionsClose} /> },
    { id: "secrets", label: "Secrets", content: <WorkspaceSecretsPanel key={session.accountId} onBusyChange={setFormBusy}
      onSignInAgain={(host) => signInAgain(null, host)} /> },
    { id: "subagents", label: "Sub-agents", content: <SubagentsPanelV2 key={`${session.accountId}:${formKey}`} onDirtyChange={setFormDirty} onBusyChange={setFormBusy} /> },
    { id: "scheduled", label: "Automations", content: <ScheduledTasksPanel key={session.accountId} accountId={session.accountId} catalog={composer.catalog} onBusyChange={setFormBusy} onOpenChat={openArtifactChat} onSignInAgain={signInAgain} workspace={scheduledTaskWorkspaceAvailability(composer.workspace)} /> },
    {
      id: "mcp",
      label: "MCP servers",
      attention: mcpAttention,
      content: (
        <McpSettingsSection key={session.accountId} onBusyChange={setFormBusy} onOpenDefaults={() => navigateToSection("defaults")}
          personalConnections={<PersonalMcpConnectionsSection onBusyChange={setPersonalMcpBusy} />} />
      )
    },
    {
      content: (
        <AssistantsTabV2
          composer={composer}
          onOpenMcpSettings={settings.openMcp}
          onRequestClose={requestAssistantSubviewClose}
          view={assistantView ?? null}
        />
      ),
      id: "assistants",
      label: "Assistants"
    },
    {
      content: (
        <FilesPanelV2
          files={files}
          complete={fileData?.nextCursor === null}
          loadState={fileLoadState}
          onOpen={(id) => {
            const file = fileData?.files.find((candidate) => candidate.id === id);
            const chatId = file?.chatId;
            const messageId = file?.messageId;
            if (!chatId || !messageId) return;
            void navigateChatRoute(() => props.workspace.pane.actions.openChatMessage(chatId, messageId))
              .then((opened) => {
                if (!opened) return;
                closeLibrary();
              });
          }}
          onSave={(id) => void saveFileToLibrary(id)}
          onRemove={(id) => void removeFileFromLibrary(id)}
          onUse={composer.reuseFile ? (id) => {
            const file = fileData?.files.find((candidate) => candidate.id === id);
            if (!file) return;
            void composer.reuseFile?.(id, file.fileName).then((used) => {
              if (!used) return;
              closeLibrary();
            });
          } : undefined}
          useDisabled={composer.uploading || props.thread.activeChatStreaming}
          onLoadMore={fileData?.nextCursor ? () => void loadMoreFileLibrary()?.catch(() => undefined) : undefined}
          onRetry={() => void refreshFileLibrary(true).catch(() => undefined)}
        />
      ),
      id: "files",
      label: "Files"
    },
    {
      content: artifactSubview ? <ArtifactViewerV2 artifactId={artifactSubview.id} versionId={artifactSubview.versionId}
        host="library" onVersionChange={versionId => setArtifactSubview(current => current ? { ...current, versionId } : null)}
        onClose={closeArtifactPreview}
        onOpenSourceChat={openArtifactChat}
        onDetailChange={detail => { artifactDetailRef.current = detail; }}
        onEditRequest={async (intent, error) => {
          const navigationEpoch = artifactNavigationEpoch.current;
          const selected = artifactSubview;
          const detail = artifactDetailRef.current;
          const version = detail?.id === selected.id ? detail.versions.find(version => version.id === selected.versionId) : null;
          if (!version) throw new Error("This artifact is no longer available.");
          const chatId = await prepareArtifactEdit(selected.id, selected.versionId);
          if (navigationEpoch !== artifactNavigationEpoch.current) return;
          await openArtifactChat(chatId);
          setArtifactEditSession(chatId, { artifactId: selected.id, versionId: selected.versionId, title: detail?.title ?? selected.title, versionNumber: version.versionNumber }, intent, error);
          // The compact viewer yields to the composer for this explicit edit action.
          requestAnimationFrame(() => {
            const workspace = document.querySelector<HTMLElement>(".v2-live-workspace");
            if (workspace && workspace.getBoundingClientRect().width >= 896) openArtifactPanel({ chatId, artifactId: selected.id, versionId: selected.versionId });
            document.querySelector<HTMLTextAreaElement>('[data-testid="composer-v2"] textarea')?.focus({ preventScroll: true });
          });
        }} /> : <ArtifactsPanelV2 recent={artifactLibrary.data.recent} archived={artifactLibrary.data.archived}
        error={artifactLibrary.errors[artifactFilter === "archived" ? "archived" : "recent"]}
        loadState={artifactLibrary.loadState[artifactFilter === "archived" ? "archived" : "recent"]}
        filter={artifactFilter} mutations={artifactLibrary.mutations} onFilterChange={setArtifactFilter}
        onRetry={() => void refreshArtifactLibrary(artifactFilter === "archived", true)} onChange={mutateArtifactLibrary}
        onOpenChat={openArtifactChat} onOpen={item => { artifactDetailRef.current = null; setArtifactSubview({ id: item.id, title: item.title, versionId: item.currentVersionId }); }} />,
      id: "artifacts",
      label: "Artifacts"
    },
    {
      content: (
        <MemoryNoteSettingsV2 key={`${session.accountId}:${formKey}`} onBusyChange={setFormBusy} onDirtyChange={setFormDirty} />
      ),
      id: "memory",
      label: "Memory"
    },
    {
      content: (
        <SkillLibrarySection
          includedSkills={assistantSkills}
          selectedSkills={selectedSkills}
          skillsMode={skillsMode}
          availableCount={assistantSkills?.filter(skill => skill.mode === "available" && !selectedSkills.some(selected => selected.id === skill.id)).length}
          modelContextWindow={composer.currentModel?.contextWindow ?? undefined}
          onDirtyChange={setSkillDirty}
          selectedIds={selectedSkills.map((skill) => skill.id)}
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
                  promptCharacterCount: skill.instructionCharacterCount,
                  instructionApproxTokens: skill.instructionApproxTokens
                }] : [];
              }
              const selected = selectedById.get(id);
              return selected ? [selected] : [];
            }));
          }}
        />
      ),
      id: "skills",
      label: "Skills"
    }
  ];

  const assistantSubview = assistantsTabSubviewV2(assistantView ?? null, requestAssistantSubviewClose);

  return (
    <>
      <LibraryV2
        activeTab={activeTab}
        busy={navigationBusy}
        initialTab={initialTab}
        navigationGuard={(intent, proceed) => {
          if (!settings.studio) requestNavigation(proceed);
          else if (intent.kind === "tab") settings.studio.select(intent.to, proceed);
          else settings.studio.exit(proceed);
        }}
        notice={settings.notice ? <ShellNotice notice={settings.notice} onDismiss={settings.dismissNotice} /> : null}
        sectionShown={settings.studio?.sectionShown ?? localSectionShown}
        subview={activeTab === "instructions" ? instructionsSubview : activeTab === "assistants" && assistantSubview ? assistantSubview
          : activeTab === "artifacts" && artifactSubview ? {
              backLabel: "Back to artifacts", key: `artifact-${artifactSubview.id}`, label: artifactSubview.title,
              onBack: closeArtifactPreview
            } : activeTab === "data" && dataArchived ? {
              backLabel: "Back to Data", key: "data-archived", label: "Archived chats", onBack: closeDataArchived
            } : null}
        tabs={tabs}
        onBack={() => { if (!settings.studio) closeLibrary(); }}
        onSectionShownChange={settings.studio?.showSection ?? setLocalSectionShown}
        onTabChange={(tab) => {
          if (settings.studio) return;
          setActiveTab(tab);
          if (tab === "assistants") settings.openLibrary();
          if (tab === "memory") settings.openMemory();
        }}
      />
      {formExit ? <DiscardChangesConfirmationDialog
        portal label="changes"
        copy={formDiscardCopy(activeTab)}
        onCancel={() => setFormExit(null)}
        onConfirm={() => {
          const { proceed, remount } = formExit;
          setFormExit(null); setFormDirty(false);
          if (remount) setFormKey(value => value + 1);
          proceed();
        }}
      /> : null}
      {assistantExit ? (
        <DiscardChangesConfirmationDialog
          portal
          label="assistant draft"
          onCancel={() => setAssistantExit(null)}
          onConfirm={() => {
            const proceed = assistantExit;
            setAssistantExit(null);
            proceed();
          }}
        />
      ) : null}
      {skillExit ? (
        <DiscardChangesConfirmationDialog
          portal
          copy={{
            body: "Your unsaved Skill edits will be lost.",
            cancelLabel: "Keep editing",
            confirmLabel: "Discard changes",
            dialogLabel: "Unsaved Skill changes",
            title: "Discard unsaved Skill changes?"
          }}
          label="Skill"
          onCancel={() => setSkillExit(null)}
          onConfirm={() => {
            // Leaving the Skills section unmounts its editor with the draft.
            const proceed = skillExit;
            setSkillExit(null);
            proceed();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Settings observes the shared MCP catalog for its lifetime so the MCP servers
 * tab flags setup, authorization and runtime problems of the servers the user
 * turned on before it is opened.
 * The observer is ref-counted with the chat shell's, reads the catalog only
 * and never wakes idle servers; the rule is the chat chip's.
 */
export function useStudioMcpAttentionV2(accountId: string): boolean {
  useEffect(() => observeMcpSettings(), [accountId]);
  return useMcpSettingsStore((state) => state.servers.some((server) => mcpAttentionSignal(server) !== null));
}

export { LibrarySurfaceV2 };
