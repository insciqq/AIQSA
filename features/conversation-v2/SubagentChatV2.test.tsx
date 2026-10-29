import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { jsonResponse, subagentChat, subagentFetch, subagentThread } from "@/tests/support/subagentViewFixtures";
import { resetSubagentStoreForTest, useSubagentStore } from "@/features/subagents-v2/subagentStore";
import { SubagentCallbackTurnV2, SubagentCardsV2, SubagentChatStatusV2, subagentRefsOf } from "./SubagentChatV2";

const activity = (calls: ThreadToolActivity["calls"]): ThreadToolActivity => ({ calls });
const callSubagent = (threadId: string, name: string, turnId: string) => ({
  origin: "tool" as const, round: 1, status: "complete" as const, subagent: { mode: "background" as const, name, threadId, turnId },
  toolName: "call_subagent"
});

beforeEach(() => resetSubagentStoreForTest());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sub-agents in the chat", () => {
  it("lists each sub-agent an answer started or continued once, ignoring its stop calls and its own steps", () => {
    const refs = subagentRefsOf(activity([
      callSubagent("thread-a", "alpha", "turn-1"),
      { origin: "tool", round: 2, status: "complete", subagentThreadId: "thread-a", subagentTurnId: "turn-1", toolName: "web_search" },
      callSubagent("thread-b", "beta", "turn-2"),
      callSubagent("thread-a", "alpha", "turn-3"),
      { origin: "tool", round: 3, status: "complete", subagent: { mode: "background", name: "beta", threadId: "thread-b" }, toolName: "stop_subagent" }
    ]));
    expect(refs.map((ref) => [ref.name, ref.turnId])).toEqual([["alpha", "turn-3"], ["beta", "turn-2"]]);
  });

  it("shows a card with the sub-agent's live state and a link to its thread", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<SubagentCardsV2 chatId="chat-a" onOpen={onOpen}
      toolActivity={activity([callSubagent("thread-a", "alpha", "turn-1")])} />);
    // Before the chat's projection arrives the card claims no state.
    expect(screen.getByRole("listitem")).toHaveTextContent(/^alphaOpen$/u);
    act(() => useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-a")]) } }));
    rerender(<SubagentCardsV2 chatId="chat-a" onOpen={onOpen} toolActivity={activity([callSubagent("thread-a", "alpha", "turn-1")])} />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    act(() => useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-a", "done")]) } }));
    expect(screen.getByText("Done")).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "Open alpha" });
    expect(open).toHaveAttribute("href", "/c/chat-a?agent=thread-a");
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith({ chatId: "chat-a", threadId: "thread-a" });
  });

  it("renders nothing for an answer without sub-agents", () => {
    const { container } = render(<SubagentCardsV2 chatId="chat-a" onOpen={vi.fn()}
      toolActivity={activity([{ origin: "tool", round: 1, status: "complete", toolName: "web_search" }])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the real phase and offers Stop all only while a sub-agent of the chat is active", async () => {
    const { calls, fetch } = subagentFetch([
      { method: "POST", path: "/api/chats/chat-a/subagents/stop-all", respond: () => jsonResponse({ stopped: 3 }) },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [
        subagentThread("thread-a", "stopped"), subagentThread("thread-b", "stopped"), subagentThread("thread-c", "stopped")
      ])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    act(() => useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [
      subagentThread("thread-a"), subagentThread("thread-b"), subagentThread("thread-c", "waiting"), subagentThread("thread-d", "done")
    ]) } }));
    const onOpen = vi.fn();
    render(<SubagentChatStatusV2 chatId="chat-a" onOpen={onOpen} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 sub-agents working · 1 waiting for you");
    fireEvent.click(screen.getByRole("link", { name: "Open c" }));
    expect(onOpen).toHaveBeenCalledWith({ chatId: "chat-a", threadId: "thread-c" });
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop all" })).toBeNull());
    expect(calls[0]).toMatchObject({ method: "POST" });
  });

  it("keeps a failed Stop all visible with its reason", async () => {
    vi.stubGlobal("fetch", subagentFetch([{ method: "POST", path: "/api/chats/chat-a/subagents/stop-all",
      respond: () => jsonResponse({ error: "boom" }, 500) }]).fetch);
    act(() => useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-a")]) } }));
    render(<SubagentChatStatusV2 chatId="chat-a" onOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 sub-agent working");
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not stop them.");
    expect(screen.getByRole("button", { name: "Stop all" })).toBeEnabled();
  });

  it("shows nothing when no sub-agent of the chat is active", () => {
    act(() => useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-a", "done")]) } }));
    const { container } = render(<SubagentChatStatusV2 chatId="chat-a" onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels a wake-up turn with the sub-agents it reports on, never as the user's message", () => {
    const names = Array.from({ length: 23 }, (_, index) => `agent-${index}`);
    const { rerender } = render(<SubagentCallbackTurnV2 anchorId="wake-1" names={["alpha", "beta"]} />);
    const turn = screen.getByRole("article", { name: "Sub-agent results" });
    expect(turn).toHaveAttribute("data-system-turn", "subagent_callback");
    expect(turn).toHaveTextContent("Sub-agent results: alpha, beta");
    rerender(<SubagentCallbackTurnV2 anchorId="wake-1" names={names} />);
    expect(turn).toHaveTextContent(`Sub-agent results: ${names.slice(0, 20).join(", ")} and 3 more`);
    rerender(<SubagentCallbackTurnV2 anchorId="wake-1" names={[]} />);
    expect(turn).toHaveTextContent(/^Sub-agent results$/u);
  });
});
