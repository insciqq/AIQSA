import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunReceipt } from "./RunReceipt";

describe("RunReceipt", () => {
  it("renders a restrained static trace line", () => {
    render(
      <RunReceipt
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
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
