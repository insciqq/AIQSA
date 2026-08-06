import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

function renderAccountMenu(overrides: Partial<ComponentProps<typeof AccountMenu>> = {}) {
  const callbacks = {
    onOpenLibrary: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn()
  };
  const props: ComponentProps<typeof AccountMenu> = {
    accountEmail: "operator@aiqsa.local",
    adminHref: null,
    signingOut: false,
    ...callbacks,
    ...overrides
  };

  return {
    callbacks,
    props,
    ...render(<AccountMenu {...props} />)
  };
}

afterEach(cleanup);

describe("AccountMenu", () => {
  it("shows Control Center only for entitled accounts and namespaces owned ids", () => {
    const { props, rerender } = renderAccountMenu({ idPrefix: "workspace-" });
    const trigger = screen.getByRole("button", { name: /Account menu/ });
    expect(trigger).not.toHaveAttribute("aria-controls");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-controls", "workspace-account-menu");
    expect(screen.getByRole("menu", { name: "Account" })).toHaveAttribute("id", "workspace-account-menu");
    expect(screen.queryByRole("menuitem", { name: "Control Center" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).not.toHaveAttribute("aria-controls");

    rerender(<AccountMenu {...props} adminHref="/admin" />);
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));

    expect(screen.getByRole("menuitem", { name: "Control Center" })).toHaveAttribute("href", "/admin");
  });

  it("shows the canonical account email as contained noninteractive identity text", () => {
    const longEmail = "research.operator.with.a.deliberately.long.identity@subdomain.example.com";
    const { props, rerender } = renderAccountMenu({ accountEmail: longEmail });
    const trigger = screen.getByRole("button", { name: /Account menu/ });
    const triggerIdentity = within(trigger).getByText(longEmail);

    expect(trigger).toHaveClass("flex", "w-full", "text-left");
    expect(trigger).toHaveAccessibleName(`Account menu for ${longEmail}`);
    expect(triggerIdentity).toHaveClass("min-w-0", "truncate");
    expect(triggerIdentity).toHaveAttribute("title", longEmail);

    fireEvent.click(trigger);
    const identity = within(screen.getByRole("menu", { name: "Account" })).getByText(longEmail);
    expect(identity).toBeVisible();
    expect(identity).toHaveAttribute("title", longEmail);
    expect(identity).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(identity.closest('[role="menuitem"]')).toBeNull();
    expect(identity).not.toHaveAttribute("tabindex");

    fireEvent.click(trigger);
    rerender(<AccountMenu {...props} accountEmail={null} />);
    const fallbackTrigger = screen.getByRole("button", { name: /Account menu/ });
    expect(fallbackTrigger).toHaveAccessibleName("Account menu for Email unavailable");
    expect(within(fallbackTrigger).getByText("Email unavailable")).toBeVisible();
    fireEvent.click(fallbackTrigger);
    expect(within(screen.getByRole("menu", { name: "Account" })).getByText("Email unavailable")).toBeVisible();
  });

  it("keeps the palette, Library, and Settings as distinct destinations", async () => {
    const { callbacks } = renderAccountMenu({ adminHref: "/admin" });
    const trigger = screen.getByRole("button", { name: /Account menu/ });

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Control Center" })).toHaveAttribute("href", "/admin");

    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    await waitFor(() => expect(callbacks.onOpenSettings).toHaveBeenCalledOnce());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Library" }));
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(callbacks.onOpenLibrary).toHaveBeenCalledOnce());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Command palette" }));
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(callbacks.onOpenPalette).toHaveBeenCalledOnce());
  });

  it("reports its active layer only while the Account menu is open", async () => {
    const onOpenChange = vi.fn();
    renderAccountMenu({ onOpenChange });
    const trigger = screen.getByRole("button", { name: /Account menu/ });

    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("supports arrow navigation, nearest scrolling, Escape restoration, and outside close", async () => {
    renderAccountMenu({ adminHref: "/admin" });
    const trigger = screen.getByRole("button", { name: /Account menu/ });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const paletteItem = await screen.findByRole("menuitem", { name: "Command palette" });
    await waitFor(() => expect(paletteItem).toHaveFocus());

    const libraryItem = screen.getByRole("menuitem", { name: "Library" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(libraryItem, "scrollIntoView", { configurable: true, value: scrollIntoView });
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "ArrowDown" });
    expect(libraryItem).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it("keeps sign-out pending and failure feedback inside the account session", () => {
    const onSignOut = vi.fn();
    const { props, rerender } = renderAccountMenu({ onSignOut });

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();

    rerender(<AccountMenu {...props} onSignOut={onSignOut} signingOut />);
    const pending = screen.getByRole("menuitem", { name: "Signing out…" });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("button", { name: /Account menu/ })).toHaveAttribute("aria-busy", "true");

    rerender(
      <AccountMenu
        {...props}
        onSignOut={onSignOut}
        signOutError="Could not sign out. Check your connection and try again. (network_error)"
      />
    );
    expect(document.getElementById("account-sign-out-error-description")).toHaveTextContent("Could not sign out");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-describedby",
      "account-sign-out-error-detail"
    );
    expect(document.getElementById("account-sign-out-error-detail")).toBeVisible();
  });

  it("announces and exposes a controlled error cue after the pending menu was closed", async () => {
    const onSignOut = vi.fn();
    const { props, rerender } = renderAccountMenu({ onSignOut });
    const trigger = screen.getByRole("button", { name: /Account menu/ });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    rerender(<AccountMenu {...props} onSignOut={onSignOut} signingOut />);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument());

    rerender(
      <AccountMenu
        {...props}
        onSignOut={onSignOut}
        signOutError="Sign out timed out. Check your connection and try again. (logout_timeout)"
      />
    );

    expect(trigger).toHaveAttribute("aria-describedby", "account-sign-out-error-description");
    expect(trigger).not.toHaveAttribute("aria-controls");
    expect(screen.getByTestId("account-error-cue")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(document.getElementById("account-sign-out-error-detail")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toHaveClass("z-[80]");

    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveAttribute("aria-describedby", "account-sign-out-error-description");

    rerender(<AccountMenu {...props} onSignOut={onSignOut} signOutError={null} signingOut />);
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("account-error-cue")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the upward nonmodal menu bounded, touch-ready, and closable while sign out is pending", async () => {
    renderAccountMenu({ signingOut: true });
    const trigger = screen.getByRole("button", { name: /Account menu/ });

    expect(trigger).toHaveClass("w-full", "[@media(pointer:coarse)]:!min-h-touch");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(menu).toHaveClass(
      "account-menu-scrollbar",
      "bottom-12",
      "left-0",
      "max-h-[calc(100dvh-7.5rem)]",
      "overflow-y-auto",
      "overscroll-contain"
    );
    expect(screen.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it("subtracts the mobile drawer safe areas from the short-height menu boundary", () => {
    renderAccountMenu({ layout: "mobile" });
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));

    const menu = screen.getByRole("menu", { name: "Account" });
    expect(menu).not.toHaveClass("max-h-[calc(100dvh-7.5rem)]");
    expect(menu).toHaveStyle({
      maxHeight:
        "calc(100dvh - max(0.5rem, env(safe-area-inset-top)) - max(0.5rem, env(safe-area-inset-bottom)) - 6.5rem)"
    });
  });

  it("shows an explicit scroll cue until the constrained menu reaches its final actions", () => {
    renderAccountMenu();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    const menu = screen.getByRole("menu", { name: "Account" });
    Object.defineProperties(menu, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 320 },
      scrollTop: { configurable: true, value: 0, writable: true }
    });

    fireEvent.scroll(menu);
    expect(screen.getByTestId("account-menu-scroll-cue")).toBeVisible();

    menu.scrollTop = 120;
    fireEvent.scroll(menu);
    expect(screen.queryByTestId("account-menu-scroll-cue")).not.toBeInTheDocument();
  });
});
