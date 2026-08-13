import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PersistedRun } from "@/lib/contracts/runs";
import { ExactRunDetailsDrawerV2 } from "./RunDetailsV2";
import {
  completeRunDetailsFixture,
  emptyRunDetailsFixture,
  memoryRunDetailsFixture,
  runDetailsCatalogFixture,
  runDetailsGeneratedFileFacts,
  runDetailsTargetFixture
} from "./fixtures";
import type { RunDetailsTargetV2 } from "./runDetailsModel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Run details v2 drawer", () => {
  it("renders the exact cached receipt without ids, secrets, raw answer text, or estimated cost", async () => {
    const onOpenSource = vi.fn();
    const { container } = render(
      <ExactRunDetailsDrawerV2
        cachedRun={memoryRunDetailsFixture}
        catalog={runDetailsCatalogFixture}
        generatedFiles={runDetailsGeneratedFileFacts}
        loadRun={vi.fn()}
        onClose={vi.fn()}
        onOpenMemorySource={onOpenSource}
        target={runDetailsTargetFixture}
      />
    );

    const drawer = await screen.findByRole("dialog", {
      name: "Детали run · Ответ «Квартальный отчёт»"
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть детали run" })).toHaveFocus());
    expect(within(drawer).getByText("OpenAI · рабочий ключ")).toBeVisible();
    expect(within(drawer).getByText("GPT-5.2")).toBeVisible();
    expect(within(drawer).getByRole("region", { name: "Redacted request preview" })).toHaveTextContent("‹redacted›");
    expect(within(drawer).getByRole("region", { name: "Redacted request preview" })).toHaveTextContent("‹private›");
    expect(drawer).toHaveTextContent("Usage · provider evidence");
    expect(drawer).not.toHaveTextContent("$0.0091");
    expect(drawer).not.toHaveTextContent("Стоимость9");
    expect(drawer).toHaveTextContent("report_q3.xlsx");
    expect(drawer).toHaveTextContent("deck_q3.pptx");

    fireEvent.click(within(drawer).getByText(/2\. Фрагмент истории/));
    expect(within(drawer).getByText("Ссылка скрыта: исходный чат удалён.")).toBeVisible();
    fireEvent.click(within(drawer).getByText(/3\. Фрагмент истории/));
    const source = within(drawer).getByRole("button", { name: "Открыть источник · 2" });
    fireEvent.click(source);
    expect(onOpenSource).toHaveBeenCalledWith("source-chat-private-live");

    fireEvent.click(within(drawer).getByText(/office-compute · create_workbook/));
    fireEvent.click(within(drawer).getByText("Аргументы · redacted"));
    expect(within(drawer).getByRole("region", { name: "Redacted tool arguments" }))
      .toHaveTextContent("‹redacted›");
    fireEvent.click(within(drawer).getByText("Результат · ненадёжные данные"));
    expect(within(drawer).getByRole("region", { name: "Untrusted tool result preview" }))
      .toHaveTextContent("‹redacted›");

    expect(container.textContent).not.toMatch(
      /assistant-message-private|run-private|fact-private|version-private|tool-call-private|knowledge-base-private|source-chat-private|sk-private|private-bearer/u
    );
  });

  it("loads owner-private evidence, rejects a mismatched answer, and retries without rendering it", async () => {
    const loadRun = vi.fn(async () => ({
      ...completeRunDetailsFixture,
      inspection: {
        ...completeRunDetailsFixture.inspection!,
        answerMessageId: "foreign-answer-private"
      }
    }));
    render(
      <ExactRunDetailsDrawerV2
        catalog={runDetailsCatalogFixture}
        loadRun={loadRun}
        onClose={vi.fn()}
        target={runDetailsTargetFixture}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Receipt не принадлежит этому ответу"
    );
    expect(screen.queryByText("OpenAI · рабочий ключ")).toBeNull();
    expect(document.body.textContent).not.toContain("foreign-answer-private");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(loadRun).toHaveBeenCalledTimes(2));
  });

  it("fences late load settlement when the requested answer changes", async () => {
    const first = deferred<PersistedRun | null>();
    const second = deferred<PersistedRun | null>();
    const firstTarget = runDetailsTargetFixture;
    const secondTarget: RunDetailsTargetV2 = {
      answerLabel: "Ответ «Вторая версия»",
      assistantMessageId: "assistant-message-private-second",
      runId: "run-private-second"
    };
    const secondRun: PersistedRun = {
      ...emptyRunDetailsFixture,
      id: secondTarget.runId,
      inspection: {
        ...emptyRunDetailsFixture.inspection!,
        answerMessageId: secondTarget.assistantMessageId
      },
      modelId: "second-readable-model"
    };
    const loadRun = vi.fn((runId: string) =>
      runId === firstTarget.runId ? first.promise : second.promise
    );
    const { rerender } = render(
      <ExactRunDetailsDrawerV2
        catalog={null}
        loadRun={loadRun}
        onClose={vi.fn()}
        target={firstTarget}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Загружаю receipt этого ответа");

    rerender(
      <ExactRunDetailsDrawerV2
        catalog={null}
        loadRun={loadRun}
        onClose={vi.fn()}
        target={secondTarget}
      />
    );
    await act(async () => first.resolve(completeRunDetailsFixture));
    expect(screen.getByRole("status")).toHaveTextContent("Загружаю receipt этого ответа");
    expect(screen.queryByText("GPT-5.2")).toBeNull();
    await act(async () => second.resolve(secondRun));
    expect(await screen.findByText("Second readable model")).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Детали run · Ответ «Вторая версия»");
  });

  it("traps focus, closes on Escape, and restores the explicit answer-bound opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">Run details</button>
          {open ? (
            <ExactRunDetailsDrawerV2
              cachedRun={completeRunDetailsFixture}
              catalog={runDetailsCatalogFixture}
              loadRun={vi.fn()}
              onClose={() => setOpen(false)}
              target={runDetailsTargetFixture}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Run details" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = await screen.findByRole("dialog");
    const close = screen.getByRole("button", { name: "Закрыть детали run" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
    expect(within(drawer).getByRole("region", { name: "Redacted request preview" })).toHaveFocus();
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(drawer).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
