import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationInlineEditV2,
  ConversationTurnV2,
  ConversationV2,
  shouldClampUserBubbleV2,
  type ConversationMessageV2
} from "./ConversationV2";

const answer: ConversationMessageV2 = {
  content: "A document-like answer.",
  id: "answer-current",
  role: "assistant"
};

describe("Conversation v2", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows one-time empty orientation and removes it for optimistic state", () => {
    const { rerender } = render(
      <ConversationV2
        composerSlot={<div>Composer preview</div>}
        messages={[]}
      />
    );

    expect(screen.getByTestId("conversation-empty")).toBeVisible();
    expect(screen.getByText("What are we working on?")).toBeVisible();
    // Quiet greeting only: no canvas wordmark and no marketing subtitle.
    expect(screen.queryByText("AIQSA")).toBeNull();
    expect(screen.queryByText(/Спросите, исследуйте/u)).toBeNull();
    expect(screen.getByText("Composer preview")).toBeVisible();

    rerender(
      <ConversationV2
        composerSlot={<div>Composer preview</div>}
        messages={[{
          content: "Optimistic question",
          id: "optimistic-question",
          optimistic: true,
          role: "user"
        }]}
      />
    );

    expect(screen.queryByTestId("conversation-empty")).toBeNull();
    expect(screen.getByRole("article", { name: "Question" })).toHaveTextContent(
      "Optimistic question"
    );
  });

  it("keeps questions compact, answers cardless, and controls contextual", () => {
    const onCopy = vi.fn();
    const onRegenerate = vi.fn();
    render(
      <ConversationV2
        getMessageActions={(message) => message.role === "user"
          ? { onCopy }
          : { onRegenerate }}
        messages={[
          { content: "Compact question", id: "question", role: "user" },
          answer
        ]}
      />
    );

    const question = screen.getByRole("article", { name: "Question" });
    const assistant = screen.getByRole("article", { name: "Answer" });
    expect(question).toHaveAttribute("data-role", "user");
    expect(question.querySelector(".v2-conversation-turn-content")).toHaveClass(
      "v2-conversation-turn-content"
    );
    expect(assistant.querySelector(".v2-conversation-turn-content")).not.toHaveClass(
      "v2-surface",
      "v2-card"
    );
    expect(screen.queryByText(/assistant|user/i)).toBeNull();

    // Turns are not tab stops (A15): the dock reveals on tap/hover/focus-within.
    expect(assistant).not.toHaveAttribute("tabindex");
    expect(question).not.toHaveAttribute("tabindex");
    fireEvent.click(assistant);
    expect(assistant).toHaveAttribute("data-controls-open", "true");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate answer" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Copy question" }));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("edits a question in its bubble and restores focus to Edit on Escape", async () => {
    function Harness() {
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState("Saved question");
      return (
        <ConversationTurnV2
          actions={{ onEdit: () => setEditing(true) }}
          anchorId="question/one"
          content="Saved question"
          edit={editing ? {
            attachmentSlot: <span>report.pdf</span>,
            draft,
            onCancel: () => setEditing(false),
            onChange: setDraft,
            onSubmit: vi.fn()
          } : undefined}
          role="user"
        />
      );
    }

    render(<Harness />);
    const edit = screen.getByRole("button", { name: "Edit question" });
    edit.focus();
    fireEvent.click(edit);

    const input = screen.getByRole("textbox", { name: "Edit question" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Saved question");
    expect(screen.getByLabelText("Attachments in this message")).toHaveTextContent("report.pdf");
    expect(screen.getByText(/original history stays unchanged/iu)).toBeVisible();
    expect(screen.queryByRole("toolbar", { name: "Question actions" })).toBeNull();

    fireEvent.change(input, { target: { value: "Rewritten question" } });
    expect(input).toHaveValue("Rewritten question");
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.getByText("Saved question")).toBeVisible());
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit question" })).toHaveFocus());
  });

  it("auto-grows the inline field and follows both send keyboard modes", () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(144);
    const onSubmit = vi.fn();
    const props = {
      draft: "Edited question",
      onCancel: vi.fn(),
      onChange: vi.fn(),
      onSubmit
    };
    const { rerender } = render(<ConversationInlineEditV2 {...props} />);
    const input = screen.getByRole("textbox", { name: "Edit question" });
    expect(input).toHaveStyle({ height: "144px" });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();

    rerender(<ConversationInlineEditV2 {...props} sendWithEnter={false} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { ctrlKey: true, key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps an unsuccessful inline edit recoverable and locks it while saving", () => {
    render(
      <ConversationInlineEditV2
        draft="Edited question"
        error="The message changed on another branch."
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        pending
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("changed on another branch");
    expect(screen.getByRole("textbox", { name: "Edit question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("clamps only a long question and restores it with «Show full message»", () => {
    const longQuestion = Array.from({ length: 40 }, (_, index) => `Строка ${index + 1}`).join("\n");
    expect(shouldClampUserBubbleV2("Короткий вопрос")).toBe(false);
    expect(shouldClampUserBubbleV2(longQuestion)).toBe(true);
    expect(shouldClampUserBubbleV2("а".repeat(2000))).toBe(true);

    render(
      <ConversationV2
        messages={[
          { content: "Короткий вопрос", id: "short-question", role: "user" },
          { content: longQuestion, id: "long-question", role: "user" },
          answer
        ]}
      />
    );

    // The short question and the answer never clamp and get no expander.
    const short = screen.getAllByRole("article", { name: "Question" })[0];
    expect(short.querySelector("[data-bubble-clamped]")).toBeNull();
    expect(within(short).queryByRole("button", { name: "Show full message" })).toBeNull();
    const assistant = screen.getByRole("article", { name: "Answer" });
    expect(assistant.querySelector("[data-bubble-clamped]")).toBeNull();

    const long = screen.getAllByRole("article", { name: "Question" })[1];
    expect(long.querySelector("[data-bubble-clamped='true']")).not.toBeNull();
    const expander = within(long).getByRole("button", { name: "Show full message" });
    expect(expander).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expander);
    expect(long.querySelector("[data-bubble-clamped]")).toBeNull();
    const collapse = within(long).getByRole("button", { name: "Collapse" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapse);
    expect(long.querySelector("[data-bubble-clamped='true']")).not.toBeNull();
  });

  it("expands only the current long question for the reading anchor", () => {
    const longQuestion = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n");
    const { rerender } = render(
      <ConversationTurnV2
        anchorId="current-question"
        content={longQuestion}
        expandForReadingAnchor
        role="user"
      />
    );

    const question = screen.getByRole("article", { name: "Question" });
    expect(question.querySelector("[data-bubble-clamped]")).toBeNull();
    expect(within(question).getByRole("button", { name: "Collapse" })).toBeVisible();

    rerender(
      <ConversationTurnV2
        anchorId="current-question"
        content={longQuestion}
        role="user"
      />
    );
    expect(question.querySelector("[data-bubble-clamped='true']")).not.toBeNull();
  });

  it("keeps answer-bound presentation beside the exact message", () => {
    render(
      <ConversationV2
        getMessagePresentation={(message) => message.id === answer.id
          ? { afterContent: <span>Bound evidence</span> }
          : undefined}
        messages={[answer]}
      />
    );

    expect(screen.getByText("Bound evidence").closest("[data-conversation-message-id]"))
      .toHaveAttribute("data-conversation-message-id", answer.id);
  });

  it("keeps Regenerate first and orders destructive More actions for keyboard use", async () => {
    const onBranch = vi.fn();
    const onDelete = vi.fn();
    const onRegenerate = vi.fn();
    render(
      <ConversationTurnV2
        actions={{
          onBranchFromHere: onBranch,
          onDelete,
          onRegenerate
        }}
        content="Versioned answer"
        role="assistant"
      />
    );

    const toolbar = screen.getByRole("toolbar", { name: "Answer actions" });
    expect(within(toolbar).getAllByRole("button")[0]).toHaveAccessibleName("Regenerate answer");
    const more = screen.getByRole("button", { name: "More answer actions" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "Answer menu" });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Branch from here" })).toHaveFocus());
    // Branch first; Delete last, destructive, and behind a separator (B4).
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Branch from here",
      "Delete"
    ]);
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toHaveAttribute("data-tone", "destructive");
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(more).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Answer menu" })).toBeNull();
  });

  it("keeps streaming actions disabled with one readable reason", () => {
    render(
      <ConversationTurnV2
        actions={{
          branchDisabled: true,
          deleteDisabled: true,
          disabledReason: "Wait for the answer to finish or stop it.",
          editDisabled: true,
          onBranchFromHere: vi.fn(),
          onDelete: vi.fn(),
          onEdit: vi.fn(),
          onRegenerate: vi.fn(),
          regenerateDisabled: true
        }}
        content="Streaming answer"
        role="assistant"
        streaming
      />
    );

    const regenerate = screen.getByRole("button", { name: "Regenerate answer" });
    expect(regenerate).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit answer" })).toBeDisabled();
    // The reason is the disabled controls' tooltip, not a permanent line (B6).
    expect(regenerate).toHaveAttribute("data-tooltip", "Wait for the answer to finish or stop it.");
    expect(screen.getByText("Wait for the answer to finish or stop it.")).toHaveClass("v2-sr-only");
    fireEvent.click(screen.getByRole("button", { name: "More answer actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Branch from here" })).toBeDisabled();
  });

  it("keeps unavailable, loading, failed, and partial-error states explicit", () => {
    const retry = vi.fn();
    const { rerender } = render(<ConversationV2 loading messages={[]} />);
    expect(screen.getByLabelText("Loading conversation")).toBeVisible();

    rerender(<ConversationV2 unavailable messages={[]} onRetry={retry} />);
    expect(screen.getByTestId("conversation-unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(<ConversationV2 error="failed" messages={[]} onRetry={retry} />);
    expect(screen.getByTestId("conversation-error")).toBeVisible();

    rerender(<ConversationV2 error="partial" messages={[answer]} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Part of the conversation did not load");
    expect(screen.getByRole("article", { name: "Answer" })).toBeVisible();
  });

  it("preserves the first visible message when earlier turns are prepended", async () => {
    const current: ConversationMessageV2[] = [
      { content: "Current question", id: "current-question", role: "user" },
      { content: "Current answer", id: "current-answer", role: "assistant" }
    ];
    const earlier: ConversationMessageV2[] = [
      { content: "Earlier question", id: "earlier-question", role: "user" },
      { content: "Earlier answer", id: "earlier-answer", role: "assistant" }
    ];

    function Harness() {
      const [messages, setMessages] = useState(current);
      const [hasOlder, setHasOlder] = useState(true);
      return (
        <ConversationV2
          hasOlder={hasOlder}
          messages={messages}
          onLoadEarlier={() => {
            setMessages((items) => [...earlier, ...items]);
            setHasOlder(false);
          }}
        />
      );
    }

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "conversation-scroll") {
        return bounds(0, 400);
      }
      const id = this.dataset.conversationMessageId;
      const prepended = Boolean(document.querySelector('[data-conversation-message-id="earlier-question"]'));
      if (id === "current-question") return bounds(prepended ? 180 : 40, prepended ? 240 : 100);
      if (id === "current-answer") return bounds(prepended ? 260 : 120, prepended ? 340 : 200);
      if (id === "earlier-question") return bounds(20, 80);
      if (id === "earlier-answer") return bounds(100, 160);
      return bounds(0, 0);
    });

    render(<Harness />);
    const scroller = screen.getByTestId("conversation-scroll");
    scroller.scrollTop = 100;
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));

    await waitFor(() => expect(screen.getByText("Earlier question")).toBeVisible());
    expect(scroller.scrollTop).toBe(240);
  });

  it("keeps unsafe Markdown inert and streaming code as plaintext", () => {
    const unsafe = [
      "[safe](https://example.com) [unsafe](javascript:alert(1))",
      "",
      "<script>window.__unsafe = true</script>",
      "",
      "```typescript",
      "const longValue = 'safe';",
      "```"
    ].join("\n");
    const { container } = render(
      <ConversationTurnV2 content={unsafe} role="assistant" streaming />
    );

    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "href",
      "https://example.com"
    );
    expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
    expect(container).toHaveTextContent("<script>window.__unsafe = true</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("region", { name: "Scrollable code block" })).toHaveTextContent(
      "const longValue = 'safe';"
    );
    expect(container.querySelector("pre code")).toBeTruthy();
  });

  it("keeps explicit run-owned content around Markdown without inventing empty copy", () => {
    render(
      <ConversationTurnV2
        afterContent={<div>Terminal state</div>}
        beforeContent={<div>Preparing state</div>}
        className="run-owned-turn"
        content=""
        hideEmptyContent
        role="assistant"
      />
    );

    const turn = screen.getByRole("article", { name: "Answer" });
    expect(turn).toHaveClass("run-owned-turn");
    expect(turn).toHaveTextContent("Preparing stateTerminal state");
    expect(turn).not.toHaveTextContent("This message has no text.");
  });
});

function bounds(top: number, bottom: number): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 800,
    top,
    width: 800,
    x: 0,
    y: top,
    toJSON: () => ({})
  };
}
