import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryCommandFeedback } from "@/lib/contracts/memoryCommand";
import { MemoryCommandStatusV2, memoryCommandIsVisible } from "./MemoryCommandStatusV2";

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

  it("shows a needed choice with the Memory link", () => {
    const onOpenMemory = vi.fn();
    render(<MemoryCommandStatusV2 command={{ ...command, status: "AMBIGUOUS" }} onOpenMemory={onOpenMemory} />);
    expect(screen.getByRole("status")).toHaveTextContent("Several memories match");
    fireEvent.click(screen.getByRole("button", { name: "Manage memory" }));
    expect(onOpenMemory).toHaveBeenCalledOnce();
  });

  it.each(["FAILED", "UNKNOWN", "STALE", "REJECTED"] as const)(
    "keeps a %s outcome silent, including historical and unrecognized commands",
    (status) => {
      for (const operation of ["SAVE", "UNKNOWN"] as const) {
        const { container, unmount } = render(
          <MemoryCommandStatusV2 command={{ ...command, operation, status }} onOpenMemory={vi.fn()} />
        );
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        unmount();
      }
      expect(memoryCommandIsVisible({ ...command, status })).toBe(false);
    }
  );
});
