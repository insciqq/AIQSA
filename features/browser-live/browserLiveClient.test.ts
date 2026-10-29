import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserLiveControlPath,
  browserLiveHandoffPath,
  browserLiveInputPath,
  browserLiveStreamPath
} from "@/lib/contracts/browserLive";
import {
  BROWSER_LIVE_RETRY_DELAYS_MS,
  BrowserLiveStream,
  postBrowserLiveControl,
  postBrowserLiveHandoff,
  postBrowserLiveInput
} from "./browserLiveClient";
import { fakeEventSources, liveFrame, liveState } from "./browserLive.testFixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BrowserLiveStream", () => {
  beforeEach(() => vi.useFakeTimers());

  it("opens the chat's stream, keeps the latest frame, replaces steps and stops on end", () => {
    const { open, sources } = fakeEventSources();
    const stream = new BrowserLiveStream("chat/1", open);
    const changes = vi.fn();
    stream.subscribe(changes);
    stream.start();
    expect(sources[0]!.url).toBe(browserLiveStreamPath("chat/1"));
    expect(stream.getSnapshot().connection).toBe("connecting");
    sources[0]!.send("state", liveState());
    expect(stream.getSnapshot()).toMatchObject({ connection: "live", state: { controller: "agent" } });
    sources[0]!.send("frame", liveFrame(1));
    sources[0]!.send("frame", liveFrame(2));
    expect(stream.getSnapshot().frame?.seq).toBe(2);
    sources[0]!.send("steps", { agent: "main", steps: [{ n: 1, action: "open", target: "", host: "shop.example", path: "/" }] });
    sources[0]!.send("steps", { agent: "main", steps: [{ n: 2, action: "click", target: "button \"Cart\"", host: "shop.example", path: "/" }] });
    expect(stream.getSnapshot().steps.map((step) => step.n)).toEqual([2]);
    sources[0]!.send("end", { reason: "run_finished" });
    expect(stream.getSnapshot()).toMatchObject({ connection: "ended", endReason: "run_finished" });
    expect(sources[0]!.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
  });

  it("reopens with backoff after a failure, then gives up and offers a restart", () => {
    const { open, sources } = fakeEventSources();
    const stream = new BrowserLiveStream("chat-1", open);
    stream.start();
    sources[0]!.send("state", liveState());
    // A malformed event fails visibly instead of becoming guessed state.
    sources[0]!.send("frame", { seq: 1, mime: "image/png", data: "AAAA", width: 1, height: 1 });
    expect(stream.getSnapshot().connection).toBe("reconnecting");
    expect(sources[0]!.closed).toBe(true);
    vi.advanceTimersByTime(BROWSER_LIVE_RETRY_DELAYS_MS[0]!);
    expect(sources).toHaveLength(2);
    for (const [index, delay] of BROWSER_LIVE_RETRY_DELAYS_MS.slice(1).entries()) {
      sources[index + 1]!.fail();
      vi.advanceTimersByTime(delay);
    }
    sources.at(-1)!.fail();
    expect(stream.getSnapshot().connection).toBe("failed");
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(BROWSER_LIVE_RETRY_DELAYS_MS.length + 1);
    stream.restart();
    expect(sources).toHaveLength(BROWSER_LIVE_RETRY_DELAYS_MS.length + 2);
    expect(stream.getSnapshot()).toMatchObject({ connection: "connecting", state: null, frame: null });
  });

  it("forgets the frame and closes the stream when stopped", () => {
    const { open, sources } = fakeEventSources();
    const stream = new BrowserLiveStream("chat-1", open);
    stream.start();
    sources[0]!.send("state", liveState());
    sources[0]!.send("frame", liveFrame(1));
    stream.stop();
    expect(sources[0]!.closed).toBe(true);
    expect(stream.getSnapshot().frame).toBeNull();
    sources[0]!.send("frame", liveFrame(2));
    expect(stream.getSnapshot().frame).toBeNull();
  });
});

describe("browser live requests", () => {
  it("posts input, control and handoff bodies to their routes", async () => {
    const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postBrowserLiveInput("chat-1", { kind: "text", text: "hello" })).resolves.toEqual({ ok: true });
    await postBrowserLiveControl("chat-1", "take");
    await postBrowserLiveHandoff("chat-1", "handoff-1", "done");
    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      [browserLiveInputPath("chat-1"), "POST", JSON.stringify({ kind: "text", text: "hello" })],
      [browserLiveControlPath("chat-1"), "POST", JSON.stringify({ action: "take" })],
      [browserLiveHandoffPath("chat-1"), "POST", JSON.stringify({ action: "done", handoffId: "handoff-1" })]
    ]);
  });

  it("reads the refusal code, and names network and unexpected failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "browser_live_handoff_stale" }), { status: 409 })));
    await expect(postBrowserLiveHandoff("chat-1", "handoff-1", "cancel")).resolves.toEqual({ ok: false, code: "browser_live_handoff_stale" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "something_else" }), { status: 500 })));
    await expect(postBrowserLiveControl("chat-1", "return")).resolves.toEqual({ ok: false, code: "unexpected_response" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(postBrowserLiveControl("chat-1", "return")).resolves.toEqual({ ok: false, code: "network_error" });
  });
});
