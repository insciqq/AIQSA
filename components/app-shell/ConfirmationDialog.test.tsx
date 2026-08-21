import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryResumeConfirmationDialog } from "./ConfirmationDialog";

afterEach(cleanup);

describe("MemoryResumeConfirmationDialog", () => {
  it("discloses the future-only boundary before confirming Resume", async () => {
    const onConfirm = vi.fn();
    render(
      <MemoryResumeConfirmationDialog
        chatTitle="Planning notes"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Resume Memory for Planning notes" });
    expect(dialog).toHaveTextContent("Only new messages sent after you resume");
    expect(dialog).toHaveTextContent("Earlier excluded messages are not added back");
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep excluded" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Resume Memory for this chat" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
