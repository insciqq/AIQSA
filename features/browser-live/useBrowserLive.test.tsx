import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLiveControlPath, browserLiveHandoffPath, browserLiveInputPath, type BrowserLiveInput } from "@/lib/contracts/browserLive";
import { fakeEventSources, liveState, type FakeBrowserLiveEventSource } from "./browserLive.testFixtures";
import { BROWSER_LIVE_END_DRAIN_MS, useBrowserLive } from "./useBrowserLive";

const CHAT = "chat-1";

type Call = { path: string; body: unknown; respond(response: Response): void };

let calls: Call[];
let sources: FakeBrowserLiveEventSource[];
let openSource: (url: string) => FakeBrowserLiveEventSource;

beforeEach(() => {
  calls = [];
  // Every request waits until the test answers it, so the order of requests is observable.
  vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    calls.push({ path, body: JSON.parse(String(init?.body)), respond: resolve });
  })));
  const fake = fakeEventSources();
  sources = fake.sources;
  openSource = fake.open;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (value: string): BrowserLiveInput => ({ kind: "text", text: value });
const ok = () => new Response(null, { status: 204 });
const refusal = (code: string, status = 409) => new Response(JSON.stringify({ code }), { status });

async function flush() {
  for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
}

function setup() {
  const hook = renderHook(() => useBrowserLive(CHAT, true, openSource));
  act(() => sources[0]!.send("state", liveState({ controller: "user" })));
  return hook;
}

function paths() {
  return calls.map((call) => call.path === browserLiveInputPath(CHAT) ? `input:${(call.body as { text?: string }).text}` : call.path);
}

describe("useBrowserLive ending control", () => {
  it("lets queued input arrive before Done, and refuses input typed after it", async () => {
    const { result } = setup();
    act(() => result.current.sendInput(text("4"), text("2")));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.answerHandoff("handoff-1", "done");
      result.current.sendInput(text("late"));
    });
    expect(result.current.busy).toBe("done");
    await flush();
    expect(paths()).toEqual(["input:4"]);
    calls[0]!.respond(ok());
    await flush();
    expect(paths()).toEqual(["input:4", "input:2"]);
    calls[1]!.respond(ok());
    await flush();
    expect(paths()).toEqual(["input:4", "input:2", browserLiveHandoffPath(CHAT)]);
    expect(calls[2]!.body).toEqual({ action: "done", handoffId: "handoff-1" });
    calls[2]!.respond(ok());
    await act(async () => { await done; });
    expect(result.current.busy).toBeNull();
  });

  it("posts Return control after the input in flight, and ignores its late not-in-control refusal", async () => {
    const { result } = setup();
    act(() => result.current.sendInput(text("a")));
    act(() => { void result.current.control("return"); });
    await flush();
    // The server already moved control (another tab ended it): the refusal is not news to this user.
    calls[0]!.respond(refusal("browser_live_not_in_control"));
    await flush();
    expect(paths()).toEqual(["input:a", browserLiveControlPath(CHAT)]);
    calls[1]!.respond(ok());
    await flush();
    expect(result.current.failure).toBeNull();
  });

  it("clears queued input and posts Cancel at once", async () => {
    const { result } = setup();
    act(() => result.current.sendInput(text("a"), text("b")));
    act(() => { void result.current.answerHandoff("handoff-1", "cancel"); });
    await flush();
    expect(paths()).toEqual(["input:a", browserLiveHandoffPath(CHAT)]);
    calls[0]!.respond(ok());
    calls[1]!.respond(ok());
    await flush();
    expect(paths()).toEqual(["input:a", browserLiveHandoffPath(CHAT)]);
  });

  it("posts Done after a bounded wait when input does not drain", async () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.sendInput(text("a"), text("b")));
    act(() => { void result.current.answerHandoff("handoff-1", "done"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_LIVE_END_DRAIN_MS - 1); });
    expect(paths()).toEqual(["input:a"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(paths()).toEqual(["input:a", browserLiveHandoffPath(CHAT)]);
    calls[0]!.respond(ok());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(paths()).toEqual(["input:a", browserLiveHandoffPath(CHAT)]);
  });

  it("gives the browser back when ending failed, and accepts input again in the next control period", async () => {
    const { result } = setup();
    act(() => { void result.current.control("return"); });
    await flush();
    calls[0]!.respond(refusal("browser_live_unavailable"));
    await flush();
    act(() => result.current.sendInput(text("again")));
    await flush();
    expect(paths()).toEqual([browserLiveControlPath(CHAT), "input:again"]);
    calls[1]!.respond(ok());

    act(() => { void result.current.control("return"); });
    await flush();
    calls[2]!.respond(ok());
    await flush();
    act(() => sources[0]!.send("state", liveState({ controller: "agent" })));
    act(() => sources[0]!.send("state", liveState({ controller: "user", handoff: null })));
    await flush();
    act(() => result.current.sendInput(text("next")));
    await flush();
    expect(paths().at(-1)).toBe("input:next");
  });

  it("clears a rate-limit alert on the next accepted input", async () => {
    const { result } = setup();
    act(() => result.current.sendInput(text("a"), text("b")));
    await flush();
    calls[0]!.respond(refusal("browser_live_rate_limited", 429));
    await flush();
    expect(result.current.failure).toBe("browser_live_rate_limited");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });
    await flush();
    calls[1]!.respond(ok());
    await flush();
    expect(result.current.failure).toBeNull();
  });
});
