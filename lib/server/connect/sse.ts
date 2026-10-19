import type { ConnectStreamWriter } from "./relay";

/** Queue bounds per stream kind; a stream whose reader falls this far behind is closed. */
export const CONNECT_DEVICE_STREAM_QUEUE_BYTES = 2_097_152;
export const CONNECT_VIEW_STREAM_QUEUE_BYTES = 1_048_576;
export const CONNECT_EVENTS_STREAM_QUEUE_BYTES = 4_194_304;

const SSE_HEADERS = {
  "cache-control": "private, no-store, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no"
} as const;

export type ConnectSseStream = ConnectStreamWriter & Readonly<{
  isClosed(): boolean;
  /** Runs once, when the server closes the stream or the client goes away. */
  onClose(listener: () => void): void;
  response: Response;
}>;

/**
 * A server-sent event stream with a bounded byte queue. `send` refuses a frame
 * that would exceed the bound instead of buffering without limit; the owner
 * then decides to close. Frames are `event: <name>` plus one JSON data line.
 */
export function createConnectSseStream(input: Readonly<{ maxQueuedBytes: number; signal?: AbortSignal }>): ConnectSseStream {
  const encoder = new TextEncoder();
  const listeners: Array<() => void> = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    input.signal?.removeEventListener("abort", abort);
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch {
        // Cleanup of one owner never prevents another's.
      }
    }
  };
  const abort = () => {
    try {
      controller?.close();
    } catch {
      // Already closed by the runtime.
    }
    finish();
  };
  const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      finish();
    }
  }, {
    highWaterMark: input.maxQueuedBytes,
    size: (chunk) => chunk.byteLength
  });

  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  return {
    close(final) {
      if (closed) return;
      if (final && controller) {
        try {
          controller.enqueue(frame(final.event, final.data));
        } catch {
          // The client is already gone.
        }
      }
      abort();
    },
    isClosed: () => closed,
    onClose(listener) {
      if (closed) {
        listener();
        return;
      }
      listeners.push(listener);
    },
    response: new Response(stream, { headers: SSE_HEADERS }),
    send(event, data) {
      if (closed || !controller) return false;
      const bytes = frame(event, data);
      if ((controller.desiredSize ?? 0) < bytes.byteLength) return false;
      try {
        controller.enqueue(bytes);
        return true;
      } catch {
        finish();
        return false;
      }
    }
  };
}
