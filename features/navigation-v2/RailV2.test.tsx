import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeChatRoute } from "@/components/app-shell/chatRoute";
import { AccountMenuV2 } from "./AccountMenuV2";
import { RailV2 } from "./RailV2";

const { signOutCurrentSession } = vi.hoisted(() => ({
  signOutCurrentSession: vi.fn(async () => ({ ok: true as const }))
}));
vi.mock("@/components/announcements/AnnouncementsBell", () => ({ AnnouncementsBell: () => null }));
vi.mock("@/components/app-shell/sessionActions", () => ({ signOutCurrentSession }));

afterEach(() => {
  cleanup();
  signOutCurrentSession.mockClear();
  window.history.replaceState(null, "", "/");
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
