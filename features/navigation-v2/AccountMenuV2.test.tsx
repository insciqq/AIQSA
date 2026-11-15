import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeChatRoute } from "@/components/app-shell/chatRoute";
import { AccountMenuV2 } from "./AccountMenuV2";

const { attentionSummary, signOutCurrentSession } = vi.hoisted(() => ({
  attentionSummary: {
    current: null as null | { bad: number; checkedAt: string; unavailable: []; warn: number },
    hook: vi.fn()
  },
  signOutCurrentSession: vi.fn(async () => ({ ok: true as const }))
}));
vi.mock("@/components/app-shell/sessionActions", () => ({ signOutCurrentSession }));
vi.mock("./useAdminAttentionSummary", async (importOriginal) => ({
  ...await importOriginal<typeof import("./useAdminAttentionSummary")>(),
  useAdminAttentionSummary: (enabled: boolean) => {
    attentionSummary.hook(enabled);
    return enabled ? attentionSummary.current : null;
  }
}));

afterEach(() => {
  cleanup();
  signOutCurrentSession.mockClear();
  attentionSummary.current = null;
  attentionSummary.hook.mockClear();
  window.history.replaceState(null, "", "/");
});

const summary = (bad: number, warn: number) => ({ bad, checkedAt: "2026-10-07T12:00:00.000Z", unavailable: [] as [], warn });

describe("Account menu", () => {
  it("shows who is signed in, Control Center with its attention count, and Sign out", () => {
    attentionSummary.current = summary(1, 1);
    render(<AccountMenuV2 accountId="admin-1" accountLabel="admin@example.test" adminEntryVisible />);
    const trigger = screen.getByRole("button", { name: "Account menu" });
    // The trigger itself stays plain (no Control Center dot on any device).
    expect(trigger).not.toHaveAttribute("aria-describedby");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(within(menu).getByTestId("account-menu-identity")).toHaveTextContent("admin@example.test");
    const entry = within(menu).getByRole("link", { name: "Control Center, 2 items need attention" });
    expect(within(entry).getByTestId("admin-attention-count")).toHaveTextContent("2");
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("offers Settings only where a Settings action is passed", () => {
    const onSettings = vi.fn();
    const view = render(<AccountMenuV2 accountId="viewer-1" accountLabel="viewer@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: "Settings" })).toBeNull();
    view.unmount();

    render(<AccountMenuV2 accountId="viewer-1" accountLabel="viewer@example.test" onSettings={onSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("never asks for counts without the administrator entry", () => {
    attentionSummary.current = summary(4, 0);
    render(<AccountMenuV2 accountId="viewer-1" accountLabel="viewer@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(attentionSummary.hook).toHaveBeenCalled();
    expect(attentionSummary.hook.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
    expect(screen.queryByRole("link", { name: /Control Center/u })).toBeNull();
  });

  it("links Control Center back to the chat being shown, following later route changes", () => {
    window.history.replaceState(null, "", "/c/chat-1");
    render(<AccountMenuV2 accountId="admin-1" accountLabel="admin@example.test" adminEntryVisible />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin?return=%2Fc%2Fchat-1");
    act(() => writeChatRoute({ chatId: "chat-2" }));
    expect(screen.getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin?return=%2Fc%2Fchat-2");
    act(() => writeChatRoute({ chatId: null }));
    expect(screen.getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin");
  });
});

describe("Account menu sign-out", () => {
  it("names the viewer's account so its browser drafts are cleared", async () => {
    render(<AccountMenuV2 accountId="viewer-1" accountLabel="viewer@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    });
    expect(signOutCurrentSession).toHaveBeenCalledWith({ accountId: "viewer-1" });
  });

  it("falls back to clearing every account when the surface has no viewer id", async () => {
    render(<AccountMenuV2 accountId={null} accountLabel="viewer@example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    });
    expect(signOutCurrentSession).toHaveBeenCalledWith({ accountId: null });
  });
});
