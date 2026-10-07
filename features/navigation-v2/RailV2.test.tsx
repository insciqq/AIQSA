import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeChatRoute } from "@/components/app-shell/chatRoute";
import { AccountMenuV2 } from "./AccountMenuV2";
import { RailV2 } from "./RailV2";

const { attentionSummary, signOutCurrentSession } = vi.hoisted(() => ({
  attentionSummary: {
    current: null as null | { bad: number; checkedAt: string; health: number | null; unavailable: []; warn: number },
    hook: vi.fn()
  },
  signOutCurrentSession: vi.fn(async () => ({ ok: true as const }))
}));
vi.mock("@/components/announcements/AnnouncementsBell", () => ({ AnnouncementsBell: () => null }));
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

describe("Control Center attention badge", () => {
  const summary = (bad: number, warn: number) => ({ bad, checkedAt: "2026-10-07T12:00:00.000Z", health: 0, unavailable: [] as [], warn });

  it("marks the rail entry with the worst severity and names the count", () => {
    attentionSummary.current = summary(1, 2);
    render(<RailV2 accountLabel="admin@example.test" active="chats" adminEntryVisible onChats={vi.fn()} onNewChat={vi.fn()} />);
    const entry = within(screen.getByTestId("workspace-rail")).getByRole("link", { name: "Control Center, 3 items need attention" });
    expect(within(entry).getByTestId("admin-attention-dot")).toHaveAttribute("data-severity", "bad");
    // The rail avatar does not repeat the dot; its menu entry carries the count.
    expect(within(screen.getByRole("button", { name: "Account menu" })).queryByTestId("admin-attention-dot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const [railEntry, menuEntry] = screen.getAllByRole("link", { name: "Control Center, 3 items need attention" });
    expect(railEntry).toBe(entry);
    expect(within(menuEntry!).getByTestId("admin-attention-count")).toHaveTextContent("3");
  });

  it("shows a warning dot on the drawer account row, the only entry on phones", () => {
    attentionSummary.current = summary(0, 1);
    render(<AccountMenuV2 accountId="admin-1" accountLabel="admin@example.test" adminEntryVisible />);
    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(within(trigger).getByTestId("admin-attention-dot")).toHaveAttribute("data-severity", "warn");
    expect(trigger).toHaveAccessibleDescription("Control Center: 1 item needs attention");
  });

  it("stays plain when nothing needs attention", () => {
    attentionSummary.current = summary(0, 0);
    render(<RailV2 accountLabel="admin@example.test" active="chats" adminEntryVisible onChats={vi.fn()} onNewChat={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Control Center" })).toBeVisible();
    expect(screen.queryByTestId("admin-attention-dot")).toBeNull();
  });

  it("never asks for counts without the administrator entry", () => {
    attentionSummary.current = summary(4, 0);
    render(<RailV2 accountLabel="viewer@example.test" active="chats" onChats={vi.fn()} onNewChat={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(attentionSummary.hook).toHaveBeenCalled();
    expect(attentionSummary.hook.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
    expect(screen.queryByRole("link", { name: /Control Center/u })).toBeNull();
    expect(screen.queryByTestId("admin-attention-dot")).toBeNull();
  });
});

describe("Control Center entries", () => {
  it("remember the chat the rail was showing, following later route changes", () => {
    window.history.replaceState(null, "", "/c/chat-1");
    render(<RailV2 accountLabel="admin@example.test" active="chats" adminEntryVisible onChats={vi.fn()} onNewChat={vi.fn()} />);
    const rail = screen.getByTestId("workspace-rail");
    expect(within(rail).getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin?return=%2Fc%2Fchat-1");
    act(() => writeChatRoute({ chatId: "chat-2", projectId: "project-1" }));
    expect(within(rail).getByRole("link", { name: "Control Center" }))
      .toHaveAttribute("href", "/admin?return=%2Fp%2Fproject-1%2Fc%2Fchat-2");
    act(() => writeChatRoute({ chatId: null, projectId: null }));
    expect(within(rail).getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin");
  });

  it("remember the chat in the account menu", () => {
    window.history.replaceState(null, "", "/p/project-1");
    render(<AccountMenuV2 accountId="admin-1" accountLabel="admin@example.test" adminEntryVisible />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("link", { name: "Control Center" }))
      .toHaveAttribute("href", "/admin?return=%2Fp%2Fproject-1");
  });
});

describe("Account menu sign-out", () => {
  it("names the viewer's account so its browser drafts are cleared", async () => {
    render(<RailV2 accountId="viewer-1" accountLabel="viewer@example.test" active="chats" onChats={vi.fn()} onNewChat={vi.fn()} />);
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
