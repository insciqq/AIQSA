// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_LIVE_LIMITS, type BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import { BrowserLiveRelay, BROWSER_LIVE_RELAY_LIMITS, decodeBrowserLiveLine } from "./browserLive";
import { fakeLiveGuest, FRAME_DATA, recordingWriter, until } from "./browserLive.testFixtures";

const owner = { authSessionId: "session-1", userId: "user-1" };
const secondTab = { authSessionId: "session-2", userId: "user-1" };
const click = { button: "left", kind: "mouse", type: "down", x: 10, y: 20 } as const;

function setup(options: Parameters<typeof fakeLiveGuest>[0] = {}) {
  const relay = new BrowserLiveRelay();
  const guest = fakeLiveGuest(options);
  const handle = relay.register({ channel: guest.channel, chatId: "chat-1", runId: "run-1", signInRemembered: async () => true,
    userId: "user-1" });
  return { guest, handle, relay, view: relay.find("chat-1", "user-1")! };
}

const ended: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const end of ended.splice(0)) await end();
  vi.useRealTimers();
});

describe("browser live lines", () => {
  it("reads a length-tagged line and drops a cut or foreign one", () => {
    expect(decodeBrowserLiveLine('@22 {"t":"state","x":"y"}')).toBeNull();
    expect(decodeBrowserLiveLine('@21 {"t":"state","x":"y"}')).toEqual({ t: "state", x: "y" });
    expect(decodeBrowserLiveLine('@21 {"t":"state","x":"y')).toBeNull();
    expect(decodeBrowserLiveLine("Traceback (most recent call last):")).toBeNull();
    expect(decodeBrowserLiveLine("@2 []")).toBeNull();
  });
});

describe("browser live relay", () => {
  it("finds a chat's live browser for the run's owner only", () => {
    const { handle, relay } = setup();
    ended.push(() => handle.end());
    expect(relay.find("chat-1", "user-1")).not.toBeNull();
    // Another user and an administrator (who is just another user here) find nothing, as for an unknown chat.
    expect(relay.find("chat-1", "admin-1")).toBeNull();
    expect(relay.find("chat-2", "user-1")).toBeNull();
  });

  it("shows a view the state, the steps and paced frames, and forgets the run once it ended", async () => {
    const { guest, handle, relay, view } = setup();
    const tab = recordingWriter();
    expect(await view.watch(owner, tab.writer)).not.toBeNull();
    const first = tab.last<BrowserLiveStateEvent>("state")!;
    expect(first).toMatchObject({ agents: [{ controller: "agent", id: "main", name: null, page: null, waitingForUser: false }],
      browser: "absent", controller: "agent", handoff: null, handoffs: [], runId: "run-1", selected: "main", signInRemembered: true,
      version: 2 });
    await until(() => tab.of("frame").length === 1);
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ browser: "running",
      page: { title: "Sign in", url: "https://shop.example/login" } });
    expect(tab.last("frame")).toEqual({ agent: "main", data: FRAME_DATA, height: 800, mime: "image/jpeg", seq: 1, width: 1280 });
    guest.navigate("https://shop.example/cart", "Cart");
    guest.frame();
    await until(() => tab.of("frame").length === 2);
    expect(tab.last<BrowserLiveStateEvent>("state")?.page).toEqual({ title: "Cart", url: "https://shop.example/cart" });
    await handle.end("run_finished");
    expect(tab.closed()).toEqual({ data: { reason: "run_finished" }, event: "end" });
    expect(tab.last<BrowserLiveStateEvent>("state")?.browser).toBe("stopped");
    expect(guest.open()).toBe(0);
    expect(relay.find("chat-1", "user-1")).toBeNull();
    // A finished run answers like an unknown one.
    expect(await view.input(owner, click)).toBe("browser_live_not_found");
  });

  it("lets a second tab of the owner watch, and a fifth view replaces the oldest", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tabs = Array.from({ length: BROWSER_LIVE_RELAY_LIMITS.views }, () => recordingWriter());
    for (const tab of tabs) await view.watch(tabs.indexOf(tab) === 1 ? secondTab : owner, tab.writer);
    await until(() => tabs.every((tab) => tab.of("frame").length >= 1));
    expect(guest.started()).toBe(1);
    const fifth = recordingWriter();
    await view.watch(owner, fifth.writer);
    expect(tabs[0]!.closed()).toEqual({ data: { reason: "replaced" }, event: "end" });
    expect(tabs[1]!.closed()).toBeUndefined();
    guest.frame();
    await until(() => fifth.of("frame").length >= 1 && tabs[1]!.of("frame").length >= 2);
  });

  it("accepts input only while the user holds the browser, from any tab of the owner, within the rate", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.browser === "running");
    expect(await view.input(owner, click)).toBe("browser_live_not_in_control");
    expect(await view.control(owner, "take")).toBeNull();
    expect(tab.last<BrowserLiveStateEvent>("state")?.controller).toBe("user");
    expect(await view.input(secondTab, click)).toBeNull();
    expect(await view.input(owner, { kind: "text", text: "123456" })).toBeNull();
    expect(guest.received.filter((message) => message.t === "input").map((message) => message.input))
      .toEqual([click, { kind: "text", text: "123456" }]);
    const results = await Promise.all(Array.from({ length: BROWSER_LIVE_LIMITS.inputsPerSecond }, () => view.input(owner, click)));
    expect(results.filter((code) => code === "browser_live_rate_limited").length).toBeGreaterThan(0);
    expect(await view.control(owner, "return")).toBeNull();
    expect(tab.last<BrowserLiveStateEvent>("state")?.controller).toBe("agent");
  });

  it("never takes the guest's word that the user holds the browser, but believes it is the agent's again", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.browser === "running");
    // Agent code that reaches the host socket reports the user in control.
    guest.report("user");
    guest.navigate("https://shop.example/forged", "Forged");
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.page?.title === "Forged");
    expect(tab.of("state").every((state) => (state as BrowserLiveStateEvent).controller === "agent")).toBe(true);
    expect(await view.input(owner, click)).toBe("browser_live_not_in_control");
    // The owner's own Take gives it; the guest's grace end or restart hands it back.
    expect(await view.control(owner, "take")).toBeNull();
    expect(tab.last<BrowserLiveStateEvent>("state")?.controller).toBe("user");
    guest.report("agent");
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.controller === "agent");
    expect(await view.input(owner, click)).toBe("browser_live_not_in_control");
  });

  it("sends a command during a rotation to the replacement, never to the retiring streamer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { guest, handle, view } = setup({ startDelayMs: 200 });
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.of("frame").length === 1);
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.rotateMs + 50);
    await until(() => guest.started() === 2);
    const taking = view.control(owner, "take");
    await vi.advanceTimersByTimeAsync(300);
    expect(await taking).toBeNull();
    const take = guest.received.findIndex((message) => message.t === "control");
    expect(guest.through[take]).toBe("exec-1");
    await until(() => guest.open() === 1);
  });

  it("drops a slow view's frames but ends a view that cannot take the state", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const slow = recordingWriter({ refuseFrames: true });
    await view.watch(owner, slow.writer);
    await until(() => slow.last<BrowserLiveStateEvent>("state")?.browser === "running");
    guest.frame();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slow.closed()).toBeUndefined();
    const stuck = recordingWriter();
    await view.watch(owner, stuck.writer);
    const send = stuck.writer.send;
    Object.assign(stuck.writer, { send: (event: string, data: unknown) => event === "state" ? false : send(event, data) });
    guest.navigate("https://shop.example/next", "Next");
    await until(() => stuck.closed() !== undefined);
    expect(stuck.closed()).toEqual({ data: { reason: "error" }, event: "end" });
  });

  it("closes the streamer a moment after the last view and opens a new one for the next", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    const id = await view.watch(owner, tab.writer);
    await until(() => guest.open() === 1);
    view.unwatch(id!);
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.lingerMs + 100);
    await until(() => guest.open() === 0);
    await view.watch(owner, recordingWriter().writer);
    await until(() => guest.open() === 1 && guest.started() === 2);
  });

  it("replaces a long-running streamer with a fresh one before closing it, keeping the view and control", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.of("frame").length === 1);
    expect(await view.control(owner, "take")).toBeNull();
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.rotateMs + 100);
    await until(() => guest.started() === 2 && guest.open() === 1);
    expect(tab.closed()).toBeUndefined();
    expect(await view.input(owner, click)).toBeNull();
    guest.frame();
    await until(() => tab.of("frame").length >= 2);
  });

  it("stops frames as soon as the last view leaves", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const id = await view.watch(owner, recordingWriter().writer);
    await until(() => guest.received.some((message) => message.t === "frames" && message.on === true));
    view.unwatch(id!);
    await until(() => guest.received.some((message) => message.t === "frames" && message.on === false));
  });

  it("ends the views of a Workspace image without the live view, and of a runtime without the channel", async () => {
    const silent = setup({ silent: true });
    ended.push(() => silent.handle.end());
    const tab = recordingWriter();
    await silent.view.watch(owner, tab.writer);
    await until(() => silent.guest.started() === 1);
    silent.guest.exitAll();
    await until(() => tab.closed() !== undefined);
    expect(tab.closed()).toEqual({ data: { reason: "not_available" }, event: "end" });
    const none = setup();
    ended.push(() => none.handle.end());
    none.guest.fail("workspace_runtime_incompatible");
    const other = recordingWriter();
    await none.view.watch(owner, other.writer);
    await until(() => other.closed() !== undefined);
    expect(other.closed()).toEqual({ data: { reason: "not_available" }, event: "end" });
  });

  it("waits for a guest that is not running yet without ending the view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    guest.fail("workspace_session_lost");
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.retryMs * 40);
    expect(tab.closed()).toBeUndefined();
    guest.fail(null);
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.retryMs + 100);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.browser === "running");
  });
});

describe("browser live handoff", () => {
  const signal = () => new AbortController().signal;

  it("waits for Done, lets the user hold the browser meanwhile, and returns the page and the saved site", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    const waiting = handle.handoff({ message: "Sign in to the shop", reason: "sign_in", signal: signal(), waitMs: 60_000 });
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.handoff !== null && tab.last<BrowserLiveStateEvent>("state")?.handoff !== undefined);
    const state = tab.last<BrowserLiveStateEvent>("state")!;
    expect(state).toMatchObject({ controller: "user", handoff: { message: "Sign in to the shop", reason: "sign_in" } });
    expect(Date.parse(state.handoff!.expiresAt) - Date.parse(state.handoff!.startedAt)).toBe(60_000);
    expect(await view.input(owner, click)).toBeNull();
    expect(view.answerHandoff(owner, { action: "done", handoffId: "handoff_other" })).toBe("browser_live_handoff_stale");
    expect(view.answerHandoff(owner, { action: "done", handoffId: state.handoff!.id })).toBeNull();
    expect(await waiting).toEqual({ kind: "ended", outcome: "completed", page: { title: "Sign in", url: "https://shop.example/login" },
      saved: "shop.example" });
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ controller: "agent", handoff: null });
    expect(guest.received.filter((message) => message.t === "handoff").map((message) => [message.action, message.outcome]))
      .toEqual([["begin", undefined], ["end", "completed"]]);
    expect(view.answerHandoff(owner, { action: "done", handoffId: state.handoff!.id })).toBe("browser_live_handoff_stale");
  });

  it("ends with Cancel, with its time limit, and refuses a second handoff meanwhile", async () => {
    const { handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    const cancelled = handle.handoff({ message: "Enter the code", reason: "verification_code", signal: signal(), waitMs: 60_000 });
    await until(() => Boolean(tab.last<BrowserLiveStateEvent>("state")?.handoff));
    expect(await handle.handoff({ message: "Again", reason: "other", signal: signal(), waitMs: 60_000 })).toEqual({ kind: "busy" });
    view.answerHandoff(owner, { action: "cancel", handoffId: tab.last<BrowserLiveStateEvent>("state")!.handoff!.id });
    expect(await cancelled).toMatchObject({ kind: "ended", outcome: "cancelled", saved: null });
    expect(await handle.handoff({ message: "Solve it", reason: "captcha", signal: signal(), waitMs: 50 }))
      .toMatchObject({ kind: "ended", outcome: "timed_out" });
  });

  it("works without any open view and tells a page not yet open from a browser that cannot be shown", async () => {
    const noPage = setup({ noPage: true });
    ended.push(() => noPage.handle.end());
    expect(await noPage.handle.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 1_000 }))
      .toEqual({ kind: "no_browser" });
    // No host answered the streamer even after its retry.
    const noHost = setup({ browser: false });
    ended.push(() => noHost.handle.end());
    expect(await noHost.handle.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 1_000 }))
      .toEqual({ kind: "unavailable" });
    const quiet = setup();
    ended.push(() => quiet.handle.end());
    const result = quiet.handle.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 100 });
    expect(await result).toMatchObject({ kind: "ended", outcome: "timed_out" });
    const stopped = setup();
    ended.push(() => stopped.handle.end());
    stopped.guest.fail("workspace_session_lost");
    expect(await stopped.handle.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 1_000 }))
      .toEqual({ kind: "no_browser" });
  });

  it("begins on a streamer started a moment ago and retries a missed end once on a fresh one", async () => {
    // Without a view the first command starts the streamer; this guest reaches its host only after a while and
    // refuses commands before, and refuses the first end.
    const { guest, handle } = setup({ connectDelayMs: 150, refuseEnds: 1 });
    ended.push(() => handle.end());
    const result = await handle.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 300 });
    expect(result).toEqual({ kind: "ended", outcome: "timed_out", page: { title: "Sign in", url: "https://shop.example/login" },
      saved: null });
    const handoffs = guest.received.flatMap((message, index) => message.t === "handoff" ? [[message.action, guest.through[index]]] : []);
    expect(handoffs).toEqual([["begin", "exec-0"], ["end", "exec-0"], ["end", "exec-1"]]);
    // The guest's control is the agent's again.
    expect(guest.guest).toMatchObject({ controller: "agent", handoff: false });
  });

  it("tells the guest the handoff's reason with its end, so Done saves the site only for signing in", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    for (const [reason, saved] of [["user_choice", null], ["consent", "shop.example"]] as const) {
      const waiting = handle.handoff({ message: "Have a look", reason, signal: signal(), waitMs: 60_000 });
      await until(() => Boolean(tab.last<BrowserLiveStateEvent>("state")?.handoff));
      view.answerHandoff(owner, { action: "done", handoffId: tab.last<BrowserLiveStateEvent>("state")!.handoff!.id });
      expect(await waiting).toMatchObject({ kind: "ended", outcome: "completed", saved });
      await until(() => tab.last<BrowserLiveStateEvent>("state")?.handoff === null);
    }
    expect(guest.received.filter((message) => message.t === "handoff" && message.action === "end").map((message) => message.reason))
      .toEqual(["user_choice", "consent"]);
  });

  it("returns a handoff still waiting as timed out when the run ends", async () => {
    const { handle, view } = setup();
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    const waiting = handle.handoff({ message: "Sign in", reason: "sign_in", signal: signal(), waitMs: 60_000 });
    await until(() => Boolean(tab.last<BrowserLiveStateEvent>("state")?.handoff));
    await handle.end("run_finished");
    expect(await waiting).toMatchObject({ kind: "ended", outcome: "timed_out" });
  });

  it("is ended by the run's Stop or deadline, which it throws, and ends the guest's handoff too", async () => {
    const { guest, handle, view } = setup();
    ended.push(() => handle.end());
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    const stop = new AbortController();
    const waiting = handle.handoff({ message: "Sign in", reason: "sign_in", signal: stop.signal, waitMs: 60_000 });
    await until(() => Boolean(tab.last<BrowserLiveStateEvent>("state")?.handoff));
    stop.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(tab.last<BrowserLiveStateEvent>("state")?.handoff).toBeNull();
    await until(() => guest.received.some((message) => message.t === "handoff" && message.action === "end"));
  });
});
