import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import {
  BranchDrawerV2,
  BranchPagerSlotV2,
  BranchPagerV2
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

    fireEvent.click(screen.getByRole("button", { name: "Previous version" }));
    fireEvent.click(screen.getByRole("button", { name: "Next version" }));
    expect(onCheckout).toHaveBeenNthCalledWith(1, "previous-private-id");
    expect(onCheckout).toHaveBeenNthCalledWith(2, "next-private-id");
    expect(screen.getByLabelText("Version 2 of 3")).toHaveTextContent("2/3");

    rerender(
      <BranchPagerV2
        disabledReason="Wait for the answer to finish."
        onCheckout={onCheckout}
        state={{
          current: 2,
          nextLeafId: "next-private-id",
          previousLeafId: "previous-private-id",
          total: 3
        }}
      />
    );
    expect(screen.getByRole("button", { name: "Previous version" })).toBeDisabled();
    expect(screen.getByText("Wait for the answer to finish.")).toBeVisible();
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

    expect(screen.getByLabelText("Version 2 of 2")).toHaveTextContent("2/2");
    fireEvent.click(screen.getByRole("button", { name: "Previous version" }));
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
          <button onClick={() => setOpen(true)} type="button">Open branches</button>
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
    const opener = screen.getByRole("button", { name: "Open branches" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: "Conversation branches" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Close branches" })).toHaveFocus());
    expect(drawer).toHaveTextContent("Version 1");
    expect(drawer).toHaveTextContent("Version 2");
    expect(drawer.textContent).not.toContain("private-id");

    const switchButton = within(drawer).getByRole("button", { name: "Switch" });
    switchButton.focus();
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close branches" })).toHaveFocus();
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
    const drawer = screen.getByRole("dialog", { name: "Conversation branches" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(within(drawer).getByRole("alert")).toHaveTextContent(
      "current branch is unchanged"
    ));
    expect(within(drawer).getByText("Current")).toBeVisible();

    const onClose = vi.fn();
    rerender(
      <BranchDrawerV2
        graph={graph}
        onCheckout={() => true}
        onClose={onClose}
      />
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {
      name: "Switch"
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps loading, failure, empty, and streaming-disabled states explicit", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <BranchDrawerV2 graph={null} loading onCheckout={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByLabelText("Loading branches")).toBeVisible();

    rerender(
      <BranchDrawerV2
        error="unavailable"
        graph={null}
        onCheckout={vi.fn()}
        onClose={vi.fn()}
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <BranchDrawerV2
        graph={{ ...graph, activeLeafMessageId: null, nodes: [] }}
        onCheckout={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("No branches yet")).toBeVisible();

    rerender(
      <BranchDrawerV2
        checkoutDisabledReason="Stop the answer or wait for it to finish."
        graph={graph}
        onCheckout={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Stop the answer or wait for it to finish.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Switch" })).toBeDisabled();
  });
});
