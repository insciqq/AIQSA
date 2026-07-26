import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PersistedRun, ThreadArtifactSummary, ThreadMessage } from "./types";
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

function persistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    errorPayload: null,
    estimatedCostMicros: null,
    events: [],
    id: "run-1",
    inputTokens: 80,
    modelId: "fake-qsa",
    outputTokens: 20,
    provider: "fake",
    reasoningTokens: 0,
    searchRuns: [],
    status: "complete",
    toolCalls: [],
    totalTokens: 100,
    ...overrides
  };
}

function artifactSummary(overrides: Partial<ThreadArtifactSummary> = {}): ThreadArtifactSummary {
  return {
    citationCount: 0,
    citations: [],
    reasoningCount: 0,
    reasoningText: [],
    searchCount: 0,
    searchStrategy: null,
    toolCallCount: 0,
    toolCalls: [],
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
    onOpenRunDetails: vi.fn(),
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
    expect(screen.getByTestId("assistant-message-content")).toHaveClass(
      "text-[16px]",
      "text-ink"
    );
    expect(screen.getByTestId("run-receipt")).toHaveTextContent(
      "Run Complete · Fake / Fake QSA"
    );

    const assistantToolbar = screen.getByRole("toolbar", { name: "Assistant message actions" });
    expect(assistantToolbar).toHaveAccessibleDescription("Answer: Answer");
    expect(assistantToolbar).toHaveClass("min-h-11");
    expect(assistantToolbar).toHaveClass("opacity-0");
    expect(assistantToolbar).toHaveClass("focus-within:opacity-100");
    expect(assistantToolbar).toHaveClass("group-hover/turn:opacity-100");
    expect(assistantToolbar).toHaveClass("[@media(hover:none)]:opacity-100");
    expect(within(assistantToolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Regenerate message",
      "Edit message",
      "Copy message",
      "Delete message",
      "Branch from here"
    ]);
    for (const action of within(assistantToolbar).getAllByRole("button")) {
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
    expect(screen.getByText("Question").closest("div.rounded-panel")).toHaveClass(
      "bg-control-surface"
    );
    const userToolbar = screen.getByRole("toolbar", { name: "User message actions" });
    expect(userToolbar).toHaveClass("min-h-11");
    expect(userToolbar).toHaveAccessibleDescription("Question: Question");
    expect(within(userToolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Edit message",
      "Copy message",
      "Delete message",
      "Branch from here"
    ]);
    for (const action of within(userToolbar).getAllByRole("button")) {
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
    expect(screen.queryByTestId("run-receipt")).not.toBeInTheDocument();
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
    expect(screen.getByTestId("run-receipt")).toHaveTextContent("Run Stopped");
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
        onOpenRunDetails={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Response failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Provider timed out");
    expect(screen.getByTestId("run-receipt")).toHaveTextContent("Run Failed");
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
        onOpenRunDetails={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />
    );
    expect(screen.getByTestId("assistant-empty-state")).toHaveTextContent("No answer text was returned.");
    expect(screen.getByTestId("run-receipt")).toHaveTextContent("Run Complete");
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

  it("opens the existing inline evidence disclosures from receipt facts", () => {
    const onOpenRunDetails = vi.fn();
    renderRow({
      artifactSummary: artifactSummary({
        citationCount: 1,
        citations: [{ index: 1, title: "Source", url: "https://example.com" }],
        reasoningCount: 1,
        reasoningText: ["Observed reasoning"],
        searchCount: 1,
        searchDetails: [{ requestPreview: { query: "evidence" }, responsePreview: { ok: true } }],
        toolCallCount: 1,
        toolCalls: [{
          argumentsPreview: { query: "memory" },
          callId: "call-1",
          capability: "mcp",
          credentialSources: [],
          durationMs: 42,
          errorMessage: null,
          externalAccountLabel: null,
          ordinal: 0,
          resultPreview: { ok: true },
          round: 1,
          serverName: "Memory",
          status: "complete",
          toolName: "search"
        }]
      }),
      onOpenRunDetails,
      showReasoningBlocks: true
    });

    const searchDisclosure = screen.getByRole("button", { name: /1 search call Search\/tool call/i });
    const toolDisclosure = screen.getByRole("button", { name: /Used 1 tool Memory/i });
    const citationDisclosure = screen.getByRole("button", { name: "Citations 1" });
    const reasoningDisclosure = screen.getByRole("button", { name: "Reasoning 1" });

    fireEvent.click(screen.getByRole("button", { name: "1 search call" }));
    fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
    fireEvent.click(screen.getByRole("button", { name: "1 citation" }));
    fireEvent.click(screen.getByRole("button", { name: "1 reasoning trace" }));

    expect(searchDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(toolDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(citationDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(reasoningDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(onOpenRunDetails).not.toHaveBeenCalled();
  });

  it("routes status, usage, warnings, context, model, and hidden evidence to Details Events", () => {
    const onOpenRunDetails = vi.fn();
    renderRow({
      artifactSummary: artifactSummary({
        citationCount: 1,
        citations: [{ index: 1, title: "Source", url: "https://example.com" }],
        contextTruncation: { approxDroppedTokens: 10, droppedMessages: 1 }
      }),
      message: assistantMessage({ runId: "run-1" }),
      onOpenRunDetails,
      persistedRun: persistedRun({
        events: [{ eventType: "usage", payload: { totalTokens: 100 }, sequence: 1 }]
      }),
      runWarnings: ["Provider warning"],
      showCitations: false
    });

    for (const name of [
      "Run Complete",
      "Fake / Fake QSA",
      "1 citation",
      "Context trimmed",
      "100 tokens used",
      "1 warning"
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    expect(onOpenRunDetails).toHaveBeenCalledTimes(6);
  });

  it("does not route a historical receipt into another answer's Details events", () => {
    const onOpenRunDetails = vi.fn();
    renderRow({
      artifactSummary: artifactSummary({
        citationCount: 1,
        citations: [{ index: 1, title: "Historical source", url: "https://example.com" }]
      }),
      message: assistantMessage({ runId: "run-historical" }),
      onOpenRunDetails,
      persistedRun: persistedRun({
        events: [{ eventType: "usage", payload: { totalTokens: 100 }, sequence: 1 }],
        id: "run-latest"
      }),
      showCitations: false
    });

    expect(screen.queryByRole("button", { name: "Run Complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fake / Fake QSA" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1 citation" })).not.toBeInTheDocument();
    expect(screen.getByText("Run").parentElement).toHaveAttribute("data-run-segment", "status");
    expect(screen.getByText("1 citation")).toHaveAttribute("data-run-segment", "citations");
    expect(onOpenRunDetails).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("run-receipt")).toHaveTextContent("1 tool call");
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
