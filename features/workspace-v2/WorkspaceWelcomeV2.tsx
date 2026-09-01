"use client";

import {
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import {
  refreshFileLibrary,
  useFileLibraryStore
} from "@/components/app-shell/fileLibraryStore";
import type {
  PowerAppShellV2Props,
  ShellComposerView
} from "@/components/app-shell/powerAppShellV2Contracts";
import { AssistantLibrary } from "@/components/assistants/AssistantLibrary";
import { KnowledgeLibrary } from "@/components/knowledge/KnowledgeLibrary";
import { useKnowledgeSourceViewer } from "@/features/citations-v2/KnowledgeCitationViewer";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  MemoryPanelV2
} from "@/features/library-v2/LibraryV2";
import type {
  AssistantSummaryV2,
  FileSummaryV2,
  KnowledgeSummaryV2,
  LibraryTabIdV2,
  LibraryTabV2,
  MemoryOverviewV2
} from "@/features/library-v2/contracts";
import { useEffect, useRef, useState } from "react";

function LibrarySurfaceV2({
  composer,
  onOpenMemoryOwner,
  onOpenSkillLibrary,
  props
}: Readonly<{
  composer: ShellComposerView;
  onOpenMemoryOwner(): void;
  onOpenSkillLibrary?(): void;
  props: PowerAppShellV2Props;
}>) {
  const { session, settings } = props;
  const memoryData = useMemorySettingsStore((state) => state.data);
  const memoryBusy = useMemorySettingsStore((state) => state.busy);
  const memoryLoadState = useMemorySettingsStore((state) => state.loadState);
  const fileData = useFileLibraryStore((state) => state.data);
  const fileLoadState = useFileLibraryStore((state) => state.loadState);
  const assistantView = settings.library;
  const knowledgeView = settings.knowledge;
  const openKnowledgeSourceViewer = useKnowledgeSourceViewer();
  const initialTab: LibraryTabIdV2 = settings.memory.open
    ? "memory"
    : knowledgeView
      ? "knowledge"
      : "assistants";
  const [activeTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);

  const assistants: AssistantSummaryV2[] = (assistantView?.list.assistants ?? composer.assistant.pickerItems)
    .map((assistant) => ({
      archived: assistant.archived,
      available: assistant.availability.ok,
      description: assistant.description,
      id: assistant.id,
      name: assistant.name,
      owned: assistant.owned,
      pinned: assistant.pinned,
      revision: assistant.revisionNumber,
      ...(!assistant.availability.ok
        ? { unavailableReason: assistant.availability.reason.replaceAll("_", " ") }
        : {})
    }));
  const knowledge: KnowledgeSummaryV2[] = (knowledgeView?.list.knowledgeBases ?? composer.knowledge.bases)
    .map((base) => ({
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
    id: file.id,
    meta: `${formatAttachmentBytes(file.byteSize)} · ${file.chatTitle} · ${formatLibraryDate(file.createdAt)}`,
    name: file.fileName,
    private: true,
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
  const mutateMemory = (key: "learnAutomatically" | "referenceChatHistory" | "useMemoryFacts", value: boolean) => {
    if (memoryBusy) return;
    void updateMemoryGate(key, value).catch(() => undefined);
  };
  const tabs: LibraryTabV2[] = [
    {
      content: (
        <AssistantsPanelV2
          assistants={assistants}
          onArchiveToggle={(id, archived) => assistantView?.list.onArchiveToggle(id, archived)}
          onCreate={() => assistantView?.list.onNewAssistant()}
          onDuplicate={(id) => assistantView?.list.onDuplicate(id)}
          onOpen={(id) => assistantView?.list.onEdit(id)}
          onOpenHistory={(id) => assistantView?.list.onOpenHistory(id)}
          onPinToggle={(id, pinned) => assistantView?.list.onPinToggle(id, pinned)}
          onUse={(id) => assistantView?.list.onUse(id)}
        />
      ),
      id: "assistants",
      label: "Assistants"
    },
    {
      content: (
        <KnowledgePanelV2
          bases={knowledge}
          error={knowledgeView?.dataError}
          loadState={knowledgeView?.dataState ?? "loading"}
          onBrowseSources={() => knowledgeView?.list.onCatalogChange("sources")}
          onCreate={() => knowledgeView?.list.onNewBase()}
          onOpen={(id) => knowledgeView?.list.onOpenBase(id)}
          onRetry={() => knowledgeView?.onRetry()}
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
            if (!file) return;
            void props.workspace.pane.actions.openChatMessage(file.chatId, file.messageId)
              .then((opened) => {
                if (!opened) return;
                assistantView?.onBackToChat();
                knowledgeView?.onBackToChat();
                settings.closeMemory();
              });
          }}
          onRetry={() => void refreshFileLibrary(true).catch(() => undefined)}
        />
      ),
      id: "files",
      label: "Files"
    },
    {
      content: (
        <MemoryPanelV2
          memory={memory}
          onChangeAutomaticLearning={(value) => mutateMemory("learnAutomatically", value)}
          onChangeReferenceHistory={(value) => mutateMemory("referenceChatHistory", value)}
          onChangeUseFacts={(value) => mutateMemory("useMemoryFacts", value)}
          onManage={onOpenMemoryOwner}
          onRetry={() => void refreshMemorySettings(true).catch(() => undefined)}
        />
      ),
      id: "memory",
      label: "Memory"
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
        onOpenSkillLibrary={onOpenSkillLibrary}
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
      {assistantView && assistantView.task !== "list" ? (
        <AssistantLibrary view={assistantView} />
      ) : null}
      {knowledgeView && (knowledgeView.task !== "list" || knowledgeView.list.catalog === "sources") ? (
        <KnowledgeLibrary
          onPreviewSource={openKnowledgeSourceViewer}
          view={knowledgeView}
        />
      ) : null}
      <span className="v2-sr-only">Account {session.accountId}</span>
    </>
  );
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

export { LibrarySurfaceV2 };
