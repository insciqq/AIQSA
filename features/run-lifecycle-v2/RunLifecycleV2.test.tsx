import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RunAnswerV2,
  RunComposerActionV2,
  RunLifecycleAnnouncerV2
} from "./RunLifecycleV2";
import {
  settledRunPresentationV2,
  type RunPresentationV2
} from "./runPresentation";

function presentation(
  overrides: Partial<RunPresentationV2> = {}
): RunPresentationV2 {
  return {
    kind: "idle",
    runId: null,
    ...overrides
  };
}

describe("Run lifecycle v2", () => {
  it("settles the answer chrome only on authoritative terminal presentations", () => {
    for (const kind of ["cancelled", "complete", "recoverable_error", "terminal_error"] as const) {
      expect(settledRunPresentationV2(presentation({ kind }))).toBe(true);
    }
    for (const kind of ["activity", "connection_lost", "idle", "streaming"] as const) {
      expect(settledRunPresentationV2(presentation({ kind }))).toBe(false);
    }
  });

  it("keeps run and request UUIDs out of the streaming chrome", () => {
    const runId = "396b627a-1c9f-4e58-9d1f-2b9a5c1e7a10";
    render(
      <RunAnswerV2
        content="Частичный ответ"
        presentation={presentation({
          activity: { kind: "provider", label: "Выполняется у провайдера…" },
          kind: "activity",
          runId
        })}
      />
    );

    expect(screen.getByTestId("run-status-line")).toHaveTextContent("Выполняется у провайдера…");
    expect(screen.queryByTestId("conversation-message-actions")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu
    );
  });

  it("renders explicit activity without an invented empty answer", () => {
    render(
      <RunAnswerV2
        content=""
        presentation={presentation({
          activity: { kind: "preparing", label: "Готовлю запрос…" },
          kind: "activity"
        })}
      />
    );

    expect(screen.getByTestId("run-status-line")).toHaveTextContent("Готовлю запрос…");
    expect(screen.queryByText("В этом сообщении нет текста.")).toBeNull();
  });

  it("keeps partial output for streaming, cancellation, and connection loss", async () => {
    const refresh = vi.fn(async () => undefined);
    const regenerate = vi.fn();
    const { rerender } = render(
      <RunAnswerV2
        content="Partial **answer**"
        presentation={presentation({ kind: "streaming", runId: "run-a" })}
      />
    );
    expect(screen.getByRole("article", { name: "Answer" })).toHaveClass(
      "v2-run-answer-streaming"
    );
    expect(screen.getByText("answer")).toBeVisible();

    rerender(
      <RunAnswerV2
        content="Partial **answer**"
        onRegenerate={regenerate}
        presentation={presentation({ kind: "cancelled", runId: "run-a" })}
      />
    );
    expect(screen.getByText("Остановлено")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Перегенерировать" }));
    expect(regenerate).toHaveBeenCalledOnce();

    rerender(
      <RunAnswerV2
        content="Partial **answer**"
        onRefresh={refresh}
        presentation={presentation({ kind: "connection_lost", runId: "run-a" })}
      />
    );
    expect(screen.getByTestId("run-connection-lost")).toHaveTextContent(
      "Соединение потеряно·Обновить"
    );
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByText("answer")).toBeVisible();
  });

  it("presents retryable and terminal errors with distinct recovery actions", () => {
    const retry = vi.fn();
    const selectModel = vi.fn();
    const regenerate = vi.fn();
    const { rerender } = render(
      <RunAnswerV2
        content="Partial result"
        onRetry={retry}
        presentation={presentation({
          failure: {
            code: "provider_stream_reset",
            message: "Частичный результат сохранён.",
            recovery: "retry"
          },
          kind: "recoverable_error"
        })}
      />
    );

    expect(screen.getByRole("region", { name: "Ответ прерван ошибкой" })).toHaveTextContent(
      "Ответ прерван ошибкой провайдераprovider_stream_reset"
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(
      <RunAnswerV2
        content=""
        onRegenerate={regenerate}
        onSelectModel={selectModel}
        presentation={presentation({
          failure: {
            code: "context_budget_exceeded",
            message: "Выберите модель с большим контекстом.",
            recovery: "change_parameters"
          },
          kind: "terminal_error"
        })}
      />
    );
    expect(screen.getByRole("region", { name: "Ошибка запуска" })).toHaveTextContent(
      "Запрос не выполненcontext_budget_exceeded"
    );
    fireEvent.click(screen.getByRole("button", { name: "Выбрать модель…" }));
    fireEvent.click(screen.getByRole("button", { name: "Перегенерировать" }));
    expect(selectModel).toHaveBeenCalledOnce();
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it("changes Send to Stop but cannot cancel before a durable run id", () => {
    const send = vi.fn();
    const stop = vi.fn();
    const { rerender } = render(
      <RunComposerActionV2 active={false} onSend={send} onStop={stop} runId={null} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
    expect(send).toHaveBeenCalledOnce();

    rerender(<RunComposerActionV2 active onSend={send} onStop={stop} runId={null} />);
    const unavailableStop = screen.getByRole("button", { name: "Остановить ответ" });
    expect(unavailableStop).toBeDisabled();
    expect(unavailableStop).toHaveAccessibleDescription(
      "Запуск ещё не подтверждён сервером."
    );

    rerender(<RunComposerActionV2 active onSend={send} onStop={stop} runId="run-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Остановить ответ" }));
    expect(stop).toHaveBeenCalledWith("run-a");
  });

  it("keeps a disabled Send reason attached to the stable action", () => {
    render(
      <RunComposerActionV2
        active={false}
        onSend={vi.fn()}
        runId={null}
        sendDisabled
        sendDisabledReason="Введите сообщение."
      />
    );

    expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отправить сообщение" }))
      .toHaveAccessibleDescription("Введите сообщение.");
  });

  it("announces only a continuously selected source and never replays historical terminal state", async () => {
    const working = presentation({
      activity: { kind: "search", label: "Ищу в интернете…" },
      kind: "activity",
      runId: "run-a"
    });
    const complete = presentation({ kind: "complete", runId: "run-a" });
    const { rerender } = render(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-a"
        presentation={working}
        sourceChatId="chat-a"
      />
    );

    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toHaveTextContent(
      "Ищу в интернете…"
    ));
    rerender(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-a"
        presentation={complete}
        sourceChatId="chat-a"
      />
    );
    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toHaveTextContent(
      "Ответ готов. Поле сообщения доступно."
    ));

    rerender(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-b"
        presentation={complete}
        sourceChatId="chat-a"
      />
    );
    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toBeEmptyDOMElement());
    rerender(
      <RunLifecycleAnnouncerV2
        activeChatId="chat-a"
        presentation={complete}
        sourceChatId="chat-a"
      />
    );
    await waitFor(() => expect(screen.getByTestId("run-lifecycle-announcer")).toBeEmptyDOMElement());
  });
});
