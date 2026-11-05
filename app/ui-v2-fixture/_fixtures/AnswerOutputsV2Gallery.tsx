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
import { AnswerOutputsV2 } from "@/features/answer-outputs-v2/AnswerOutputsV2";
import { researchAnswerViewV2 } from "@/features/answer-outputs-v2/researchAnswerView";
import { McpApprovalCardsV2, McpApprovalContinuationTurnV2 } from "@/features/answer-outputs-v2/McpApprovalCardV2";
import { MemoryActionConfirmationV2 } from "@/features/answer-outputs-v2/MemoryActionConfirmationV2";
import { mcpApprovalContinuationText, type McpApprovalCard } from "@/lib/contracts/mcpApprovals";

export type AnswerOutputsGalleryState =
  | "approval"
  | "complete"
  | "empty"
  | "memory"
  | "reasoning"
  | "research";

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
    content: "## Проверяемый вывод\n\nМультиязычный поиск устойчивее, когда lexical и vector lanes остаются независимыми до финального отбора [1].",
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
  { approvalId: "approval-server", canContinue: true, serverName: "Calendar", source: "model", state: "allowed_server",
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
    { durationMs: 640, round: 1, status: "complete", toolName: "web_search" },
    { durationMs: 1_400, round: 2, serverName: "Memory", status: "complete", toolName: "save_memory" }
  ]
};

/* Two synthetic research answers, laid out as the server writes them (`researchDraftText`, then `researchAnswerText`): the first wrote a page, so
   the chat shows its summary, its notes, the page's card and the report's file; the second wrote none and shows its whole text, as today. */
const researchSummary = "Лучший выбор для дома — **Contoso Rest 2** за 24 900 ₽: средняя жёсткость и независимые пружины подходят для пары с разным весом, " +
  "а гарантия 10 лет перекрывает разницу в цене с более дешёвым Fabrikam Base.\n\n" +
  "- Цена: Contoso Rest 2 дороже Fabrikam Base на 3 100 ₽; разница покупает независимый блок пружин и вдвое более долгую гарантию.\n" +
  "- Пара с разным весом: независимые пружины Contoso Rest 2 гасят движение соседа, у Fabrikam Base зависимый блок.";
const researchReport = "## Как выбирали\n\nСравнивали пять матрасов 160×200 по жёсткости, блоку пружин, гарантии и цене в трёх магазинах.\n\n" +
  "## Сравнение\n\n| Модель | Жёсткость | Блок | Гарантия | Цена |\n| --- | --- | --- | --- | --- |\n" +
  "| Contoso Rest 2 | средняя | независимый | 10 лет | 24 900 ₽ |\n| Fabrikam Base | средняя | зависимый | 5 лет | 21 800 ₽ |\n" +
  "| Northwind Cloud | мягкая | независимый | 7 лет | 27 400 ₽ |\n| Adatum Firm | жёсткая | без пружин | 3 года | 18 600 ₽ |\n" +
  "| Litware Duo | разная по сторонам | независимый | 8 лет | 29 900 ₽ |\n\n" +
  "## Что важно знать\n\nОтзывы о Northwind Cloud расходятся: два магазина пишут о продавливании через год, производитель этого не подтверждает.\n\n" +
  "## Источники\n\n1. Каталог Contoso, страница модели.\n2. Обзор трёх магазинов, октябрь 2026.";
const researchNotes = "*The sources establish only part of what this report says about these facts, so rely only on what they state: Northwind Cloud — warranty.*";
const researchDraft = `${researchSummary}\n\n${researchReport}`;
const researchWithPage = `${researchDraft}\n\n---\n\n${researchNotes}`;
const researchWithoutPage = researchDraft;

const researchMessages: ConversationMessageV2[] = [
  { content: "Проведи исследование: какой матрас 160×200 купить для пары?", id: "research-question", role: "user" },
  { content: researchWithPage, id: "research-answer", role: "assistant" },
  { content: "Проведи то же исследование ещё раз.", id: "research-question-2", role: "user" },
  { content: researchWithoutPage, id: "research-answer-2", role: "assistant" }
];

const researchArtifacts: Readonly<Record<string, ThreadArtifactSummary>> = {
  "research-answer": {
    citations: [],
    generatedArtifacts: [{ artifactId: "research-page", entrypoint: "index.html", kind: "html",
      researchPage: { notesStart: researchDraft.length, summaryEnd: researchSummary.length },
      title: "Матрас 160×200 для пары: сравнение пяти моделей", versionId: "research-page-v1", versionNumber: 1 }],
    reasoningText: [],
    sources: [],
    workDurationMs: 2_520_000
  },
  "research-answer-2": { citations: [], reasoningText: [], sources: [], workDurationMs: 1_980_000 }
};

function ResearchAnswerOutput({ message }: Readonly<{ message: ConversationMessageV2 }>) {
  const artifact = researchArtifacts[message.id] ?? null;
  const view = researchAnswerViewV2(message.content, artifact?.generatedArtifacts);
  return (
    <RunAnswerV2
      actions={{ onCopy: () => undefined, onMore: () => undefined, onReadAloud: () => undefined, onRegenerate: () => undefined }}
      actionsSlot={<AnswerOutputsV2 artifact={artifact} researchReport={view.download} />}
      anchorId={message.id}
      artifact={artifact}
      content={view.content}
      presentation={{ kind: "complete", runId: `${message.id}-run` }}
      workDurationMs={artifact?.workDurationMs ?? null}
    />
  );
}

function artifactFor(state: AnswerOutputsGalleryState): ThreadArtifactSummary | null {
  switch (state) {
    case "approval":
    case "empty":
    case "research":
      return null;
    case "reasoning":
      return reasoningArtifact;
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
  const artifact = artifactFor(state);
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
    <div
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
            messages={state === "memory"
              ? memoryMessages
              : state === "approval" ? approvalMessages : state === "research" ? researchMessages : messages}
            renderMessage={(message) => state === "research" && message.role === "assistant" ? (
              <ResearchAnswerOutput message={message} />
            ) : message.id === "answer-outputs-continuation" ? (
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
                leadingSlot={state === "complete" ? (
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
                toolActivity={state === "memory" ? memoryToolActivity : null}
                workDurationMs={artifact?.workDurationMs ?? null}
              />
            )}
          />
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
