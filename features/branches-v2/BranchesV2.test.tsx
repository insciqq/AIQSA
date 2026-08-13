import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import {
  BranchDrawerV2,
  BranchPagerSlotV2,
  BranchPagerV2,
  EditBranchStripV2
} from "./BranchesV2";

const graph: ChatBranchGraphWire = {
  activeLeafMessageId: "answer-current-private-id",
  nodes: [
    {
      id: "question-private-id",
      parentMessageId: null,
      preview: "Как проверить результат?",
      role: "user",
      status: "complete"
    },
    {
      id: "answer-old-private-id",
      parentMessageId: "question-private-id",
      preview: "Первый ответ",
      role: "assistant",
      status: "complete"
    },
    {
      id: "answer-current-private-id",
      parentMessageId: "question-private-id",
      preview: "Новый ответ",
      role: "assistant",
      status: "complete"
    }
  ],
  snapshotUpdatedAt: "2026-08-13T10:00:00.000Z"
};

describe("Branches v2", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("states the immutable edit consequence and preserves cancellation while pending", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<EditBranchStripV2 onCancel={onCancel} />);

    expect(screen.getByTestId("edit-branch-strip-v2")).toHaveTextContent(
      "Отправка создаст новую ветвь; история не изменится."
    );
    fireEvent.click(screen.getByRole("button", { name: "Отменить редактирование" }));
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(<EditBranchStripV2 error="Черновик сохранён" onCancel={onCancel} pending />);
    expect(screen.getByRole("button", { name: "Отменить редактирование" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Черновик сохранён");
  });

  it("checks out exact pager targets and explains streaming disablement", () => {
    const onCheckout = vi.fn();
    const { rerender } = render(
      <BranchPagerV2
        onCheckout={onCheckout}
        state={{
          current: 2,
          nextLeafId: "next-private-id",
          previousLeafId: "previous-private-id",
          total: 3
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Предыдущая версия" }));
    fireEvent.click(screen.getByRole("button", { name: "Следующая версия" }));
    expect(onCheckout).toHaveBeenNthCalledWith(1, "previous-private-id");
    expect(onCheckout).toHaveBeenNthCalledWith(2, "next-private-id");
    expect(screen.getByLabelText("Версия 2 из 3")).toHaveTextContent("2/3");

    rerender(
      <BranchPagerV2
        disabledReason="Дождитесь завершения ответа."
        onCheckout={onCheckout}
        state={{
          current: 2,
          nextLeafId: "next-private-id",
          previousLeafId: "previous-private-id",
          total: 3
        }}
      />
    );
    expect(screen.getByRole("button", { name: "Предыдущая версия" })).toBeDisabled();
    expect(screen.getByText("Дождитесь завершения ответа.")).toBeVisible();
  });

  it("renders the live pager slot only for sibling messages and checks out the sibling leaf", () => {
    const onCheckout = vi.fn();
    const { rerender } = render(
      <BranchPagerSlotV2
        graph={graph}
        messageId="answer-current-private-id"
        onCheckout={onCheckout}
      />
    );

    expect(screen.getByLabelText("Версия 2 из 2")).toHaveTextContent("2/2");
    fireEvent.click(screen.getByRole("button", { name: "Предыдущая версия" }));
    expect(onCheckout).toHaveBeenCalledWith("answer-old-private-id");

    rerender(
      <BranchPagerSlotV2
        graph={graph}
        messageId="question-private-id"
        onCheckout={onCheckout}
      />
    );
    expect(screen.queryByTestId("branch-pager")).toBeNull();

    rerender(
      <BranchPagerSlotV2
        graph={null}
        messageId="answer-current-private-id"
        onCheckout={onCheckout}
      />
    );
    expect(screen.queryByTestId("branch-pager")).toBeNull();
  });

  it("traps focus, restores the opener, and never renders raw graph ids", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">Открыть ветви</button>
          {open ? (
            <BranchDrawerV2
              graph={graph}
              onCheckout={() => true}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Открыть ветви" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: "Ветви разговора" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть ветви" })).toHaveFocus());
    expect(drawer).toHaveTextContent("Версия 1");
    expect(drawer).toHaveTextContent("Версия 2");
    expect(drawer.textContent).not.toContain("private-id");

    const switchButton = within(drawer).getByRole("button", { name: "Переключиться" });
    switchButton.focus();
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Закрыть ветви" })).toHaveFocus();
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(drawer).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("closes only after a successful checkout and keeps the current version on failure", async () => {
    const failedCheckout = vi.fn().mockResolvedValue(false);
    const { rerender } = render(
      <BranchDrawerV2
        graph={graph}
        onCheckout={failedCheckout}
        onClose={vi.fn()}
      />
    );
    const drawer = screen.getByRole("dialog", { name: "Ветви разговора" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Переключиться" }));
    await waitFor(() => expect(within(drawer).getByRole("alert")).toHaveTextContent(
      "Текущая ветвь не изменилась"
    ));
    expect(within(drawer).getByText("Текущая")).toBeVisible();

    const onClose = vi.fn();
    rerender(
      <BranchDrawerV2
        graph={graph}
        onCheckout={() => true}
        onClose={onClose}
      />
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {
      name: "Переключиться"
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps loading, failure, empty, and streaming-disabled states explicit", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <BranchDrawerV2 graph={null} loading onCheckout={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByLabelText("Загружаем ветви")).toBeVisible();

    rerender(
      <BranchDrawerV2
        error="unavailable"
        graph={null}
        onCheckout={vi.fn()}
        onClose={vi.fn()}
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <BranchDrawerV2
        graph={{ ...graph, activeLeafMessageId: null, nodes: [] }}
        onCheckout={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Ветвей пока нет")).toBeVisible();

    rerender(
      <BranchDrawerV2
        checkoutDisabledReason="Остановите ответ или дождитесь завершения."
        graph={graph}
        onCheckout={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Остановите ответ или дождитесь завершения.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Переключиться" })).toBeDisabled();
  });
});
