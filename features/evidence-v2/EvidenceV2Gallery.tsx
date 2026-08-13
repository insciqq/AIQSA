"use client";

import type {
  ChatNavigationSummaryWire,
  ThreadArtifactSummary,
  ThreadRunEvidenceSummary,
  ThreadToolActivity
} from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import {
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import { useCallback, useState } from "react";
import {
  CitationMarkerV2,
  EvidenceRowV2,
  EvidenceStackV2,
  KnowledgeEvidenceV2,
  SearchEvidenceV2,
  ToolApprovalCardV2,
  ToolEvidenceV2,
  type ToolApprovalStatusV2
} from "./EvidenceV2";

export type EvidenceGalleryState = "approval" | "complete" | "empty" | "partial";

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  folderId: null,
  id: "evidence-fixture",
  title: "Evidence review",
  updatedAt: "2026-08-13T08:00:00.000Z"
}];

const messages: ConversationMessageV2[] = [
  {
    content: "Сверь вывод с источниками и покажи только проверяемые доказательства.",
    id: "evidence-question",
    role: "user"
  },
  {
    content: "## Проверяемый вывод\n\nМультиязычный поиск устойчивее, когда lexical и vector lanes остаются независимыми до финального отбора. Нулевой результат отдельного источника не превращается в успешный поиск.",
    id: "evidence-answer",
    role: "assistant"
  }
];

const completeToolCall: ThreadToolActivity = {
  argumentsPreview: { document: "[redacted-name]", section: "retrieval" },
  callId: "private-call-id-must-not-render",
  capability: "mcp",
  credentialSources: ["personal"],
  durationMs: 184,
  errorMessage: null,
  externalAccountLabel: null,
  ordinal: 0,
  resultPreview: { content: [{ text: "Untrusted result preview", type: "text" }] },
  round: 1,
  serverName: "Research vault",
  status: "complete",
  toolName: "lookup_document"
};

const completeArtifacts: ThreadArtifactSummary = {
  citationCount: 2,
  citations: [
    {
      index: 1,
      source: "Research notes",
      title: "Cross-language retrieval evaluation",
      url: "https://example.com/retrieval"
    },
    {
      index: 2,
      source: "Architecture handbook",
      title: "Independent retrieval lanes",
      url: "https://example.com/architecture"
    }
  ],
  knowledgeCitations: [{
    baseName: "Engineering handbook",
    documentVersionNumber: 4,
    fileName: "retrieval-policy.pdf",
    handle: "K1.1",
    knowledgeBaseId: "knowledge-base-private-id",
    page: 18
  }],
  knowledgeInvocationCount: 1,
  knowledgeOutcomes: [{ invocationOrdinal: 1, outcome: "complete" }],
  reasoningCount: 0,
  reasoningText: [],
  searchActivity: [{
    displayName: "Research Search",
    providerOperations: null,
    providerOperationsTruncated: false,
    query: "multilingual retrieval independent lanes",
    sourceCount: 3,
    sources: [
      {
        rank: 1,
        snippet: "Evaluation across three query languages.",
        title: "Cross-language retrieval evaluation",
        url: "https://example.com/retrieval"
      },
      {
        rank: 2,
        snippet: "Architecture notes for independent retrieval lanes.",
        title: "Independent retrieval lanes",
        url: "https://example.com/architecture"
      }
    ],
    status: "complete"
  }],
  searchCount: 1,
  searchDisplayName: "Research Search",
  searchStrategy: "search-research",
  toolCallCount: 1,
  toolCalls: [completeToolCall]
};

const emptyArtifacts: ThreadArtifactSummary = {
  citationCount: 0,
  citations: [],
  reasoningCount: 0,
  reasoningText: [],
  searchActivity: [{
    displayName: "Research Search",
    providerOperations: [],
    providerOperationsTruncated: false,
    query: "unpublished benchmark 2028",
    sourceCount: 0,
    sources: [],
    status: "complete"
  }],
  searchCount: 1,
  searchDisplayName: "Research Search",
  searchStrategy: "search-research",
  toolCallCount: 0,
  toolCalls: []
};

const partialArtifacts: ThreadArtifactSummary = {
  citationCount: 1,
  citations: [{
    index: 1,
    title: "Unsafe source stays inert",
    url: "javascript:alert('never')"
  }],
  reasoningCount: 0,
  reasoningText: [],
  searchActivity: [
    {
      displayName: "Primary Search",
      providerOperations: [],
      providerOperationsTruncated: false,
      query: "multilingual retrieval",
      sourceCount: 1,
      sources: [{
        rank: 1,
        title: "Safe partial result",
        url: "https://example.com/partial"
      }],
      status: "complete"
    },
    {
      displayName: "Archive Search",
      failureReason: "The archive endpoint timed out before returning a source.",
      providerOperations: null,
      providerOperationsTruncated: false,
      query: "multilingual retrieval archive",
      sourceCount: 0,
      sources: [],
      status: "error"
    }
  ],
  searchCount: 2,
  searchDisplayName: "Primary Search + Archive Search",
  searchStrategy: "search-combined",
  toolCallCount: 1,
  toolCalls: [{
    ...completeToolCall,
    errorMessage: "The tool returned a bounded failure.",
    resultPreview: { error: "Unavailable" },
    status: "error"
  }]
};

const summaries: Record<Exclude<EvidenceGalleryState, "approval">, ThreadRunEvidenceSummary> = {
  complete: { fileCount: 2, hasUsage: true, sourceCount: 3, toolCallCount: 1 },
  empty: { fileCount: 0, hasUsage: true, sourceCount: 0, toolCallCount: 0 },
  partial: { fileCount: 0, hasUsage: true, sourceCount: 1, toolCallCount: 1 }
};

function EvidenceAnswer({ state }: { state: Exclude<EvidenceGalleryState, "approval"> }) {
  const artifactSummary = state === "complete"
    ? completeArtifacts
    : state === "empty"
      ? emptyArtifacts
      : partialArtifacts;
  const [searchOpen, setSearchOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [focusCitationIndex, setFocusCitationIndex] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const settleCitation = useCallback(() => setFocusCitationIndex(null), []);

  function openCitation(index: number) {
    setSearchOpen(true);
    setFocusCitationIndex(index);
  }

  return (
    <>
      {artifactSummary.citations.length > 0 ? (
        <p className="v2-evidence-cited-line">
          Источники подтверждают разделение retrieval lanes
          <CitationMarkerV2 index={1} onActivate={openCitation} />
          {artifactSummary.citations.length > 1 ? (
            <>и независимость финального отбора<CitationMarkerV2 index={2} onActivate={openCitation} />.</>
          ) : <>.</>}
        </p>
      ) : null}
      <EvidenceRowV2
        onOpenFiles={() => setLiveStatus("Files are available in Run details.")}
        onOpenRunDetails={() => setLiveStatus("Run details requested for this exact answer.")}
        onOpenSources={() => setSearchOpen(true)}
        onOpenTools={() => setToolOpen(true)}
        summary={summaries[state]}
      />
      <p aria-live="polite" className="v2-evidence-live-status">{liveStatus}</p>
      <EvidenceStackV2>
        <SearchEvidenceV2
          focusCitationIndex={focusCitationIndex}
          onFocusCitationSettled={settleCitation}
          onOpenChange={setSearchOpen}
          open={searchOpen}
          summary={artifactSummary}
        />
        <KnowledgeEvidenceV2 summary={artifactSummary} />
        <ToolEvidenceV2
          onOpenChange={setToolOpen}
          open={toolOpen}
          toolCalls={artifactSummary.toolCalls}
        />
      </EvidenceStackV2>
    </>
  );
}

function ApprovalAnswer() {
  const [status, setStatus] = useState<ToolApprovalStatusV2>("pending");
  return (
    <ToolApprovalCardV2
      onAllow={() => setStatus("allowed")}
      onReject={() => setStatus("rejected")}
      redactedArgumentsPreview={{ path: "[private path redacted]", query: "retrieval policy" }}
      serverName="Research vault"
      status={status}
      toolName="lookup_document"
    />
  );
}

export function EvidenceV2Gallery({ state = "complete" }: { state?: EvidenceGalleryState }) {
  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="evidence-fixture"
      chats={navigationChats}
      error={null}
      folders={[]}
      hasMore={false}
      loading={false}
      now={new Date("2026-08-13T12:00:00.000Z")}
      onClose={onClose}
      onLoadMore={() => undefined}
      onNewChat={() => undefined}
      onRetry={() => undefined}
      onSearch={() => undefined}
      onSelectChat={() => undefined}
      ready
      searchError={null}
      searchLoading={false}
      searchQuery=""
    />
  );

  return (
    <div data-testid="ui-v2-evidence-gallery" data-state={state}>
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main className="v2-conversation-gallery-main">
          <ConversationV2
            getMessageActions={(message) => message.role === "assistant" ? {
              onCopy: () => undefined,
              onMore: () => undefined,
              onRegenerate: () => undefined
            } : {
              onCopy: () => undefined,
              onEdit: () => undefined,
              onMore: () => undefined
            }}
            getMessagePresentation={(message) => message.role === "assistant" ? {
              afterContent: state === "approval"
                ? <ApprovalAnswer />
                : <EvidenceAnswer state={state} />
            } : undefined}
            messages={messages}
          />
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
