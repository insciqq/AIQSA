import { describe, expect, it } from "vitest";
import { parseSseStream } from "./sse";

describe("provider SSE parser", () => {
  it("cancels the underlying reader when the consumer exits early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(encoder.encode("event: message\ndata: {\"ok\":true}\n\n"));
      }
    });
    const events = parseSseStream(stream);

    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: "{\"ok\":true}",
        event: "message"
      }
    });
    await events.return(undefined);

    expect(cancelled).toBe(true);
  });

  it("fails with a timeout when a stream is idle too long", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const events = parseSseStream(stream, { idleTimeoutMs: 1 });

    await expect(events.next()).rejects.toThrow("provider_stream_timeout");
  });
});
