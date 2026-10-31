import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonResponse,
  subagentFetch,
  subagentThread,
  subagentTurn,
  subagentView
} from "@/tests/support/subagentViewFixtures";
import { invalidateChatSubagents, resetSubagentStoreForTest, setOpenSubagentThread, useSubagentStore } from "./subagentStore";
import { SubagentThreadViewV2 } from "./SubagentThreadViewV2";

const target = { chatId: "chat-a", threadId: "thread-researcher" };
const threadPath = "/api/chats/chat-a/subagents/thread-researcher";

function renderView(onBack = vi.fn()) {
  act(() => setOpenSubagentThread(target));
  return { onBack, view: render(<SubagentThreadViewV2 target={target} onBack={onBack} />) };
}

beforeEach(() => resetSubagentStoreForTest());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sub-agent thread view", () => {
  it("shows the briefs, messages, steps and reply read-only, with Stop while it runs", async () => {
    const running = subagentThread("thread-researcher");
    const stopped = subagentThread("thread-researcher", "stopped", { updatedAt: "2026-10-30T09:06:00.000Z" });
    const first = subagentTurn("turn-1", "done", { mode: "foreground", report: "First **report**." });
    const second = subagentTurn("turn-2", "running", {
      brief: "Now check the reviews.",
      messages: [{ createdAt: "2026-10-30T09:02:00.000Z", delivery: "delivered", text: "Skip refurbished ones." }],
      toolActivity: { calls: [{ origin: "tool", round: 1, status: "running", toolName: "web_search" }] }
    });
    let stoppedYet = false;
    const { calls, fetch } = subagentFetch([
      { path: threadPath, respond: () => jsonResponse(stoppedYet
        ? subagentView("chat-a", stopped, [first, subagentTurn("turn-2", "stopped", { brief: "Now check the reviews." })])
        : subagentView("chat-a", running, [first, second])) },
      { method: "POST", path: `${threadPath}/stop`, respond: () => {
        stoppedYet = true;
        return jsonResponse({ thread: stopped });
      } },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse({ chatId: "chat-a", running: 0, threads: [stopped], truncated: false }) }
    ]);
    vi.stubGlobal("fetch", fetch);
    renderView();
    expect(await screen.findByRole("heading", { name: "researcher" })).toBeInTheDocument();
    expect(screen.getByText("Compare the three cheapest laptops.")).toBeInTheDocument();
    expect(screen.getByText("Now check the reviews.")).toBeInTheDocument();
    expect(screen.getByText("Skip refurbished ones.")).toBeInTheDocument();
    expect(screen.getByText(/Message from the main agent · Read by the sub-agent/u)).toBeInTheDocument();
    expect(screen.getByText("report")).toBeInTheDocument();
    // No composer: writing to a sub-agent comes later.
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === `${threadPath}/stop`)).toBe(true);
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  });

  it("goes back to the chat from its back link", async () => {
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () =>
      jsonResponse(subagentView("chat-a", subagentThread("thread-researcher", "done"))) }]).fetch);
    const { onBack } = renderView();
    const back = await screen.findByRole("link", { name: "Back to chat" });
    expect(back).toHaveAttribute("href", "/c/chat-a");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("says a thread the routes refuse is not available here, the same for every reason", async () => {
    vi.stubGlobal("fetch", subagentFetch([]).fetch);
    const { onBack } = renderView();
    expect(await screen.findByText(/This sub-agent is not available here/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("shows loading, then a load failure with Retry, never an empty thread", async () => {
    let fail = true;
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () => fail
      ? jsonResponse({ error: "unavailable" }, 503)
      : jsonResponse(subagentView("chat-a", subagentThread("thread-researcher", "done"))) }]).fetch);
    renderView();
    expect(screen.getByRole("status", { name: "Loading sub-agent" })).toBeInTheDocument();
    expect(await screen.findByText("Could not load this sub-agent.")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Found three laptops.")).toBeInTheDocument();
  });

  it("checks a running sub-agent again until it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: "done" | "running" = "running";
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () =>
      jsonResponse(subagentView("chat-a", subagentThread("thread-researcher", state))) }]).fetch);
    renderView();
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    state = "done";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.getByText("Found three laptops.")).toBeInTheDocument();
  });

  it("starts over on a branch switch and shows that the thread is not on the new branch", async () => {
    let onBranch = true;
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () => onBranch
      ? jsonResponse(subagentView("chat-a", subagentThread("thread-researcher", "done")))
      : jsonResponse({ error: "subagent_not_found" }, 404) }]).fetch);
    renderView();
    expect(await screen.findByText("Found three laptops.")).toBeInTheDocument();
    onBranch = false;
    act(() => void invalidateChatSubagents("chat-a"));
    // The previous branch's reply is gone at once, before the new answer.
    expect(screen.queryByText("Found three laptops.")).toBeNull();
    expect(await screen.findByText(/This sub-agent is not available here/u)).toBeInTheDocument();
    expect(screen.queryByText("Found three laptops.")).toBeNull();
    expect(useSubagentStore.getState().view?.status).toBe("unavailable");
  });

  it("names an ended turn's whole duration, not only its tool steps", async () => {
    const ended = subagentTurn("turn-1", "done", {
      endedAt: "2026-10-30T09:03:20.000Z", startedAt: "2026-10-30T09:00:00.000Z", report: "Done.",
      workspaceActivity: { entries: [{ command: { preview: "python forecast.py" }, durationMs: 75, id: "call:1", kind: "command", phase: "succeeded" }] }
    });
    const { fetch } = subagentFetch([{ path: threadPath, respond: () => jsonResponse(subagentView("chat-a", subagentThread("thread-researcher", "done"), [ended])) }]);
    vi.stubGlobal("fetch", fetch);
    renderView();
    expect(await screen.findByText("Worked in Workspace for 3m 20s")).toBeInTheDocument();
  });
});
