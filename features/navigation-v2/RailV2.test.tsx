import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeChatRoute } from "@/components/app-shell/chatRoute";
import { AccountMenuV2 } from "./AccountMenuV2";
import { RailV2 } from "./RailV2";

vi.mock("@/components/announcements/AnnouncementsBell", () => ({ AnnouncementsBell: () => null }));

afterEach(() => {
  cleanup();
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
    render(<AccountMenuV2 accountLabel="admin@example.test" adminEntryVisible />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("link", { name: "Control Center" }))
      .toHaveAttribute("href", "/admin?return=%2Fp%2Fproject-1");
  });
});
