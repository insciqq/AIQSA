import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatContextIndicatorV2 } from "./ChatContextIndicatorV2";

describe("header context indicator", () => {
  it("shows low fullness and keeps technical detail folded with keyboard dismissal", () => {
    render(<ChatContextIndicatorV2 stats={{
      approximateInputTokens: 4400, safeInputBudgetTokens: 10000, totalContextTokens: 12000
    }} />);
    const trigger = screen.getByRole("button", { name: "Chat context is approximately 44% full" });
    expect(trigger).toHaveTextContent("44%");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Chat context" });
    expect(dialog).toHaveTextContent("Space for its next answer is reserved");
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
});
