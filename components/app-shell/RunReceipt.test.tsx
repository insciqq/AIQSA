import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunReceipt } from "./RunReceipt";

describe("RunReceipt", () => {
  it("renders a restrained actionable trace line", () => {
    const onActivate = vi.fn();
    render(
      <RunReceipt
        actionableSegments={new Set(["status", "citations"])}
        onActivate={onActivate}
        receipt={{
          facts: [
            { kind: "model", label: "Anthropic / Claude" },
            { kind: "citations", label: "2 citations" }
          ],
          status: "complete",
          statusLabel: "Complete"
        }}
        settled
      />
    );

    const receipt = screen.getByTestId("run-receipt");
    expect(receipt).toHaveAttribute("data-run-receipt-status", "complete");
    expect(receipt).toHaveAttribute("data-run-settled", "true");
    expect(receipt).toHaveClass("border-trace-subtle", "text-ink-muted");
    expect(receipt).toHaveTextContent("Run Complete · Anthropic / Claude · 2 citations");
    fireEvent.click(screen.getByRole("button", { name: "Run Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "2 citations" }));
    expect(screen.queryByRole("button", { name: "Anthropic / Claude" })).not.toBeInTheDocument();
    expect(screen.getByText("Anthropic / Claude")).toHaveAttribute("data-run-segment", "model");
    expect(onActivate.mock.calls).toEqual([["status"], ["citations"]]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
