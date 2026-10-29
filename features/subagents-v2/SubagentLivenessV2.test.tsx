import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import { resetRunLifecycleStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { jsonResponse, subagentChat, subagentFetch, subagentThread } from "@/tests/support/subagentViewFixtures";
import { SubagentLivenessV2 } from "./SubagentLivenessV2";
import { SUBAGENT_POLL_INTERVAL_MS, resetSubagentStoreForTest, useSubagentStore } from "./subagentStore";

const navigationChat = (id: string): ChatNavigationSummaryWire => ({
  activeRun: false, assistant: null, folderId: null, id, title: id, updatedAt: "2026-10-30T08:00:00.000Z"
});

beforeEach(() => {
  vi.useFakeTimers();
  resetSubagentStoreForTest();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  resetWorkspaceStoreForTest();
  resetRunLifecycleStoreForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sub-agent liveness", () => {
  it("loads the listed chats, checks running ones on an interval, and stops when none runs", async () => {
    let running = true;
    const { calls, fetch } = subagentFetch([{ path: "/api/subagents", respond: (url) => jsonResponse({
      chats: url.searchParams.getAll("chatId").includes("a")
        ? [subagentChat("a", [subagentThread("thread-alpha", running ? "running" : "done")])] : []
    }) }]);
    vi.stubGlobal("fetch", fetch);
    useWorkspaceStore.getState().applyNavigationPage({ chats: [navigationChat("a"), navigationChat("b")], folders: [], nextCursor: null }, false);
    render(<SubagentLivenessV2 />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.getAll("chatId").sort()).toEqual(["a", "b"]);
    expect(useSubagentStore.getState().chats.a?.running).toBe(1);
    running = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_INTERVAL_MS + 10);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.getAll("chatId")).toEqual(["a"]);
    expect(useSubagentStore.getState().chats.a?.running).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_INTERVAL_MS * 3);
    });
    expect(calls).toHaveLength(2);
  });

  it("refreshes the open chat on a branch switch and reports when its sub-agents settle while it is idle", async () => {
    let state: "done" | "running" = "running";
    const { calls, fetch } = subagentFetch([
      { path: "/api/subagents", respond: () => jsonResponse({ chats: [] }) },
      { path: "/api/chats/a/subagents", respond: () => jsonResponse(subagentChat("a", [subagentThread("thread-alpha", state)])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    const workspace = useWorkspaceStore.getState();
    workspace.setChats([{ activeLeafMessageId: "leaf-1", createdAt: "2026-10-30T08:00:00.000Z", defaultModelId: "m",
      defaultProvider: "p", folderId: null, id: "a", messageCount: 2, title: "a", updatedAt: "2026-10-30T08:00:00.000Z" }]);
    workspace.setActiveChatId("a");
    const onActiveChatSettled = vi.fn();
    render(<SubagentLivenessV2 onActiveChatSettled={onActiveChatSettled} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls.filter((call) => call.url.pathname === "/api/chats/a/subagents")).toHaveLength(1);
    expect(useSubagentStore.getState().chats.a?.running).toBe(1);
    state = "done";
    await act(async () => {
      useWorkspaceStore.getState().setChats([{ ...useWorkspaceStore.getState().chats[0]!, activeLeafMessageId: "leaf-2" }]);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls.filter((call) => call.url.pathname === "/api/chats/a/subagents")).toHaveLength(2);
    expect(useSubagentStore.getState().chats.a?.running).toBe(0);
    expect(onActiveChatSettled).toHaveBeenCalledWith("a");
  });
});
