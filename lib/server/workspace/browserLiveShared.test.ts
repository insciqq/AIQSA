// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import { WORKSPACE_AGENT_PROTOCOL } from "../subagents/guestProtocol";
import type { BrowserLiveChannelRequest } from "./browserLive";
import { BrowserLiveRelay, BROWSER_LIVE_RELAY_LIMITS } from "./browserLive";
import { fakeLiveGuest, recordingWriter, until } from "./browserLive.testFixtures";

const owner = { authSessionId: "session-1", userId: "user-1" };
const shop = { id: "thread_shop", name: "shop" };
const signal = () => new AbortController().signal;

afterEach(() => { vi.useRealTimers(); });

/**
 * One guest, reached through each run's own channel, as the runtime serves a streamer only to its starting run. A run
 * in `failing` has its channel refuse with that code: `workspace_session_lost` for a run without a guest session (a
 * background sub-agent that has not used the Workspace yet).
 */
function sharedGuest(options: Parameters<typeof fakeLiveGuest>[0] = {}) {
  const guest = fakeLiveGuest(options);
  const calls: Array<Readonly<{ action: string; runId: string }>> = [];
  const failing = new Map<string, string>();
  const channel = (runId: string) => (request: BrowserLiveChannelRequest) => {
    calls.push({ action: request.action, runId });
    const code = failing.get(runId);
    if (code) return Promise.reject(Object.assign(new Error(code), { code }));
    return guest.channel(request);
  };
  const starts = () => calls.filter((call) => call.action === "start").map((call) => call.runId);
  return { calls, channel, failing, guest, starts };
}

/** The main run first, then a background sub-agent's run: the newest member. */
function mainAndSubagent(options: Parameters<typeof fakeLiveGuest>[0] = {}, mainFlag = true) {
  const shared = sharedGuest(options);
  const relay = new BrowserLiveRelay();
  const registration = (runId: string, main: boolean) => ({ channel: shared.channel(runId), chatId: "chat-1",
    ...(main ? { main: true } : {}), runId, signInRemembered: async () => false, userId: "user-1" });
  const main = relay.register(registration("run-main", mainFlag));
  const subagent = relay.register(registration("run-subagent", false));
  return { ...shared, main, relay, subagent, view: relay.find("chat-1", "user-1")! };
}

describe("browser live transport through a member with a guest session", () => {
  it("starts the panel's streamer through an older member when the newest has no guest session", async () => {
    const { calls, failing, main, starts, subagent, view } = mainAndSubagent({}, false);
    failing.set("run-subagent", "workspace_session_lost");
    const tab = recordingWriter();
    expect(await view.watch(owner, tab.writer)).not.toBeNull();
    await until(() => tab.of("frame").length === 1);
    expect(starts()).toEqual(["run-subagent", "run-main"]);
    expect(tab.last<BrowserLiveStateEvent>("state")?.browser).toBe("running");
    // Everything after the start goes through the member that started the streamer.
    expect(calls.filter((call) => call.action !== "start").every((call) => call.runId === "run-main")).toBe(true);
    await subagent.end("run_finished");
    await main.end("run_finished");
  });

  it("starts the panel's streamer through the main agent's run first", async () => {
    const { main, starts, subagent, view } = mainAndSubagent();
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.of("frame").length === 1);
    expect(starts()).toEqual(["run-main"]);
    await subagent.end("run_finished");
    await main.end("run_finished");
  });

  it("begins a sub-agent's handoff through another member, still for the sub-agent's own tab only", async () => {
    const { failing, guest, main, starts, subagent } = mainAndSubagent();
    failing.set("run-subagent", "workspace_session_lost");
    const result = await subagent.handoff({ agent: shop, message: "Solve the check", reason: "captcha", signal: signal(), waitMs: 200 });
    expect(result).toEqual({ kind: "ended", outcome: "timed_out", page: { title: "Sign in", url: "https://shop.example/login" },
      saved: null });
    // The asking agent's run first, then the others.
    expect(starts()).toEqual(["run-subagent", "run-main"]);
    const handoffs = guest.received.filter((message) => message.t === "handoff");
    expect(handoffs.map((message) => [message.action, message[WORKSPACE_AGENT_PROTOCOL.LIVE_AGENT_FIELD]]))
      .toEqual([["begin", "thread_shop"], ["end", "thread_shop"]]);
    await subagent.end("run_finished");
    await main.end("run_finished");
  });

  it("begins a handoff through the asking agent's run when it has a guest session", async () => {
    const { main, starts, subagent } = mainAndSubagent();
    expect(await subagent.handoff({ agent: shop, message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 50 }))
      .toMatchObject({ kind: "ended", outcome: "timed_out" });
    expect(starts()).toEqual(["run-subagent"]);
    await subagent.end("run_finished");
    await main.end("run_finished");
  });

  it("says no page only when the guest reached through another member says so", async () => {
    const { failing, main, subagent } = mainAndSubagent({ noPage: true });
    failing.set("run-subagent", "workspace_session_lost");
    expect(await subagent.handoff({ agent: shop, message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 1_000 }))
      .toEqual({ kind: "no_browser" });
    await subagent.end("run_finished");
    await main.end("run_finished");
  });

  it("tries no other member after a failure other than a missing guest session", async () => {
    const { failing, main, starts, subagent } = mainAndSubagent();
    failing.set("run-subagent", "workspace_operation_stale");
    expect(await subagent.handoff({ agent: shop, message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 1_000 }))
      .toEqual({ kind: "unavailable" });
    expect(starts()).toEqual(["run-subagent"]);
    await subagent.end("run_finished");
    await main.end("run_finished");
  });

  it("is unavailable while no member has a guest session, and the panel recovers once any member's guest is live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { failing, main, starts, subagent, view } = mainAndSubagent();
    failing.set("run-main", "workspace_session_lost");
    failing.set("run-subagent", "workspace_session_lost");
    expect(await main.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 1_000 })).toEqual({ kind: "unavailable" });
    expect(starts()).toEqual(["run-main", "run-subagent"]);
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.retryMs * 3);
    expect(tab.closed()).toBeUndefined();
    expect(tab.of("frame")).toEqual([]);
    // The sub-agent used the Workspace: its run now has the guest session.
    failing.delete("run-subagent");
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.retryMs + 100);
    await until(() => tab.of("frame").length === 1);
    expect(tab.last<BrowserLiveStateEvent>("state")?.browser).toBe("running");
    expect(starts().at(-1)).toBe("run-subagent");
    await subagent.end("run_finished");
    await main.end("run_finished");
  });
});

describe("browser live channel of a shared Workspace", () => {
  it("keeps the session's views across one run's end and closes them with the last run", async () => {
    const { calls, channel, guest } = sharedGuest();
    const relay = new BrowserLiveRelay();
    const registration = (runId: string) => ({ channel: channel(runId), chatId: "chat-1", runId,
      signInRemembered: async () => false, userId: "user-1" });
    const main = relay.register(registration("run-main"));
    const tab = recordingWriter();
    expect(await relay.find("chat-1", "user-1")!.watch(owner, tab.writer)).not.toBeNull();
    await until(() => tab.of("frame").length === 1);
    // A sub-agent run of the same chat joins the open channel instead of ending its views.
    const subagent = relay.register(registration("run-subagent"));
    expect(tab.closed()).toBeUndefined();

    await main.end("run_finished");
    // The streamer the main run started is replaced through the sub-agent run, then closed through its own run.
    expect(tab.closed()).toBeUndefined();
    expect(calls).toContainEqual({ action: "start", runId: "run-subagent" });
    expect(calls).toContainEqual({ action: "close", runId: "run-main" });
    const ended = calls.length;
    const before = tab.of("frame").length;
    guest.frame();
    await until(() => tab.of("frame").length > before);
    // Once the main run left, nothing reaches the guest through its channel any more.
    expect(calls.slice(ended).every((call) => call.runId === "run-subagent")).toBe(true);
    expect(relay.find("chat-1", "user-1")).not.toBeNull();

    await subagent.end("run_finished");
    expect(tab.closed()).toEqual({ data: { reason: "run_finished" }, event: "end" });
    expect(relay.find("chat-1", "user-1")).toBeNull();
    expect(guest.open()).toBe(0);
  });

  it("drops a member whose run is gone without ending, so the last live run still closes the channel", async () => {
    const { channel } = sharedGuest();
    const relay = new BrowserLiveRelay();
    let crashedHolds = true;
    relay.register({ attached: async () => crashedHolds, channel: channel("run-crashed"), chatId: "chat-1", runId: "run-crashed",
      signInRemembered: async () => false, userId: "user-1" });
    const live = relay.register({ attached: async () => true, channel: channel("run-live"), chatId: "chat-1", runId: "run-live",
      signInRemembered: async () => false, userId: "user-1" });
    const tab = recordingWriter();
    await relay.find("chat-1", "user-1")!.watch(owner, tab.writer);
    // The crashed run never calls `end`; it no longer holds the Workspace.
    crashedHolds = false;
    await live.end("run_finished");
    expect(tab.closed()).toEqual({ data: { reason: "run_finished" }, event: "end" });
    expect(relay.find("chat-1", "user-1")).toBeNull();
  });

  it("ends every run's view at once when the browser itself stopped", async () => {
    const { channel } = sharedGuest();
    const relay = new BrowserLiveRelay();
    const first = relay.register({ channel: channel("run-1"), chatId: "chat-1", runId: "run-1", signInRemembered: async () => false,
      userId: "user-1" });
    const second = relay.register({ channel: channel("run-2"), chatId: "chat-1", runId: "run-2", signInRemembered: async () => false,
      userId: "user-1" });
    const tab = recordingWriter();
    await relay.find("chat-1", "user-1")!.watch(owner, tab.writer);
    await first.end("browser_stopped");
    expect(tab.closed()).toEqual({ data: { reason: "browser_stopped" }, event: "end" });
    expect(relay.find("chat-1", "user-1")).toBeNull();
    await second.end("run_finished");
  });
});
