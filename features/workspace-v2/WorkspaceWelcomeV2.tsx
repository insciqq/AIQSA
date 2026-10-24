"use client";

import {
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import {
  applyMemorySearch,
  beginCreateMemory,
  beginEditMemory,
  cancelMemoryDraft,
  discardMemoryManagerDraft,
  forgetCurrentMemory,
  openMemoryDetail,
  refreshMemoryList,
  requestForgetMemory,
  saveMemoryChanges,
  saveNewMemory,
  useMemoryManagerStore
} from "@/components/app-shell/memoryManagerStore";
import { navigateChatRoute } from "@/components/app-shell/chatRoute";
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
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
  LibraryV2,
  MemoryPanelV2
} from "@/features/library-v2/LibraryV2";
import type {
  FileSummaryV2,
  LibraryTabIdV2,
  LibraryTabV2,
  LibrarySubviewV2,
  MemoryOverviewV2
} from "@/features/library-v2/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { ChatDefaultsPanelV2 } from "@/features/library-v2/ChatDefaultsPanelV2";
import { InstructionsSettingsPanel } from "@/features/settings-v2/InstructionsSettingsPanel";
import { WorkspaceSecretsPanel } from "@/features/settings-v2/WorkspaceSecretsPanel";
import { ScheduledTasksPanel } from "@/features/scheduled-tasks/ScheduledTasksPanel";
import { scheduledTaskMemoryAvailability, scheduledTaskWorkspaceAvailability } from "@/features/scheduled-tasks/scheduledTaskDraft";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
import { mcpSetupAttention } from "@/components/app-shell/mcpReadiness";
import { observeMcpSettings, useMcpSettingsStore } from "@/components/app-shell/mcpSettingsStore";
import { MemorySettingsRowsV2 } from "@/features/settings-v2/MemorySettingsRowsV2";

function LibrarySurfaceV2({ composer, props, initialTab: requestedInitialTab }: Readonly<{
  composer: ShellComposerView;
  props: PowerAppShellV2Props;
  initialTab?: LibraryTabIdV2;
}>) {
  const { session, settings } = props;
  const memoryData = useMemorySettingsStore((state) => state.data);
  const memoryLoadState = useMemorySettingsStore((state) => state.loadState);
  const activeMemory = useMemoryManagerStore((state) => state.activeMemory);
  const memoryDraft = useMemoryManagerStore((state) => state.draft.statement);
  const memoryDraftDirty = useMemoryManagerStore((state) => state.draftDirty);
  const memoryListError = useMemoryManagerStore((state) => state.listError);
  const memoryListState = useMemoryManagerStore((state) => state.listLoadState);
  const memories = useMemoryManagerStore((state) => state.memories);
  const memoryMutationError = useMemoryManagerStore((state) => state.mutationError);
  const memoryMutationOutcomeUnknown = useMemoryManagerStore((state) => state.mutationOutcomeUnknown);
  const memoryBusy = useMemoryManagerStore((state) => state.mutationState);
  const memoryResetPending = useMemoryManagerStore(state => state.resetPending);
  const memoryNextCursor = useMemoryManagerStore((state) => state.nextCursor);
  const memoryNotice = useMemoryManagerStore((state) => state.notice);
  const memoryQueryApplied = useMemoryManagerStore((state) => state.queryApplied);
  const memoryQuery = useMemoryManagerStore((state) => state.queryInput);
  const memoryScreen = useMemoryManagerStore((state) => state.screen);
  const setMemoryDraft = useMemoryManagerStore((state) => state.setDraft);
  const setMemoryQuery = useMemoryManagerStore((state) => state.setQueryInput);
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
  const initialTab: LibraryTabIdV2 = requestedInitialTab ?? (settings.memory.open ? "memory" : "assistants");
  const [localTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);
  const activeTab = settings.studio?.tab ?? localTab;
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
    // last visited Library. Recent and Published share this request.
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
  /** Opens a chat like a chat row does: one history entry, then Studio closes over it. */
  const openArtifactChat = async (chatId: string) => {
    if (!await navigateChatRoute(() => props.workspace.pane.actions.openChat?.(chatId))) {
      throw new Error("This chat is no longer available.");
    }
    closeLibrary();
  };
  const [assistantExit, setAssistantExit] = useState<(() => void) | null>(null);
  const [memoryExit, setMemoryExit] = useState<(() => void) | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [formExit, setFormExit] = useState<{ proceed(): void; remount: boolean } | null>(null);
  const [instructionsSubview, setInstructionsSubview] = useState<LibrarySubviewV2 | null>(null);
  const [skillDirty, setSkillDirty] = useState(false);
  const [skillExit, setSkillExit] = useState<(() => void) | null>(null);
  useBeforeUnloadGuard(formDirty || formBusy);
  useBeforeUnloadGuard(memoryDraftDirty);
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
    assistantView?.busy || assistantView?.editor?.saving || memoryBusy || formBusy
  );
  const requestNavigation = useEventCallback((proceed: () => void, remountForm: boolean = true) => {
    if (navigationBusy) return;
    if (activeTab === "assistants" && assistantDirty) {
      setAssistantExit(() => () => { assistantView?.onDiscardDrafts(); proceed(); });
    } else if (activeTab === "memory" && memoryDraftDirty) setMemoryExit(() => proceed);
    else if (activeTab === "skills" && skillDirty) setSkillExit(() => proceed);
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
  const memory: MemoryOverviewV2 = memoryData ? {
    administratorDisabled: memoryData.status === "NEEDS_ADMIN_SETUP",
    automaticLearning: memoryData.settings.learnAutomatically,
    explicitCrudAvailable: memoryData.capabilities.managementAvailable,
    loadState: memoryLoadState,
    referenceChatHistory: memoryData.settings.referenceChatHistory,
    status: memoryData.status,
    useMemoryFacts: memoryData.settings.useMemoryFacts
  } : {
    administratorDisabled: false,
    automaticLearning: false,
    explicitCrudAvailable: false,
    loadState: memoryLoadState,
    referenceChatHistory: false,
    status: null,
    useMemoryFacts: false
  };
  const tabs: LibraryTabV2[] = [
    { id: "defaults", label: "Chat defaults", content: <ChatDefaultsPanelV2 composer={composer} onNavigate={navigateToSection} /> },
    { id: "instructions", label: "Instructions", content: <InstructionsSettingsPanel key={`${session.accountId}:${formKey}`} onDirtyChange={setFormDirty} onBusyChange={setFormBusy} onSubviewChange={setInstructionsSubview} onRequestExit={requestInstructionsClose} /> },
    { id: "secrets", label: "Secrets", content: <WorkspaceSecretsPanel key={session.accountId} onBusyChange={setFormBusy} /> },
    { id: "scheduled", label: "Automations", content: <ScheduledTasksPanel key={session.accountId} accountId={session.accountId} catalog={composer.catalog} memory={scheduledTaskMemoryAvailability(memoryData)} onBusyChange={setFormBusy} onOpenChat={openArtifactChat} workspace={scheduledTaskWorkspaceAvailability(composer.workspace)} /> },
    { id: "mcp", label: "MCP servers", attention: mcpAttention, content: <McpSettingsSection key={session.accountId} onBusyChange={setFormBusy} onOpenDefaults={() => navigateToSection("defaults")} /> },
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
        <MemoryPanelV2
          settingsContent={<MemorySettingsRowsV2 onBusyChange={setFormBusy} />}
          resetPending={memoryResetPending}
          activeRef={activeMemory?.memoryRef ?? null}
          busy={memoryBusy}
          draft={memoryDraft}
          hasMore={memoryNextCursor !== null}
          items={memories}
          listError={memoryListError}
          listState={memoryListState}
          memory={memory}
          mutationError={memoryManagerErrorCopy(memoryMutationError)}
          mutationOutcomeUnknown={memoryMutationOutcomeUnknown}
          notice={memoryNotice ? memoryUiCopy(
            memoryNotice === "forgotten"
              ? "manager.forgotten"
              : memoryNotice === "saved_use_off"
                ? "manager.savedUseOff"
                : "manager.saved"
          ) : null}
          onCancelRow={cancelMemoryDraft}
          onConfirmForget={() => void forgetCurrentMemory().catch(() => undefined)}
          onCreate={beginCreateMemory}
          onDraftChange={(statement) => setMemoryDraft({ statement })}
          onEdit={(memoryRef) => {
            openMemoryDetail(memoryRef);
            beginEditMemory();
          }}
          onForget={requestForgetMemory}
          onLoadMore={() => void refreshMemoryList({ append: true }).catch(() => undefined)}
          onQueryChange={setMemoryQuery}
          onRetry={() => void Promise.all([
            refreshMemorySettings(true).catch(() => null),
            refreshMemoryList().catch(() => undefined)
          ])}
          onSave={() => void (
            memoryScreen === "create"
              ? saveNewMemory(memoryData?.settings.useMemoryFacts ?? false)
              : saveMemoryChanges()
          ).catch(() => undefined)}
          onSubmitQuery={() => void applyMemorySearch().catch(() => undefined)}
          query={memoryQuery}
          searchActive={memoryQueryApplied.length > 0}
          rowMode={memoryScreen === "create" || memoryScreen === "edit" || memoryScreen === "forget"
            ? memoryScreen
            : null}
        />
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
      <MemoryListPollingV2
        active={memoryListPollingActiveV2({ activeTab, memory: memoryData })}
        onRefresh={refreshMemoryListInBackgroundV2}
      />
      <LibraryV2
        activeTab={activeTab}
        busy={navigationBusy}
        initialTab={initialTab}
        navigationGuard={(intent, proceed) => {
          if (!settings.studio) requestNavigation(proceed);
          else if (intent.kind === "tab") settings.studio.open(intent.to, proceed);
          else settings.studio.exit(proceed);
        }}
        subview={activeTab === "instructions" ? instructionsSubview : activeTab === "assistants" && assistantSubview ? assistantSubview
          : activeTab === "artifacts" && artifactSubview ? {
              backLabel: "Back to artifacts", key: `artifact-${artifactSubview.id}`, label: artifactSubview.title,
              onBack: closeArtifactPreview
            } : null}
        tabs={tabs}
        onBack={() => { if (!settings.studio) closeLibrary(); }}
        onTabChange={(tab) => {
          if (settings.studio) return;
          setActiveTab(tab);
          if (tab === "assistants") settings.openLibrary();
          if (tab === "memory") settings.openMemory();
        }}
      />
      {formExit ? <DiscardChangesConfirmationDialog
        portal label="changes"
        copy={{
          title: "Discard your unsaved instructions?",
          body: "Your unsaved instructions will be lost.",
          dialogLabel: "Unsaved instructions",
          cancelLabel: "Keep editing", confirmLabel: "Discard changes"
        }}
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
      {memoryExit ? (
        <DiscardChangesConfirmationDialog
          portal
          copy={{
            body: memoryUiCopy("manager.discardBody"),
            cancelLabel: memoryUiCopy("manager.keepEditing"),
            confirmLabel: memoryUiCopy("manager.discardDraft"),
            dialogLabel: memoryUiCopy("manager.discardTitle"),
            title: memoryUiCopy("manager.discardTitle")
          }}
          label="Memory draft"
          onCancel={() => setMemoryExit(null)}
          onConfirm={() => {
            const proceed = memoryExit;
            setMemoryExit(null);
            discardMemoryManagerDraft();
            proceed();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Studio observes the shared MCP catalog for its lifetime so the MCP servers
 * tab flags setup, authorization and runtime problems before it is opened.
 * The observer is ref-counted with the chat shell's, reads the catalog only
 * and never wakes idle servers; the rule is the chat chip's.
 */
export function useStudioMcpAttentionV2(accountId: string): boolean {
  useEffect(() => observeMcpSettings(), [accountId]);
  return useMcpSettingsStore((state) => state.servers.some((server) => mcpSetupAttention(server) !== null));
}

/** Calm cadence for picking up facts saved after a chat finished. */
export const MEMORY_LIST_POLL_INTERVAL_MS = 30_000;

/**
 * Both automatic learning and "remember that…" requests commit in the
 * background worker after the answer, and the requests work with learning
 * off, so polling follows only the main switch being on and ready.
 */
export function memoryListPollingActiveV2(input: Readonly<{
  activeTab: LibraryTabIdV2;
  memory: Readonly<{ status: string }> | null;
}>): boolean {
  return input.activeTab === "memory" && input.memory?.status === "ON";
}

/**
 * Background Memory writes finish in a worker after the chat run, with no
 * channel to the browser. While the Memory list is open, visible and Memory is
 * on, re-read it quietly on a calm interval and once when the page becomes
 * visible again. A hidden page schedules nothing.
 */
export function MemoryListPollingV2({
  active,
  onRefresh
}: Readonly<{
  active: boolean;
  onRefresh(): Promise<void>;
}>) {
  const refreshRef = useRef(onRefresh);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let running = false;
    let timer: number | null = null;

    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clear();
      if (cancelled || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    };
    const run = async () => {
      if (cancelled || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await refreshRef.current();
      } catch {
        // A failed background read keeps the last known rows silently.
      } finally {
        running = false;
        schedule(MEMORY_LIST_POLL_INTERVAL_MS);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clear();
        return;
      }
      if (!running) {
        clear();
        void run();
      }
    };

    schedule(MEMORY_LIST_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active]);

  return null;
}

function refreshMemoryListInBackgroundV2(): Promise<void> {
  return refreshMemoryList({ background: true });
}

/** Only input validation reaches the user; Memory failures stay silent. */
export function memoryManagerErrorCopy(code: string | null): string | null {
  if (code === "memory_secret_rejected") return memoryUiCopy("manager.secretRejected");
  if (code === "memory_changed") return memoryUiCopy("manager.draftStale");
  return null;
}

export { LibrarySurfaceV2 };
