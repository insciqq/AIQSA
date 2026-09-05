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
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import {
  refreshFileLibrary,
  loadMoreFileLibrary,
  removeFileFromLibrary,
  saveFileToLibrary,
  useFileLibraryStore
} from "@/components/app-shell/fileLibraryStore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useSkillLibraryStore } from "@/components/app-shell/skillLibraryStore";
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
import { useEffect, useRef, useState } from "react";

function LibrarySurfaceV2({ composer, props }: Readonly<{
  composer: ShellComposerView;
  props: PowerAppShellV2Props;
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
  const assistantView = settings.library;
  const knowledgeView = settings.knowledge;
  const knowledgeExit = useKnowledgeLibraryExit(knowledgeView ?? null);
  const initialTab: LibraryTabIdV2 = settings.memory.open
    ? "memory"
    : knowledgeView
      ? "knowledge"
      : "assistants";
  const [activeTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);
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
    else if (assistantView.task === "history") assistantView.history?.onBack();
  };
  const requestAssistantSubviewClose = () => {
    if (assistantView?.task === "editor" && assistantView.editor?.dirty) {
      setAssistantExit(() => closeAssistantSubview);
      return;
    }
    closeAssistantSubview();
  };

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
        revision: assistant.revisionNumber,
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
    canOpenChat: Boolean(file.chatId && file.messageId),
    id: file.id,
    meta: `${formatAttachmentBytes(file.byteSize)} · ${file.savedAt ? "Saved" : file.chatTitle} · ${formatLibraryDate(file.savedAt ?? file.createdAt)}`,
    mutation: fileMutations[file.id],
    name: file.fileName,
    private: true,
    saved: Boolean(file.savedAt),
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
            onOpenHistory={(id) => assistantView?.list.onOpenHistory(id)}
            onPinToggle={(id, pinned) => assistantView?.list.onPinToggle(id, pinned)}
            onRetry={() => assistantView?.onRetryCatalog()}
            onUnavailableAction={(id, action) => dispatchAssistantUnavailableActionV2({
              action,
              assistantId: id,
              onCloseLibrary() {
                assistantView?.onBackToChat();
                knowledgeView?.onBackToChat();
                settings.closeMemory();
              },
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
          loadState={fileLoadState}
          onOpen={(id) => {
            const file = fileData?.files.find((candidate) => candidate.id === id);
            if (!file?.chatId || !file.messageId) return;
            void props.workspace.pane.actions.openChatMessage(file.chatId, file.messageId)
              .then((opened) => {
                if (!opened) return;
                assistantView?.onBackToChat();
                knowledgeView?.onBackToChat();
                settings.closeMemory();
              });
          }}
          onSave={(id) => void saveFileToLibrary(id)}
          onRemove={(id) => void removeFileFromLibrary(id)}
          onUse={composer.reuseFile ? (id) => {
            const file = fileData?.files.find((candidate) => candidate.id === id);
            if (!file) return;
            void composer.reuseFile?.(id, file.fileName).then((used) => {
              if (!used) return;
              assistantView?.onBackToChat();
              knowledgeView?.onBackToChat();
              settings.closeMemory();
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
          onOpenSettings={() => {
            if (memoryDraftDirty) setMemoryExit(() => settings.openMemorySettingsTab);
            else settings.openMemorySettingsTab();
          }}
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
                  promptCharacterCount: skill.instructionCharacterCount
                }] : [];
              }
              const selected = selectedById.get(id);
              return selected ? [selected] : [];
            }));
          }}
        />
      ),
      id: "skills",
      label: "Skill library"
    }
  ];

  return (
    <>
      <CompactKnowledgePollingV2
        active={compactKnowledgePolling}
        onRefresh={knowledgeView?.list.onRefresh}
      />
      <LibraryV2
        key={initialTab}
        initialTab={initialTab}
        navigationGuard={(intent, proceed) => {
          // A dirty Knowledge draft asks for an explicit discard before the
          // section changes or the Library closes; a clean sub-view simply
          // stays open behind the other tab.
          if (activeTab === "knowledge" && knowledgeExit.dirty) knowledgeExit.requestExit(proceed);
          else if (activeTab === "assistants" && assistantDirty) {
            setAssistantExit(() => () => {
              assistantView?.editor?.onCancel();
              proceed();
            });
          }
          else if (activeTab === "memory" && memoryDraftDirty) setMemoryExit(() => proceed);
          else proceed();
        }}
        subview={activeTab === "assistants" && assistantView?.task === "editor" && assistantView.editor
          ? {
              backLabel: "Assistants",
              busy: assistantView.busy || assistantView.editor.saving,
              key: `assistant-editor-${assistantView.editor.revisionNumber ?? "new"}`,
              label: assistantView.editor.draft.name.trim() || "New assistant",
              onBack: requestAssistantSubviewClose
            }
          : activeTab === "assistants" && assistantView?.task === "history" && assistantView.history
            ? {
                backLabel: "Assistant",
                busy: assistantView.busy || assistantView.history.restoring,
                key: `assistant-history-${assistantView.history.assistantName}`,
                label: `History · ${assistantView.history.assistantName}`,
                onBack: assistantView.history.onBack
              }
            : activeTab === "knowledge" && knowledgeView && isKnowledgeSubview(knowledgeView) ? {
              ...knowledgeSubviewChrome(knowledgeView),
              busy: knowledgeView.busy,
              onBack: () => knowledgeExit.requestExit()
            }
          : null}
        tabs={tabs}
        onBack={() => {
          assistantView?.onBackToChat();
          knowledgeView?.onBackToChat();
          settings.closeMemory();
        }}
        onTabChange={(tab) => {
          setActiveTab(tab);
          if (tab === "assistants") settings.openLibrary();
          if (tab === "knowledge") settings.openKnowledge();
          if (tab === "files") void refreshFileLibrary(true).catch(() => undefined);
          if (tab === "memory") settings.openMemory();
        }}
      />
      {knowledgeExit.confirmation}
      {assistantExit ? (
        <DiscardChangesConfirmationDialog
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
  onCloseLibrary(): void;
  onOpenEditor(assistantId: string): void;
  onOpenMcpSettings(): void;
}>): void {
  if (input.action === "open-editor") {
    input.onOpenEditor(input.assistantId);
    return;
  }
  input.onCloseLibrary();
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
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export function memoryManagerErrorCopy(code: string | null): string | null {
  if (!code) return null;
  if (code === "memory_secret_rejected") return memoryUiCopy("manager.secretRejected");
  if (code === "memory_changed") return memoryUiCopy("manager.draftStale");
  if (code === "memory_unavailable") return memoryUiCopy("manager.unavailable");
  return memoryUiCopy("manager.mutationError");
}

export { LibrarySurfaceV2 };
