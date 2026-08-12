import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceIconRail } from "./WorkspaceIconRail";

function baseProps(): ComponentProps<typeof WorkspaceIconRail> {
  return {
    accountTrigger: (tooltipId) => (
      <button type="button" aria-describedby={tooltipId} aria-label="Account">
        Account
      </button>
    ),
    adminHref: null,
    creatingChat: false,
    onNewChat: vi.fn(),
    onOpenAssistants: vi.fn(),
    onOpenKnowledge: vi.fn(),
    onOpenMemory: vi.fn(),
    onOpenSettings: vi.fn(),
    onRestoreChats: vi.fn(),
    paneHidden: false,
    signingOut: false,
    workspaceReady: true
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceIconRail", () => {
  it("renders the named landmark and exact destination order with Chats current", () => {
    const props = baseProps();
    render(<WorkspaceIconRail {...props} adminHref="/admin" />);

    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    const controls = Array.from(navigation.querySelectorAll<HTMLElement>("button, a"));
    expect(controls.map((control) => control.getAttribute("aria-label"))).toEqual([
      "New chat",
      "Chats",
      "Account",
      "Assistants",
      "Knowledge",
      "Memory",
      "Settings",
      "Control Center"
    ]);
    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin");
    expect(navigation).toHaveClass(
      "hidden",
      "min-[1281px]:flex",
      "w-[calc(5rem+env(safe-area-inset-left))]",
      "pl-[env(safe-area-inset-left)]",
      "bg-workspace-rail"
    );
  });

  it("restores a hidden pane from Chats or the non-control rail surface without stealing control clicks", () => {
    const props = baseProps();
    const { rerender } = render(<WorkspaceIconRail {...props} />);
    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click(navigation);
    expect(props.onRestoreChats).not.toHaveBeenCalled();

    rerender(<WorkspaceIconRail {...props} paneHidden />);
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(props.onRestoreChats).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(props.onRestoreChats).toHaveBeenCalledOnce();
    fireEvent.click(navigation);
    expect(props.onRestoreChats).toHaveBeenCalledTimes(2);
  });

  it("gates Control Center by entitlement", () => {
    const props = baseProps();
    const { rerender } = render(<WorkspaceIconRail {...props} />);
    expect(screen.queryByRole("link", { name: "Control Center" })).not.toBeInTheDocument();

    rerender(<WorkspaceIconRail {...props} adminHref="/admin" />);
    expect(screen.getByRole("link", { name: "Control Center" })).toBeVisible();
  });

  it("associates one real tooltip per control and dismisses it on blur, leave, and Escape", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }))
    );
    render(<WorkspaceIconRail {...baseProps()} />);
    const settings = screen.getByRole("button", { name: "Settings" });
    const tooltipId = settings.getAttribute("aria-describedby");
    const tooltip = tooltipId ? document.getElementById(tooltipId) : null;

    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(tooltip).toHaveTextContent("Open personal settings");
    expect(tooltip).not.toHaveAttribute("data-visible");

    fireEvent.focus(settings);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(settings, { key: "Escape" });
    expect(tooltip).not.toHaveAttribute("data-visible");
    fireEvent.blur(settings);

    const entry = settings.parentElement;
    if (!entry) throw new Error("Expected Settings rail entry");
    fireEvent.pointerEnter(entry, { pointerType: "mouse" });
    expect(tooltip).toHaveAttribute("data-visible", "true");
    fireEvent.pointerLeave(entry, { pointerType: "mouse" });
    expect(tooltip).not.toHaveAttribute("data-visible");
  });

  it("keeps unavailable controls focusable and guards every activation route", () => {
    const props = baseProps();
    render(
      <WorkspaceIconRail
        {...props}
        adminHref="/admin"
        creatingChat
        signingOut
        workspaceReady={false}
      />
    );

    const unavailable = [
      screen.getByRole("button", { name: "New chat" }),
      screen.getByRole("button", { name: "Assistants" }),
      screen.getByRole("button", { name: "Knowledge" }),
      screen.getByRole("button", { name: "Memory" }),
      screen.getByRole("button", { name: "Settings" }),
      screen.getByRole("link", { name: "Control Center" })
    ];
    for (const control of unavailable) {
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).not.toHaveAttribute("disabled");
      expect(control).toHaveClass("min-h-[3.25rem]", "w-[4.5rem]", "[@media(pointer:coarse)]:!min-h-touch");
      control.focus();
      expect(control).toHaveFocus();
      fireEvent.keyDown(control, { key: "Enter" });
      fireEvent.keyDown(control, { key: " " });
      fireEvent.click(control);
    }
    expect(props.onNewChat).not.toHaveBeenCalled();
    expect(props.onOpenAssistants).not.toHaveBeenCalled();
    expect(props.onOpenKnowledge).not.toHaveBeenCalled();
    expect(props.onOpenMemory).not.toHaveBeenCalled();
    expect(props.onOpenSettings).not.toHaveBeenCalled();
  });

  it("routes enabled direct destinations through their existing owners", () => {
    const props = baseProps();
    render(<WorkspaceIconRail {...props} />);
    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });

    fireEvent.click(within(navigation).getByRole("button", { name: "New chat" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Assistants" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Knowledge" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Memory" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Settings" }));

    expect(props.onNewChat).toHaveBeenCalledOnce();
    expect(props.onOpenAssistants).toHaveBeenCalledOnce();
    expect(props.onOpenKnowledge).toHaveBeenCalledOnce();
    expect(props.onOpenMemory).toHaveBeenCalledOnce();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("renders compact persistent labels inside every desktop control", () => {
    render(<WorkspaceIconRail {...baseProps()} adminHref="/admin" />);
    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });

    for (const label of ["New chat", "Chats", "Account", "Assistants", "Knowledge", "Memory", "Settings", "Admin"]) {
      expect(within(navigation).getByText(label)).toBeVisible();
    }
  });
});
