import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryCommandFeedback } from "@/lib/contracts/memoryCommand";
import { MemoryCommandStatusV2 } from "./MemoryCommandStatusV2";

const command: MemoryCommandFeedback = {
  commandRef: "opaque-ref", operation: "SAVE", status: "PENDING", updatedAt: "2026-09-28T12:00:00Z"
};

describe("background Memory feedback", () => {
  afterEach(cleanup);

  it("shows pending work without claiming that it succeeded", () => {
    const { rerender } = render(<MemoryCommandStatusV2 command={command} />);
    expect(screen.getByRole("status")).toHaveTextContent("processed in the background");
    expect(screen.queryByText("Memory saved.")).not.toBeInTheDocument();
    rerender(<MemoryCommandStatusV2 command={{ ...command, status: "COMMITTED" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Memory saved.");
    expect(screen.queryByText("opaque-ref")).not.toBeInTheDocument();
  });

  it("keeps ordinary messages quiet until a mutation is recognized", () => {
    render(<MemoryCommandStatusV2 command={{ ...command, operation: "UNKNOWN" }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers review for an unknown outcome without replaying the command", () => {
    const onOpenMemory = vi.fn();
    render(<MemoryCommandStatusV2 command={{ ...command, status: "UNKNOWN" }} onOpenMemory={onOpenMemory} />);
    expect(screen.getByRole("status")).toHaveTextContent("could not be confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Manage memory" }));
    expect(onOpenMemory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("reports classifier failure when the operation itself is unknown", () => {
    render(<MemoryCommandStatusV2 command={{ ...command, operation: "UNKNOWN", status: "UNKNOWN" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("could not be confirmed");
  });
});
