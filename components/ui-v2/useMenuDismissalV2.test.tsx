import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiV2MenuItem, UiV2MenuSurface } from "./index";
import { useMenuDismissalV2 } from "./useMenuDismissalV2";

function MenuHarness({ onAction }: { onAction?(): void }) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });

  return (
    <div>
      <button
        aria-expanded={open}
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        Открыть меню
      </button>
      {open ? (
        <UiV2MenuSurface label="Тестовое меню" ref={menuRef}>
          <UiV2MenuItem onClick={() => { setOpen(false); onAction?.(); }}>
            Первый пункт
          </UiV2MenuItem>
        </UiV2MenuSurface>
      ) : null}
      <button type="button">Другой контрол</button>
    </div>
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
  return screen.getByRole("menu", { name: "Тестовое меню" });
}

describe("useMenuDismissalV2", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes on Escape, returns focus to the trigger, and consumes the key", () => {
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    render(<MenuHarness />);
    const menu = openMenu();
    const item = screen.getByRole("menuitem", { name: "Первый пункт" });
    item.focus();

    fireEvent.keyDown(item, { key: "Escape" });

    expect(menu).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть меню" })).toHaveFocus();
    expect(windowEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowEscape);
  });

  it("closes on pointerdown outside while inside presses keep it open", () => {
    render(<MenuHarness />);
    const menu = openMenu();

    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Первый пункт" }));
    expect(menu).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Другой контрол" }));
    expect(menu).not.toBeInTheDocument();
  });

  it("closes when focus leaves the menu and its trigger", () => {
    render(<MenuHarness />);
    const menu = openMenu();

    fireEvent.focusIn(screen.getByRole("menuitem", { name: "Первый пункт" }));
    expect(menu).toBeInTheDocument();

    fireEvent.focusIn(screen.getByRole("button", { name: "Другой контрол" }));
    expect(menu).not.toBeInTheDocument();
  });

  it("keeps the trigger a plain toggle and closes through item activation", () => {
    const onAction = vi.fn();
    render(<MenuHarness onAction={onAction} />);
    const menu = openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Первый пункт" }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(menu).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    expect(screen.getByRole("menu", { name: "Тестовое меню" })).toBeVisible();
  });
});
