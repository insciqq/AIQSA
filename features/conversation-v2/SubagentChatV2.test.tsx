import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { SubagentThreadSummary } from "@/lib/contracts/subagentViews";
import { jsonResponse, subagentChat, subagentFetch, subagentThread } from "@/tests/support/subagentViewFixtures";
import { resetSubagentStoreForTest, useSubagentStore } from "@/features/subagents-v2/subagentStore";
import { SubagentAnswerRowsV2, SubagentBackgroundChipV2, SubagentCallbackTurnV2, subagentRefsOf } from "./SubagentChatV2";

const activity = (calls: ThreadToolActivity["calls"]): ThreadToolActivity => ({ calls });
const callSubagent = (threadId: string, name: string, turnId: string, mode: "background" | "foreground" = "foreground") => ({
  origin: "tool" as const, round: 1, status: "complete" as const, subagent: { mode, name, threadId, turnId },
  toolName: "call_subagent"
});
const foreground = (id: string, state: SubagentThreadSummary["state"] = "running", overrides: Partial<SubagentThreadSummary> = {}) =>
  subagentThread(id, state, { mode: "foreground", ...overrides });
const project = (threads: readonly SubagentThreadSummary[]) =>
  act(() => useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", threads) } }));
const webSearch = { origin: "web_search" as const, serverName: "Web search", toolName: "web_search" };
const luna = { displayName: "GPT-6 Luna", effort: "high" };

beforeEach(() => resetSubagentStoreForTest());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sub-agents an answer started", () => {
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

  it("makes the whole row the link to its thread, with its step and model, then its outcome and model", () => {
    const onOpen = vi.fn();
    const tool = activity([callSubagent("thread-a", "alpha", "turn-1")]);
    render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={onOpen} toolActivity={tool} />);
    // Before the chat's projection arrives the row claims no state, but it already opens the thread.
    const row = screen.getByRole("link", { name: "Open alpha" });
    expect(row).toHaveTextContent(/^alpha$/u);
    project([foreground("thread-a", "running", { currentStep: webSearch, model: luna })]);
    expect(screen.getByRole("link", { name: /^Open alpha/u })).toHaveTextContent("alphaSearching the web…GPT-6 Luna · high");
    project([foreground("thread-a", "done", { model: luna })]);
    const done = screen.getByRole("link", { name: "Open alpha, Done, GPT-6 Luna · high" });
    expect(done).toHaveAttribute("href", "/c/chat-a?agent=thread-a");
    expect(done).toHaveAttribute("data-tone", "ok");
    fireEvent.click(done);
    expect(onOpen).toHaveBeenCalledWith({ chatId: "chat-a", threadId: "thread-a" });
  });

  it("shows a running answer's foreground sub-agent from the projection, as live steps name none, and keeps it once it ended", () => {
    project([foreground("thread-a", "running", { currentStep: webSearch }), subagentThread("thread-b"), foreground("thread-c", "done")]);
    const { rerender } = render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={null} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open a, Searching the web…" })).toHaveAttribute("href", "/c/chat-a?agent=thread-a");
    project([foreground("thread-a", "done"), subagentThread("thread-b"), foreground("thread-c", "done")]);
    expect(screen.getByRole("link", { name: "Open a, Done" })).toBeInTheDocument();
    // The saved projection names the same sub-agent: still one row.
    rerender(<SubagentAnswerRowsV2 chatId="chat-a" live={false} onOpen={vi.fn()} toolActivity={activity([callSubagent("thread-a", "a", "turn-1")])} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("gives a settled answer no sub-agent it did not address", () => {
    project([foreground("thread-a")]);
    const { container } = render(<SubagentAnswerRowsV2 chatId="chat-a" live={false} onOpen={vi.fn()} toolActivity={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses neutral words when no step is known and for a step the answer hides, and renders an older row without a model", () => {
    project([foreground("thread-a")]);
    const tool = activity([callSubagent("thread-a", "alpha", "turn-1")]);
    render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={tool} />);
    expect(screen.getByRole("link", { name: "Open alpha, Working…" })).toBeInTheDocument();
    project([foreground("thread-a", "running", { currentStep: { origin: "session", serverName: "Plan", toolName: "update_plan" } })]);
    expect(screen.getByRole("link", { name: "Open alpha, Working…" })).toBeInTheDocument();
  });

  it("names a failed or stopped end by its reason and an unknown reason by its state", () => {
    project([foreground("thread-a", "stopped", { reason: "stopped_by_user" }), foreground("thread-b", "failed", { reason: "provider_error" })]);
    render(<SubagentAnswerRowsV2 chatId="chat-a" live={false} onOpen={vi.fn()}
      toolActivity={activity([callSubagent("thread-a", "alpha", "turn-1"), callSubagent("thread-b", "beta", "turn-2")])} />);
    expect(screen.getByRole("link", { name: /^Open beta, Failed/u })).toHaveAttribute("data-tone", "danger");
    expect(screen.getByRole("link", { name: /^Open alpha/u })).toHaveAttribute("data-state", "stopped");
  });

  it("reads a sub-agent waiting for the user as such, in the warn tone", () => {
    project([foreground("thread-a", "waiting", { currentStep: { origin: "workspace", toolName: "browser_handoff" } })]);
    render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={activity([callSubagent("thread-a", "alpha", "turn-1")])} />);
    expect(screen.getByRole("link", { name: "Open alpha, Waiting for you" })).toHaveAttribute("data-tone", "warn");
  });

  it("gives each active sub-agent one place: a background one in the chip, a foreground one in the answer running it", () => {
    const tool = activity([callSubagent("thread-a", "alpha", "turn-1", "background")]);
    project([subagentThread("thread-a")]);
    const { container, rerender } = render(<SubagentAnswerRowsV2 chatId="chat-a" live={false} onOpen={vi.fn()} toolActivity={tool} />);
    expect(container).toBeEmptyDOMElement();
    // Once it has ended, the answer that started it keeps its outcome and model.
    project([subagentThread("thread-a", "done", { model: luna })]);
    expect(screen.getByRole("link", { name: "Open alpha, Done, GPT-6 Luna · high" })).toBeInTheDocument();
    // An earlier answer of a thread a later answer is running holds no second row.
    project([foreground("thread-a")]);
    expect(container).toBeEmptyDOMElement();
    rerender(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={tool} />);
    expect(screen.getByRole("link", { name: /^Open alpha/u })).toBeInTheDocument();
  });

  it("shows up to three rows and collapses more into one summary row that unfolds", () => {
    const names = ["a", "b", "c", "d", "e"];
    const threads = names.map((name, index) => foreground(`thread-${name}`, index < 3 ? "done" : "running"));
    project(threads);
    const tool = activity(names.map((name) => callSubagent(`thread-${name}`, name, `turn-${name}`)));
    const { rerender } = render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={tool} />);
    const summary = screen.getByRole("button", { name: "5 sub-agents · 3 done, 2 running" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("link")).toHaveLength(5);
    fireEvent.click(summary);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    // A summary claims no state for one the projection does not have.
    project([threads[0]!]);
    rerender(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={tool} />);
    expect(screen.getByRole("button", { name: "5 sub-agents · 1 done" })).toBeInTheDocument();
  });

  it("keeps three as plain rows", () => {
    const names = ["a", "b", "c"];
    project(names.map((name) => foreground(`thread-${name}`, "done")));
    render(<SubagentAnswerRowsV2 chatId="chat-a" live={false} onOpen={vi.fn()}
      toolActivity={activity(names.map((name) => callSubagent(`thread-${name}`, name, `turn-${name}`)))} />);
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("warns through the summary row when a collapsed sub-agent waits for the user", () => {
    const names = ["a", "b", "c", "d"];
    project(names.map((name, index) => foreground(`thread-${name}`, index === 0 ? "waiting" : "running")));
    render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()}
      toolActivity={activity(names.map((name) => callSubagent(`thread-${name}`, name, `turn-${name}`)))} />);
    expect(screen.getByRole("button", { name: "4 sub-agents · 3 running, 1 waiting for you" })).toHaveAttribute("data-tone", "warn");
  });

  it("says so when the projection cannot be refreshed instead of implying the rows are current", () => {
    act(() => useSubagentStore.setState({ chatErrors: { "chat-a": true } }));
    render(<SubagentAnswerRowsV2 chatId="chat-a" live onOpen={vi.fn()} toolActivity={activity([callSubagent("thread-a", "alpha", "turn-1")])} />);
    expect(screen.getByRole("link", { name: "Open alpha" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh sub-agents.");
  });

  it("renders nothing for an answer without sub-agents", () => {
    const { container } = render(<SubagentAnswerRowsV2 chatId="chat-a" live={false} onOpen={vi.fn()}
      toolActivity={activity([{ origin: "tool", round: 1, status: "complete", toolName: "web_search" }])} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("background sub-agents above the composer", () => {
  it("shows nothing without an active background sub-agent: a foreground one has its row and the composer's Stop", () => {
    project([subagentThread("thread-a", "done"), foreground("thread-b")]);
    const { container } = render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links one straight to its thread with its step, and offers no Stop all", () => {
    const onOpen = vi.fn();
    project([subagentThread("thread-a", "running", { currentStep: webSearch, model: luna }), subagentThread("thread-b", "done")]);
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={onOpen} />);
    const chip = screen.getByRole("link", { name: "Open a, Searching the web…, GPT-6 Luna · high" });
    expect(chip).toHaveAttribute("href", "/c/chat-a?agent=thread-a");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith({ chatId: "chat-a", threadId: "thread-a" });
    expect(screen.queryByText("Stop all")).toBeNull();
  });

  it("reads a single waiting sub-agent as such in the warn tone", () => {
    project([subagentThread("thread-a", "waiting")]);
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open a, Waiting for you" })).toHaveAttribute("data-tone", "warn");
  });

  it("opens a list of several, each row with its thread and its own stop, and Stop all ends them", async () => {
    const onOpen = vi.fn();
    const { calls, fetch } = subagentFetch([
      { method: "POST", path: "/api/chats/chat-a/subagents/stop-all", respond: () => jsonResponse({ stopped: 3 }) },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [
        subagentThread("thread-a", "stopped"), subagentThread("thread-b", "stopped"), subagentThread("thread-c", "stopped")
      ])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    project([subagentThread("thread-a"), subagentThread("thread-b"), subagentThread("thread-c", "waiting"), subagentThread("thread-d", "done"),
      foreground("thread-e")]);
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: "2 sub-agents working · 1 waiting for you" });
    expect(chip).toHaveAttribute("data-tone", "warn");
    fireEvent.click(chip);
    const menu = screen.getByRole("menu", { name: "Background sub-agents" });
    expect(within(menu).getByRole("menuitem", { name: "Stop a" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Stop e/u })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stop all" }));
    await waitFor(() => expect(screen.queryByTestId("subagent-chat-chip")).toBeNull());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(calls[0]).toMatchObject({ method: "POST" });
  });

  it("opens a thread from its row and closes the list", () => {
    const onOpen = vi.fn();
    project([subagentThread("thread-a"), subagentThread("thread-b", "waiting")]);
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /sub-agent/u }));
    const open = screen.getByRole("menuitem", { name: "Open b, Waiting for you" });
    expect(open).toHaveAttribute("href", "/c/chat-a?agent=thread-b");
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith({ chatId: "chat-a", threadId: "thread-b" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the list open while one row is stopped, and a failed stop stays visible on its row", async () => {
    const stopped = subagentThread("thread-a", "stopped");
    const { fetch } = subagentFetch([
      { method: "POST", path: "/api/chats/chat-a/subagents/thread-a/stop", respond: () => jsonResponse({ thread: stopped }) },
      { method: "POST", path: "/api/chats/chat-a/subagents/thread-b/stop", respond: () => jsonResponse({ error: "boom" }, 500) },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [stopped, subagentThread("thread-b")])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    project([subagentThread("thread-a"), subagentThread("thread-b")]);
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "2 sub-agents working" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop a" }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Stop a" })).toBeNull());
    expect(screen.getByRole("button", { name: "1 sub-agent working" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop b" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not stop b. Try again.");
    expect(screen.getByRole("menuitem", { name: "Stop b" })).toBeEnabled();
  });

  it("keeps a failed Stop all visible with its reason", async () => {
    vi.stubGlobal("fetch", subagentFetch([{ method: "POST", path: "/api/chats/chat-a/subagents/stop-all",
      respond: () => jsonResponse({ error: "boom" }, 500) }]).fetch);
    project([subagentThread("thread-a"), subagentThread("thread-b")]);
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "2 sub-agents working" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop all" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not stop them.");
    expect(screen.getByRole("menuitem", { name: "Stop all" })).toBeEnabled();
  });

  it("says so when the chat's sub-agents cannot be refreshed", () => {
    act(() => useSubagentStore.setState({ chatErrors: { "chat-a": true }, chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-a")]) } }));
    render(<SubagentBackgroundChipV2 chatId="chat-a" onOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh sub-agents.");
  });
});

describe("the wake-up turn", () => {
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
