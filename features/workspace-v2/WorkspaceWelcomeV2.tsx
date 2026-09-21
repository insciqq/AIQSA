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
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { formatStudioDate } from "@/features/library-v2/studioDate";
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
import { AssistantLibrary } from "@/components/assistants/AssistantLibrary";
import { SkillLibrarySection } from "@/components/skills/SkillLibraryDialog";
import {
  isKnowledgeSubview,
  KnowledgeLibrary,
  knowledgeReadinessText,
  knowledgeSubviewChrome,
  useKnowledgeLibraryExit
} from "@/components/knowledge/KnowledgeLibrary";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  MemoryPanelV2
} from "@/features/library-v2/LibraryV2";
import { assistantUnavailabilityCopy } from "@/features/library-v2/assistantAvailabilityCopy";
import type {
  AssistantSummaryV2,
  FileSummaryV2,
  KnowledgeSummaryV2,
  LibraryTabIdV2,
  LibraryTabV2,
  MemoryOverviewV2
} from "@/features/library-v2/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEventCallback } from "@/components/app-shell/useEventCallback";

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
  const assistantView = settings.library;
  const knowledgeView = settings.knowledge;
  const knowledgeExit = useKnowledgeLibraryExit(knowledgeView ?? null, true);
  const initialTab: LibraryTabIdV2 = requestedInitialTab ?? (settings.memory.open
    ? "memory"
    : knowledgeView
      ? "knowledge"
      : "assistants");
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
    knowledgeView?.onBackToChat();
    settings.closeMemory();
  };
  const openArtifactChat = async (chatId: string) => {
    if (!await props.workspace.pane.actions.openChat?.(chatId)) throw new Error("This chat is no longer available.");
    closeLibrary();
  };
  const [assistantExit, setAssistantExit] = useState<(() => void) | null>(null);
  const [memoryExit, setMemoryExit] = useState<(() => void) | null>(null);
  useBeforeUnloadGuard(memoryDraftDirty);
  const assistantDirty = Boolean(
    assistantView?.task === "editor" && assistantView.editor?.dirty
  );
  useBeforeUnloadGuard(assistantDirty);

  const closeAssistantSubview = () => {
    if (!assistantView || assistantView.busy) return;
    if (assistantView.task === "editor") assistantView.editor?.onCancel();
  };
  const requestAssistantSubviewClose = () => {
    if (assistantView?.busy || assistantView?.editor?.saving) return;
    if (assistantView?.task === "editor" && assistantView.editor?.dirty) {
      setAssistantExit(() => closeAssistantSubview);
      return;
    }
    closeAssistantSubview();
  };

  const navigationBusy = Boolean(
    assistantView?.busy || assistantView?.editor?.saving || knowledgeView?.busy || memoryBusy
  );
  const requestNavigation = useEventCallback((proceed: () => void) => {
    if (navigationBusy) return;
    if (activeTab === "knowledge" && knowledgeExit.dirty) knowledgeExit.requestExit(proceed);
    else if (activeTab === "assistants" && assistantDirty) {
      setAssistantExit(() => () => { assistantView?.editor?.onCancel(); proceed(); });
    } else if (activeTab === "memory" && memoryDraftDirty) setMemoryExit(() => proceed);
    else proceed();
  });
  const registerGuard = settings.studio?.registerGuard;
  useLayoutEffect(() => {
    registerGuard?.(requestNavigation, navigationBusy);
    return () => registerGuard?.(null, false);
  }, [navigationBusy, registerGuard, requestNavigation]);
  useEffect(() => {
    if (activeTab === "files") void refreshFileLibrary(true).catch(() => undefined);
  }, [activeTab]);

  const assistants: AssistantSummaryV2[] = (assistantView?.list.assistants ?? composer.assistant.pickerItems)
    .map((assistant) => {
      const unavailable = assistantUnavailabilityCopy(assistant);
      return {
        archived: assistant.archived,
        available: assistant.availability.ok,
        avatar: assistant.avatar,
        description: assistant.description,
        id: assistant.id,
        modelLabel: assistant.fingerprint.modelLabel,
        name: assistant.name,
        owned: assistant.owned,
        ownerDisplayName: assistant.ownerDisplayName,
        pinned: assistant.pinned,
        ...(unavailable
          ? { unavailable }
          : {})
      };
    });
  const knowledge: KnowledgeSummaryV2[] = knowledgeView
    ? knowledgeView.list.knowledgeBases.map((base) => ({
      description: base.description,
        archived: base.archived,
        sourceCount: base.sourceCount,
        id: base.id,
        name: base.name,
        owned: base.owned,
        purgeScheduledAt: base.purgeScheduledAt ? formatLibraryDate(base.purgeScheduledAt) : null,
        readinessLabel: knowledgeReadinessText(base.readiness, base.purgeScheduledAt),
        sharedBy: base.owned ? undefined : base.ownerDisplayName,
        status: knowledgeSummaryStatusV2(base),
        trashed: base.trashed,
        trashedAt: base.trashedAt,
        updatedLabel: formatLibraryDate(base.updatedAt)
      }))
    : composer.knowledge.bases.map((base) => ({
        description: base.description,
        sourceCount: "sourceCount" in base && typeof base.sourceCount === "number"
          ? base.sourceCount
          : 0,
        id: base.id,
        name: base.name,
        owned: base.owned,
        status: knowledgeSummaryStatusV2(base)
      }));
  const knowledgeBusy = knowledgeView?.busy ?? false;
  const knowledgeCatalog = knowledgeView?.list.catalog ?? null;
  const knowledgeTask = knowledgeView?.task ?? null;
  const knowledgeHasProcessing = knowledge.some((base) => base.status === "processing");
  const compactKnowledgePolling = compactKnowledgeRefreshPendingV2({
    activeTab,
    busy: knowledgeBusy,
    catalog: knowledgeCatalog,
    processing: knowledgeHasProcessing,
    task: knowledgeTask
  });
  const files: FileSummaryV2[] = (fileData?.files ?? []).map((file) => ({
    byteSize: file.byteSize,
    canOpenChat: Boolean(file.chatId && file.messageId),
    chatId: file.chatId,
    chatTitle: file.chatTitle,
    createdAt: file.createdAt,
    id: file.id,
    mutation: fileMutations[file.id],
    name: file.fileName,
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
    {
      content: (
        assistantView && assistantView.task !== "list" ? (
          <AssistantLibrary view={assistantView} onRequestClose={requestAssistantSubviewClose} />
        ) : (
          <AssistantsPanelV2
            assistants={assistants}
            error={assistantView?.catalogError}
            loadState={assistantView?.catalogState ?? "loading"}
            onArchiveToggle={(id, archived) => assistantView?.list.onArchiveToggle(id, archived)}
            onCreate={() => assistantView?.list.onNewAssistant()}
            onCreateFromCurrentSetup={composer.assistant.startFromCurrentSetup}
            onDuplicate={(id) => assistantView?.list.onDuplicate(id)}
            onOpen={(id) => assistantView?.list.onEdit(id)}
            onPinToggle={(id, pinned) => assistantView?.list.onPinToggle(id, pinned)}
            onRetry={() => assistantView?.onRetryCatalog()}
            onUnavailableAction={(id, action) => dispatchAssistantUnavailableActionV2({
              action,
              assistantId: id,
              onOpenEditor: (assistantId) => assistantView?.list.onEdit(assistantId),
              onOpenMcpSettings: settings.openMcp
            })}
            onUse={(id) => assistantView?.list.onUse(id)}
          />
        )
      ),
      id: "assistants",
      label: "Assistants"
    },
    {
      // A base, the Sources catalog, base creation and Source detail render
      // as sub-views of this section under the Library's own crumb (A14).
      content: knowledgeView && isKnowledgeSubview(knowledgeView) ? (
        <KnowledgeLibrary view={knowledgeView} />
      ) : (
        <KnowledgePanelV2
          bases={knowledge}
          canCreate={knowledgeView?.list.canCreate ?? true}
          error={knowledgeView?.dataError}
          filter={knowledgeView?.list.filter}
          loadState={knowledgeView?.dataState ?? "loading"}
          onArchiveToggle={(id, archived) => knowledgeView?.list.onArchiveToggle(id, archived)}
          onBrowseSources={() => knowledgeView?.list.onCatalogChange("sources")}
          onCreate={() => knowledgeView?.list.onNewBase()}
          onFilterChange={(filter) => knowledgeView?.list.onFilterChange(filter)}
          onOpen={(id) => knowledgeView?.list.onOpenBase(id)}
          onQueryChange={(query) => knowledgeView?.list.onQueryChange(query)}
          onRetry={() => knowledgeView?.onRetry()}
          query={knowledgeView?.list.query}
        />
      ),
      id: "knowledge",
      label: "Knowledge"
    },
    {
      content: (
        <FilesPanelV2
          files={files}
          complete={fileData?.nextCursor === null}
          loadState={fileLoadState}
          onOpen={(id) => {
            const file = fileData?.files.find((candidate) => candidate.id === id);
            if (!file?.chatId || !file.messageId) return;
            void props.workspace.pane.actions.openChatMessage(file.chatId, file.messageId)
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
          onOpenSettings={settings.openMemorySettingsTab}
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
          includedSkills={composer.assistant.selected?.includedSkills}
          selectedSkills={selectedSkills}
          skillsMode={composer.assistant.selected?.skillsMode ?? skillsMode}
          availableCount={composer.assistant.selected ? (composer.assistant.selected.includedSkills ?? []).filter(skill => skill.mode === "available" && !selectedSkills.some(selected => selected.id === skill.id)).length : undefined}
          modelContextWindow={composer.currentModel?.contextWindow ?? undefined}
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

  return (
    <>
      <CompactKnowledgePollingV2
        active={compactKnowledgePolling}
        onRefresh={knowledgeView?.list.onRefresh}
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
        subview={activeTab === "assistants" && assistantView?.task === "editor" && assistantView.editor
          ? {
              backLabel: "Assistants",
              busy: assistantView.busy || assistantView.editor.saving,
              key: `assistant-editor-${assistantView.editor.mode}`,
              label: assistantView.editor.draft.name.trim() || "New assistant",
              onBack: requestAssistantSubviewClose
            }
          : activeTab === "knowledge" && knowledgeView && isKnowledgeSubview(knowledgeView) ? {
              ...knowledgeSubviewChrome(knowledgeView),
              busy: knowledgeView.busy,
              onBack: () => knowledgeExit.requestExit()
            }
          : activeTab === "artifacts" && artifactSubview ? {
              backLabel: "Back to artifacts", key: `artifact-${artifactSubview.id}`, label: artifactSubview.title,
              onBack: () => { setArtifactSubview(null); artifactDetailRef.current = null; void refreshArtifactLibrary(artifactFilter === "archived", true); }
            } : null}
        tabs={tabs}
        onBack={() => { if (!settings.studio) closeLibrary(); }}
        onTabChange={(tab) => {
          if (settings.studio) return;
          setActiveTab(tab);
          if (tab === "assistants") settings.openLibrary();
          if (tab === "knowledge") settings.openKnowledge();
          if (tab === "memory") settings.openMemory();
        }}
      />
      {knowledgeExit.confirmation}
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
      <span className="v2-sr-only">Account {session.accountId}</span>
    </>
  );
}

export function dispatchAssistantUnavailableActionV2(input: Readonly<{
  action: "mcp-settings" | "open-editor";
  assistantId: string;
  onOpenEditor(assistantId: string): void;
  onOpenMcpSettings(): void;
}>): void {
  if (input.action === "open-editor") {
    input.onOpenEditor(input.assistantId);
    return;
  }
  input.onOpenMcpSettings();
}

type KnowledgeReadinessStateV2 =
  | "archived"
  | "empty"
  | "needs_attention"
  | "processing"
  | "ready"
  | "trashed";

export function knowledgeSummaryStatusV2(base: Readonly<{
  archived: boolean;
  readiness?: Readonly<{ state?: unknown }>;
}>): KnowledgeSummaryV2["status"] {
  const state = base.readiness?.state;
  if (typeof state === "string" && [
    "archived",
    "empty",
    "needs_attention",
    "processing",
    "ready",
    "trashed"
  ].includes(state)) return state as KnowledgeReadinessStateV2;
  return base.archived ? "archived" : "unavailable";
}

export function compactKnowledgeRefreshPendingV2(input: Readonly<{
  activeTab: LibraryTabIdV2;
  busy: boolean;
  catalog: "bases" | "sources" | null;
  processing: boolean;
  task: "create" | "detail" | "list" | "source-detail" | null;
}>): boolean {
  return input.activeTab === "knowledge" &&
    input.catalog === "bases" &&
    input.task === "list" &&
    !input.busy &&
    input.processing;
}

export function CompactKnowledgePollingV2({
  active,
  onRefresh
}: Readonly<{
  active: boolean;
  onRefresh?(): Promise<void>;
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

    const schedule = (delay = 2_000) => {
      if (cancelled || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    };
    const run = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      const refresh = refreshRef.current;
      if (!refresh) {
        schedule();
        return;
      }
      running = true;
      try {
        await refresh();
      } catch {
        // The Knowledge owner publishes its own user-safe error state. Polling
        // remains sequential and retries while processing is still visible.
      } finally {
        running = false;
        schedule();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || running) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      schedule(0);
    };

    schedule();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active]);

  return null;
}

export function formatLibraryDate(value: string): string {
  return formatStudioDate(value);
}

export function memoryManagerErrorCopy(code: string | null): string | null {
  if (!code) return null;
  if (code === "memory_secret_rejected") return memoryUiCopy("manager.secretRejected");
  if (code === "memory_changed") return memoryUiCopy("manager.draftStale");
  if (code === "memory_unavailable") return memoryUiCopy("manager.unavailable");
  return memoryUiCopy("manager.mutationError");
}

export { LibrarySurfaceV2 };
