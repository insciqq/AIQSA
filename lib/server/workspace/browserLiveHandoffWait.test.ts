// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserLiveStreamPath, type BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { BROWSER_HANDOFF_WAIT_MS } from "../tools/browserHandoff";
import { BROWSER_HANDOFF_IDLE_MS, BrowserLiveRelay } from "./browserLive";
import { createBrowserLiveHandlers } from "./browserLiveHandlers";
import { fakeLiveGuest, recordingWriter } from "./browserLive.testFixtures";

/**
 * How long a handoff waits (operator decision 2026-11-20): two minutes without any sign of the user, each sign
 * starting them again, the whole wait capped. Fake timers drive the relay, its streamer and the wait alike.
 */

const owner = { authSessionId: "session-1", userId: "user-1" };
const click = { button: "left", kind: "mouse", type: "down", x: 10, y: 20 } as const;
const handles: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const end of handles.splice(0)) await end();
  vi.useRealTimers();
});

/** A handoff asked at t0 = 0; `at(ms)` moves the clock to t0 + ms. */
async function asked(waitMs = BROWSER_HANDOFF_WAIT_MS) {
  vi.useFakeTimers();
  const relay = new BrowserLiveRelay();
  const guest = fakeLiveGuest();
  const handle = relay.register({ channel: guest.channel, chatId: "chat-1", runId: "run-1", signInRemembered: async () => true,
    userId: "user-1" });
  handles.push(() => handle.end());
  const view = relay.find("chat-1", "user-1")!;
  const t0 = Date.now();
  let outcome: string | null = null;
  void handle.handoff({ message: "Sign in", reason: "sign_in", signal: new AbortController().signal, waitMs })
    .then((result) => { outcome = result.kind === "ended" ? result.outcome : result.kind; });
  const at = async (ms: number) => { await vi.advanceTimersByTimeAsync(t0 + ms - Date.now()); };
  await at(100);
  expect(guest.guest.handoff).toBe(true);
  const tab = recordingWriter();
  return { at, guest, handle, outcome: () => outcome, relay, tab, t0, view };
}

describe("a handoff's wait for the user", () => {
  it("ends in about two minutes as not_answered when nobody comes, and says so to a view opened later", async () => {
    const { at, outcome, tab, t0, view } = await asked();
    await at(BROWSER_HANDOFF_IDLE_MS - 1_000);
    expect(outcome()).toBeNull();
    await at(BROWSER_HANDOFF_IDLE_MS + 1_000);
    expect(outcome()).toBe("not_answered");
    expect(Date.now() - t0).toBeLessThan(BROWSER_HANDOFF_IDLE_MS + 2_000);
    await view.watch(owner, tab.writer, { presence: true });
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ controller: "agent", handoff: null,
      ended: [{ agent: { id: "main", name: null }, outcome: "not_answered" }] });
  });

  it("never cuts off a user who opens the view at 1:50 and signs in for four more minutes", async () => {
    const { at, outcome, tab, t0, view } = await asked();
    await at(110_000);
    expect(outcome()).toBeNull();
    await view.watch(owner, tab.writer, { presence: true });
    // The card counts down from the user's arrival.
    const shown = tab.last<BrowserLiveStateEvent>("state")!.handoff!;
    expect(Date.parse(shown.expiresAt) - t0).toBeGreaterThanOrEqual(110_000 + BROWSER_HANDOFF_IDLE_MS);
    // Typing a password, waiting for the code, typing it: input every 50 seconds.
    for (let time = 160_000; time <= 350_000; time += 50_000) {
      await at(time);
      expect(outcome()).toBeNull();
      expect(await view.input(owner, click)).toBeNull();
    }
    expect(view.answerHandoff(owner, { action: "done", handoffId: shown.id })).toBeNull();
    await at(352_000);
    expect(outcome()).toBe("completed");
  });

  it("ends as timed_out two minutes after the last sign of a user who left halfway", async () => {
    const { at, outcome, tab, view } = await asked();
    await at(30_000);
    await view.watch(owner, tab.writer, { presence: true });
    for (const time of [60_000, 120_000, 180_000]) {
      await at(time);
      expect(await view.input(owner, click)).toBeNull();
    }
    await at(180_000 + BROWSER_HANDOFF_IDLE_MS - 1_000);
    expect(outcome()).toBeNull();
    await at(180_000 + BROWSER_HANDOFF_IDLE_MS + 1_000);
    expect(outcome()).toBe("timed_out");
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ handoff: null, ended: [{ outcome: "timed_out" }] });
  });

  it("counts Take control, picking an agent and a refused input as signs too", async () => {
    const { at, outcome, view } = await asked();
    await at(100_000);
    // During the handoff the user already holds the tab: Take control is accepted and changes nothing else.
    expect(await view.control(owner, "take")).toBeNull();
    await at(200_000);
    expect(await view.control(owner, { action: "select", agent: "main" })).toBeNull();
    await at(300_000);
    expect(await view.input(owner, { ...click, agent: "thread_other" })).toBe("browser_live_not_in_control");
    await at(300_000 + BROWSER_HANDOFF_IDLE_MS - 1_000);
    expect(outcome()).toBeNull();
    await at(300_000 + BROWSER_HANDOFF_IDLE_MS + 1_000);
    expect(outcome()).toBe("timed_out");
  });

  it("stops at the whole wait however active the user is, and at a short cap without a sign as not_answered", async () => {
    const busy = await asked();
    await busy.view.watch(owner, busy.tab.writer, { presence: true });
    for (let time = 60_000; time < BROWSER_HANDOFF_WAIT_MS; time += 60_000) {
      await busy.at(time);
      expect(await busy.view.input(owner, click)).toBeNull();
    }
    await busy.at(BROWSER_HANDOFF_WAIT_MS - 1_000);
    expect(busy.outcome()).toBeNull();
    await busy.at(BROWSER_HANDOFF_WAIT_MS + 1_000);
    expect(busy.outcome()).toBe("timed_out");
    for (const end of handles.splice(0)) await end();
    vi.useRealTimers();

    const short = await asked(40_000);
    await short.at(39_000);
    expect(short.outcome()).toBeNull();
    await short.at(41_000);
    expect(short.outcome()).toBe("not_answered");
  });

  it("moves the card's deadline a few seconds at a time, not with every key", async () => {
    const { at, tab, view } = await asked();
    await at(10_000);
    await view.watch(owner, tab.writer, { presence: true });
    await at(20_000);
    const before = tab.of("state").length;
    for (let index = 0; index < 10; index += 1) expect(await view.input(owner, click)).toBeNull();
    const states = tab.of("state") as BrowserLiveStateEvent[];
    expect(states).toHaveLength(before + 1);
    await at(22_000);
    expect(await view.input(owner, click)).toBeNull();
    expect(tab.of("state")).toHaveLength(before + 1);
  });

  // Review 2026-11-20: a panel left open reconnected on its own 100 s in, which pushed the wait back with nobody there.
  it("takes only an opening the person made through the route as a sign, never an automatic reconnect", async () => {
    const session = { expiresAt: new Date(Date.now() + 3_600_000), id: "session-1", userId: "user-1",
      user: { email: "user-1@example.test", id: "user-1", role: "member", status: "active" } } as AuthenticatedSession;
    const open = async (relay: BrowserLiveRelay, presence: boolean) => {
      const routes = createBrowserLiveHandlers({ authSessionActive: async () => true, relay: () => relay,
        resolveAuth: async () => session });
      const response = await routes.stream(new Request(`https://aiqsa.test${browserLiveStreamPath("chat-1", { presence })}`),
        { params: { chatId: "chat-1" } });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
    };

    const reconnect = await asked();
    await reconnect.at(100_000);
    await open(reconnect.relay, false);
    await reconnect.at(BROWSER_HANDOFF_IDLE_MS + 1_000);
    expect(reconnect.outcome()).toBe("not_answered");
    for (const end of handles.splice(0)) await end();
    vi.useRealTimers();

    const opened = await asked();
    await opened.at(100_000);
    await opened.view.watch(owner, opened.tab.writer);
    await open(opened.relay, true);
    await opened.at(BROWSER_HANDOFF_IDLE_MS + 1_000);
    expect(opened.outcome()).toBeNull();
    await opened.at(100_000 + BROWSER_HANDOFF_IDLE_MS + 1_000);
    expect(opened.outcome()).toBe("timed_out");
  });

  it("forgets an agent's unanswered request once it asks again", async () => {
    const { at, guest, handle, outcome, tab, view } = await asked(40_000);
    await at(41_000);
    expect(outcome()).toBe("not_answered");
    expect(guest.guest.handoff).toBe(false);
    await view.watch(owner, tab.writer, { presence: true });
    expect(tab.last<BrowserLiveStateEvent>("state")?.ended).toHaveLength(1);
    void handle.handoff({ message: "Please choose", reason: "consent", signal: new AbortController().signal, waitMs: 60_000 });
    await at(42_000);
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ handoff: { reason: "consent" } });
    expect(tab.last<BrowserLiveStateEvent>("state")?.ended).toBeUndefined();
  });
});
