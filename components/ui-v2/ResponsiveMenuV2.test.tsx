import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiV2MenuItem } from "./index";
import { MOBILE_MENU_QUERY, UiV2ResponsiveMenu } from "./ResponsiveMenuV2";
import { useMenuDismissalV2 } from "./useMenuDismissalV2";

function matchMedia(mobile: boolean) {
  return vi.fn(() => ({
    addEventListener: vi.fn(),
    matches: mobile,
    removeEventListener: vi.fn()
  } as unknown as MediaQueryList));
}

type ScreenProfile = Readonly<{ height: number; touch: boolean; width: number }>;

/**
 * Evaluates the width, height, hover and pointer features the menu's media
 * query uses for one screen (1rem = 16px); any other feature fails the test.
 */
function matchesScreen(query: string, profile: ScreenProfile): boolean {
  return query.split(",").some((part) => part.trim().split(/\s+and\s+/u).every((feature) => {
    const match = /^\((max-width|max-height|hover|pointer):\s*([^)]+)\)$/u.exec(feature.trim());
    if (!match) throw new Error(`Unsupported media feature: ${feature}`);
    const [, name, value] = match;
    if (name === "hover") return (value === "none") === profile.touch;
    if (name === "pointer") return (value === "coarse") === profile.touch;
    const limit = value.endsWith("rem") ? Number.parseFloat(value) * 16 : Number.parseFloat(value);
    return (name === "max-width" ? profile.width : profile.height) <= limit;
  }));
}

function screenMedia(profile: ScreenProfile) {
  return vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    matches: matchesScreen(query, profile),
    removeEventListener: vi.fn()
  } as unknown as MediaQueryList));
}

function ResponsiveMenuHarness({ align, icons = false }: Readonly<{ align?: "end" | "start"; icons?: boolean }>) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: close, open });
  return (
    <div data-testid="background">
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open actions</button>
      {open ? (
        <UiV2ResponsiveMenu
          align={align}
          anchorRef={triggerRef}
          label="Test actions"
          menuRef={menuRef}
          onClose={close}
        >
          <UiV2MenuItem icon={icons ? "edit" : undefined}>First action</UiV2MenuItem>
          <UiV2MenuItem disabled icon={icons ? "copy" : undefined}>Disabled action</UiV2MenuItem>
          <UiV2MenuItem icon={icons ? "trash" : undefined}>Last action</UiV2MenuItem>
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
    expect(menu.style.left).toBe("8px");
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Escape" });
    expect(menu).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opts into sharing the anchor's start edge on desktop", () => {
    vi.stubGlobal("matchMedia", matchMedia(false));
    render(<ResponsiveMenuHarness align="start" />);
    const trigger = screen.getByRole("button", { name: "Open actions" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 40, height: 32, left: 80, right: 112, top: 8, width: 32, x: 80, y: 8, toJSON: () => ({})
    });

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Test actions" });
    expect(menu).toHaveAttribute("data-side", "bottom");
    expect(menu.style.left).toBe("80px");
    expect(menu.style.top).toBe("46px");
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

  it.each([
    { form: "sheet", label: "phone portrait 390×844 touch", profile: { height: 844, touch: true, width: 390 } },
    { form: "sheet", label: "phone landscape 844×390 touch", profile: { height: 390, touch: true, width: 844 } },
    { form: "sheet", label: "large phone landscape 932×430 touch", profile: { height: 430, touch: true, width: 932 } },
    { form: "sheet", label: "narrow window 700×900 fine pointer", profile: { height: 900, touch: false, width: 700 } },
    { form: "popover", label: "short window 844×390 fine pointer", profile: { height: 390, touch: false, width: 844 } },
    { form: "popover", label: "tablet portrait 768×1024 touch", profile: { height: 1024, touch: true, width: 768 } },
    { form: "popover", label: "tablet landscape 1024×768 touch", profile: { height: 768, touch: true, width: 1024 } },
    { form: "popover", label: "desktop 1440×900 fine pointer", profile: { height: 900, touch: false, width: 1440 } }
  ] as const)("uses the $form form on a $label screen", ({ form, profile }) => {
    const media = screenMedia(profile);
    vi.stubGlobal("matchMedia", media);
    render(<ResponsiveMenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));

    expect(media).toHaveBeenCalledWith(MOBILE_MENU_QUERY);
    const menu = screen.getByRole("menu", { name: "Test actions" });
    if (form === "sheet") {
      expect(screen.getByRole("dialog", { name: "Test actions sheet" })).toContainElement(menu);
      // The sheet ends with its own Close row after the last action.
      const items = screen.getAllByRole("menuitem");
      expect(items.at(-2)).toHaveAccessibleName("Last action");
      expect(items.at(-1)).toHaveAccessibleName("Close");
    } else {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(menu.parentElement).toBe(document.body);
      expect(menu).toHaveClass("v2-responsive-menu-popover");
    }
  });

  it("puts the sheet's Close row in the icon column of the rows above", () => {
    vi.stubGlobal("matchMedia", matchMedia(true));
    render(<ResponsiveMenuHarness icons />);
    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));

    const first = screen.getByRole("menuitem", { name: "First action" });
    const close = screen.getByRole("menuitem", { name: "Close" });
    expect(first).toHaveAttribute("data-icon");
    expect(close).toHaveAttribute("data-icon");
    expect(close).toHaveAttribute("data-menu-close");
    expect(close.firstElementChild).toHaveClass("v2-menu-item-icon");
    expect(close.querySelector("use")).toHaveAttribute("href", "#v2-icon-close");
    expect(close).toHaveAccessibleName("Close");
  });
});
