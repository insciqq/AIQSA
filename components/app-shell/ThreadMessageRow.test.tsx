import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function revealRunDetails() {
  fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Show run details" }));
  await waitFor(() => expect(screen.getByTestId("answer-metadata-block")).toBeVisible());
}

describe("ThreadMessageRow", () => {
  it("uses one highlighted reading surface and the same positioned action dock for both roles", async () => {
    const { container, unmount } = renderRow({
      message: assistantMessage({ id: "assistant-readable" })
    });

    const assistant = container.querySelector('article[data-role="assistant"]');
    expect(assistant).toHaveAttribute("data-message-id", "assistant-readable");
    expect(assistant).toHaveAttribute("data-status", "complete");
    expect(assistant).toHaveAttribute("tabindex", "0");
    expect(assistant).toHaveClass("[@media(max-height:32rem)]:!pb-7");
    expect(screen.getByRole("article", { name: "Answer" })).toBe(assistant);
    expect(assistant?.firstElementChild).toHaveClass("max-w-reading");
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.queryByText("Fake / Fake QSA")).not.toBeInTheDocument();
    expect(screen.getByTestId("assistant-message-content")).toHaveClass(
      "text-[16px]",
      "text-ink"
    );
    expect(assistant?.firstElementChild).toHaveAttribute("data-message-interaction-surface", "true");
    expect(screen.queryByTestId("run-receipt")).not.toBeInTheDocument();

    const assistantToolbar = screen.getByRole("toolbar", { name: "Assistant message actions" });
    expect(assistantToolbar).toHaveAttribute("data-message-controls-kind", "actions");
    expect(assistantToolbar).toHaveAccessibleDescription("Answer: Answer");
    expect(assistantToolbar).toHaveClass("absolute", "bottom-0", "right-2", "min-h-11");
    expect(assistantToolbar).not.toHaveClass("opacity-0");
    expect(within(assistantToolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Regenerate message",
      "Edit message",
      "Copy message",
      "More message actions"
    ]);
    expect(within(assistantToolbar).getByText("Regenerate")).toHaveClass("sr-only");
    expect(within(assistantToolbar).getByText("Edit")).toHaveClass("sr-only");
    expect(within(assistantToolbar).getByText("Copy")).toHaveClass("sr-only");
    expect(within(assistantToolbar).getByText("More")).toHaveClass("sr-only");
    for (const action of within(assistantToolbar).getAllByRole("button")) {
      expect(action).toHaveAccessibleDescription("Answer: Answer");
    }
    fireEvent.click(within(assistantToolbar).getByRole("button", { name: "More message actions" }));
    const assistantMenu = screen.getByRole("menu", { name: "More message actions" });
    expect(within(assistantMenu).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Show run details",
      "Delete message",
      "Branch from here"
    ]);
    for (const action of within(assistantMenu).getAllByRole("menuitem")) {
      expect(action).toHaveAccessibleDescription("Answer: Answer");
    }
    expect(
      screen.getByTestId("assistant-message-content").compareDocumentPosition(assistantToolbar) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(within(assistantMenu).getByRole("menuitem", { name: "Show run details" }));
    await waitFor(() =>
      expect(screen.getByTestId("run-receipt")).toHaveTextContent(
        "Run Complete · Fake / Fake QSA"
      )
    );
    fireEvent.click(within(assistantToolbar).getByRole("button", { name: "More message actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide run details" }));
    await waitFor(() => expect(screen.queryByTestId("run-receipt")).not.toBeInTheDocument());
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
    expect(user).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("article", { name: "Question" })).toBe(user);
    expect(user?.firstElementChild).toHaveClass("max-w-reading");
    expect(user?.firstElementChild).toHaveAttribute("data-message-interaction-surface", "true");
    expect(screen.queryByText("User")).not.toBeInTheDocument();
    expect(screen.getByText("Question").closest("div.rounded-panel")).toHaveClass(
      "bg-control-surface"
    );
    const userToolbar = screen.getByRole("toolbar", { name: "User message actions" });
    expect(userToolbar).toHaveAttribute("data-message-controls-kind", "actions");
    expect(userToolbar).toHaveClass("absolute", "bottom-0", "right-2", "min-h-11");
    expect(userToolbar).toHaveAccessibleDescription("Question: Question");
    expect(within(userToolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Regenerate message",
      "Edit message",
      "Copy message",
      "More message actions"
    ]);
    for (const action of within(userToolbar).getAllByRole("button")) {
      expect(action).toHaveAccessibleDescription("Question: Question");
    }
  });

  it("uses a noninteractive touch on the message as the contextual-control disclosure", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }))
    );
    try {
      const message = assistantMessage({ id: "assistant-touch" });
      const onCopyMessage = vi.fn();
      const onToggleMobileControls = vi.fn();
      renderRow({ message, onCopyMessage, onToggleMobileControls });

      fireEvent.click(screen.getByRole("article", { name: "Answer" }));
      expect(onToggleMobileControls).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("assistant-message-content"));
      expect(onToggleMobileControls).toHaveBeenCalledWith("assistant-touch");

      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
      expect(onCopyMessage).toHaveBeenCalledWith(message);
      expect(onToggleMobileControls).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("calls every assistant action with the message or message id it owns", async () => {
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
    const more = screen.getByRole("button", { name: "More message actions" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith("assistant-actions"));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Branch from here" }));

    expect(onRegenerateMessage).toHaveBeenCalledWith("assistant-actions");
    expect(onEditMessage).toHaveBeenCalledWith(message);
    expect(onCopyMessage).toHaveBeenCalledWith(message);
    expect(onDeleteMessage).toHaveBeenCalledWith("assistant-actions");
    await waitFor(() => expect(onBranchFromMessage).toHaveBeenCalledWith("assistant-actions"));
  });

  it("calls the same visible user actions as the assistant dock", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Regenerate message" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    const more = screen.getByRole("button", { name: "More message actions" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    await waitFor(() => expect(onDeleteMessage).toHaveBeenCalledWith("user-actions"));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Branch from here" }));

    expect(onRegenerateMessage).toHaveBeenCalledWith("user-actions");
    expect(onEditMessage).toHaveBeenCalledWith(message);
    expect(onCopyMessage).toHaveBeenCalledWith(message);
    expect(onDeleteMessage).toHaveBeenCalledWith("user-actions");
    await waitFor(() => expect(onBranchFromMessage).toHaveBeenCalledWith("user-actions"));
  });

  it("gates mutable actions during a response without gating Copy", () => {
    renderRow({ streaming: true });

    expect(screen.getByRole("button", { name: "Regenerate message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeEnabled();
    const more = screen.getByRole("button", { name: "More message actions" });
    expect(more).toBeDisabled();
    expect(more).toHaveAccessibleDescription(/unavailable while a response is streaming/i);
    fireEvent.click(more);
    expect(screen.queryByRole("menu", { name: "More message actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit message" })).toHaveAttribute(
      "title",
      "Edit is disabled while a response is streaming"
    );
    expect(screen.getByRole("button", { name: "Edit message" })).toHaveAccessibleDescription(
      /unavailable while a response is streaming/i
    );
  });

  it("dismisses an open uncommon-action menu when streaming starts", async () => {
    const view = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    expect(screen.getByRole("menu", { name: "More message actions" })).toBeVisible();

    view.rerender(<ThreadMessageRow {...view.props} streaming />);

    expect(screen.queryByRole("menu", { name: "More message actions" })).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "More message actions" });
    expect(more).toBeDisabled();
    expect(more).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(more).not.toHaveAttribute("aria-controls"));
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
    fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete message" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Branch from here" })).toBeEnabled();
  });

  it("supports keyboard entry and Escape focus restoration for uncommon actions", async () => {
    renderRow();
    const trigger = screen.getByRole("button", { name: "More message actions" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "More message actions" });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Show run details" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "End" });
    expect(within(menu).getByRole("menuitem", { name: "Branch from here" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "More message actions" })).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const reopenedMenu = await screen.findByRole("menu", { name: "More message actions" });
    await waitFor(() => expect(
      within(reopenedMenu).getByRole("menuitem", { name: "Branch from here" })
    ).toHaveFocus());
  });

  it("keeps Tab order deterministic when the uncommon-action menu is portalled", async () => {
    const view = renderRow();
    view.rerender(
      <>
        <ThreadMessageRow {...view.props} />
        <button type="button">After message</button>
      </>
    );
    const trigger = screen.getByRole("button", { name: "More message actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    let menu = await screen.findByRole("menu", { name: "More message actions" });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Show run details" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "Tab" });
    await waitFor(() => expect(screen.getByRole("button", { name: "After message" })).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "More message actions" })).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    menu = await screen.findByRole("menu", { name: "More message actions" });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Branch from here" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy message" })).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "More message actions" })).not.toBeInTheDocument();
  });

  it("portals and prefers placing the uncommon-action menu below when both sides fit", async () => {
    const zeroRect = {
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "BUTTON" && this.getAttribute("aria-label") === "More message actions") {
        return {
          ...zeroRect,
          bottom: 344,
          height: 44,
          left: 256,
          right: 300,
          top: 300,
          width: 44,
          x: 256,
          y: 300
        };
      }
      if (this.getAttribute("role") === "menu") {
        return {
          ...zeroRect,
          bottom: 120,
          height: 120,
          right: 208,
          width: 208
        };
      }
      return zeroRect;
    });
    renderRow();

    fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    const menu = await screen.findByRole("menu", { name: "More message actions" });

    await waitFor(() => expect(menu).toHaveAttribute("data-placement", "below"));
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveClass("fixed", "max-w-[calc(100vw-1rem)]");
    expect(menu).toHaveStyle({ top: "352px", visibility: "visible" });
  });

  it("renders an optimistic empty assistant as a generic working state", () => {
    const { container } = renderRow({
      answerModelLabel: null,
      message: assistantMessage({ content: "", id: "assistant-queued", status: "streaming" }),
      streaming: true
    });

    expect(container.querySelector('[data-message-id="assistant-queued"]')).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("assistant-pending-state")).toHaveTextContent("Working…");
    expect(screen.getByTestId("assistant-pending-state")).not.toHaveAttribute("role");
    expect(screen.queryByTestId("streaming-cursor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-empty-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("run-receipt")).not.toBeInTheDocument();
  });

  it("renders partial streamed markdown with a non-live visual caret", () => {
    const { container } = renderRow({
      message: assistantMessage({ content: "Partial **answer**", status: "streaming" }),
      streaming: true
    });

    expect(screen.getByTestId("assistant-message-content")).toHaveTextContent("Partial answer");
    expect(screen.queryByText("Answer streaming")).not.toBeInTheDocument();
    expect(screen.getByTestId("streaming-cursor")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-pending-state")).not.toBeInTheDocument();
    expect(container.querySelector('article[data-role="assistant"]')).toHaveAttribute("aria-busy", "true");
  });

  it("offers a visible answer retry that uses the existing regenerate action", () => {
    const onRegenerateMessage = vi.fn();
    renderRow({
      message: assistantMessage({
        content: "Provider timed out",
        id: "failed-answer",
        status: "error"
      }),
      onRegenerateMessage
    });

    const retry = screen.getByRole("button", { name: "Retry answer" });
    expect(retry).toBeVisible();
    expect(retry).toHaveAccessibleDescription("Answer: Provider timed out");

    fireEvent.click(retry);

    expect(onRegenerateMessage).toHaveBeenCalledTimes(1);
    expect(onRegenerateMessage).toHaveBeenCalledWith("failed-answer");
  });

  it("disables answer retry while another response is streaming", () => {
    const onRegenerateMessage = vi.fn();
    renderRow({
      message: assistantMessage({
        content: "Provider timed out",
        id: "failed-answer",
        status: "error"
      }),
      onRegenerateMessage,
      streaming: true
    });

    const retry = screen.getByRole("button", { name: "Retry answer" });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleDescription(
      /regenerating are unavailable while a response is streaming/u
    );

    fireEvent.click(retry);
    expect(onRegenerateMessage).not.toHaveBeenCalled();
  });

  it("distinguishes cancelled, failed, and empty complete answers after explicit detail disclosure", async () => {
    const { rerender } = renderRow({
      message: assistantMessage({ content: "Partial result", status: "cancelled" })
    });

    expect(screen.getByText("Partial result")).toBeVisible();
    expect(screen.getByTestId("assistant-cancelled-state")).toHaveTextContent("Response stopped");
    expect(screen.getByTestId("assistant-cancelled-state")).not.toHaveAttribute("role");
    expect(screen.queryByTestId("run-receipt")).not.toBeInTheDocument();
    await revealRunDetails();
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
    expect(screen.getByTestId("assistant-error-state")).toHaveTextContent("Response failed");
    expect(screen.getByTestId("assistant-error-state")).toHaveTextContent("Provider timed out");
    expect(screen.getByTestId("assistant-error-state")).not.toHaveAttribute("role");
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
    expect(screen.queryByTestId("assistant-error-state")).not.toBeInTheDocument();
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
    expect(activity).not.toHaveAttribute("role");
    expect(activity).not.toHaveAttribute("aria-live");
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

  it("keeps Search directly collapsed under a completed answer and opens its facts in one click", async () => {
    const onOpenRunDetails = vi.fn();
    renderRow({
      artifactSummary: artifactSummary({
        citationCount: 1,
        citations: [{ index: 1, title: "Source", url: "https://example.com" }],
        reasoningCount: 1,
        reasoningText: ["Observed reasoning"],
        searchActivity: [{
          displayName: "OpenAI Search",
          providerOperations: [],
          providerOperationsTruncated: false,
          query: "evidence",
          sourceCount: 1,
          sources: [{ rank: 1, title: "Source", url: "https://example.com" }],
          status: "complete"
        }],
        searchCount: 1,
        searchStrategy: "openai-native-web-search",
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

    expect(screen.queryByTestId("answer-metadata-block")).not.toBeInTheDocument();
    const directSearch = screen.getByRole("button", { name: /Search OpenAI Search.*Completed/i });
    expect(directSearch).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(directSearch);
    expect(directSearch).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("thread-search-details")).toHaveTextContent("evidence");
    fireEvent.click(directSearch);

    await revealRunDetails();
    const metadata = screen.getByTestId("answer-metadata-block");
    const searchDisclosure = within(metadata).getByRole("button", { name: "1 search call" });
    const citationDisclosure = within(metadata).getByRole("button", { name: "1 citation" });
    const toolDisclosure = screen.getByRole("button", { name: /Used 1 tool Memory/i });
    const reasoningDisclosure = screen.getByRole("button", { name: "Reasoning 1" });
    expect(within(metadata).getByTestId("run-receipt")).toHaveTextContent(
      "Run Complete · Fake / Fake QSA · 1 search call · OpenAI Search · 1 tool call · 1 citation · 1 reasoning trace"
    );
    expect(screen.getByTestId("thread-search-summary")).toBeVisible();
    expect(screen.queryByTestId("thread-citations-block")).not.toBeInTheDocument();

    fireEvent.click(searchDisclosure);
    fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
    fireEvent.click(citationDisclosure);
    fireEvent.click(screen.getByRole("button", { name: "1 reasoning trace" }));

    expect(searchDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(toolDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(citationDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(reasoningDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("thread-search-details")).toHaveTextContent("evidence");
    expect(within(metadata).getByRole("link", { name: "[1] Source" })).toBeVisible();

    fireEvent.click(searchDisclosure);
    fireEvent.click(citationDisclosure);
    expect(searchDisclosure).toHaveAttribute("aria-expanded", "false");
    expect(citationDisclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("thread-search-details")).not.toBeInTheDocument();
    expect(within(metadata).queryByRole("link", { name: "[1] Source" })).not.toBeInTheDocument();
    expect(onOpenRunDetails).not.toHaveBeenCalled();
  });

  it("routes status, usage, warnings, context, model, and hidden evidence to Details Events", async () => {
    const onOpenRunDetails = vi.fn();
    renderRow({
      artifactSummary: artifactSummary({
        citationCount: 1,
        citations: [{ index: 1, title: "Source", url: "https://example.com" }],
        contextTruncation: { approxDroppedTokens: 10, droppedMessages: 1 }
      }),
      message: assistantMessage({ runId: "run-1", runUsage: { totalTokens: 100 } }),
      onOpenRunDetails,
      persistedRun: persistedRun({
        events: [{ eventType: "usage", payload: { totalTokens: 100 }, sequence: 1 }]
      }),
      runWarnings: ["Provider warning"],
      showCitations: false
    });
    await revealRunDetails();

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

  it("keeps completed client Search direct, independent of generic tool visibility, and not duplicated", () => {
    const clientSummary = artifactSummary({
        searchActivity: [{
          displayName: "OpenAI Search",
          providerOperations: [],
          providerOperationsTruncated: false,
          query: "latest news in Moscow",
          sourceCount: 4,
          sources: [],
          status: "complete"
        }],
        searchCount: 1,
        searchStrategy: "client-search-plan",
        toolCallCount: 1,
        toolCalls: [{
          argumentsPreview: { query: "latest news in Moscow" },
          callId: "search-call-1",
          capability: "web_search",
          credentialSources: [],
          durationMs: 145_900,
          errorMessage: null,
          externalAccountLabel: null,
          ordinal: 0,
          resultPreview: null,
          round: 1,
          searchExecutions: [{
            displayName: "Web Search · Sol",
            durationMs: 145_800,
            modelId: "gpt-5.6-sol",
            optionId: "web-search-sol",
            provider: "openai-compatible",
            providerOperations: [],
            providerOperationsTruncated: false,
            query: "latest news in Moscow",
            sourceCount: 4,
            status: "complete",
            warning: null
          }],
          serverName: null,
          status: "complete",
          toolName: "search_selected_engines"
        }]
    });
    const { props, rerender } = renderRow({ artifactSummary: clientSummary });

    expect(screen.getByTestId("thread-search-summary")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Search OpenAI Search/i })).toHaveLength(1);
    expect(screen.queryByTestId("thread-tool-activity")).not.toBeInTheDocument();
    expect(screen.queryByText("search_selected_engines")).not.toBeInTheDocument();

    rerender(<ThreadMessageRow {...props} artifactSummary={clientSummary} showToolActivity={false} />);
    expect(screen.getByTestId("thread-search-summary")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Search OpenAI Search/i })).toHaveLength(1);
  });

  it("loads a historical Knowledge receipt independently of generic tool visibility", async () => {
    const onInspectRun = vi.fn(async () => undefined);
    renderRow({
      artifactSummary: artifactSummary({
        knowledgeInvocationCount: 1,
        knowledgeOutcomes: [{ invocationOrdinal: 1, outcome: "base_empty" }]
      }),
      message: assistantMessage({ runId: "run-historical" }),
      onInspectRun,
      persistedRun: persistedRun({ id: "run-latest" }),
      showToolActivity: false
    });

    const disclosure = screen.getByRole("button", { name: /Knowledge 1 invocation/ });
    expect(screen.queryByTestId("thread-tool-activity")).not.toBeInTheDocument();
    fireEvent.click(disclosure);
    await waitFor(() => expect(onInspectRun).toHaveBeenCalledWith("run-historical"));
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("renders an honest collapsed Search row when only the historical observation survives", () => {
    renderRow({
      artifactSummary: artifactSummary({
        searchActivity: [],
        searchCount: 1,
        searchDisplayName: "Perplexity Search",
        searchStrategy: "perplexity-tool-search"
      })
    });

    const search = screen.getByRole("button", {
      name: /Search Perplexity Search.*Status unavailable/i
    });
    expect(search).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(search);
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("thread-search-details")).toHaveTextContent(
      "Detailed Search evidence is unavailable for this run."
    );
  });

  it("does not route a historical receipt into another answer's Details events", async () => {
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
    await revealRunDetails();

    expect(screen.queryByRole("button", { name: "Run Complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fake / Fake QSA" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1 citation" })).not.toBeInTheDocument();
    expect(screen.getByText("Run").parentElement).toHaveAttribute("data-run-segment", "status");
    expect(screen.getByText("1 citation")).toHaveAttribute("data-run-segment", "citations");
    expect(onOpenRunDetails).not.toHaveBeenCalled();
  });

  it("shows tool activity by default and hides only its inline projection", async () => {
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
    await revealRunDetails();

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
