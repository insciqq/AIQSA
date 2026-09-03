import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiV2MenuItem } from "./index";
import { UiV2ResponsiveMenu } from "./ResponsiveMenuV2";
import { useMenuDismissalV2 } from "./useMenuDismissalV2";

function matchMedia(mobile: boolean) {
  return vi.fn(() => ({
    addEventListener: vi.fn(),
    matches: mobile,
    removeEventListener: vi.fn()
  } as unknown as MediaQueryList));
}

function ResponsiveMenuHarness() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: close, open });
  return (
    <div data-testid="background">
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open actions</button>
      {open ? (
        <UiV2ResponsiveMenu
          anchorRef={triggerRef}
          label="Test actions"
          menuRef={menuRef}
          onClose={close}
        >
          <UiV2MenuItem>First action</UiV2MenuItem>
          <UiV2MenuItem disabled>Disabled action</UiV2MenuItem>
          <UiV2MenuItem>Last action</UiV2MenuItem>
        </UiV2ResponsiveMenu>
      ) : null}
    </div>
  );
}

describe("UiV2ResponsiveMenu", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("portals and flips a desktop menu while keeping keyboard focus local", async () => {
    vi.stubGlobal("matchMedia", matchMedia(false));
    render(<ResponsiveMenuHarness />);
    const trigger = screen.getByRole("button", { name: "Open actions" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: window.innerHeight - 1,
      height: 32,
      left: 80,
      right: 112,
      top: window.innerHeight - 33,
      width: 32,
      x: 80,
      y: window.innerHeight - 33,
      toJSON: () => ({})
    });

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Test actions" });
    const first = screen.getByRole("menuitem", { name: "First action" });
    const last = screen.getByRole("menuitem", { name: "Last action" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveAttribute("data-side", "top");
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Escape" });
    expect(menu).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("uses a modal mobile sheet, traps focus, and restores the opener after scrim close", async () => {
    vi.stubGlobal("matchMedia", matchMedia(true));
    render(<ResponsiveMenuHarness />);
    const trigger = screen.getByRole("button", { name: "Open actions" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Test actions sheet" });
    const first = screen.getByRole("menuitem", { name: "First action" });
    const close = screen.getByRole("menuitem", { name: "Close" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const backgroundRoot = screen.getByTestId("background").parentElement as HTMLElement;
    expect(backgroundRoot).toHaveAttribute("aria-hidden", "true");
    expect(backgroundRoot.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close Test actions" }));
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
  });
});
