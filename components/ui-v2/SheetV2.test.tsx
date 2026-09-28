import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UiV2Sheet } from "./SheetV2";

describe("UiV2Sheet", () => {
  it("renders a labelled modal dialog over an inert page, closes on Escape and scrim, and restores focus", async () => {
    const onClose = vi.fn();
    const view = render(
      <>
        <button type="button">Opener</button>
        <UiV2Sheet onClose={onClose} open={false} testId="sheet" title="Add key">
          <input aria-label="Label" />
        </UiV2Sheet>
      </>
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener.closest("div")).not.toHaveAttribute("aria-hidden");

    view.rerender(
      <>
        <button type="button">Opener</button>
        <UiV2Sheet
          description="Runs a few small paid requests"
          footer={<button type="button">Test &amp; Save</button>}
          onClose={onClose}
          open
          testId="sheet"
          title="Add key"
        >
          <input aria-label="Label" />
        </UiV2Sheet>
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
        <UiV2Sheet onClose={onClose} open={false} testId="sheet" title="Add key">
          <input aria-label="Label" />
        </UiV2Sheet>
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
      <UiV2Sheet closeBlocked onClose={onClose} open testId="sheet" title="Rotate key">
        <p>Saving…</p>
      </UiV2Sheet>
    );
    const dialog = await screen.findByRole("dialog", { name: "Rotate key" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("centres the title on Close's row and keeps the description under the title", async () => {
    render(
      <UiV2Sheet description="Stored encrypted" onClose={vi.fn()} open testId="sheet" title="Add key">
        <p>Body</p>
      </UiV2Sheet>
    );
    const dialog = await screen.findByRole("dialog", { name: "Add key" });
    const header = dialog.querySelector("header") as HTMLElement;
    const [title, close, description] = Array.from(header.children);
    expect(header).toHaveClass("grid", "items-center");
    expect(header).not.toHaveClass("items-start");
    expect(title).toHaveTextContent("Add key");
    expect(close).toBe(screen.getByRole("button", { name: "Close" }));
    expect(description).toHaveTextContent("Stored encrypted");
    expect(description).not.toHaveClass("col-span-2");
  });

  it("goes full screen on short phone viewports only when the consumer opts in", async () => {
    const view = render(
      <UiV2Sheet onClose={vi.fn()} open testId="sheet" title="Details" width="wide">
        <p>Body</p>
      </UiV2Sheet>
    );
    const ordinary = await screen.findByRole("dialog", { name: "Details" });
    expect(ordinary).not.toHaveAttribute("data-phone-full-screen");
    expect(ordinary.className).not.toContain("max-height:32rem");
    expect(ordinary.className).toContain("sm:w-[37.5rem]");

    view.rerender(
      <UiV2Sheet onClose={vi.fn()} open phoneFullScreen testId="sheet" title="Details" width="wide">
        <p>Body</p>
      </UiV2Sheet>
    );
    const fullScreen = await screen.findByRole("dialog", { name: "Details" });
    expect(fullScreen).toHaveAttribute("data-phone-full-screen", "true");
    expect(fullScreen.className).toContain("[@media(max-height:32rem)]:!w-full");
    expect(fullScreen.className).toContain("sm:w-[37.5rem]");
  });
});
