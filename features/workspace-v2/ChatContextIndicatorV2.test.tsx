import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatContextIndicatorV2 } from "./ChatContextIndicatorV2";

describe("header context indicator", () => {
  const stats = { approximateInputTokens: 4400, safeInputBudgetTokens: 10000, totalContextTokens: 12000 };

  it("separates cumulative usage from the context estimate and keeps it visible without advanced details", () => {
    render(<ChatContextIndicatorV2 stats={stats} usageStats={{ hasCompletedAnswer: true, totalTokens: 43210,
      estimatedCostMicros: 125000, recordCount: 4, knownCostRecordCount: 4, incompleteRecordCount: 0 }} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    const context = screen.getByRole("group", { name: "Context" });
    const spent = screen.getByRole("group", { name: "Spent" });
    expect(context).toHaveTextContent("37% full");
    expect(spent).toHaveTextContent("Tokens spent43,210");
    expect(spent).toHaveTextContent("Approximate cost≈ $0.125");
    expect(within(spent).getByText("43,210")).toBeVisible();
    expect(spent).not.toHaveTextContent(/known for|incomplete|memory|cached|branch/iu);
    expect(screen.getByText("Advanced details").closest("details")).not.toHaveAttribute("open");
  });

  it("describes partial cost and incomplete token records independently", () => {
    render(<ChatContextIndicatorV2 stats={stats} usageStats={{ hasCompletedAnswer: true, totalTokens: 932,
      estimatedCostMicros: 1250000, recordCount: 5, knownCostRecordCount: 2, incompleteRecordCount: 1 }} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    const spent = screen.getByRole("group", { name: "Spent" });
    expect(spent).toHaveTextContent("Tokens spent932");
    expect(spent).toHaveTextContent("Approximate cost≈ $1.25");
    expect(spent).toHaveTextContent(/cost known for 2 of 5 requests/iu);
    expect(spent).toHaveTextContent("Token usage is incomplete for 1 of 5 requests.");
  });

  it("keeps missing cost and token usage unknown while showing the received records", () => {
    const view = render(<ChatContextIndicatorV2 stats={stats} usageStats={{ hasCompletedAnswer: true, totalTokens: 1200,
      estimatedCostMicros: null, recordCount: 2, knownCostRecordCount: 0, incompleteRecordCount: 0 }} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    const spent = screen.getByRole("group", { name: "Spent" });
    expect(spent).toHaveTextContent("Tokens spent1,200");
    expect(spent).toHaveTextContent("Approximate cost—");
    expect(spent).not.toHaveTextContent(/known for|incomplete/iu);
    view.rerender(<ChatContextIndicatorV2 stats={stats} usageStats={{ hasCompletedAnswer: true, totalTokens: null,
      estimatedCostMicros: null, recordCount: 2, knownCostRecordCount: 0, incompleteRecordCount: 2 }} />);
    expect(spent).toHaveTextContent("Tokens spent—");
    expect(spent).toHaveTextContent("Token usage is incomplete for 2 of 2 requests.");
  });

  it.each([null, { hasCompletedAnswer: true, totalTokens: null, estimatedCostMicros: null, recordCount: 0,
    knownCostRecordCount: 0, incompleteRecordCount: 0 }])("omits spent before any accounting record exists: %j", (usageStats) => {
    render(<ChatContextIndicatorV2 stats={stats} usageStats={usageStats} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    expect(screen.getByRole("group", { name: "Context" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Spent" })).toBeNull();
  });

  it("hides pre-answer receipts until an answer attempt without discarding their totals", () => {
    const usageStats = { hasCompletedAnswer: false, recordCount: 1, knownCostRecordCount: 1,
      incompleteRecordCount: 0, totalTokens: 750, estimatedCostMicros: 25000 };
    const view = render(<ChatContextIndicatorV2 stats={stats} usageStats={usageStats} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    expect(screen.queryByRole("group", { name: "Spent" })).toBeNull();
    view.rerender(<ChatContextIndicatorV2 stats={stats} usageStats={{ ...usageStats, hasCompletedAnswer: true }} />);
    expect(screen.getByRole("group", { name: "Spent" })).toHaveTextContent("Tokens spent750");
    expect(screen.getByRole("group", { name: "Spent" })).toHaveTextContent("Approximate cost≈ $0.025");
  });

  it.each([
    [{ status: "pending" }, "files are waiting to be restored"],
    [{ status: "ready" }, "files were restored in this chat"],
    [{ status: "none" }, "had no Workspace project disk to copy"],
    [{ status: "failed", reason: "timeout" }, "copy exceeded its time budget"],
    [{ status: "failed", reason: "reset_consumed" }, "will not be restored again"],
    [{ status: "failed", reason: "restored_disk_lost" }, "old copy will not be applied again"]
  ] as const)("explains Workspace copy state %j", (continuationFiles, message) => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 50, safeInputBudgetTokens: 1000, totalContextTokens: 2000 }} continuationFiles={continuationFiles} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    expect(screen.getByRole("dialog")).toHaveTextContent(message);
    expect(screen.getByRole(continuationFiles.status === "failed" ? "alert" : "status")).toHaveTextContent(message);
  });

  it("shows low fullness and keeps technical detail folded with keyboard dismissal", () => {
    render(<ChatContextIndicatorV2 stats={{
      approximateInputTokens: 4400, safeInputBudgetTokens: 10000, totalContextTokens: 12000,
      answerReserveTokens: 800, safetyMarginTokens: 1200
    }} />);
    const trigger = screen.getByRole("button", { name: "Chat context is approximately 37% full. Preliminary estimate" });
    expect(trigger).toHaveTextContent("37%");
    expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    expect(trigger.querySelector(".v2-chat-context-track")).toHaveAttribute("stroke-dasharray", "3 3");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Chat context" });
    expect(screen.getByText("Preliminary estimate.")).toBeVisible();
    expect(screen.getByText(/Share of the model's full context window/)).not.toBeVisible();
    expect(dialog).toHaveTextContent("Safe input budget");
    expect(dialog).toHaveTextContent("Answer reserve800");
    expect(dialog).toHaveTextContent("Safety margin1.2k");
    expect(screen.getByText("Advanced details").closest("details")).not.toHaveAttribute("open");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps an ordinary continuation compact and exposes its explanation on the action", () => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 50,
      safeInputBudgetTokens: 1000, totalContextTokens: 2000,
      session: { approximateInputTokens: 50, contextWindow: 2000, droppedMessages: 0,
        loadedTools: 0, maxOutputTokens: 800, modelId: "model", phase: "after_answer",
        provider: "fake", safetyMarginTokens: 200, version: 1 } }}
      continuation={{ busy: false, error: null, suggested: false,
        onContinue: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn() }} />);
    fireEvent.click(screen.getByTestId("header-context-indicator"));
    const action = screen.getByRole("button", { name: "Summarize and open new chat" });
    expect(action).toHaveAttribute("data-tone", "ghost");
    expect(screen.getByText("Based on the last reply.")).toBeVisible();
    const carryOver = "A new chat starts with a summary of this one and takes your draft, files and settings (and Workspace files, if on). This chat stays as it is.";
    expect(action).toHaveAttribute("data-tooltip", carryOver);
    expect(action).toHaveAccessibleDescription(carryOver);
    // Hover devices hide this note by CSS; without hover it is the only visible carry-over text.
    const touchNote = screen.getByText(carryOver);
    expect(touchNote).toHaveClass("v2-chat-context-touch-note");
    expect(touchNote).toHaveAttribute("aria-hidden", "true");
    expect(touchNote.parentElement).toBe(action.parentElement);
    expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();
    expect(screen.getByText(/Tools and private context are added/)).not.toBeVisible();
  });

  it.each([
    { suggested: true, approximateInputTokens: 50, omitted: 0 },
    { suggested: false, approximateInputTokens: 750, omitted: 0 },
    { suggested: false, approximateInputTokens: 1000, omitted: 0 },
    { suggested: false, approximateInputTokens: 50, omitted: 1 }
  ])("shows carry-over and both actions when recommended: %j", ({ suggested, approximateInputTokens, omitted }) => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens,
      safeInputBudgetTokens: 1000, totalContextTokens: 2000,
      session: { approximateInputTokens, contextWindow: 2000, droppedMessages: omitted,
        loadedTools: 0, maxOutputTokens: 800, modelId: "model", phase: "after_answer",
        provider: "fake", safetyMarginTokens: 200, version: 1 }
    }} continuation={{ busy: false, error: null, suggested,
      onContinue: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn() }} />);
    if (!suggested) fireEvent.click(screen.getByTestId("header-context-indicator"));
    expect(screen.getByText(/A new chat starts with a summary/)).toBeVisible();
    expect(screen.getByText(/A new chat starts with a summary/)).not.toHaveClass("v2-chat-context-touch-note");
    expect(screen.getAllByText(/A new chat starts with a summary/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stay here" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Summarize and open new chat" })).toHaveAttribute("data-tone", "primary");
  });

  it("does not invent a percentage when capacity is unknown and dismisses outside", () => {
    render(<ChatContextIndicatorV2 stats={{
      approximateInputTokens: 400, safeInputBudgetTokens: null, totalContextTokens: null
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat context size is unavailable. Preliminary estimate" }));
    expect(screen.getByRole("dialog")).not.toHaveTextContent("% full");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("explains omitted history and requires an explicit continuation action", () => {
    const onContinue = vi.fn();
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 6000, safeInputBudgetTokens: 7976,
      totalContextTokens: 10000, session: { approximateInputTokens: 6000, contextWindow: 10000,
        droppedMessages: 4, loadedTools: 3, maxOutputTokens: 1024, modelId: "model", phase: "after_answer",
        provider: "fake", safetyMarginTokens: 1000, version: 1 }
    }} continuation={{ busy: false, error: null, suggested: true, onContinue, onDismiss: vi.fn(), onCancel: vi.fn() }} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("4 earlier messages are still in this chat, but were omitted from the model request");
    expect(screen.getByText(/A new chat starts with a summary of this one/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Stay here" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Summarize and open new chat" })).toHaveAttribute("data-tone", "primary");
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Summarize and open new chat" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("keeps a snapshot ring solid and describes the separate draft estimate", () => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 7000, safeInputBudgetTokens: 7976,
      totalContextTokens: 10000, draftInputTokens: 1000, session: { approximateInputTokens: 6000,
        contextWindow: 10000, droppedMessages: 0, loadedTools: 3, maxOutputTokens: 1024,
        modelId: "model", phase: "after_answer", provider: "fake", safetyMarginTokens: 1000, version: 1 }
    }} />);
    const trigger = screen.getByRole("button", { name: "Chat context is approximately 70% full" });
    expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    expect(trigger).toHaveAttribute("data-context-tone", "warning");
    expect(trigger.querySelector(".v2-chat-context-track")).not.toHaveAttribute("stroke-dasharray");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveTextContent("Based on the last reply and your draft.");
    expect(screen.getByRole("dialog")).toHaveTextContent("Request and answer estimate~6k");
    expect(screen.getByRole("dialog")).toHaveTextContent("Draft and attachments estimate~1k");
    expect(screen.getByRole("dialog")).toHaveTextContent("Available input tokens976");
  });

  it("describes changed settings and an earlier measured base honestly, including an unknown window", () => {
    const stats = {
      approximateInputTokens: 6321, safeInputBudgetTokens: null, totalContextTokens: null,
      answerReserveTokens: null, safetyMarginTokens: null,
      basis: "settings_changed" as const, snapshotSource: "persisted" as const,
      session: { approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 0,
        loadedTools: 3, maxOutputTokens: 1024, modelId: "model", phase: "after_answer" as const,
        provider: "fake", safetyMarginTokens: 1000, version: 1 as const }
    };
    const view = render(<ChatContextIndicatorV2 stats={stats} />);
    const trigger = screen.getByTestId("header-context-indicator");
    expect(trigger).toHaveTextContent("?");
    expect(trigger).toHaveAttribute("data-context-estimate", "snapshot");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("Based on the last reply. Settings changed since.", { exact: true })).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveTextContent("Context tokens~6.3k");
    expect(screen.getByRole("dialog")).toHaveTextContent("Answer reserveUnavailable");
    expect(screen.getByRole("dialog")).toHaveTextContent("Safety marginUnavailable");
    view.rerender(<ChatContextIndicatorV2 stats={{ ...stats, basis: "preliminary", approximateInputTokensAfterSession: 321 }} />);
    expect(trigger).toHaveAttribute("data-context-estimate", "preliminary");
    expect(trigger.querySelector(".v2-chat-context-track")).toHaveAttribute("stroke-dasharray", "3 3");
    expect(screen.getByRole("dialog")).toHaveTextContent("Preliminary estimate.");
  });

  it.each([
    [{ requestInFlight: true }, "Based on the current request."],
    [{ requestInFlight: false }, "Based on the last request."],
    [{}, "Based on the last request."],
    [{ requestInFlight: false, draftInputTokens: 25 }, "Based on the last request and your draft."],
    [{ requestInFlight: false, basis: "settings_changed" as const }, "Based on the last request. Settings changed since."]
  ])("words a request measurement by whether its run is in flight: %j", (extra, line) => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 6000, safeInputBudgetTokens: 7976,
      totalContextTokens: 10000, basis: "measured", snapshotSource: "persisted", ...extra,
      session: { approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 0, loadedTools: 3,
        maxOutputTokens: 1024, modelId: "model", phase: "request", provider: "fake", safetyMarginTokens: 1000, version: 1 }
    }} />);
    const trigger = screen.getByTestId("header-context-indicator");
    expect(trigger).toHaveAttribute("title", `Chat context is approximately 60% full. ${line}`);
    fireEvent.click(trigger);
    expect(screen.getByText(line, { exact: true })).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveTextContent("Request estimate~6k");
  });

  it.each([false, true])("makes exhausted or rejected input actionable (rejected=%s)", (requestRejected) => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 400,
      safeInputBudgetTokens: requestRejected ? null : 0, totalContextTokens: requestRejected ? null : 1000,
      requestRejected }} />);
    const trigger = screen.getByTestId("header-context-indicator");
    expect(trigger).toHaveAttribute("data-context-tone", "critical");
    expect(trigger).not.toHaveTextContent("?");
    fireEvent.click(trigger);
    expect(screen.getByRole("alert")).toHaveTextContent("Shorten it, remove attachments");
  });

});
