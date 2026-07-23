import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "./types";
import { ThreadMessageRow } from "./ThreadMessageRow";

function assistantMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    content: "Answer",
    id: "message-1",
    parentMessageId: "question-1",
    role: "assistant",
    status: "complete",
    ...overrides
  };
}

function renderRow(overrides: Partial<ComponentProps<typeof ThreadMessageRow>> = {}) {
  const props: ComponentProps<typeof ThreadMessageRow> = {
    answerModelLabel: "Fake / Fake QSA",
    message: assistantMessage(),
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
    streaming: false,
    onBranchFromMessage: vi.fn(),
    onCopyMessage: vi.fn(),
    onDeleteMessage: vi.fn(),
    onEditMessage: vi.fn(),
    onRegenerateMessage: vi.fn(),
    ...overrides
  };

  return { props, ...render(<ThreadMessageRow {...props} />) };
}

describe("ThreadMessageRow", () => {
  it("uses the shared reading measure and exposes stable message and toolbar semantics", () => {
    const { container, unmount } = renderRow({
      message: assistantMessage({ id: "assistant-readable" })
    });

    const assistant = container.querySelector('article[data-role="assistant"]');
    expect(assistant).toHaveAttribute("data-message-id", "assistant-readable");
    expect(assistant).toHaveAttribute("data-status", "complete");
    expect(screen.getByRole("article", { name: "Answer" })).toBe(assistant);
    expect(assistant?.firstElementChild).toHaveClass("max-w-reading");
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.getByText("Fake / Fake QSA")).toBeVisible();

    const assistantToolbar = screen.getByRole("toolbar", { name: "Assistant message actions" });
    expect(assistantToolbar).toHaveAccessibleDescription("Answer: Answer");
    expect(assistantToolbar).toHaveClass("min-h-11");
    expect(assistantToolbar).toHaveClass("opacity-0");
    expect(assistantToolbar).toHaveClass("focus-within:opacity-100");
    expect(assistantToolbar).toHaveClass("group-hover/turn:opacity-100");
    expect(assistantToolbar).toHaveClass("[@media(hover:none)]:opacity-100");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Regenerate message",
      "Edit message",
      "Copy message",
      "Delete message",
      "Branch from here"
    ]);
    for (const action of screen.getAllByRole("button")) {
      expect(action).toHaveAccessibleDescription("Answer: Answer");
    }
    expect(
      screen.getByTestId("assistant-message-content").compareDocumentPosition(assistantToolbar) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    unmount();

    const { container: userContainer } = renderRow({
      answerModelLabel: null,
      message: {
        content: "Question",
        id: "user-readable",
        parentMessageId: null,
        role: "user",
        status: "complete"
      }
    });
    const user = userContainer.querySelector('article[data-role="user"]');
    expect(user).toHaveAttribute("data-message-id", "user-readable");
    expect(screen.getByRole("article", { name: "Question" })).toBe(user);
    expect(user?.firstElementChild).toHaveClass("max-w-reading");
    expect(screen.queryByText("User")).not.toBeInTheDocument();
    const userToolbar = screen.getByRole("toolbar", { name: "User message actions" });
    expect(userToolbar).toHaveClass("min-h-11");
    expect(userToolbar).toHaveAccessibleDescription("Question: Question");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Edit message",
      "Copy message",
      "Delete message",
      "Branch from here"
    ]);
    for (const action of screen.getAllByRole("button")) {
      expect(action).toHaveAccessibleDescription("Question: Question");
    }
  });

  it("calls every assistant action with the message or message id it owns", () => {
    const message = assistantMessage({ id: "assistant-actions" });
    const onBranchFromMessage = vi.fn();
    const onCopyMessage = vi.fn();
    const onDeleteMessage = vi.fn();
    const onEditMessage = vi.fn();
    const onRegenerateMessage = vi.fn();
    renderRow({
      message,
      onBranchFromMessage,
      onCopyMessage,
      onDeleteMessage,
      onEditMessage,
      onRegenerateMessage
    });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate message" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));

    expect(onRegenerateMessage).toHaveBeenCalledWith("assistant-actions");
    expect(onEditMessage).toHaveBeenCalledWith(message);
    expect(onCopyMessage).toHaveBeenCalledWith(message);
    expect(onDeleteMessage).toHaveBeenCalledWith("assistant-actions");
    expect(onBranchFromMessage).toHaveBeenCalledWith("assistant-actions");
  });

  it("calls every available user action and does not offer regenerate", () => {
    const message: ThreadMessage = {
      content: "Question",
      id: "user-actions",
      parentMessageId: null,
      role: "user",
      status: "complete"
    };
    const onBranchFromMessage = vi.fn();
    const onCopyMessage = vi.fn();
    const onDeleteMessage = vi.fn();
    const onEditMessage = vi.fn();
    const onRegenerateMessage = vi.fn();
    renderRow({
      answerModelLabel: null,
      message,
      onBranchFromMessage,
      onCopyMessage,
      onDeleteMessage,
      onEditMessage,
      onRegenerateMessage
    });

    expect(screen.queryByRole("button", { name: "Regenerate message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));

    expect(onRegenerateMessage).not.toHaveBeenCalled();
    expect(onEditMessage).toHaveBeenCalledWith(message);
    expect(onCopyMessage).toHaveBeenCalledWith(message);
    expect(onDeleteMessage).toHaveBeenCalledWith("user-actions");
    expect(onBranchFromMessage).toHaveBeenCalledWith("user-actions");
  });

  it("gates mutable actions during a response without gating Copy", () => {
    renderRow({ streaming: true });

    expect(screen.getByRole("button", { name: "Regenerate message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Branch from here" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit message" })).toHaveAttribute(
      "title",
      "Edit is disabled while a response is streaming"
    );
    expect(screen.getByRole("button", { name: "Edit message" })).toHaveAccessibleDescription(
      /unavailable while a response is streaming/i
    );
    expect(screen.getByRole("button", { name: "Delete message" })).toHaveAccessibleDescription(
      /unavailable while a response is streaming/i
    );
  });

  it("gates only edit replacement while an edited branch is saving", () => {
    renderRow({ editPending: true });

    const edit = screen.getByRole("button", { name: "Edit message" });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAccessibleDescription(/another edited branch is saving/i);
    expect(edit).toHaveAttribute(
      "title",
      "Edit is disabled while another edited branch is saving"
    );
    expect(screen.getByRole("button", { name: "Regenerate message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Branch from here" })).toBeEnabled();
  });

  it("renders an optimistic empty assistant as a generic working state", () => {
    const { container } = renderRow({
      answerModelLabel: null,
      message: assistantMessage({ content: "", id: "assistant-queued", status: "streaming" }),
      streaming: true
    });

    expect(container.querySelector('[data-message-id="assistant-queued"]')).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("assistant-pending-state")).toHaveTextContent("Working…");
    expect(screen.getByTestId("assistant-pending-state")).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("streaming-cursor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-empty-state")).not.toBeInTheDocument();
  });

  it("renders partial streamed markdown with an announced liveness state and caret", () => {
    const { container } = renderRow({
      message: assistantMessage({ content: "Partial **answer**", status: "streaming" }),
      streaming: true
    });

    expect(screen.getByTestId("assistant-message-content")).toHaveTextContent("Partial answer");
    expect(screen.getByText("Answer streaming")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("streaming-cursor")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-pending-state")).not.toBeInTheDocument();
    expect(container.querySelector('article[data-role="assistant"]')).toHaveAttribute("aria-busy", "true");
  });

  it("distinguishes cancelled, failed, and empty complete answers", () => {
    const { rerender } = renderRow({
      message: assistantMessage({ content: "Partial result", status: "cancelled" })
    });

    expect(screen.getByText("Partial result")).toBeVisible();
    expect(screen.getByTestId("assistant-cancelled-state")).toHaveTextContent("Response stopped");
    expect(screen.queryByTestId("streaming-cursor")).not.toBeInTheDocument();

    const error = assistantMessage({ content: "Provider timed out", status: "error" });
    rerender(
      <ThreadMessageRow
        answerModelLabel="Fake / Fake QSA"
        message={error}
        showCitations
        showReasoningBlocks={false}
        showToolActivity
        streaming={false}
        onBranchFromMessage={vi.fn()}
        onCopyMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
        onEditMessage={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Response failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Provider timed out");
    expect(screen.queryByTestId("assistant-cancelled-state")).not.toBeInTheDocument();

    const empty = assistantMessage({ content: "", status: "complete" });
    rerender(
      <ThreadMessageRow
        answerModelLabel="Fake / Fake QSA"
        message={empty}
        showCitations
        showReasoningBlocks={false}
        showToolActivity
        streaming={false}
        onBranchFromMessage={vi.fn()}
        onCopyMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
        onEditMessage={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />
    );
    expect(screen.getByTestId("assistant-empty-state")).toHaveTextContent("No answer text was returned.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("suppresses the legacy cancelled placeholder while keeping the stopped status", () => {
    renderRow({ message: assistantMessage({ content: "Stopped.", status: "cancelled" }) });

    expect(screen.queryByText("Stopped.")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant-cancelled-state")).toHaveTextContent("Response stopped");
  });

  it.each([
    {
      expected: "Working…",
      label: "Working",
      pipeline: { answer: "idle", phase: "running", question: "active", search: "idle" } as const
    },
    {
      expected: "Searching…",
      label: "Searching",
      pipeline: { answer: "idle", phase: "running", question: "done", search: "active" } as const
    },
    {
      expected: "Answering…",
      label: "Answering",
      pipeline: { answer: "active", phase: "running", question: "done", search: "done" } as const
    }
  ])("reports only observed $label activity", ({ expected, label, pipeline }) => {
    renderRow({
      message: assistantMessage({ content: "", status: "streaming" }),
      runActivity: pipeline,
      streaming: true
    });

    const activity = screen.getByTestId("thread-run-activity");
    expect(activity).toHaveTextContent(expected);
    expect(activity).toHaveAccessibleName(`Run status: ${label}`);
    expect(activity).not.toHaveTextContent(/Question|waiting/i);
    expect(screen.queryByTestId("assistant-pending-state")).not.toBeInTheDocument();
  });

  it("renders provider warnings as a readable semantic surface", () => {
    renderRow({
      runWarnings: ["Malformed provider event was skipped.", "Search response was incomplete."]
    });

    const warnings = screen.getByLabelText("Run warnings");
    expect(warnings).toHaveTextContent("Run warning");
    expect(warnings).toHaveTextContent("Malformed provider event was skipped.");
    expect(warnings).toHaveTextContent("Search response was incomplete.");
    expect(warnings.querySelectorAll("li")).toHaveLength(2);
  });

  it("shows tool activity by default and hides only its inline projection", () => {
    const artifactSummary = {
      citationCount: 0,
      citations: [],
      reasoningCount: 0,
      reasoningText: [],
      searchCount: 0,
      searchStrategy: null,
      toolCallCount: 1,
      toolCalls: [{
        argumentsPreview: { query: "memory" },
        callId: "call-1",
        capability: "mcp" as const,
        credentialSources: ["personal" as const],
        durationMs: 42,
        errorMessage: null,
        externalAccountLabel: null,
        ordinal: 0,
        resultPreview: { content: [{ text: "found", type: "text" }] },
        round: 1,
        serverName: "Mem0",
        status: "complete" as const,
        toolName: "search"
      }]
    };
    const { props, rerender } = renderRow({ artifactSummary });

    expect(screen.getByTestId("thread-tool-activity")).toHaveTextContent("Mem0");

    rerender(<ThreadMessageRow {...props} artifactSummary={artifactSummary} showToolActivity={false} />);
    expect(screen.queryByTestId("thread-tool-activity")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant-message-content")).toHaveTextContent("Answer");
  });

  it("renders attachment chips from structured user message content", () => {
    renderRow({
      answerModelLabel: null,
      message: {
        content: {
          blocks: [
            {
              text: "See attached",
              type: "text"
            },
            {
              alt: "diagram.png",
              attachmentId: "attachment-image",
              type: "image"
            },
            {
              attachmentId: "attachment-file",
              fileName: "notes.md",
              type: "file"
            }
          ]
        },
        id: "message-attachment",
        parentMessageId: null,
        role: "user",
        status: "complete"
      }
    });

    expect(screen.getByText("See attached")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Message attachments" })).toBeInTheDocument();
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });
});
