import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatContextIndicatorV2 } from "./ChatContextIndicatorV2";

describe("header context indicator", () => {
  it("shows low fullness and keeps technical detail folded with keyboard dismissal", () => {
    render(<ChatContextIndicatorV2 stats={{
      approximateInputTokens: 4400, safeInputBudgetTokens: 10000, totalContextTokens: 12000,
      answerReserveTokens: 800, safetyMarginTokens: 1200
    }} />);
    const trigger = screen.getByRole("button", { name: "Chat context is approximately 37% full" });
    expect(trigger).toHaveTextContent("37%");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Chat context" });
    expect(dialog).toHaveTextContent("full model context window");
    expect(dialog).toHaveTextContent("Space for its next answer is reserved");
    expect(dialog).toHaveTextContent("Safe input budget");
    expect(dialog).toHaveTextContent("Answer reserve800");
    expect(dialog).toHaveTextContent("Safety margin1.2k");
    expect(screen.getByText("Advanced details").closest("details")).not.toHaveAttribute("open");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("does not invent a percentage when capacity is unknown and dismisses outside", () => {
    render(<ChatContextIndicatorV2 stats={{
      approximateInputTokens: 400, safeInputBudgetTokens: null, totalContextTokens: null
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat context size is unavailable" }));
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
    expect(screen.getByRole("dialog")).toHaveTextContent("Files and Workspace won’t be carried over");
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Summarize and open new chat" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("makes exhausted or rejected input actionable (rejected=%s)", (requestRejected) => {
    render(<ChatContextIndicatorV2 stats={{ approximateInputTokens: 400,
      safeInputBudgetTokens: requestRejected ? null : 0, totalContextTokens: requestRejected ? null : 1000,
      requestRejected }} />);
    const trigger = screen.getByTestId("header-context-indicator");
    expect(trigger).toHaveAttribute("data-context-tone", "critical");
    expect(trigger).not.toHaveTextContent("?");
    fireEvent.click(trigger);
    expect(screen.getByRole("alert")).toHaveTextContent("Shorten the message, remove attachments");
  });

});
