import { describe, expect, it, vi } from "vitest";
import { ADMIN_PROVIDER_SETUP_STREAM_TYPE } from "@/lib/contracts/adminProviderSetupProgress";
import { readAdminProviderSetupResponse } from "./adminProviderSetupStream";

const encoder = new TextEncoder();
const progress = (completed: number) => ({ type: "progress", progress: { phase: "checking", completed, total: 4 } });
const encode = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);

function streamResponse() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel });
  const response = new Response(body, { headers: { "content-type": `${ADMIN_PROVIDER_SETUP_STREAM_TYPE}; charset=utf-8` } });
  return { body, cancel, response, source };
}

describe("readAdminProviderSetupResponse", () => {
  it("delivers each real four-model count before the terminal response, including split UTF-8 frames", async () => {
    const { body, cancel, response, source } = streamResponse();
    const received = vi.fn();
    let settled = false;
    const reading = readAdminProviderSetupResponse(response, received).finally(() => { settled = true; });
    for (let completed = 0; completed <= 4; completed += 1) {
      const frame = encode(progress(completed));
      source.enqueue(frame.slice(0, 9));
      source.enqueue(frame.slice(9));
      await vi.waitFor(() => expect(received).toHaveBeenLastCalledWith({ phase: "checking", completed, total: 4 }));
      expect(settled).toBe(false);
    }
    source.enqueue(encode({ type: "heartbeat" }));
    const terminal = encode({ type: "result", status: 201, data: { displayName: "Модель" } });
    for (const byte of terminal) source.enqueue(new Uint8Array([byte]));
    await expect(reading).resolves.toEqual({ ok: true, value: { displayName: "Модель" } });
    expect(received).toHaveBeenCalledTimes(5);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("preserves the terminal error status rather than the successful streaming transport status", async () => {
    const { response, source } = streamResponse();
    source.enqueue(encode(progress(2)));
    source.enqueue(encode({ type: "result", status: 422, data: { error: "provider_custom_setup_test_failed" } }));
    await expect(readAdminProviderSetupResponse(response)).resolves.toEqual({
      ok: false, value: { error: "provider_custom_setup_test_failed" }
    });
  });

  it.each([
    null,
    [],
    { type: "unknown" },
    { type: "heartbeat", extra: true },
    { type: "progress", progress: { phase: "checking", completed: 5, total: 4 } },
    { type: "progress", progress: { phase: "checking", completed: -1, total: 4 } },
    { type: "progress", progress: { phase: "checking", completed: 0.5, total: 4 } },
    { type: "progress", progress: { phase: "checking", completed: 0, total: 65 } },
    { type: "progress", progress: { phase: "checking", completed: 1, total: null } },
    { type: "progress", progress: { phase: "unknown", completed: 0, total: null } },
    { type: "progress", progress: { phase: "checking", completed: 0, total: 4, secret: "synthetic" } },
    { type: "result", status: 199, data: {} },
    { type: "result", status: 600, data: {} },
    { type: "result", status: "200", data: {} },
    { type: "result", status: 200, data: {}, extra: true }
  ])("rejects malformed envelopes without delivering them as progress: %j", async (event) => {
    const { body, cancel, response, source } = streamResponse();
    const received = vi.fn();
    source.enqueue(encode(event));
    await expect(readAdminProviderSetupResponse(response, received)).rejects.toThrow("provider_setup_response_invalid");
    expect(received).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(["", "{broken}\n", '{"type":"result","status":200,"data":{}}'])(
    "never invents success from an empty, malformed, or truncated terminal stream", async (text) => {
      const { body, response, source } = streamResponse();
      source.enqueue(encoder.encode(text));
      source.close();
      await expect(readAdminProviderSetupResponse(response)).rejects.toThrow();
      expect(body.locked).toBe(false);
    }
  );

  it("rejects an oversized individual frame and releases the stream", async () => {
    const { cancel, response, source } = streamResponse();
    source.enqueue(encoder.encode("x".repeat(65_537)));
    await expect(readAdminProviderSetupResponse(response)).rejects.toThrow("provider_setup_response_invalid");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("limits total bytes even when every frame is a valid heartbeat", async () => {
    const { cancel, response, source } = streamResponse();
    const frame = encode({ type: "heartbeat" });
    for (let sent = 0; sent <= 1_048_576; sent += frame.length) source.enqueue(frame);
    await expect(readAdminProviderSetupResponse(response)).rejects.toThrow("provider_setup_response_invalid");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("handles many small frames in one transport chunk independently of the frame-size bound", async () => {
    const { response, source } = streamResponse();
    const received = vi.fn();
    source.enqueue(encoder.encode(`${JSON.stringify({ type: "heartbeat" })}\n`.repeat(4_000)));
    source.enqueue(encode(progress(4)));
    source.enqueue(encode({ type: "result", status: 200, data: {} }));
    await expect(readAdminProviderSetupResponse(response, received)).resolves.toEqual({ ok: true, value: {} });
    expect(received).toHaveBeenCalledExactlyOnceWith({ phase: "checking", completed: 4, total: 4 });
  });

  it("rejects a cancelled reader without completing setup", async () => {
    const { body, response, source } = streamResponse();
    const received = vi.fn();
    const reading = readAdminProviderSetupResponse(response, received);
    source.enqueue(encode(progress(1)));
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    source.error(new DOMException("The request was aborted", "AbortError"));
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(body.locked).toBe(false);
  });

  it("bounds a silent connection and resets that deadline only when bytes arrive", async () => {
    vi.useFakeTimers();
    try {
      const { body, cancel, response, source } = streamResponse();
      const reading = readAdminProviderSetupResponse(response);
      const rejected = expect(reading).rejects.toThrow("provider_setup_interrupted");
      await vi.advanceTimersByTimeAsync(44_999);
      expect(cancel).not.toHaveBeenCalled();
      source.enqueue(encode({ type: "heartbeat" }));
      await vi.advanceTimersByTimeAsync(44_999);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues decoding ordinary JSON success and HTTP failures", async () => {
    const received = vi.fn();
    await expect(readAdminProviderSetupResponse(Response.json({ result: true }), received)).resolves.toEqual({ ok: true, value: { result: true } });
    await expect(readAdminProviderSetupResponse(Response.json({ error: "forbidden" }, { status: 403 }), received)).resolves.toEqual({ ok: false, value: { error: "forbidden" } });
    expect(received).not.toHaveBeenCalled();
  });
});
