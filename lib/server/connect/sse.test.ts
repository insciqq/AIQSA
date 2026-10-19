import { describe, expect, it, vi } from "vitest";
import { createConnectSseStream } from "./sse";

async function chunks(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const read: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return read;
    read.push(decoder.decode(value));
  }
}

describe("AIQSA Connect SSE stream", () => {
  it("writes one event frame per send and an optional final frame before closing", async () => {
    const stream = createConnectSseStream({ maxQueuedBytes: 4096 });

    expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(stream.response.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
    expect(stream.send("ping", {})).toBe(true);
    stream.close({ data: { code: "connect_disabled" }, event: "closed" });
    expect(stream.send("ping", {})).toBe(false);

    await expect(chunks(stream.response)).resolves.toEqual([
      "event: ping\ndata: {}\n\n",
      "event: closed\ndata: {\"code\":\"connect_disabled\"}\n\n"
    ]);
  });

  it("refuses a frame that would exceed its queue instead of buffering without bound", () => {
    const stream = createConnectSseStream({ maxQueuedBytes: 64 });

    expect(stream.send("output", { data: "a".repeat(20) })).toBe(true);
    expect(stream.send("output", { data: "b".repeat(20) })).toBe(false);
    expect(stream.isClosed()).toBe(false);
  });

  it("runs its close listeners once, whether the server closes or the client goes away", async () => {
    const closedByServer = vi.fn();
    const server = createConnectSseStream({ maxQueuedBytes: 1024 });
    server.onClose(closedByServer);
    server.close();
    server.close();
    expect(closedByServer).toHaveBeenCalledOnce();

    const aborted = new AbortController();
    const closedByClient = vi.fn();
    const client = createConnectSseStream({ maxQueuedBytes: 1024, signal: aborted.signal });
    client.onClose(closedByClient);
    aborted.abort();
    expect(closedByClient).toHaveBeenCalledOnce();
    expect(client.isClosed()).toBe(true);

    const cancelled = createConnectSseStream({ maxQueuedBytes: 1024 });
    const closedByCancel = vi.fn();
    cancelled.onClose(closedByCancel);
    await cancelled.response.body!.cancel();
    expect(closedByCancel).toHaveBeenCalledOnce();

    const late = vi.fn();
    cancelled.onClose(late);
    expect(late).toHaveBeenCalledOnce();
  });
});
