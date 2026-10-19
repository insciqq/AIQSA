import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_MAX_INPUT_BYTES } from "@/lib/contracts/connect";
import { base64, deferred, fakeViewTransport, okVoid } from "./connect.testFixtures";
import {
  CONNECT_VIEW_RETRY_DELAYS_MS,
  CONNECT_VISIBILITY_REFRESH_MS,
  ConnectTerminalSession,
  clampConnectSize,
  takeConnectInputChunk,
  type ConnectViewState
} from "./connectTerminalSession";
import type { ConnectApiResult } from "./connectApi";

const DEVICE_ID = "0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f";
const SESSION_ID = "ac-k3m9q2";

function setup(size = { cols: 120, rows: 40 }) {
  const fake = fakeViewTransport();
  const states: ConnectViewState[] = [];
  const written: string[] = [];
  const terminal = { reset: vi.fn(), write: vi.fn((bytes: Uint8Array) => { written.push(new TextDecoder().decode(bytes)); }) };
  const currentSize = { ...size };
  const session = new ConnectTerminalSession({
    deviceId: DEVICE_ID,
    onState: (state) => states.push(state),
    sessionId: SESSION_ID,
    size: () => currentSize,
    terminal,
    transport: fake.transport
  });
  return { ...fake, currentSize, session, states, terminal, written };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectTerminalSession", () => {
  it("opens a view sized to the terminal and writes its output in order", async () => {
    const { session, states, streams, terminal, transport, written } = setup();
    session.start();
    await flush();
    expect(transport.createView).toHaveBeenCalledWith({ cols: 120, deviceId: DEVICE_ID, rows: 40, sessionId: SESSION_ID });
    expect(states.at(-1)).toEqual({ kind: "connecting" });

    streams[0]!.open();
    expect(states.at(-1)).toEqual({ kind: "live" });
    expect(terminal.reset).toHaveBeenCalledOnce();
    streams[0]!.send("output", { data: base64("hello "), seq: 0 });
    streams[0]!.send("output", { data: base64("world ✓"), seq: 1 });
    expect(written).toEqual(["hello ", "world ✓"]);
    expect(transport.setVisibility).toHaveBeenCalledWith(expect.any(String), false);
    session.dispose();
    expect(streams[0]!.closed).toBe(true);
    expect(transport.closeView).toHaveBeenCalledOnce();
  });

  it("clamps the size to the contract bounds", () => {
    expect(clampConnectSize(3, 900)).toEqual({ cols: 20, rows: 200 });
    expect(clampConnectSize(Number.NaN, 12.7)).toEqual({ cols: 20, rows: 12 });
  });

  it("sends keystrokes strictly one request at a time, joining what was typed meanwhile", async () => {
    const { session, streams, transport } = setup();
    const first = deferred<ConnectApiResult<void>>();
    transport.sendInput.mockImplementationOnce(() => first.promise);
    session.start();
    await flush();
    streams[0]!.open();

    session.input("l");
    session.input("s");
    session.input(" -la\r");
    expect(transport.sendInput).toHaveBeenCalledTimes(1);
    expect(transport.sendInput).toHaveBeenLastCalledWith(expect.any(String), "l");

    first.resolve(okVoid);
    await flush();
    expect(transport.sendInput).toHaveBeenCalledTimes(2);
    expect(transport.sendInput).toHaveBeenLastCalledWith(expect.any(String), "s -la\r");
    session.dispose();
  });

  it("ignores keystrokes until the view is live", async () => {
    const { session, transport } = setup();
    session.start();
    await flush();
    session.input("x");
    expect(transport.sendInput).not.toHaveBeenCalled();
    session.dispose();
  });

  it("splits large input at code-point boundaries within the input limit", () => {
    const text = `${"a".repeat(CONNECT_MAX_INPUT_BYTES - 1)}😀tail`;
    const [chunk, rest] = takeConnectInputChunk(text);
    expect(chunk).toBe("a".repeat(CONNECT_MAX_INPUT_BYTES - 1));
    expect(rest).toBe("😀tail");
    expect(takeConnectInputChunk("short")).toEqual(["short", ""]);
  });

  it("resizes the live view once per new size", async () => {
    const { session, streams, transport } = setup();
    session.start();
    await flush();
    streams[0]!.open();
    session.resize(120, 40);
    expect(transport.resize).not.toHaveBeenCalled();
    session.resize(100, 30);
    session.resize(100, 30);
    expect(transport.resize).toHaveBeenCalledTimes(1);
    expect(transport.resize).toHaveBeenCalledWith(expect.any(String), 100, 30);
    session.dispose();
  });

  it("reports visibility changes and repeats it while the view is watched", async () => {
    const { session, streams, transport } = setup();
    session.setVisible(true);
    session.start();
    await flush();
    streams[0]!.open();
    expect(transport.setVisibility).toHaveBeenLastCalledWith(expect.any(String), true);
    session.setVisible(true);
    expect(transport.setVisibility).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONNECT_VISIBILITY_REFRESH_MS);
    expect(transport.setVisibility).toHaveBeenCalledTimes(2);
    session.setVisible(false);
    expect(transport.setVisibility).toHaveBeenLastCalledWith(expect.any(String), false);
    vi.advanceTimersByTime(CONNECT_VISIBILITY_REFRESH_MS);
    expect(transport.setVisibility).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it("reopens a lost view with backoff and a fresh screen", async () => {
    const { session, states, streams, terminal, transport } = setup();
    session.start();
    await flush();
    streams[0]!.open();
    streams[0]!.send("closed", { reason: "detached" });
    expect(streams[0]!.closed).toBe(true);
    expect(transport.closeView).toHaveBeenCalledOnce();
    const reconnecting = states.at(-1);
    expect(reconnecting).toMatchObject({ cause: "detached", kind: "reconnecting" });

    vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[0]! - 1);
    expect(transport.createView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    streams[1]!.open();
    expect(states.at(-1)).toEqual({ kind: "live" });
    expect(terminal.reset).toHaveBeenCalledTimes(2);

    // A failed stream counts from the first delay again once the view was live.
    streams[1]!.fail();
    expect(states.at(-1)).toMatchObject({ cause: "stream_lost", kind: "reconnecting" });
    session.dispose();
  });

  it("backs off further while reopening keeps failing", async () => {
    const { createResults, session, states, transport } = setup();
    createResults.push({ code: "connect_device_timeout", ok: false }, { code: "connect_view_limit", ok: false });
    session.start();
    await flush();
    expect(states.at(-1)).toMatchObject({ cause: "connect_device_timeout", kind: "reconnecting" });
    vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[0]!);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toMatchObject({ cause: "connect_view_limit", kind: "reconnecting" });
    vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[0]!);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[1]! - CONNECT_VIEW_RETRY_DELAYS_MS[0]!);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it("reopens at once when output skips a sequence number", async () => {
    const { session, streams, transport, written } = setup();
    session.start();
    await flush();
    streams[0]!.open();
    streams[0]!.send("output", { data: base64("a"), seq: 0 });
    streams[0]!.send("output", { data: base64("c"), seq: 2 });
    expect(written).toEqual(["a"]);
    vi.advanceTimersByTime(0);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("shows an ended session and stays there", async () => {
    const { session, states, streams, transport } = setup();
    session.start();
    await flush();
    streams[0]!.open();
    streams[0]!.send("closed", { reason: "session_ended" });
    expect(states.at(-1)).toEqual({ kind: "ended" });
    vi.advanceTimersByTime(60_000);
    expect(transport.createView).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("waits offline until the device list sees the computer again", async () => {
    const { createResults, session, states, streams, transport } = setup();
    session.setDeviceOnline(true);
    session.start();
    await flush();
    streams[0]!.open();
    streams[0]!.send("closed", { reason: "connect_device_offline" });
    expect(states.at(-1)).toEqual({ kind: "offline" });
    session.setDeviceOnline(false);
    vi.advanceTimersByTime(60_000);
    expect(transport.createView).toHaveBeenCalledTimes(1);

    createResults.push({ data: { viewId: "11111111-1111-4111-8111-111111111111" }, ok: true });
    session.setDeviceOnline(true);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    streams[1]!.open();
    expect(states.at(-1)).toEqual({ kind: "live" });
    session.dispose();
  });

  it("names refusals: an unknown session, an offline computer and a turned-off feature", async () => {
    for (const [code, expected] of [
      ["connect_not_found", { kind: "not_found" }],
      ["connect_session_not_found", { kind: "ended" }],
      ["connect_device_offline", { kind: "offline" }],
      ["connect_disabled", { kind: "left", reason: "disabled" }],
      ["connect_unauthorized", { kind: "left", reason: "signed_out" }],
      ["connect_request_invalid", { code: "connect_request_invalid", kind: "failed" }]
    ] as const) {
      const { createResults, session, states } = setup();
      createResults.push({ code, ok: false });
      session.start();
      await flush();
      expect(states.at(-1)).toEqual(expected);
      session.dispose();
    }
  });

  it("waits for retry-after when rate limited, and retries at once on request", async () => {
    const { createResults, session, states, transport } = setup();
    createResults.push({ code: "connect_rate_limited", ok: false, retryAfterSeconds: 7 });
    session.start();
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: "reconnecting" });
    vi.advanceTimersByTime(6_999);
    expect(transport.createView).toHaveBeenCalledTimes(1);
    session.retryNow();
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("drops answers of a view it already replaced", async () => {
    const { session, streams, transport, written } = setup();
    const slow = deferred<ConnectApiResult<{ viewId: string }>>();
    transport.createView.mockImplementationOnce(() => slow.promise);
    session.start();
    session.retryNow();
    await flush();
    slow.resolve({ data: { viewId: "22222222-2222-4222-8222-222222222222" }, ok: true });
    await flush();
    expect(transport.closeView).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(streams).toHaveLength(1);
    streams[0]!.open();
    streams[0]!.send("output", { data: base64("ok"), seq: 0 });
    expect(written).toEqual(["ok"]);
    session.dispose();
  });

  it("review: failed input stops further typing", async () => {
    const { session, streams, transport } = setup();
    session.start(); await flush(); streams[0]!.open();
    session.input("echo "); await flush();
    transport.sendInput.mockResolvedValueOnce({ code: "network_error", ok: false });
    session.input("safe"); await flush();
    const sent = transport.sendInput.mock.calls.length;
    session.input("\r"); await flush();
    const state = session.getState(); session.dispose();
    expect(state.kind).not.toBe("live");
    expect(transport.sendInput).toHaveBeenCalledTimes(sent);
  });

  it("stops typing on a server failure and drops what was queued behind it", async () => {
    for (const failure of [
      { code: "response_invalid", ok: false },
      { code: "connect_device_error", ok: false },
      { code: "connect_device_timeout", ok: false }
    ] as const) {
      const { session, states, streams, transport } = setup();
      const pending = deferred<ConnectApiResult<void>>();
      transport.sendInput.mockImplementationOnce(() => pending.promise);
      session.start();
      await flush();
      streams[0]!.open();
      session.input("rm -rf /tmp/demo");
      session.input("/cache");
      pending.resolve(failure);
      await flush();
      expect(states.at(-1)).toMatchObject({ cause: "input_lost", kind: "reconnecting" });
      session.input("\r");
      await flush();
      vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[0]!);
      await flush();
      expect(transport.sendInput.mock.calls.map(([, data]) => data)).toEqual(["rm -rf /tmp/demo"]);
      session.dispose();
    }
  });

  it("recovers from lost input on a fresh view that says so and accepts typing again", async () => {
    const { session, states, streams, terminal, transport } = setup();
    transport.sendInput.mockResolvedValueOnce({ code: "network_error", ok: false });
    session.start();
    await flush();
    streams[0]!.open();
    session.input("x");
    await flush();
    expect(streams[0]!.closed).toBe(true);
    expect(transport.closeView).toHaveBeenCalledOnce();

    session.retryNow();
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    streams[1]!.open();
    expect(states.at(-1)).toEqual({ inputLost: true, kind: "live" });
    expect(terminal.reset).toHaveBeenCalledTimes(2);
    session.input("y");
    await flush();
    expect(transport.sendInput).toHaveBeenLastCalledWith(transport.openStream.mock.calls[1]![0], "y");

    session.dismissInputNotice();
    expect(states.at(-1)).toEqual({ kind: "live" });
    // Reconnecting for another reason later does not bring the notice back.
    streams[1]!.fail();
    vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[0]!);
    await flush();
    streams[2]!.open();
    expect(states.at(-1)).toEqual({ kind: "live" });
    session.dispose();
  });

  it("reopens on its own after lost input with the usual backoff", async () => {
    const { session, states, streams, transport } = setup();
    transport.sendInput.mockResolvedValueOnce({ code: "network_error", ok: false });
    session.start();
    await flush();
    streams[0]!.open();
    session.input("x");
    await flush();
    vi.advanceTimersByTime(CONNECT_VIEW_RETRY_DELAYS_MS[0]! - 1);
    expect(transport.createView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    streams[1]!.open();
    expect(states.at(-1)).toEqual({ inputLost: true, kind: "live" });
    session.dispose();
  });

  it("shows a refused input and stops typing until the user reopens the terminal", async () => {
    for (const code of ["connect_input_too_large", "connect_request_invalid"] as const) {
      const { session, states, streams, transport } = setup();
      transport.sendInput.mockResolvedValueOnce({ code, ok: false });
      session.start();
      await flush();
      streams[0]!.open();
      session.input("x");
      await flush();
      expect(states.at(-1)).toEqual({ code, inputLost: true, kind: "failed" });
      session.input("\r");
      vi.advanceTimersByTime(60_000);
      await flush();
      expect(transport.sendInput).toHaveBeenCalledTimes(1);
      expect(transport.createView).toHaveBeenCalledTimes(1);
      session.dispose();
    }
  });

  it("repeats a rate-limited chunk after retry-after, in order", async () => {
    const { session, streams, transport } = setup();
    transport.sendInput.mockResolvedValueOnce({ code: "connect_rate_limited", ok: false, retryAfterSeconds: 2 });
    session.start();
    await flush();
    streams[0]!.open();
    session.input("ab");
    await flush();
    session.input("c");
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(transport.sendInput.mock.calls.map(([, data]) => data)).toEqual(["ab", "abc"]);
    expect(session.getState()).toEqual({ kind: "live" });
    session.dispose();
  });

  it("reopens the view when an input answers that the view is gone", async () => {
    const { session, streams, transport } = setup();
    transport.sendInput.mockResolvedValueOnce({ code: "connect_not_found", ok: false });
    session.start();
    await flush();
    streams[0]!.open();
    session.input("x");
    await flush();
    vi.advanceTimersByTime(0);
    await flush();
    expect(transport.createView).toHaveBeenCalledTimes(2);
    session.dispose();
  });
});
