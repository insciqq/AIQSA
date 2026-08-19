"use client";

import type {
  ChatNavigationSummaryWire,
  ThreadArtifactSummary
} from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import {
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import { useState } from "react";
import {
  AnswerOutputsV2,
  ToolApprovalCardV2,
  type ToolApprovalStatusV2
} from "@/features/answer-outputs-v2/AnswerOutputsV2";
import {
  KnowledgeCitationControl,
  KnowledgeCitationViewerProvider
} from "@/features/citations-v2/KnowledgeCitationViewer";

export type AnswerOutputsGalleryState =
  | "approval"
  | "citation-assistant"
  | "citation-personal"
  | "citation-project"
  | "citation-visual"
  | "complete"
  | "empty"
  | "reasoning";

function citationSurface(state: AnswerOutputsGalleryState) {
  if (state === "citation-personal") return "personal";
  if (state === "citation-project") return "project";
  if (state === "citation-assistant" || state === "citation-visual" || state === "complete") {
    return "assistant";
  }
  return null;
}

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  folderId: null,
  id: "answer-outputs-fixture",
  title: "Answer outputs",
  updatedAt: "2026-08-13T08:00:00.000Z"
}];

const messages: ConversationMessageV2[] = [
  {
    content: "Сверь вывод с источниками и покажи результат.",
    id: "answer-outputs-question",
    role: "user"
  },
  {
    content: "## Проверяемый вывод\n\nМультиязычный поиск устойчивее, когда lexical и vector lanes остаются независимыми до финального отбора [K1.1].",
    id: "answer-outputs-answer",
    role: "assistant"
  }
];

const visualMessages: ConversationMessageV2[] = [
  {
    content: "Что показывает график выручки по регионам?",
    id: "answer-outputs-question",
    role: "user"
  },
  {
    content: "Северный регион растёт, а южный остаётся на прежнем уровне [K1.1].",
    id: "answer-outputs-answer",
    role: "assistant"
  }
];

const completeArtifact: ThreadArtifactSummary = {
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
    handle: "K1.1"
  }],
  reasoningText: [],
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
  ]
};

const reasoningArtifact: ThreadArtifactSummary = {
  citations: [],
  reasoningText: ["**Сопоставление источников**\n\nПроверяю, что вывод следует из доступных материалов."],
  sources: []
};

const visualArtifact: ThreadArtifactSummary = {
  citations: [],
  knowledgeCitations: [{ handle: "K1.1" }],
  reasoningText: [],
  sources: []
};

function ApprovalOutput() {
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

function AnswerOutput({ state }: { state: AnswerOutputsGalleryState }) {
  if (state === "approval") return <ApprovalOutput />;
  if (state === "empty") return null;
  const artifact = state === "reasoning"
    ? reasoningArtifact
    : state === "citation-visual"
      ? visualArtifact
      : completeArtifact;
  const surface = citationSurface(state);
  return (
    <AnswerOutputsV2
      artifact={artifact}
      identitySlot={surface === "assistant" ? <span>Research assistant · revision 4</span> : null}
      knowledgeReference={surface
        ? { messageId: "answer-outputs-answer", runId: "answer-outputs-run" }
        : undefined}
      showReasoning
    />
  );
}

export function AnswerOutputsV2Gallery({
  state = "complete"
}: {
  state?: AnswerOutputsGalleryState;
}) {
  const surface = citationSurface(state);
  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="answer-outputs-fixture"
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
    <KnowledgeCitationViewerProvider>
      <div
        data-citation-surface={surface ?? undefined}
        data-testid="ui-v2-answer-outputs-gallery"
        data-state={state}
      >
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
                afterContent: <AnswerOutput state={state} />,
                renderCitation: surface
                  ? (handle, key) => handle === "K1.1" ? (
                      <KnowledgeCitationControl
                        key={key}
                        reference={{
                          handle,
                          messageId: "answer-outputs-answer",
                          runId: "answer-outputs-run"
                        }}
                      />
                    ) : null
                  : undefined
              } : undefined}
              messages={state === "citation-visual" ? visualMessages : messages}
            />
          </main>
        </ReadingRoomShellV2>
      </div>
    </KnowledgeCitationViewerProvider>
  );
}
