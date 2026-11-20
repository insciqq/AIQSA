// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { decodeBrowserLiveEvent, type BrowserLiveEvent } from "@/lib/contracts/browserLive";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createConnectSseStream } from "../connect/sse";
import { BROWSER_LIVE_RELAY_LIMITS, BrowserLiveRelay } from "./browserLive";
import { createBrowserLiveHandlers, frameBudgetWriter } from "./browserLiveHandlers";
import { fakeLiveGuest, FRAME_DATA, until } from "./browserLive.testFixtures";

const MARKER = "zz-typed-marker-4242";

function session(userId: string, extra: Partial<AuthenticatedSession["user"]> = {}): AuthenticatedSession {
  return { expiresAt: new Date(Date.now() + 60_000), id: `session-${userId}`, userId,
    user: { email: `${userId}@example.test`, id: userId, role: "member", status: "active", ...extra } as AuthenticatedSession["user"] };
}

function setup() {
  const relay = new BrowserLiveRelay();
  const guest = fakeLiveGuest();
  const handle = relay.register({ channel: guest.channel, chatId: "chat-1", runId: "run-1", signInRemembered: async () => false,
    userId: "owner" });
  const sessions = new Map<string, AuthenticatedSession>([
    ["owner", session("owner")], ["owner-phone", { ...session("owner"), id: "session-owner-phone" }],
    ["other", session("other")], ["admin", session("admin", { role: "admin" } as never)],
    ["inactive", session("owner", { status: "inactive" } as never)]
  ]);
  let signedIn = true;
  const handlers = createBrowserLiveHandlers({
    authSessionActive: async () => signedIn,
    heartbeatMs: 20,
    relay: () => relay,
    resolveAuth: async (request) => sessions.get(request.headers.get("x-test-user") ?? "") ?? null
  });
  return { guest, handle, handlers, relay, signOut: () => { signedIn = false; } };
}

function request(user: string | null, body?: unknown): Request {
  return new Request("https://aiqsa.test/api/chats/chat-1/browser/x", {
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), method: "POST" }),
    headers: user ? { "x-test-user": user } : {}
  });
}

const context = (chatId = "chat-1") => ({ params: Promise.resolve({ chatId }) });

/** Reads a stream's events as the panel decodes them, until `stop` holds. */
async function readEvents(response: Response, stop: (events: BrowserLiveEvent[]) => boolean): Promise<BrowserLiveEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: BrowserLiveEvent[] = [];
  let buffer = "";
  while (!stop(events)) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.+)$/mu.exec(block)?.[1] ?? "";
      const data = /^data: (.+)$/mu.exec(block)?.[1] ?? "";
      const event = decodeBrowserLiveEvent(name, data);
      if (event) events.push(event);
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

const ended: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const end of ended.splice(0)) await end();
  vi.useRealTimers();
});

describe("a slow view's frames", () => {
  const PICTURE = 200_000;
  const frame = (seq: number) => ({ agent: "main", data: "A".repeat(PICTURE), height: 800, mime: "image/jpeg", seq, width: 1280 });

  /** The next `count` events the reader takes: their names, a frame's seq, and the bytes read before each. */
  async function take(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
    const decoder = new TextDecoder();
    const taken: Array<{ before: number; event: string; seq?: number }> = [];
    let bytes = 0;
    while (taken.length < count) {
      const next = await reader.read();
      if (next.done) break;
      const block = decoder.decode(next.value);
      const event = /^event: (.+)$/mu.exec(block)?.[1] ?? "";
      const seq = event === "frame" ? (JSON.parse(/^data: (.+)$/mu.exec(block)![1]!) as { seq: number }).seq : undefined;
      taken.push({ before: bytes, event, ...(seq === undefined ? {} : { seq }) });
      bytes += next.value.byteLength;
    }
    return taken;
  }

  it("queue a state ahead of all but about two frames, and resume with the latest once the reader drains", async () => {
    vi.useFakeTimers();
    const stream = createConnectSseStream({ maxQueuedBytes: BROWSER_LIVE_RELAY_LIMITS.viewQueueBytes });
    const writer = frameBudgetWriter(stream);
    // A burst of 20 frames (4 MB) to a reader that takes nothing: only the budget is queued, the rest held back.
    const accepted = Array.from({ length: 20 }, (_, index) => writer.send("frame", frame(index + 1)));
    expect(accepted.filter(Boolean)).toHaveLength(BROWSER_LIVE_RELAY_LIMITS.framesQueued);
    expect(stream.queuedBytes()).toBeLessThan((BROWSER_LIVE_RELAY_LIMITS.framesQueued + 0.1) * PICTURE);
    expect(writer.send("state", { browser: "running" })).toBe(true);
    const reader = stream.response.body!.getReader();
    const first = await take(reader, 3);
    expect(first.map((entry) => [entry.event, entry.seq])).toEqual([["frame", 1], ["frame", 2], ["state", undefined]]);
    // No 4 MB of pictures before the state: two frames at most.
    expect(first[2]!.before).toBeLessThan((BROWSER_LIVE_RELAY_LIMITS.framesQueued + 0.1) * PICTURE);
    // The reader drained: the newest held frame goes out on its retry, and new frames go out at once again.
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.frameRetryMs);
    expect((await take(reader, 1)).map((entry) => [entry.event, entry.seq])).toEqual([["frame", 20]]);
    expect(writer.send("frame", frame(21))).toBe(true);
    expect((await take(reader, 1)).map((entry) => [entry.event, entry.seq])).toEqual([["frame", 21]]);
    writer.close();
    expect(writer.send("frame", frame(22))).toBe(false);
  });

  it("drop a held frame once a newer one fits or the stream closes", async () => {
    vi.useFakeTimers();
    const stream = createConnectSseStream({ maxQueuedBytes: BROWSER_LIVE_RELAY_LIMITS.viewQueueBytes });
    const writer = frameBudgetWriter(stream);
    for (let seq = 1; seq <= 3; seq += 1) writer.send("frame", frame(seq));
    const reader = stream.response.body!.getReader();
    await take(reader, 2);
    // Sent directly, the newer frame replaces the held one, which never follows it.
    expect(writer.send("frame", frame(4))).toBe(true);
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_RELAY_LIMITS.frameRetryMs * 3);
    expect(writer.send("steps", { agent: "main", steps: [] })).toBe(true);
    expect((await take(reader, 2)).map((entry) => [entry.event, entry.seq])).toEqual([["frame", 4], ["steps", undefined]]);
    writer.send("frame", frame(5));
    writer.send("frame", frame(6));
    writer.send("frame", frame(7));
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("browser live routes", () => {
  it("answer another user, an administrator, a signed-out or inactive caller, a foreign chat and a finished run alike", async () => {
    const { handle, handlers } = setup();
    const probes: Array<[string | null, string]> = [["other", "chat-1"], ["admin", "chat-1"], [null, "chat-1"], ["inactive", "chat-1"],
      ["owner", "chat-2"], ["owner", "../chat-1"]];
    const routes = [
      (user: string | null, chat: string) => handlers.stream(request(user), context(chat)),
      (user: string | null, chat: string) => handlers.input(request(user, { kind: "text", text: MARKER }), context(chat)),
      (user: string | null, chat: string) => handlers.control(request(user, { action: "take" }), context(chat)),
      // Every agent's tab, a sub-agent's included, answers alike: it is the same owner's live browser.
      (user: string | null, chat: string) => handlers.input(request(user, { agent: "thread_1", kind: "text", text: MARKER }), context(chat)),
      (user: string | null, chat: string) => handlers.control(request(user, { action: "take", agent: "thread_1" }), context(chat)),
      (user: string | null, chat: string) => handlers.control(request(user, { action: "select", agent: "thread_1" }), context(chat)),
      (user: string | null, chat: string) => handlers.handoff(request(user, { action: "done", handoffId: "handoff_1" }), context(chat))
    ];
    for (const [user, chat] of probes) {
      for (const route of routes) {
        const response = await route(user, chat);
        expect([user, chat, response.status, await response.json()]).toEqual([user, chat, 404, { code: "browser_live_not_found" }]);
      }
    }
    await handle.end();
    for (const route of routes) {
      const response = await route("owner", "chat-1");
      expect([response.status, await response.json()]).toEqual([404, { code: "browser_live_not_found" }]);
    }
  });

  it("streams the panel's events to the owner and ends them with the run", async () => {
    const { guest, handle, handlers } = setup();
    const response = await handlers.stream(request("owner"), context());
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const reading = readEvents(response, (events) => events.some((event) => event.type === "end"));
    await until(() => guest.open() === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.end();
    const events = await reading;
    expect(events[0]).toMatchObject({ type: "state", value: { browser: "absent", runId: "run-1", signInRemembered: false } });
    expect(events).toContainEqual({ type: "frame", value: { agent: "main", data: FRAME_DATA, height: 800, mime: "image/jpeg", seq: 1, width: 1280 } });
    expect(events.at(-2)).toMatchObject({ type: "state", value: { browser: "stopped" } });
    expect(events.at(-1)).toEqual({ type: "end", value: { reason: "run_finished" } });
  });

  it("ends a stream whose browser session signed out", async () => {
    const { handle, handlers, signOut } = setup();
    ended.push(() => handle.end());
    const response = await handlers.stream(request("owner"), context());
    const reading = readEvents(response, (events) => events.some((event) => event.type === "end"));
    signOut();
    expect((await reading).at(-1)).toEqual({ type: "end", value: { reason: "not_available" } });
  });

  it("take input only while the user holds the browser, from the owner's other sessions too, and bound the body", async () => {
    const records = await captureRunObservation();
    const { guest, handle, handlers } = setup();
    ended.push(() => handle.end());
    const stream = await handlers.stream(request("owner"), context());
    const reading = readEvents(stream, (events) => events.some((event) => event.type === "end"));
    await until(() => guest.open() === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = { kind: "text", text: MARKER };
    let response = await handlers.input(request("owner", text), context());
    expect([response.status, await response.json()]).toEqual([409, { code: "browser_live_not_in_control" }]);
    for (const body of ["{", { kind: "script", text: "x" }, { kind: "text", text: "a\u0000" }, { kind: "text", text: "x".repeat(20_000) }]) {
      response = await handlers.input(request("owner", body), context());
      expect([response.status, await response.json()]).toEqual([400, { code: "browser_live_request_invalid" }]);
    }
    expect((await handlers.control(request("owner", { action: "steal" }), context())).status).toBe(400);
    expect((await handlers.control(request("owner", { action: "take" }), context())).status).toBe(204);
    expect((await handlers.input(request("owner-phone", text), context())).status).toBe(204);
    expect(guest.received.filter((message) => message.t === "input")).toEqual([{ agent: "main", input: text, t: "input" }]);
    const burst = await Promise.all(Array.from({ length: 70 }, () => handlers.input(request("owner", { kind: "key", type: "down", key: "a",
      code: "KeyA" }), context())));
    const limited = burst.filter((item) => item.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(await limited[0]!.json()).toEqual({ code: "browser_live_rate_limited" });
    expect((await handlers.control(request("owner", { action: "return" }), context())).status).toBe(204);
    await handle.end();
    await reading;
    // Nothing of what the user typed, or of the page, reaches a log.
    const logged = JSON.stringify(records.records());
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(FRAME_DATA);
    expect(logged).not.toContain("shop.example");
  });

  it("answer the pending handoff by its id only", async () => {
    const { handle, handlers } = setup();
    ended.push(() => handle.end());
    const waiting = handle.handoff({ message: "Sign in to the shop", reason: "sign_in", signal: new AbortController().signal, waitMs: 60_000 });
    const stream = await handlers.stream(request("owner"), context());
    const events = await readEvents(stream, (seen) => seen.some((event) => event.type === "state" && event.value.handoff !== null));
    const pending = events.flatMap((event) => event.type === "state" && event.value.handoff ? [event.value.handoff] : [])[0]!;
    let response = await handlers.handoff(request("owner", { action: "done", handoffId: "handoff_stale" }), context());
    expect([response.status, await response.json()]).toEqual([409, { code: "browser_live_handoff_stale" }]);
    response = await handlers.control(request("owner", { action: "return" }), context());
    expect([response.status, await response.json()]).toEqual([409, { code: "browser_live_unavailable" }]);
    response = await handlers.handoff(request("owner", { action: "done", handoffId: pending.id }), context());
    expect(response.status).toBe(204);
    expect(await waiting).toMatchObject({ kind: "ended", outcome: "completed" });
  });
});
