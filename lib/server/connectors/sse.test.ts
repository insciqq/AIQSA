import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeSseEvent, RUN_STREAM_KEEPALIVE } from "@/lib/domain/modelRunEvents";
import { createRunStreamReader } from "./sse";

afterEach(() => { vi.useRealTimers(); });

function stream(chunks: readonly string[], close = true) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
  if (close) controller.close();
  return { body, push: (chunk: string) => controller.enqueue(encoder.encode(chunk)) };
}

describe("run stream reader", () => {
  it("reads frames split across chunks, ignores keepalives and skips malformed data", async () => {
    const frames = [
      encodeSseEvent({ data: { modelId: "m", provider: "p", runId: "run-1", status: "streaming" }, type: "run_start" }),
      RUN_STREAM_KEEPALIVE,
      encodeSseEvent({ data: { delta: "Привет, " }, type: "token" }),
      "event: token\ndata: {broken\n\n",
      "event: token\r\ndata: {\"delta\":\"world\"}\r\n\r\n",
      encodeSseEvent({ data: { runId: "run-1", status: "complete" }, type: "done" })
    ].join("");
    // Byte-level splits, including inside a multi-byte character.
    const bytes = new TextEncoder().encode(frames);
    const encoderless = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
        controller.close();
      }
    });
    const reader = createRunStreamReader(encoderless);
    const read: unknown[] = [];
    for (;;) {
      const next = await reader.next();
      if (next.kind !== "frame") {
        expect(next.kind).toBe("closed");
        break;
      }
      read.push(next.frame);
    }
    expect(read).toEqual([
      { data: { modelId: "m", provider: "p", runId: "run-1", status: "streaming" }, type: "run_start" },
      { data: { delta: "Привет, " }, type: "token" },
      { data: { delta: "world" }, type: "token" },
      { data: { runId: "run-1", status: "complete" }, type: "done" }
    ]);
  });

  it("reports a stream silent past its bound as stalled, keepalives keeping it alive", async () => {
    vi.useFakeTimers();
    const live = stream([], false);
    const reader = createRunStreamReader(live.body, { idleMs: 60_000 });
    const pending = reader.next();
    await vi.advanceTimersByTimeAsync(50_000);
    live.push(RUN_STREAM_KEEPALIVE);
    await vi.advanceTimersByTimeAsync(50_000);
    live.push(encodeSseEvent({ data: { delta: "x" }, type: "token" }));
    await expect(pending).resolves.toEqual({ frame: { data: { delta: "x" }, type: "token" }, kind: "frame" });
    const silent = reader.next();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(silent).resolves.toEqual({ kind: "stalled" });
    await expect(reader.next()).resolves.toEqual({ kind: "stalled" });
  });

  it("stops reading on cancel", async () => {
    const reader = createRunStreamReader(stream([encodeSseEvent({ data: { round: 1 }, type: "message_reset" })]).body);
    await reader.cancel();
    await expect(reader.next()).resolves.toEqual({ kind: "closed" });
  });
});
