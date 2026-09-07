import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminSheet } from "./AdminSheet";

describe("AdminSheet", () => {
  it("renders a labelled modal dialog over an inert page, closes on Escape and scrim, and restores focus", async () => {
    const onClose = vi.fn();
    const view = render(
      <>
        <button type="button">Opener</button>
        <AdminSheet onClose={onClose} open={false} testId="sheet" title="Add key">
          <input aria-label="Label" />
        </AdminSheet>
      </>
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener.closest("div")).not.toHaveAttribute("aria-hidden");

    view.rerender(
      <>
        <button type="button">Opener</button>
        <AdminSheet
          description="Runs a few small paid requests"
          footer={<button type="button">Test &amp; Save</button>}
          onClose={onClose}
          open
          testId="sheet"
          title="Add key"
        >
          <input aria-label="Label" />
        </AdminSheet>
      </>
    );

    const dialog = await screen.findByRole("dialog", { name: "Add key" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Runs a few small paid requests");
    expect(screen.getByRole("button", { name: "Test & Save" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
    expect(opener.closest("div")).toHaveAttribute("aria-hidden", "true");
    expect((opener.closest("div") as HTMLElement).inert).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    view.rerender(
      <>
        <button type="button">Opener</button>
        <AdminSheet onClose={onClose} open={false} testId="sheet" title="Add key">
          <input aria-label="Label" />
        </AdminSheet>
      </>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener.closest("div")).not.toHaveAttribute("aria-hidden");
    expect((opener.closest("div") as HTMLElement).inert).toBeFalsy();
  });

  it("keeps the sheet open while closing is blocked", async () => {
    const onClose = vi.fn();
    render(
      <AdminSheet closeBlocked onClose={onClose} open testId="sheet" title="Rotate key">
        <p>Saving…</p>
      </AdminSheet>
    );
    const dialog = await screen.findByRole("dialog", { name: "Rotate key" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
});
