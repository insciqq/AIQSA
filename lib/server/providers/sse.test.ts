import { describe, expect, it, vi } from "vitest";
import {
  ProviderStreamDeadlineExceededError,
  ProviderStreamEventTooLargeError,
  ProviderStreamIdleTimeoutError,
  ProviderStreamTooLargeError,
  providerStreamSafetyReport,
  providerStreamSafetySnapshot
} from "./streamSafety";
import { parseSseStream, type ParsedServerSentEvent } from "./sse";

const encoder = new TextEncoder();

function closedStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}

async function collectEvents(
  events: AsyncGenerator<ParsedServerSentEvent>
): Promise<ParsedServerSentEvent[]> {
  const collected: ParsedServerSentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("provider SSE parser", () => {
  it("preserves every accepted delimiter and arbitrary chunk splits, including UTF-8", async () => {
    for (const delimiter of ["\n\n", "\n\r\n", "\r\n\n", "\r\n\r\n"]) {
      const bytes = encoder.encode(`event: update\ndata: café${delimiter}`);

      for (let split = 1; split < bytes.byteLength; split += 1) {
        await expect(collectEvents(parseSseStream(closedStream([
          bytes.slice(0, split),
          bytes.slice(split)
        ]), {
          maxBytes: bytes.byteLength,
          maxEventBytes: bytes.byteLength
        }))).resolves.toEqual([{ data: "café", event: "update" }]);
      }
    }
  });

  it("parses multiple events while ignoring comment heartbeats", async () => {
    const bytes = encoder.encode([
      ": keepalive",
      "",
      "event: first",
      "data: one",
      "data: two",
      "",
      "data: three",
      "",
      ""
    ].join("\n"));

    await expect(collectEvents(parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength
    }))).resolves.toEqual([
      { data: "one\ntwo", event: "first" },
      { data: "three", event: "message" }
    ]);
  });

  it("parses one event delivered one raw byte per network chunk", async () => {
    const bytes = encoder.encode("event: bytewise\ndata: café\r\n\r\n");

    await expect(collectEvents(parseSseStream(closedStream(
      Array.from(bytes, (byte) => Uint8Array.of(byte))
    ), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength
    }))).resolves.toEqual([{ data: "café", event: "bytewise" }]);
  });

  it("attaches a non-enumerable raw-byte and duration snapshot", async () => {
    const bytes = encoder.encode("data: ok\n\n");
    const events = parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength
    });
    const result = await events.next();

    expect(result.done).toBe(false);
    expect(result.value).toEqual({ data: "ok", event: "message" });
    expect(Object.keys(result.value as object)).toEqual(["data", "event"]);
    expect(JSON.stringify(result.value)).toBe('{"data":"ok","event":"message"}');
    expect(providerStreamSafetySnapshot(result.value)).toEqual({
      durationMs: expect.any(Number),
      totalStreamBytes: bytes.byteLength
    });
    await events.return(undefined);
  });

  it("accepts an event exactly at its raw-byte limit", async () => {
    const frame = encoder.encode("data: exact");
    const delimiter = encoder.encode("\n\n");
    const bytes = new Uint8Array(frame.byteLength + delimiter.byteLength);
    bytes.set(frame);
    bytes.set(delimiter, frame.byteLength);

    await expect(collectEvents(parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: frame.byteLength
    }))).resolves.toEqual([{ data: "exact", event: "message" }]);
  });

  it("rejects the first event byte over, cancels once with the same typed reason, and unlocks", async () => {
    const frame = encoder.encode("data: overflow");
    let cancellationReason: unknown;
    let cancellationCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationCount += 1;
        cancellationReason = reason;
      },
      start(controller) {
        controller.enqueue(frame);
      }
    });
    const events = parseSseStream(stream, {
      maxBytes: frame.byteLength + 10,
      maxEventBytes: frame.byteLength - 1
    });
    const failure = await events.next().then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderStreamEventTooLargeError);
    expect(failure).toMatchObject({
      code: "provider_stream_event_too_large",
      limit: frame.byteLength - 1,
      maxBytes: frame.byteLength - 1,
      observed: frame.byteLength,
      observedBytes: frame.byteLength,
      termination: "event_limit",
      totalStreamBytes: frame.byteLength,
      unit: "bytes"
    });
    expect(providerStreamSafetyReport(failure)).toMatchObject({
      code: "provider_stream_event_too_large",
      message: "The provider stream exceeded a safety limit."
    });
    expect(cancellationCount).toBe(1);
    expect(cancellationReason).toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it("does not wait for a non-cooperative underlying cancel hook", async () => {
    const frame = encoder.encode("data: overflow");
    let cancellationReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
        return new Promise<void>(() => undefined);
      },
      start(controller) {
        controller.enqueue(frame);
      }
    });
    const events = parseSseStream(stream, {
      maxBytes: frame.byteLength + 10,
      maxEventBytes: frame.byteLength - 1
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      events.next().then(
        () => "unexpected_success" as const,
        (error: unknown) => error
      ),
      new Promise<"still_pending">((resolve) => {
        timeout = setTimeout(() => resolve("still_pending"), 100);
      })
    ]);
    if (timeout) clearTimeout(timeout);

    expect(outcome).toBeInstanceOf(ProviderStreamEventTooLargeError);
    expect(cancellationReason).toBe(outcome);
    expect(stream.locked).toBe(false);
  });

  it("bounds a large unterminated event before exposing it", async () => {
    const bytes = new Uint8Array(4097).fill(65);
    let cancellationReason: unknown;
    let cancellationCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationCount += 1;
        cancellationReason = reason;
      },
      start(controller) {
        controller.enqueue(bytes);
      }
    });
    const events = parseSseStream(stream, {
      maxBytes: bytes.byteLength,
      maxEventBytes: 4096
    });
    const failure = await events.next().then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderStreamEventTooLargeError);
    expect(failure).toMatchObject({ observedBytes: 4097, totalStreamBytes: 4097 });
    expect(cancellationCount).toBe(1);
    expect(cancellationReason).toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it("counts delimiters in the total stream limit and does not expose an overflowing frame", async () => {
    const bytes = encoder.encode("data: exact\n\n");

    await expect(collectEvents(parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength
    }))).resolves.toEqual([{ data: "exact", event: "message" }]);

    let cancellationReason: unknown;
    const overflowingStream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
      start(controller) {
        controller.enqueue(bytes);
      }
    });
    const failure = await parseSseStream(overflowingStream, {
      maxBytes: bytes.byteLength - 1,
      maxEventBytes: bytes.byteLength
    }).next().then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderStreamTooLargeError);
    expect(failure).toMatchObject({
      code: "provider_stream_too_large",
      maxBytes: bytes.byteLength - 1,
      observedBytes: bytes.byteLength,
      totalStreamBytes: bytes.byteLength
    });
    expect(cancellationReason).toBe(failure);
    expect(overflowingStream.locked).toBe(false);
  });

  it("rejects cumulative overflow across small events after yielding only the valid prefix", async () => {
    const firstBytes = encoder.encode("data: one\n\n");
    const secondBytes = encoder.encode("data: two\n\n");
    const combined = new Uint8Array(firstBytes.byteLength + secondBytes.byteLength);
    combined.set(firstBytes);
    combined.set(secondBytes, firstBytes.byteLength);
    let cancellationReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
      start(controller) {
        controller.enqueue(combined);
      }
    });
    const events = parseSseStream(stream, {
      maxBytes: combined.byteLength - 1,
      maxEventBytes: firstBytes.byteLength
    });

    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { data: "one", event: "message" }
    });
    const failure = await events.next().then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderStreamTooLargeError);
    expect(failure).toMatchObject({
      observedBytes: combined.byteLength,
      totalStreamBytes: combined.byteLength
    });
    expect(cancellationReason).toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it("counts a trailing partial CR/LF delimiter at exact and one-over event limits", async () => {
    const bytes = encoder.encode("data: tail\r\n\r");

    await expect(collectEvents(parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength
    }))).resolves.toEqual([{ data: "tail", event: "message" }]);

    const failure = await parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength - 1
    }).next().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderStreamEventTooLargeError);
    expect(failure).toMatchObject({
      observedBytes: bytes.byteLength,
      totalStreamBytes: bytes.byteLength
    });
  });

  it("emits a trailing event without a delimiter", async () => {
    const bytes = encoder.encode("event: tail\ndata: done");

    await expect(collectEvents(parseSseStream(closedStream([bytes]), {
      maxBytes: bytes.byteLength,
      maxEventBytes: bytes.byteLength
    }))).resolves.toEqual([{ data: "done", event: "tail" }]);
  });

  it("fails a stalled read with a typed idle timeout and the identical cancellation reason", async () => {
    vi.useFakeTimers();
    try {
      let cancellationReason: unknown;
      let cancellationCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationCount += 1;
          cancellationReason = reason;
        }
      });
      const failurePromise = parseSseStream(stream, {
        idleTimeoutMs: 10,
        maxDurationMs: 100
      }).next().then(() => null, (error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);
      const failure = await failurePromise;

      expect(failure).toBeInstanceOf(ProviderStreamIdleTimeoutError);
      expect(failure).toMatchObject({
        code: "provider_stream_timeout",
        idleTimeoutMs: 10,
        observedIdleMs: 10,
        termination: "idle_timeout"
      });
      expect(cancellationCount).toBe(1);
      expect(cancellationReason).toBe(failure);
      expect(stream.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an active heartbeat stream at the absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const streamController: {
        current?: ReadableStreamDefaultController<Uint8Array>;
      } = {};
      let cancellationReason: unknown;
      let cancellationCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationCount += 1;
          cancellationReason = reason;
        },
        start(controller) {
          streamController.current = controller;
        }
      });
      const failurePromise = parseSseStream(stream, {
        idleTimeoutMs: 5,
        maxDurationMs: 12
      }).next().then(() => null, (error: unknown) => error);

      streamController.current?.enqueue(encoder.encode(": ping\n\n"));
      await vi.advanceTimersByTimeAsync(4);
      streamController.current?.enqueue(encoder.encode(": ping\n\n"));
      await vi.advanceTimersByTimeAsync(4);
      streamController.current?.enqueue(encoder.encode(": ping\n\n"));
      await vi.advanceTimersByTimeAsync(4);
      const failure = await failurePromise;

      expect(failure).toBeInstanceOf(ProviderStreamDeadlineExceededError);
      expect(failure).toMatchObject({
        code: "provider_stream_deadline_exceeded",
        maxDurationMs: 12,
        observedDurationMs: 12,
        termination: "absolute_deadline"
      });
      expect(cancellationCount).toBe(1);
      expect(cancellationReason).toBe(failure);
      expect(stream.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the absolute timer active while the generator is suspended at yield", async () => {
    vi.useFakeTimers();
    try {
      let cancellationReason: unknown;
      let cancellationCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationCount += 1;
          cancellationReason = reason;
        },
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
        }
      });
      const events = parseSseStream(stream, {
        idleTimeoutMs: 100,
        maxDurationMs: 20
      });

      await expect(events.next()).resolves.toMatchObject({
        done: false,
        value: { data: "first", event: "message" }
      });
      await vi.advanceTimersByTimeAsync(20);

      expect(cancellationCount).toBe(1);
      expect(cancellationReason).toBeInstanceOf(ProviderStreamDeadlineExceededError);
      expect(stream.locked).toBe(false);
      const failure = await events.next().then(() => null, (error: unknown) => error);
      expect(failure).toBe(cancellationReason);
      expect(cancellationCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a parent abort reason before reading and while suspended at yield", async () => {
    const preAborted = new AbortController();
    const preAbortReason = new Error("caller_cancelled_before_read");
    preAborted.abort(preAbortReason);
    let preAbortCancellationReason: unknown;
    const preAbortStream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        preAbortCancellationReason = reason;
      }
    });

    await expect(parseSseStream(preAbortStream, {
      signal: preAborted.signal
    }).next()).rejects.toBe(preAbortReason);
    expect(preAbortCancellationReason).toBe(preAbortReason);
    expect(preAbortStream.locked).toBe(false);

    const duringYield = new AbortController();
    const duringYieldReason = new Error("caller_cancelled_during_yield");
    let duringYieldCancellationReason: unknown;
    let cancellationCount = 0;
    const duringYieldStream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationCount += 1;
        duringYieldCancellationReason = reason;
      },
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
      }
    });
    const events = parseSseStream(duringYieldStream, { signal: duringYield.signal });
    await events.next();

    duringYield.abort(duringYieldReason);
    await Promise.resolve();

    expect(duringYieldCancellationReason).toBe(duringYieldReason);
    expect(duringYieldStream.locked).toBe(false);
    await expect(events.next()).rejects.toBe(duringYieldReason);
    expect(cancellationCount).toBe(1);
  });

  it("cancels the underlying reader when the consumer exits early", async () => {
    let cancelled = false;
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
    expect(stream.locked).toBe(false);
  });

  it("cleans up timers and never cancels a normally completed stream", async () => {
    vi.useFakeTimers();
    try {
      let cancellationCount = 0;
      const parent = new AbortController();
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancellationCount += 1;
        },
        start(controller) {
          controller.enqueue(encoder.encode("data: done\n\n"));
          controller.close();
        }
      });

      await expect(collectEvents(parseSseStream(stream, {
        idleTimeoutMs: 10,
        maxDurationMs: 20,
        signal: parent.signal
      }))).resolves.toEqual([{ data: "done", event: "message" }]);
      expect(vi.getTimerCount()).toBe(0);
      parent.abort(new Error("too_late_to_cancel_completed_stream"));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(cancellationCount).toBe(0);
      expect(stream.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects structurally spoofed reports with unsafe messages or mismatched dimensions", () => {
    const valid = {
      code: "provider_stream_too_large",
      durationMs: 12,
      limit: 10,
      message: "The provider stream exceeded a safety limit.",
      observed: 11,
      termination: "total_limit",
      totalStreamBytes: 11,
      unit: "bytes"
    } as const;

    expect(providerStreamSafetyReport(valid)).toEqual(valid);
    expect(providerStreamSafetyReport({ ...valid, message: "raw provider payload" })).toBeNull();
    expect(providerStreamSafetyReport({ ...valid, termination: "output_limit" })).toBeNull();
    expect(providerStreamSafetyReport({ ...valid, unit: "characters" })).toBeNull();
    expect(providerStreamSafetyReport({ ...valid, observed: Number.NaN })).toBeNull();
  });
});
