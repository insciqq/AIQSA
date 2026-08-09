import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountMenu,
  AccountMenuTrigger,
  type AccountMenuAnchor,
  type AccountMenuInitialFocus
} from "./AccountMenu";

type HarnessProps = {
  accountEmail?: string | null;
  adminHref?: string | null;
  onOpenKnowledge?(): void;
  onOpenLibrary?(): void;
  onOpenPalette?(): void;
  onOpenSettings?(): void;
  onSignOut?(): void;
  signOutError?: string | null;
  signingOut?: boolean;
};

function DesktopAccountHarness({
  accountEmail = "operator@aiqsa.local",
  adminHref = null,
  onOpenKnowledge = () => undefined,
  onOpenLibrary = () => undefined,
  onOpenPalette = () => undefined,
  onOpenSettings = () => undefined,
  onSignOut = () => undefined,
  signOutError = null,
  signingOut = false
}: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<AccountMenuInitialFocus>("first");
  const railRef = useRef<HTMLButtonElement>(null);

  function openMenu(focus: AccountMenuInitialFocus) {
    setInitialFocus(focus);
    setOpen(true);
  }

  return (
    <div>
      <AccountMenuTrigger
        ref={railRef}
        accountEmail={accountEmail}
        active={open}
        controlsId="account-menu"
        layout="rail"
        onClose={() => setOpen(false)}
        onOpen={openMenu}
        signOutError={signOutError}
        signingOut={signingOut}
        tooltipId="rail-account-tooltip"
      />
      <span id="rail-account-tooltip" role="tooltip">Open account and session actions</span>
      {open ? (
        <AccountMenu
          accountEmail={accountEmail}
          activeTriggerRef={railRef}
          adminHref={adminHref}
          anchor="rail"
          initialFocus={initialFocus}
          menuId="account-menu"
          onClose={() => setOpen(false)}
          onOpenKnowledge={onOpenKnowledge}
          onOpenLibrary={onOpenLibrary}
          onOpenPalette={onOpenPalette}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
          signOutError={signOutError}
          signingOut={signingOut}
          triggerRefs={[railRef]}
        />
      ) : null}
    </div>
  );
}

function MobileAccountHarness({ signingOut = false }: { signingOut?: boolean }) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<AccountMenuInitialFocus>("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchor: AccountMenuAnchor = "mobile";

  return (
    <div className="relative w-full">
      <AccountMenuTrigger
        ref={triggerRef}
        accountEmail="mobile@aiqsa.local"
        active={open}
        controlsId="mobile-account-menu"
        layout={anchor}
        onClose={() => setOpen(false)}
        onOpen={(focus) => {
          setInitialFocus(focus);
          setOpen(true);
        }}
        signingOut={signingOut}
      />
      {open ? (
        <AccountMenu
          accountEmail="mobile@aiqsa.local"
          activeTriggerRef={triggerRef}
          anchor={anchor}
          initialFocus={initialFocus}
          menuId="mobile-account-menu"
          onClose={() => setOpen(false)}
          onOpenKnowledge={() => undefined}
          onOpenLibrary={() => undefined}
          onOpenPalette={() => undefined}
          onOpenSettings={() => undefined}
          onSignOut={() => undefined}
          signingOut={signingOut}
          triggerRefs={[triggerRef]}
        />
      ) : null}
    </div>
  );
}

afterEach(cleanup);

describe("AccountMenu", () => {
  it("anchors one uniquely identified desktop surface beside the top rail Account control", () => {
    render(<DesktopAccountHarness adminHref="/admin" />);
    const railTrigger = screen.getByRole("button", { name: "Account" });

    expect(railTrigger).not.toHaveAttribute("aria-controls");
    fireEvent.click(railTrigger);

    const menu = screen.getByRole("menu", { name: "Account" });
    expect(menu).toHaveAttribute("id", "account-menu");
    expect(screen.getAllByRole("menu", { name: "Account" })).toHaveLength(1);
    expect(railTrigger).toHaveAttribute("aria-controls", "account-menu");
    expect(menu.parentElement).toHaveAttribute("data-account-menu-anchor", "rail");
    expect(menu.parentElement).toHaveClass(
      "fixed",
      "left-[calc(5rem+env(safe-area-inset-left)+0.5rem)]",
      "top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)]",
      "w-64"
    );
    expect(screen.getByRole("menuitem", { name: "Control Center" })).toHaveAttribute("href", "/admin");
  });

  it("keeps identity text contained and entitlement-gates Control Center", () => {
    const longEmail = "research.operator.with.a.deliberately.long.identity@subdomain.example.com";
    render(<DesktopAccountHarness accountEmail={longEmail} />);
    const railTrigger = screen.getByRole("button", { name: "Account" });
    expect(within(railTrigger).getByText("Account")).toHaveClass("truncate");
    fireEvent.click(railTrigger);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(within(menu).getByText(longEmail)).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(screen.queryByRole("menuitem", { name: "Control Center" })).not.toBeInTheDocument();
  });

  it("runs replacement destinations from the invoking trigger and closes the menu", async () => {
    const onOpenLibrary = vi.fn();
    const onOpenKnowledge = vi.fn();
    const onOpenPalette = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <DesktopAccountHarness
        onOpenKnowledge={onOpenKnowledge}
        onOpenLibrary={onOpenLibrary}
        onOpenPalette={onOpenPalette}
        onOpenSettings={onOpenSettings}
      />
    );
    const railTrigger = screen.getByRole("button", { name: "Account" });

    fireEvent.click(railTrigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(railTrigger).toHaveFocus();
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledOnce());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();

    fireEvent.click(railTrigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Assistants" }));
    await waitFor(() => expect(onOpenLibrary).toHaveBeenCalledOnce());

    fireEvent.click(railTrigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Knowledge" }));
    await waitFor(() => expect(onOpenKnowledge).toHaveBeenCalledOnce());

    fireEvent.click(railTrigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Command palette" }));
    await waitFor(() => expect(onOpenPalette).toHaveBeenCalledOnce());
  });

  it("supports arrow navigation, nearest scrolling, Escape restoration, and outside dismissal", async () => {
    render(<DesktopAccountHarness adminHref="/admin" />);
    const railTrigger = screen.getByRole("button", { name: "Account" });
    railTrigger.focus();
    fireEvent.keyDown(railTrigger, { key: "ArrowDown" });

    const paletteItem = await screen.findByRole("menuitem", { name: "Command palette" });
    await waitFor(() => expect(paletteItem).toHaveFocus());
    const libraryItem = screen.getByRole("menuitem", { name: "Assistants" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(libraryItem, "scrollIntoView", { configurable: true, value: scrollIntoView });
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "ArrowDown" });
    expect(libraryItem).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(railTrigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();

    fireEvent.click(railTrigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it("keeps sign-out pending and failure evidence in the rail trigger and menu", () => {
    const onSignOut = vi.fn();
    const { rerender } = render(<DesktopAccountHarness onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();

    rerender(<DesktopAccountHarness onSignOut={onSignOut} signingOut />);
    expect(screen.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Account" })).toHaveAttribute("aria-busy", "true");

    rerender(
      <DesktopAccountHarness
        onSignOut={onSignOut}
        signOutError="Could not sign out. Check your connection and try again. (network_error)"
      />
    );
    expect(screen.getByTestId("rail-account-error-cue")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-describedby",
      "account-menu-sign-out-error-detail"
    );
    expect(document.getElementById("account-menu-sign-out-error-detail")).toBeVisible();
  });

  it("keeps mobile placement safe-area bounded and locally scrollable", () => {
    render(<MobileAccountHarness signingOut />);
    fireEvent.click(screen.getByRole("button", { name: /Account menu for/ }));
    const menu = screen.getByRole("menu", { name: "Account" });

    expect(menu.parentElement).toHaveClass("absolute", "bottom-12", "left-0", "max-w-64");
    expect(menu).toHaveClass("account-menu-scrollbar", "overflow-y-auto", "overscroll-contain");
    expect(menu).toHaveStyle({
      maxHeight:
        "calc(100dvh - max(0.5rem, env(safe-area-inset-top)) - max(0.5rem, env(safe-area-inset-bottom)) - 6.5rem)"
    });
    expect(screen.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled();
  });

  it("shows the continuation cue until the final actions enter the local viewport", () => {
    render(<DesktopAccountHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
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
