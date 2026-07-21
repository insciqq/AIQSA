import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineSnapshot } from "./runState";
import { TopRail } from "./TopRail";

const idlePipeline: PipelineSnapshot = {
  answer: "idle",
  phase: "idle",
  question: "idle",
  search: "idle"
};

function renderTopRail(overrides: Partial<ComponentProps<typeof TopRail>> = {}) {
  const callbacks = {
    onCopyThread: vi.fn(),
    onOpenBranches: vi.fn(),
    onOpenDetails: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenPipeline: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onShare: vi.fn(),
    onSignOut: vi.fn(),
    onStartNewChat: vi.fn()
  };
  const props: ComponentProps<typeof TopRail> = {
    accountEmail: "operator@aiqsa.local",
    activeChatId: "chat-1",
    activeChatTitle: "Research notes",
    adminHref: null,
    detailsOpen: false,
    newChatDisabled: false,
    pipeline: idlePipeline,
    sharing: false,
    ...callbacks,
    ...overrides
  };

  return {
    callbacks,
    props,
    ...render(<TopRail {...props} />)
  };
}

afterEach(cleanup);

describe("TopRail", () => {
  it("renders the current chat title once and gives a blank workspace an unambiguous title", () => {
    const { rerender, props } = renderTopRail();

    expect(screen.getByRole("heading", { level: 1, name: "Research notes" })).toBeVisible();
    expect(screen.getByTestId("current-chat-title")).toHaveTextContent("Research notes");
    expect(screen.getByTestId("current-chat-title")).toHaveClass("sr-only", "lg:not-sr-only");
    expect(screen.getAllByText("Research notes")).toHaveLength(1);

    rerender(<TopRail {...props} activeChatId={null} activeChatTitle="Ignored title" />);

    expect(screen.getByRole("heading", { level: 1, name: "New chat" })).toBeVisible();
  });

  it("keeps idle and settled pipeline decoration out of the top bar", () => {
    const { rerender, props } = renderTopRail();

    expect(screen.queryByTestId("pipeline-indicator")).not.toBeInTheDocument();

    rerender(
      <TopRail
        {...props}
        pipeline={{ answer: "done", phase: "settled", question: "done", search: "skipped" }}
      />
    );

    expect(screen.queryByTestId("pipeline-indicator")).not.toBeInTheDocument();
  });

  it.each([
    {
      expected: "Working…",
      pipeline: { answer: "idle", phase: "running", question: "active", search: "idle" } as PipelineSnapshot
    },
    {
      expected: "Searching…",
      pipeline: { answer: "idle", phase: "running", question: "done", search: "active" } as PipelineSnapshot
    },
    {
      expected: "Answering…",
      pipeline: { answer: "active", phase: "running", question: "done", search: "done" } as PipelineSnapshot
    }
  ])("shows the readable $expected activity stage and opens Events", ({ expected, pipeline }) => {
    const onOpenPipeline = vi.fn();
    renderTopRail({ onOpenPipeline, pipeline });

    const indicator = screen.getByTestId("pipeline-indicator");
    expect(indicator).toHaveTextContent(expected);
    expect(indicator).toHaveAttribute("data-phase", "running");
    expect(indicator.querySelector("[data-run-activity]")).toBeInTheDocument();

    fireEvent.click(indicator);
    expect(onOpenPipeline).toHaveBeenCalledOnce();
  });

  it("shows a readable error state with the failing stage preserved", () => {
    const onOpenPipeline = vi.fn();
    renderTopRail({
      onOpenPipeline,
      pipeline: {
        answer: "idle",
        phase: "error",
        question: "done",
        search: "error"
      }
    });

    const indicator = screen.getByRole("button", { name: "Run error - open run events" });
    expect(indicator).toHaveAttribute("data-phase", "error");
    expect(indicator).toHaveTextContent("Run error");

    fireEvent.click(indicator);
    expect(onOpenPipeline).toHaveBeenCalledOnce();
  });

  it("wires compact New chat, thread actions, workspace, palette, settings, share, and state-aware Details", () => {
    const { callbacks, props, rerender } = renderTopRail();

    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch tree" }));
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Share anonymously" }));

    const openDetails = screen.getByRole("button", { name: "Open details" });
    expect(openDetails).toHaveAttribute("aria-controls", "details-pane");
    expect(openDetails).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openDetails);

    expect(callbacks.onOpenWorkspace).toHaveBeenCalledOnce();
    expect(callbacks.onStartNewChat).toHaveBeenCalledOnce();
    expect(callbacks.onCopyThread).toHaveBeenCalledOnce();
    expect(callbacks.onOpenBranches).toHaveBeenCalledOnce();
    expect(callbacks.onOpenPalette).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();
    expect(callbacks.onShare).toHaveBeenCalledOnce();
    expect(callbacks.onOpenDetails).toHaveBeenCalledOnce();

    rerender(<TopRail {...props} detailsOpen />);
    const closeDetails = screen.getByRole("button", { name: "Close details" });
    expect(closeDetails).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(closeDetails);
    expect(callbacks.onOpenDetails).toHaveBeenCalledTimes(2);
  });

  it("disables only sharing while the operation is pending", () => {
    renderTopRail({ sharing: true });

    expect(screen.getByRole("button", { name: "Share anonymously" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Share anonymously" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Open details" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeEnabled();
  });

  it("disables only the compact New chat action when its workspace owner is unavailable", () => {
    renderTopRail({ newChatDisabled: true });

    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open details" })).toBeEnabled();
  });

  it("shows the admin console entry only inside an entitled account menu", () => {
    const { props, rerender } = renderTopRail();
    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger).not.toHaveAttribute("aria-controls");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-controls", "account-menu");
    expect(screen.queryByRole("menuitem", { name: "Admin console" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).not.toHaveAttribute("aria-controls");

    rerender(<TopRail {...props} adminHref="/admin" />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

    expect(screen.getByRole("menuitem", { name: "Admin console" })).toHaveAttribute("href", "/admin");
  });

  it("shows the canonical account email as contained noninteractive identity text", () => {
    const longEmail = "research.operator.with.a.deliberately.long.identity@subdomain.example.com";
    const { props, rerender } = renderTopRail({ accountEmail: longEmail });
    const trigger = screen.getByRole("button", { name: "Account menu" });

    fireEvent.click(trigger);
    const identity = screen.getByText(longEmail);
    expect(identity).toBeVisible();
    expect(identity).toHaveAttribute("title", longEmail);
    expect(identity).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(identity.closest('[role="menuitem"]')).toBeNull();
    expect(identity).not.toHaveAttribute("tabindex");

    fireEvent.click(trigger);
    rerender(<TopRail {...props} accountEmail={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByText("Email unavailable")).toBeVisible();
  });

  it("moves rare narrow actions into the account menu and hands replacement focus through its trigger", async () => {
    const { callbacks } = renderTopRail({ adminHref: "/admin" });
    const trigger = screen.getByRole("button", { name: "Account menu" });

    expect(screen.getByRole("button", { name: "Open command palette" })).toHaveClass("hidden", "lg:grid");
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveClass("hidden", "lg:grid");

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Admin console" })).toHaveAttribute("href", "/admin");

    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    await waitFor(() => expect(callbacks.onOpenSettings).toHaveBeenCalledOnce());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Command palette" }));
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(callbacks.onOpenPalette).toHaveBeenCalledOnce());
  });

  it("supports arrow navigation, Escape restoration, and outside close", async () => {
    renderTopRail({ adminHref: "/admin" });
    const trigger = screen.getByRole("button", { name: "Account menu" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Command palette" })).toHaveFocus());

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
    const { props, rerender } = renderTopRail({ onSignOut });

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();

    rerender(<TopRail {...props} onSignOut={onSignOut} signingOut />);
    const pending = screen.getByRole("menuitem", { name: "Signing out…" });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveAttribute("aria-busy", "true");

    rerender(
      <TopRail
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
    const { props, rerender } = renderTopRail({ onSignOut });
    const trigger = screen.getByRole("button", { name: "Account menu" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    rerender(<TopRail {...props} onSignOut={onSignOut} signingOut />);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument());

    rerender(
      <TopRail
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

    rerender(<TopRail {...props} onSignOut={onSignOut} signOutError={null} signingOut />);
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("account-error-cue")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the nonmodal account menu closable while sign out is pending", async () => {
    renderTopRail({ signingOut: true });
    const trigger = screen.getByRole("button", { name: "Account menu" });

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it("keeps narrow touch chrome reachable without exposing the decorative brand", () => {
    renderTopRail({
      adminHref: "/admin",
      pipeline: { answer: "active", phase: "running", question: "done", search: "done" }
    });

    expect(screen.getByLabelText("AIQSA")).toHaveClass("hidden", "sm:flex");
    expect(screen.getByRole("button", { name: "Open workspace" })).toHaveClass(
      "[@media(hover:none)]:!size-11"
    );
    const newChat = screen.getByRole("button", { name: "Start new chat" });
    expect(newChat).toHaveClass("lg:hidden", "[@media(hover:none)]:!size-11");
    expect(newChat.parentElement).toHaveClass("gap-0", "sm:gap-2");
    expect(screen.getByRole("button", { name: "Copy thread" })).toHaveClass(
      "lg:hidden",
      "[@media(hover:none)]:!size-11"
    );
    expect(screen.getByRole("button", { name: "Branch tree" })).toHaveClass(
      "lg:hidden",
      "[@media(pointer:coarse)]:!size-11"
    );
    expect(screen.getByTestId("pipeline-indicator")).toHaveClass(
      "[@media(hover:none)]:!h-touch",
      "[@media(hover:none)]:!min-w-touch"
    );
    expect(screen.getByRole("button", { name: "Share anonymously" })).toHaveClass(
      "[@media(pointer:coarse)]:!min-w-touch"
    );
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveClass(
      "[@media(pointer:coarse)]:!size-11"
    );
  });
});
