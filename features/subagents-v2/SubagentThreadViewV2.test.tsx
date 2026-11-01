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
  it("shows the briefs, messages, steps and reply with a composer and Stop while it runs", async () => {
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
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByTestId("composer-v2-surface")).toHaveAttribute("data-message-only");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === `${threadPath}/stop`)).toBe(true);
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/This sub-agent has finished/u)).toBeInTheDocument();
  });

  it("shows what agents wrote as rows of the thread, and a wait for the main agent in plain words that ask nothing of the user", async () => {
    const asking = subagentThread("thread-researcher", "waiting", { reason: "waiting_for_answer" });
    const turn = subagentTurn("turn-1", "waiting", { messages: [
      { createdAt: "2026-10-30T09:01:00.000Z", delivery: "delivered", from: "scout", text: "The outlet closes at nine." },
      { createdAt: "2026-10-30T09:02:00.000Z", delivery: "accepted", text: "Thanks, mine is seven.", to: "scout" },
      { createdAt: "2026-10-30T09:03:00.000Z", delivery: "accepted", question: true, text: "Which size should I take?", to: "main" }
    ], reason: "waiting_for_answer" });
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () => jsonResponse(subagentView("chat-a", asking, [turn])) }]).fetch);
    renderView();
    expect(await screen.findByText("The outlet closes at nine.")).toBeInTheDocument();
    expect(screen.getByText("Message from scout · Read by the sub-agent")).toBeInTheDocument();
    expect(screen.getByText("Message to scout")).toBeInTheDocument();
    expect(screen.getByText("Question to the main agent")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for the main agent").length).toBeGreaterThan(0);
    expect(screen.queryByText("Waiting for you")).toBeNull();
    expect(screen.getByText(/Your message will be read at the next step; it does not end this wait/u)).toBeInTheDocument();
    // Stop reaches it while it waits.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("names a child's parent where a sub-agent's thread names the main agent", async () => {
    const asking = subagentThread("thread-researcher", "waiting", { parent: { id: "thread-research", name: "research" }, reason: "waiting_for_answer" });
    const turn = subagentTurn("turn-1", "waiting", { reason: "waiting_for_answer" });
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () => jsonResponse(subagentView("chat-a", asking, [turn])) }]).fetch);
    renderView();
    expect(await screen.findByText("Brief from research")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for research").length).toBeGreaterThan(0);
    expect(screen.queryByText("Brief from the main agent")).toBeNull();
    expect(screen.getByText(/Waiting for research’s answer/u)).toBeInTheDocument();
  });

  it("sends a finished child's follow-up through its parent, which alone continues it", async () => {
    const ended = subagentThread("thread-researcher", "done", { parent: { id: "thread-research", name: "research" } });
    vi.stubGlobal("fetch", subagentFetch([{ path: threadPath, respond: () => jsonResponse(subagentView("chat-a", ended)) }]).fetch);
    renderView();
    expect(await screen.findByText(/ask the main agent to continue research by name/u)).toBeInTheDocument();
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

for (const sendWithEnter of [true, false]) {
  it(`sends user speech with the product keyboard preference (${sendWithEnter}), preserving IME and newline input`, async () => {
    let sent = false;
    const received: Array<{ nonce: string; text: string; turnId: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        received.push(JSON.parse(String(init.body)) as { nonce: string; text: string; turnId: string });
        sent = true;
        return jsonResponse({ accepted: true }, 202);
      }
      return jsonResponse(subagentView("chat-a", subagentThread(target.threadId), [subagentTurn("turn-1", "running", {
        messages: sent ? [{ createdAt: "2026-10-30T09:04:00.000Z", delivery: "accepted", text: "Please place the order.", user: true }] : []
      })]));
    }));
    act(() => setOpenSubagentThread(target));
    render(<SubagentThreadViewV2 target={target} onBack={vi.fn()} sendWithEnter={sendWithEnter} />);
    const field = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "Please place the order." } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(received).toHaveLength(0);
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: !sendWithEnter });
    expect(await screen.findByRole("article", { name: "Your message" })).toHaveTextContent("Please place the order.");
    expect(received).toEqual([{ nonce: expect.any(String), text: "Please place the order.", turnId: "turn-1" }]);
    expect(field).toHaveValue("");
    expect(screen.getByText("Queued for the sub-agent’s next step")).toBeInTheDocument();
  });
}

it("keeps the draft on a visible mailbox refusal and prevents duplicate submissions", async () => {
  let finish!: (response: Response) => void;
  const posted: Array<{ nonce: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)) as { nonce: string });
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return jsonResponse(subagentView("chat-a", subagentThread(target.threadId)));
  }));
  renderView();
  const field = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(field, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(posted).toHaveLength(1);
  await act(async () => finish(jsonResponse({ error: "subagent_message_limit_reached" }, 409)));
  expect(screen.getByRole("alert")).toHaveTextContent("mailbox is full");
  expect(field).toHaveValue("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(posted[1]!.nonce).toBe(posted[0]!.nonce);
  await act(async () => finish(jsonResponse({ accepted: true }, 202)));
});
