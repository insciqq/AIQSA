"use client";

import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import type { RunEventView } from "@/lib/contracts/runs";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import { useState, type ReactNode } from "react";
import {
  RunAnswerV2,
  RunComposerActionV2,
  RunLifecycleAnnouncerV2
} from "./RunLifecycleV2";
import {
  presentRunLifecycleV2,
  type RunLifecycleEvidenceV2,
  type RunLifecycleStatusV2
} from "./runPresentation";

const chats: ChatNavigationSummaryWire[] = [
  {
    activeRun: true,
    folderId: null,
    id: "run-lifecycle",
    title: "Run lifecycle states",
    updatedAt: "2026-08-13T08:00:00.000Z"
  },
  {
    activeRun: false,
    folderId: null,
    id: "settled-run",
    title: "Settled answer",
    updatedAt: "2026-08-12T08:00:00.000Z"
  }
];

function runEvidence(overrides: Partial<RunLifecycleEvidenceV2>): RunLifecycleEvidenceV2 {
  return {
    content: "",
    events: [],
    runId: "run-gallery",
    ...overrides
  };
}

function summary(stage: string, status: string, extra: Record<string, unknown> = {}): RunEventView {
  return {
    data: {
      artifactType: "summary",
      payload: { ...extra, stage, status }
    },
    type: "artifact"
  };
}

const activityCases: Array<{
  evidence: RunLifecycleEvidenceV2;
  label: string;
}> = [
  {
    evidence: runEvidence({ status: "queued" as RunLifecycleStatusV2 }),
    label: "Queued"
  },
  {
    evidence: runEvidence({ status: "preparing" }),
    label: "Preparing"
  },
  {
    evidence: runEvidence({ events: [summary("search", "running")] }),
    label: "Search"
  },
  {
    evidence: runEvidence({
      events: [{
        data: {
          artifactType: "tool_call",
          payload: { name: "create_workbook", status: "requested" }
        },
        type: "artifact"
      }]
    }),
    label: "Tool round"
  },
  {
    evidence: runEvidence({ events: [summary("compute", "running")] }),
    label: "Compute"
  },
  {
    evidence: runEvidence({ events: [summary("preview", "running")] }),
    label: "Preview"
  },
  {
    evidence: runEvidence({ status: "in_progress" }),
    label: "Provider"
  }
];

function StateSpec({
  children,
  label
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section className="v2-run-gallery-spec" aria-label={label}>
      <p className="v2-run-gallery-label">{label}</p>
      {children}
    </section>
  );
}

export function RunLifecycleV2Gallery() {
  const [connectionLost, setConnectionLost] = useState(true);
  const [selectedChatId, setSelectedChatId] = useState("run-lifecycle");
  const connectionPresentation = presentRunLifecycleV2(runEvidence({
    authoritativeMessageStatus: connectionLost ? null : "complete",
    connectionLost,
    content: "Собрал книгу из трёх листов: **Данные**, **Сводная** и **Гра**.",
    events: [{ data: { delta: "partial" }, type: "token" }]
  }));

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId={selectedChatId}
      chats={chats}
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
      onSelectChat={(chat) => setSelectedChatId(chat.id)}
      ready
      searchError={null}
      searchLoading={false}
      searchQuery=""
    />
  );

  return (
    <div data-testid="ui-v2-run-lifecycle-gallery">
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={(chat) => setSelectedChatId(chat.id)}
        sidebar={sidebar}
      >
        <main className="v2-run-gallery-main">
          <div className="v2-run-gallery-document">
            <header className="v2-run-gallery-header">
              <p>Reading Room · Run lifecycle</p>
              <h1>Честные состояния выполнения</h1>
              <span>Одна спокойная строка сообщает только подтверждённую фазу. Частичный ответ остаётся документом.</span>
            </header>

            <section className="v2-run-gallery-group" aria-labelledby="run-activity-heading">
              <div className="v2-run-gallery-group-heading">
                <h2 id="run-activity-heading">Серверные фазы</h2>
                <span>Без процентов и стадий по таймеру</span>
              </div>
              <div className="v2-run-gallery-activities">
                {activityCases.map((item) => (
                  <StateSpec key={item.label} label={item.label}>
                    <RunAnswerV2
                      content=""
                      presentation={presentRunLifecycleV2(item.evidence)}
                    />
                  </StateSpec>
                ))}
              </div>
            </section>

            <section className="v2-run-gallery-group" aria-labelledby="run-terminal-heading">
              <div className="v2-run-gallery-group-heading">
                <h2 id="run-terminal-heading">Ответ и терминальные состояния</h2>
                <span>Partial не становится complete без серверного перехода</span>
              </div>

              <StateSpec label="Streaming">
                <RunAnswerV2
                  content="Собрал книгу из трёх листов: **Данные**, **Сводная** и"
                  presentation={presentRunLifecycleV2(runEvidence({
                    content: "Собрал книгу из трёх листов: Данные, Сводная и",
                    events: [{ data: { delta: "и" }, type: "token" }]
                  }))}
                />
              </StateSpec>

              <StateSpec label="Cancelled · partial preserved">
                <RunAnswerV2
                  content="Собрал книгу из трёх листов: **Данные**, **Сводная** и **Гра**"
                  onRegenerate={() => undefined}
                  presentation={presentRunLifecycleV2(runEvidence({
                    content: "Собрал книгу из трёх листов: Данные, Сводная и Гра",
                    events: [{ data: { status: "cancelled" }, type: "done" }]
                  }))}
                />
              </StateSpec>

              <StateSpec label="Connection lost · unknown until refresh">
                <RunAnswerV2
                  content="Собрал книгу из трёх листов: **Данные**, **Сводная** и **Гра**"
                  onRefresh={() => setConnectionLost(false)}
                  presentation={connectionPresentation}
                />
              </StateSpec>

              <StateSpec label="Partial · recoverable provider error">
                <RunAnswerV2
                  content="Собрал книгу из трёх листов: **Данные**, **Сводная** и **Гра**"
                  onRetry={() => undefined}
                  presentation={presentRunLifecycleV2(runEvidence({
                    content: "Собрал книгу из трёх листов: Данные, Сводная и Гра",
                    failure: {
                      code: "provider_stream_reset",
                      message: "Соединение с провайдером сброшено во время стриминга. Частичный результат сохранён; можно повторить с теми же параметрами.",
                      recovery: "retry"
                    },
                    status: "error"
                  }))}
                />
              </StateSpec>

              <StateSpec label="Terminal error · change parameters">
                <RunAnswerV2
                  content=""
                  onRegenerate={() => undefined}
                  onSelectModel={() => undefined}
                  presentation={presentRunLifecycleV2(runEvidence({
                    failure: {
                      code: "context_budget_exceeded",
                      message: "Контекст выбранной модели меньше объёма беседы с вложениями. Сократите вложения или выберите модель с бо́льшим контекстом.",
                      recovery: "change_parameters"
                    },
                    status: "error"
                  }))}
                />
              </StateSpec>

              <StateSpec label="Complete · terminal server transition">
                <RunAnswerV2
                  content="Готовый ответ остаётся спокойным документом; evidence появится отдельной строкой."
                  presentation={presentRunLifecycleV2(runEvidence({
                    content: "Готовый ответ",
                    events: [{ data: { status: "complete" }, type: "done" }]
                  }))}
                />
              </StateSpec>
            </section>

            <section className="v2-run-gallery-group" aria-labelledby="run-controls-heading">
              <div className="v2-run-gallery-group-heading">
                <h2 id="run-controls-heading">Send → Stop</h2>
                <span>Stop доступен только после durable run id</span>
              </div>
              <div className="v2-run-gallery-controls">
                <span>Send</span>
                <RunComposerActionV2 active={false} runId={null} />
                <span>Awaiting run id</span>
                <RunComposerActionV2 active runId={null} />
                <span>Cancelable</span>
                <RunComposerActionV2 active onStop={() => undefined} runId="run-gallery" />
              </div>
            </section>
          </div>
        </main>
      </ReadingRoomShellV2>

      <RunLifecycleAnnouncerV2
        activeChatId={selectedChatId}
        presentation={presentRunLifecycleV2(activityCases[2]!.evidence)}
        sourceChatId="run-lifecycle"
      />
    </div>
  );
}
