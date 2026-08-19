"use client";

import {
  openMemoryDetail,
  useMemoryManagerStore
} from "@/components/app-shell/memoryManagerStore";
import {
  updateMemoryGate,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
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

function scopeLabel(scope: Readonly<{ projectId?: string; type: string }>): string {
  if (scope.type === "GLOBAL_USER") return "Personal";
  if (scope.type === "PROJECT") return "Project";
  return scope.type.toLocaleLowerCase().replaceAll("_", " ");
}
function LibrarySurfaceV2({
  composer,
  onOpenMemoryOwner,
  props
}: Readonly<{
  composer: ShellComposerView;
  onOpenMemoryOwner(): void;
  props: PowerAppShellV2Props;
}>) {
  const { session, settings } = props;
  const memoryData = useMemorySettingsStore((state) => state.data);
  const memories = useMemoryManagerStore((state) => state.memories);
  const memoryBusy = useMemorySettingsStore((state) => state.busy);
  const assistantView = settings.library;
  const knowledgeView = settings.knowledge;
  const openKnowledgeSourceViewer = useKnowledgeSourceViewer();
  const initialTab: LibraryTabIdV2 = settings.memory.open
    ? "memory"
    : knowledgeView
      ? "knowledge"
      : "assistants";

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
      status: base.archived ? "archived" : "ready"
    }));
  const files: FileSummaryV2[] = composer.attachments.map((attachment) => ({
    id: attachment.id,
    meta: typeof attachment.byteSize === "number" ? `${attachment.byteSize.toLocaleString()} bytes` : "Active chat upload",
    name: attachment.fileName,
    private: true,
    status: attachment.status === "failed"
      ? "failed"
      : attachment.status === "ready" || attachment.status === undefined
        ? "ready"
        : "processing"
  }));
  const memory: MemoryOverviewV2 = memoryData ? {
    administratorDisabled: !memoryData.capabilities.explicitMemory &&
      !memoryData.capabilities.historyRecall &&
      !memoryData.capabilities.automaticLearning,
    automaticLearning: memoryData.settings.learnAutomatically,
    explicitCrudAvailable: memoryData.capabilities.explicitMemory,
    facts: memories.filter((fact) => fact.factState === "ACTIVE" && fact.displayText).slice(0, 8).map((fact) => ({
      id: fact.id,
      pinned: fact.pinned,
      scope: scopeLabel(fact.scope),
      statement: fact.displayText ?? ""
    })),
    healthDetail: memoryData.egress.reviewRequired
      ? "Utility egress needs review before automatic work can continue."
      : `${memoryData.historyIndexing.completedChats} of ${memoryData.historyIndexing.totalChats} retained chats indexed.`,
    healthLabel: memoryData.egress.reviewRequired ? "Review required" : "Memory ready",
    referenceChatHistory: memoryData.settings.referenceChatHistory,
    useMemoryFacts: memoryData.settings.useMemoryFacts
  } : {
    administratorDisabled: false,
    automaticLearning: false,
    explicitCrudAvailable: false,
    facts: [],
    healthDetail: "Loading exact Memory status…",
    healthLabel: "Memory",
    referenceChatHistory: false,
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
          onBrowseSources={() => knowledgeView?.list.onCatalogChange("sources")}
          onCreate={() => knowledgeView?.list.onNewBase()}
          onOpen={(id) => knowledgeView?.list.onOpenBase(id)}
        />
      ),
      id: "knowledge",
      label: "Knowledge"
    },
    {
      content: <FilesPanelV2 files={files} />,
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
          onForget={(id) => {
            void openMemoryDetail(id).catch(() => undefined);
            onOpenMemoryOwner();
          }}
          onManage={onOpenMemoryOwner}
          onOpenHistory={onOpenMemoryOwner}
          onOpenOperations={onOpenMemoryOwner}
        />
      ),
      id: "memory",
      label: "Memory"
    }
  ];

  return (
    <>
      <LibraryV2
        key={initialTab}
        initialTab={initialTab}
        tabs={tabs}
        onBack={() => {
          assistantView?.onBackToChat();
          knowledgeView?.onBackToChat();
          settings.closeMemory();
        }}
        onTabChange={(tab) => {
          if (tab === "assistants") settings.openLibrary();
          if (tab === "knowledge") settings.openKnowledge();
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

export const WELCOME_STARTER_PROMPTS = [
  "Explain a complex topic in simple terms",
  "Turn my notes into a work plan",
  "Compare options and recommend one"
] as const;

/**
 * Blank-welcome starter prompts render exactly while the canvas is a quiet
 * greeting: no selected Assistant (that intro owns its own starters), nothing
 * typed, no attachments in flight.
 */
export function blankWelcomeStartersVisibleV2({
  assistantSelected,
  attachmentCount,
  draft,
  uploading
}: Readonly<{
  assistantSelected: boolean;
  attachmentCount: number;
  draft: string;
  uploading: boolean;
}>): boolean {
  return !assistantSelected && !draft.trim() && attachmentCount === 0 && !uploading;
}

/**
 * S1 §5.2 welcome: a quiet greeting plus up to four unobtrusive prompts —
 * no canvas wordmark, no marketing subtitle. Prompt clicks prefill the draft;
 * the optional last entry opens the Assistant picker.
 */
export function WelcomeOrientationV2({
  onOpenAssistantPicker,
  onPickPrompt,
  showAssistantEntry
}: Readonly<{
  onOpenAssistantPicker(): void;
  onPickPrompt(prompt: string): void;
  showAssistantEntry: boolean;
}>) {
  return (
    <div className="v2-live-welcome" data-testid="welcome-orientation">
      <div className="v2-conversation-orientation-copy">
        <h1>What are we working on?</h1>
      </div>
      <div
        aria-label="Starter prompts"
        className="v2-live-assistant-starters"
        data-testid="welcome-starter-prompts"
      >
        {WELCOME_STARTER_PROMPTS.map((prompt) => (
          <button
            className="v2-focusable"
            key={prompt}
            type="button"
            onClick={() => onPickPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
        {showAssistantEntry ? (
          <button className="v2-focusable" type="button" onClick={onOpenAssistantPicker}>
            Start with an Assistant…
          </button>
        ) : null}
      </div>
    </div>
  );
}

export { LibrarySurfaceV2 };
