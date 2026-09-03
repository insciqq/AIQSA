"use client";

import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";

export type ConversationGalleryState =
  | "basic"
  | "containment"
  | "earlier"
  | "empty"
  | "error"
  | "jump"
  | "loading"
  | "unavailable";

const navigationChats: ChatNavigationSummaryWire[] = [
  {
    activeRun: false,
    folderId: null,
    id: "conversation-fixture",
    title: "Research synthesis",
    updatedAt: "2026-08-13T08:00:00.000Z"
  },
  {
    activeRun: false,
    folderId: null,
    id: "conversation-second",
    title: "Quarterly product brief",
    updatedAt: "2026-08-12T08:00:00.000Z"
  }
];

const baseMessages: ConversationMessageV2[] = [
  {
    content: "Собери короткий план исследования по мультиязычному поиску.",
    id: "question-current",
    role: "user"
  },
  {
    content: [
      "## План исследования",
      "",
      "Начните с **трёх проверяемых гипотез**: качество межъязычного поиска, устойчивость при коротких запросах и влияние свежести данных.",
      "",
      "1. Зафиксируйте небольшой эталонный набор на разных языках.",
      "2. Сравните lexical, vector и blended lanes по отдельности.",
      "3. Проверьте итоговый ответ без раскрытия внутренней телеметрии.",
      "",
      "> Итог должен читаться как документ, а доказательства оставаться доступными по запросу."
    ].join("\n"),
    id: "answer-current",
    role: "assistant"
  },
  {
    content: "Добавь критерий остановки и простой пример.",
    id: "question-follow-up",
    role: "user"
  },
  {
    content: "Остановитесь, когда новая выборка перестаёт менять top-5 результатов и итоговую оценку. Например, повторите один и тот же факт на русском и английском, затем задайте вопрос на третьем языке.",
    id: "answer-follow-up",
    role: "assistant"
  }
];

const earlierMessages: ConversationMessageV2[] = [
  {
    content: "Сначала определим, что именно хотим измерить.",
    id: "question-earlier",
    role: "user"
  },
  {
    content: "Зафиксируем качество найденных фактов, полезность ответа и отсутствие утечки скрытых данных как три независимых результата.",
    id: "answer-earlier",
    role: "assistant"
  }
];

const earlierCurrentMessages: ConversationMessageV2[] = Array.from(
  { length: 10 },
  (_, index): ConversationMessageV2 => ({
    content: index % 2 === 0
      ? `Уточнение ${index / 2 + 1}: сравним результаты на ещё одной контрольной выборке.`
      : "Зафиксируйте наблюдение отдельным абзацем. Так длинный разговор остаётся читаемым, а загрузка истории не сдвигает текущую точку чтения.\n\nСледующий шаг проверяет тот же критерий на другом языке.",
    id: `earlier-current-${index}`,
    role: index % 2 === 0 ? "user" : "assistant"
  })
);

const jumpMessages: ConversationMessageV2[] = [
  ...earlierCurrentMessages,
  {
    content: "Сформулируй подробный критерий остановки для мультиязычной проверки так, чтобы вопрос занял всю разрешённую ширину сообщения и остался читаемым.",
    id: "question-jump-latest",
    role: "user"
  }
];

const containmentMessages: ConversationMessageV2[] = [
  {
    content: "Покажи сложный технический фрагмент без расширения страницы.",
    id: "question-containment",
    role: "user"
  },
  {
    content: [
      "## Containment audit",
      "",
      `Длинный токен: ${"AIQSA_UNBROKEN_VALUE_".repeat(16)}`,
      "",
      "| Lane | Stable identifier | Result |",
      "| --- | --- | --- |",
      `| vector | ${"VECTOR_SPACE_IDENTIFIER_".repeat(8)} | contained |`,
      "| lexical | unicode-normalized | contained |",
      "",
      "\\[",
      "\\operatorname{score}(q, d) = \\alpha \\cos(q,d) + (1-\\alpha)\\operatorname{lex}(q,d)",
      "\\]",
      "",
      "```typescript",
      "const immutableReceipt = {",
      `  source: "${"very-long-source-segment-".repeat(10)}",`,
      "  included: true",
      "};",
      "```",
      "",
      "Безопасная ссылка: [research](https://example.com/research). Опасная остаётся текстом: [bad](javascript:alert(1)).",
      "",
      "<script>window.__unsafe = true</script>"
    ].join("\n"),
    id: "answer-containment",
    role: "assistant"
  }
];

export function ConversationV2Gallery({ state = "basic" }: { state?: ConversationGalleryState }) {
  const [messages, setMessages] = useState<ConversationMessageV2[]>(
    state === "containment"
      ? containmentMessages
      : state === "jump"
        ? jumpMessages
        : state === "earlier"
          ? earlierCurrentMessages
          : state === "empty" || state === "loading" || state === "error" || state === "unavailable"
            ? []
            : baseMessages
  );
  const [hasOlder, setHasOlder] = useState(state === "earlier");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Like an opened chat, the "earlier" thread mounts at its latest message;
  // the top sentinel then loads the previous page only on a real scroll up.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (state === "earlier" && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [state]);

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="conversation-fixture"
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
    <div data-testid="ui-v2-conversation-gallery">
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main className="v2-conversation-gallery-main">
          <ConversationV2
            composerSlot={(
              <div className="v2-conversation-empty-composer-fixture" aria-label="Composer preview">
                <span>Message AIQSA</span>
                <span aria-hidden="true">↑</span>
              </div>
            )}
            error={state === "error" ? "fixture_error" : null}
            getMessageActions={(message) => message.role === "user" ? {
              onCopy: () => undefined,
              onEdit: () => undefined,
              onMore: () => undefined
            } : {
              onCopy: () => undefined,
              onMore: () => undefined,
              onRegenerate: () => undefined
            }}
            getMessagePresentation={(message) => message.id === "question-current" ? {
              // Sent files stay visible as a quiet owner-only line under the
              // user-bubble text.
              afterContent: (
                <SentAttachmentsV2
                  blocks={[{
                    attachmentId: "gallery-attachment",
                    label: "sales_q3.csv",
                    type: "file"
                  }]}
                />
              )
            } : undefined}
            hasOlder={hasOlder}
            jumpToLatestBottomOffset={96}
            loading={state === "loading"}
            messages={messages}
            scrollRef={scrollRef}
            onLoadEarlier={() => {
              setMessages((current) => [...earlierMessages, ...current]);
              setHasOlder(false);
            }}
            onRetry={() => undefined}
            onJumpToLatest={() => undefined}
            showJumpToLatest={state === "jump"}
            unavailable={state === "unavailable"}
          />
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}
