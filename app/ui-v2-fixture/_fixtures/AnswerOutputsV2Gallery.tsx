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
import { AnswerOutputsV2 } from "@/features/answer-outputs-v2/AnswerOutputsV2";
import { McpApprovalCardsV2, McpApprovalContinuationTurnV2 } from "@/features/answer-outputs-v2/McpApprovalCardV2";
import { MemoryActionConfirmationV2 } from "@/features/answer-outputs-v2/MemoryActionConfirmationV2";
import {
  KnowledgeCitationControl,
  KnowledgeCitationViewerProvider
} from "@/features/citations-v2/KnowledgeCitationViewer";
import { mcpApprovalContinuationText, type McpApprovalCard } from "@/lib/contracts/mcpApprovals";

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
  assistant: null,
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

/* MCP write approval: a refused call per source and every decided state.
   Decisions resolve locally; the request preview is the initiator's only. */
const approvalCards: McpApprovalCard[] = [
  { approvalId: "approval-model", canDecide: true, details: { ordinal: 0, roundIndex: 1 }, serverName: "Records vault",
    source: "model", state: "pending", toolName: "delete_record" },
  { approvalId: "approval-code", canDecide: true, serverName: "Records vault", source: "code", state: "pending",
    toolName: "archive_records_with_a_rather_long_tool_name" },
  { approvalId: "approval-member", serverName: "Shared tracker", source: "model", state: "pending", toolName: "close_issue" },
  { approvalId: "approval-once", serverName: "Records vault", source: "model", state: "allowed_once", toolName: "update_record" },
  // An Allow whose continuation started no run: the latest answer offers Continue.
  { approvalId: "approval-server", canContinue: true, serverName: "Calendar", source: "agent", state: "allowed_server",
    toolName: "create_event" },
  { approvalId: "approval-denied", serverName: "Records vault", source: "model", state: "denied", toolName: "purge_records" }
];

const approvalMessages: ConversationMessageV2[] = [
  { content: "Delete record r-17 and archive the old ones.", id: "answer-outputs-question", role: "user" },
  { content: "I wanted to delete record r-17 and archive the old records. Both need your approval in the cards below.",
    id: "answer-outputs-answer", role: "assistant" },
  { content: mcpApprovalContinuationText({ serverName: "Records vault", toolName: "update_record" }),
    id: "answer-outputs-continuation", role: "user" },
  { content: "Record r-12 is updated.", id: "answer-outputs-continued", role: "assistant" }
];

function ApprovalOutput() {
  return (
    <McpApprovalCardsV2
      cards={approvalCards}
      decide={async ({ approvalId, decision }) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const card = approvalCards.find((candidate) => candidate.approvalId === approvalId)!;
        return { approvalId, serverName: card.serverName, source: card.source, toolName: card.toolName,
          state: decision === "allow_once" ? "allowed_once" : decision === "allow_server" ? "allowed_server" : "denied" };
      }}
      offerContinue
      onContinue={async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return "not_started" as const;
      }}
      runId="answer-outputs-run"
    />
  );
}

const memoryToolActivity: ThreadToolActivity = {
  calls: [
    { durationMs: 640, round: 1, status: "complete", toolName: "search_knowledge" },
    { durationMs: 1_400, round: 2, serverName: "Memory", status: "complete", toolName: "save_memory" }
  ]
};

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
  const [openedLibrarySource, setOpenedLibrarySource] = useState<string | null>(null);
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
    <KnowledgeCitationViewerProvider onOpenLibrarySource={setOpenedLibrarySource}>
      <div
        data-citation-surface={surface ?? undefined}
        data-library-source={openedLibrarySource ?? undefined}
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
                  : state === "approval" ? approvalMessages : messages}
              renderMessage={(message) => message.id === "answer-outputs-continuation" ? (
                <McpApprovalContinuationTurnV2 anchorId={message.id} content={message.content} />
              ) : message.role === "user" ? (
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
                      {state === "approval" && message.id === "answer-outputs-answer" ? <ApprovalOutput /> : null}
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
