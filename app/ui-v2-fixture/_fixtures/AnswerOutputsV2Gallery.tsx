"use client";

import type {
  ChatNavigationSummaryWire,
  ThreadArtifactSummary,
  ThreadToolActivity
} from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import {
  ConversationTurnV2,
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { useState } from "react";
import {
  AnswerOutputsV2,
  ToolApprovalCardV2,
  type ToolApprovalStatusV2
} from "@/features/answer-outputs-v2/AnswerOutputsV2";
import { MemoryActionConfirmationV2 } from "@/features/answer-outputs-v2/MemoryActionConfirmationV2";
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
  | "memory"
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

const memoryMessages: ConversationMessageV2[] = [
  {
    content: "Где я живу и как зовут мою собаку? Запомни, что я предпочитаю единицы СИ.",
    id: "answer-outputs-question",
    role: "user"
  },
  {
    content: "Вы живёте в Лиссабоне, а собаку зовут Бруно. Единицы СИ теперь в памяти.",
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
  sources: [],
  workDurationMs: 12_400
};

const visualArtifact: ThreadArtifactSummary = {
  citations: [],
  knowledgeCitations: [{ handle: "K1.1" }],
  reasoningText: [],
  sources: []
};

/* The full settled anatomy: Thinking → Steps → Memory in the fold, a
   "Memory saved." notice above the text, and no Sources chip. */
const memoryArtifact: ThreadArtifactSummary = {
  citations: [],
  memoryAction: {
    memoryRef: "mr1.gallery-save-reference",
    operation: "SAVE",
    statement: "I prefer SI units in answers.",
    status: "COMMITTED"
  },
  memorySources: [
    {
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
      date: "2026-09-02T09:00:00.000Z",
      memoryRef: "mr1.gallery-source-1",
      sourceAvailable: true,
      sourceType: "SAVED_MEMORY",
      text: "My dog is called Bruno and he is a beagle."
    },
    {
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
      date: "2026-08-28T09:00:00.000Z",
      memoryRef: "mr1.gallery-source-2",
      sourceAvailable: true,
      sourceType: "LEARNED_MEMORY",
      text: "I live in Lisbon."
    }
  ],
  reasoningText: ["Two facts are already in memory; the unit preference is new and worth saving."],
  sources: [],
  workDurationMs: 8_300
};

const memoryToolActivity: ThreadToolActivity = {
  calls: [
    { durationMs: 640, round: 1, status: "complete", toolName: "search_knowledge" },
    { durationMs: 1_400, round: 2, serverName: "Memory", status: "complete", toolName: "save_memory" }
  ]
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

function artifactFor(state: AnswerOutputsGalleryState): ThreadArtifactSummary | null {
  switch (state) {
    case "approval":
    case "empty":
      return null;
    case "reasoning":
      return reasoningArtifact;
    case "citation-visual":
      return visualArtifact;
    case "memory":
      return memoryArtifact;
    default:
      return completeArtifact;
  }
}

export function AnswerOutputsV2Gallery({
  state = "complete"
}: {
  state?: AnswerOutputsGalleryState;
}) {
  const surface = citationSurface(state);
  const artifact = artifactFor(state);
  const knowledgeReference = surface
    ? { messageId: "answer-outputs-answer", runId: "answer-outputs-run" }
    : undefined;
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
              messages={state === "citation-visual"
                ? visualMessages
                : state === "memory"
                  ? memoryMessages
                  : messages}
              renderMessage={(message) => message.role === "user" ? (
                <ConversationTurnV2
                  actions={{
                    onCopy: () => undefined,
                    onEdit: () => undefined,
                    onMore: () => undefined
                  }}
                  anchorId={message.id}
                  content={message.content}
                  role="user"
                />
              ) : (
                <RunAnswerV2
                  actions={{
                    onCopy: () => undefined,
                    onMore: () => undefined,
                    onRegenerate: () => undefined
                  }}
                  actionsSlot={(
                    <>
                      {state === "approval" ? <ApprovalOutput /> : null}
                      <AnswerOutputsV2 artifact={artifact} />
                    </>
                  )}
                  anchorId={message.id}
                  artifact={artifact}
                  content={message.content}
                  knowledgeReference={knowledgeReference}
                  leadingSlot={surface === "assistant" ? (
                    <div className="v2-answer-lead">
                      <span className="v2-answer-identity">Research assistant</span>
                    </div>
                  ) : null}
                  noticeSlot={artifact?.memoryAction ? (
                    <MemoryActionConfirmationV2
                      action={artifact.memoryAction}
                      onOpenMemorySettings={() => undefined}
                    />
                  ) : null}
                  presentation={{ kind: "complete", runId: "answer-outputs-run" }}
                  renderCitation={surface
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
                    : undefined}
                  toolActivity={state === "memory" ? memoryToolActivity : null}
                  workDurationMs={artifact?.workDurationMs ?? null}
                />
              )}
            />
          </main>
        </ReadingRoomShellV2>
      </div>
    </KnowledgeCitationViewerProvider>
  );
}
