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

export type AnswerOutputsGalleryState = "approval" | "complete" | "empty" | "reasoning";

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
    content: "## Проверяемый вывод\n\nМультиязычный поиск устойчивее, когда lexical и vector lanes остаются независимыми до финального отбора.",
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
    baseName: "Engineering handbook",
    fileName: "retrieval-policy.pdf",
    handle: "K1.1",
    page: 18
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
  const artifact = state === "reasoning" ? reasoningArtifact : completeArtifact;
  return (
    <AnswerOutputsV2
      artifact={artifact}
      identitySlot={state === "complete" ? <span>Research assistant · revision 4</span> : null}
      showReasoning
    />
  );
}

export function AnswerOutputsV2Gallery({
  state = "complete"
}: {
  state?: AnswerOutputsGalleryState;
}) {
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
    <div data-testid="ui-v2-answer-outputs-gallery" data-state={state}>
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
              afterContent: <AnswerOutput state={state} />
            } : undefined}
            messages={messages}
          />
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
