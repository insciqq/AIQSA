import {
  resolveProviderStreamLimits,
  type ProviderStreamLimits
} from "./network";
import {
  attachProviderStreamSafetySnapshot,
  ProviderStreamDeadlineExceededError,
  ProviderStreamEventTooLargeError,
  ProviderStreamIdleTimeoutError,
  ProviderStreamTooLargeError,
  type ProviderStreamSafetySnapshot
} from "./streamSafety";
import { beginTransportStage, createProviderAbortObserver, observeProviderDeadline, observeProviderResponseStart,
  transportFailureFacts } from "./providerObservability";
import { markProviderStreamReset } from "./streamDrop";
import { markProviderStreamProgress, providerStreamProgressFacts } from "./streamProgress";

export type ParsedServerSentEvent = {
  data: string;
  event: string;
};

export type ParseSseStreamOptions = Partial<
  Pick<ProviderStreamLimits, "idleTimeoutMs" | "maxBytes" | "maxDurationMs" | "maxEventBytes">
> & {
  signal?: AbortSignal;
};

type ResolvedParseSseStreamOptions = Readonly<
  Pick<ProviderStreamLimits, "idleTimeoutMs" | "maxBytes" | "maxDurationMs" | "maxEventBytes">
>;

const delimiterPatterns = [
  [10, 10],
  [10, 13, 10],
  [13, 10, 10],
  [13, 10, 13, 10]
] as const;

function resolveOptions(options: ParseSseStreamOptions): ResolvedParseSseStreamOptions {
  const configured = resolveProviderStreamLimits(options);

  return {
    idleTimeoutMs: configured.idleTimeoutMs,
    maxBytes: configured.maxBytes,
    maxDurationMs: configured.maxDurationMs,
    maxEventBytes: configured.maxEventBytes
  };
}

function parseSseChunk(chunk: string): ParsedServerSentEvent | null {
  const lines = chunk.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    data: dataLines.join("\n"),
    event
  };
}

function abortReason(signal: AbortSignal): unknown {
  return typeof signal.reason === "undefined"
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

function isPatternPrefix(bytes: readonly number[], pattern: readonly number[]): boolean {
  if (bytes.length > pattern.length) {
    return false;
  }
  return bytes.every((byte, index) => byte === pattern[index]);
}

function isDelimiter(bytes: readonly number[]): boolean {
  return delimiterPatterns.some((pattern) => (
    bytes.length === pattern.length && isPatternPrefix(bytes, pattern)
  ));
}

function isDelimiterPrefix(bytes: readonly number[]): boolean {
  return delimiterPatterns.some((pattern) => isPatternPrefix(bytes, pattern));
}

class BoundedEventBuffer {
  private readonly createOverflowError: (observedBytes: number) => Error;
  private readonly maxBytes: number;
  private bytes: Uint8Array;
  private byteLength = 0;

  constructor(maxBytes: number, createOverflowError: (observedBytes: number) => Error) {
    this.maxBytes = maxBytes;
    this.createOverflowError = createOverflowError;
    this.bytes = new Uint8Array(Math.min(1024, maxBytes));
  }

  append(byte: number): void {
    if (this.byteLength >= this.maxBytes) {
      throw this.createOverflowError(this.byteLength + 1);
    }

    if (this.byteLength === this.bytes.byteLength) {
      const nextCapacity = Math.min(
        this.maxBytes,
        Math.max(this.byteLength + 1, this.bytes.byteLength * 2)
      );
      const nextBytes = new Uint8Array(nextCapacity);
      nextBytes.set(this.bytes);
      this.bytes = nextBytes;
    }

    this.bytes[this.byteLength] = byte;
    this.byteLength += 1;
  }

  reset(): void {
    this.byteLength = 0;
  }

  value(): Uint8Array {
    return this.bytes.subarray(0, this.byteLength);
  }
}

class SseByteFramer {
  private readonly eventBuffer: BoundedEventBuffer;
  private readonly pendingDelimiterBytes: number[] = [];

  constructor(maxEventBytes: number, createOverflowError: (observedBytes: number) => Error) {
    this.eventBuffer = new BoundedEventBuffer(maxEventBytes, createOverflowError);
  }

  push(byte: number): Uint8Array | null {
    this.pendingDelimiterBytes.push(byte);

    while (this.pendingDelimiterBytes.length > 0) {
      if (isDelimiter(this.pendingDelimiterBytes)) {
        this.pendingDelimiterBytes.length = 0;
        const frame = this.eventBuffer.value();
        this.eventBuffer.reset();
        return frame;
      }
      if (isDelimiterPrefix(this.pendingDelimiterBytes)) {
        return null;
      }

      this.eventBuffer.append(this.pendingDelimiterBytes.shift() as number);
    }

    return null;
  }

  finish(): Uint8Array {
    while (this.pendingDelimiterBytes.length > 0) {
      this.eventBuffer.append(this.pendingDelimiterBytes.shift() as number);
    }
    return this.eventBuffer.value();
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {}
): AsyncGenerator<ParsedServerSentEvent> {
  const limits = resolveOptions(options);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const startedAt = performance.now();
  const observation = beginTransportStage("stream", stream);
  const observeAbort = createProviderAbortObserver();
  observeProviderDeadline({ stream_idle_timeout_ms: limits.idleTimeoutMs, stream_absolute_timeout_ms: limits.maxDurationMs });
  const preAborted = options.signal?.aborted === true;
  let totalStreamBytes = 0;
  let receivedBytes = 0;
  let chunks = 0;
  let lastProgressAt: number | undefined;
  // The last parsed event, never a comment: a gateway's keepalive comments keep bytes flowing while nothing happens.
  let lastEventAt: number | undefined;
  let firstEventAt: number | undefined;
  // The longest silences between received bytes (from the stream's start) and between parsed events (from the first).
  let maxByteGapMs = 0;
  let maxEventGapMs = 0;
  const receivedByte = () => {
    const at = performance.now();
    maxByteGapMs = Math.max(maxByteGapMs, at - (lastProgressAt ?? startedAt));
    lastProgressAt = at;
  };
  // A frame with empty data carries nothing, like a comment: a proxy may send one while its upstream works.
  const parsedEvent = (event: ParsedServerSentEvent) => {
    if (!event.data.trim()) return;
    const at = performance.now();
    if (lastEventAt !== undefined) maxEventGapMs = Math.max(maxEventGapMs, at - lastEventAt);
    lastEventAt = at;
    if (firstEventAt !== undefined) return;
    firstEventAt = at;
    // The response started: the request's owner bounds it from here by the stream's idle timeout and ceiling (`network.ts`).
    observeProviderResponseStart();
  };
  // The stream's final record: its counters, and its first event's wait and longest silences so far, the open one included,
  // so a future no-events detector can be sized from data. Numbers only, never content.
  const progress = () => {
    if (preAborted) return {};
    const now = performance.now();
    return {
      bytes: receivedBytes, chunks,
      last_progress_ms: lastProgressAt === undefined ? undefined : Math.max(0, now - lastProgressAt),
      max_byte_gap_ms: Math.max(maxByteGapMs, now - (lastProgressAt ?? startedAt)),
      ...(firstEventAt === undefined || lastEventAt === undefined ? {} : {
        first_event_ms: Math.max(0, firstEventAt - startedAt), max_event_gap_ms: Math.max(maxEventGapMs, now - lastEventAt)
      })
    };
  };
  // How far the stream had got when a timeout ended it (`streamProgress.ts`); diagnostics only.
  const timeoutProgress = () => providerStreamProgressFacts({
    lastByteMs: lastProgressAt === undefined ? undefined : performance.now() - lastProgressAt,
    lastEventMs: lastEventAt === undefined ? undefined : performance.now() - lastEventAt,
    responseStarted: lastEventAt !== undefined
  });
  let completed = false;
  let terminated = false;
  let fatalReason: unknown;
  let released = false;
  let cancellationStarted = false;
  let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectPendingRead: ((reason: unknown) => void) | null = null;
  let abortListenerAttached = false;

  const elapsedMs = () => Math.max(0, performance.now() - startedAt);
  const snapshot = (): ProviderStreamSafetySnapshot => ({
    durationMs: elapsedMs(),
    totalStreamBytes
  });
  const releaseReader = (): void => {
    if (released) {
      return;
    }
    reader.releaseLock();
    released = true;
  };
  const tryReleaseReader = (): void => {
    try {
      releaseReader();
    } catch {
      // A pending read may need one microtask to settle after cancellation.
    }
  };
  const cancelAndRelease = (reason: unknown): void => {
    if (cancellationStarted) {
      return;
    }
    cancellationStarted = true;

    const readerClosed = reader.closed;
    let cancelResult: Promise<void> | null = null;
    try {
      cancelResult = reader.cancel(reason);
    } catch {
      // Preserve the parsing/cancellation reason.
    }
    tryReleaseReader();
    void readerClosed.then(tryReleaseReader, tryReleaseReader);
    if (cancelResult) {
      void cancelResult.catch(() => {
        // A non-cooperative upstream must not replace or delay the typed failure.
      });
    }
  };
  const onParentAbort = () => {
    if (!terminated && !completed) observeAbort({ stage: "delivery", abort_source: "parent_signal", duration_ms: elapsedMs() });
    terminate(abortReason(options.signal as AbortSignal));
  };
  const clearControls = (): void => {
    if (absoluteTimer) {
      clearTimeout(absoluteTimer);
      absoluteTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (abortListenerAttached && options.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
      abortListenerAttached = false;
    }
  };
  function terminate(reason: unknown): void {
    if (terminated || completed) {
      return;
    }
    terminated = true;
    fatalReason = reason;
    clearControls();
    const reject = rejectPendingRead;
    rejectPendingRead = null;
    cancelAndRelease(reason);
    reject?.(reason);
  }
  const deadlineFailure = (): ProviderStreamDeadlineExceededError => {
    if (!terminated && !completed) observeAbort({ stage: "delivery", abort_source: "provider_deadline", deadline_kind: "stream_absolute",
      timeout_ms: limits.maxDurationMs, duration_ms: elapsedMs() });
    const observedDurationMs = Math.max(limits.maxDurationMs, elapsedMs());
    return new ProviderStreamDeadlineExceededError({
      maxDurationMs: limits.maxDurationMs,
      observedDurationMs,
      snapshot: {
        durationMs: observedDurationMs,
        totalStreamBytes
      }
    });
  };
  const ensureActive = (): void => {
    if (terminated) {
      throw fatalReason;
    }
    if (elapsedMs() >= limits.maxDurationMs) {
      const failure = deadlineFailure();
      terminate(failure);
      throw failure;
    }
  };
  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    ensureActive();
    const readStartedAt = performance.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanupRead = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (rejectPendingRead === rejectRead) {
          rejectPendingRead = null;
        }
      };
      const rejectRead = (reason: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupRead();
        reject(reason);
      };
      const resolveRead = (result: ReadableStreamReadResult<Uint8Array>) => {
        if (settled) {
          return;
        }
        if (terminated) {
          rejectRead(fatalReason);
          return;
        }
        if (elapsedMs() >= limits.maxDurationMs) {
          terminate(deadlineFailure());
          return;
        }
        settled = true;
        cleanupRead();
        resolve(result);
      };

      rejectPendingRead = rejectRead;
      idleTimer = setTimeout(() => {
        if (!terminated && !completed) observeAbort({ stage: "delivery", abort_source: "provider_deadline", deadline_kind: "stream_idle",
          timeout_ms: limits.idleTimeoutMs, duration_ms: elapsedMs(), ...timeoutProgress() });
        const durationMs = elapsedMs();
        const observedIdleMs = Math.max(
          limits.idleTimeoutMs,
          performance.now() - readStartedAt
        );
        terminate(new ProviderStreamIdleTimeoutError({
          idleTimeoutMs: limits.idleTimeoutMs,
          observedIdleMs,
          snapshot: {
            durationMs,
            totalStreamBytes
          }
        }));
      }, limits.idleTimeoutMs);
      reader.read().then(resolveRead, rejectRead);
    });
  };

  const framer = new SseByteFramer(
    limits.maxEventBytes,
    (observedBytes) => new ProviderStreamEventTooLargeError({
      maxBytes: limits.maxEventBytes,
      observedBytes,
      snapshot: snapshot()
    })
  );

  try {
    if (options.signal?.aborted) {
      observeAbort({ stage: "before_start", abort_source: "unknown" });
      terminate(abortReason(options.signal));
    } else if (options.signal) {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      abortListenerAttached = true;
    }
    if (!terminated) {
      const remainingDurationMs = limits.maxDurationMs - elapsedMs();
      absoluteTimer = setTimeout(() => {
        terminate(deadlineFailure());
      }, Math.max(0, remainingDurationMs));
    }

    while (true) {
      const { done, value } = await readNext();
      if (done) {
        completed = true;
        clearControls();
        releaseReader();
        break;
      }
      chunks += 1;
      receivedBytes += value.byteLength;
      if (value.byteLength > 0) receivedByte();

      for (let index = 0; index < value.byteLength; index += 1) {
        if ((index & 4095) === 0) {
          ensureActive();
        }

        totalStreamBytes += 1;
        if (totalStreamBytes > limits.maxBytes) {
          throw new ProviderStreamTooLargeError({
            maxBytes: limits.maxBytes,
            observedBytes: totalStreamBytes,
            snapshot: snapshot()
          });
        }

        const frame = framer.push(value[index]);
        if (!frame) {
          continue;
        }

        const event = parseSseChunk(decoder.decode(frame));
        if (event) {
          parsedEvent(event);
          ensureActive();
          yield attachProviderStreamSafetySnapshot(event, snapshot());
          ensureActive();
        }
      }
      ensureActive();
    }

    const trailing = parseSseChunk(decoder.decode(framer.finish()).trim());
    if (trailing) {
      parsedEvent(trailing);
      yield attachProviderStreamSafetySnapshot(trailing, snapshot());
    }
    observation.finish("completed", progress());
  } catch (error) {
    const facts = transportFailureFacts(error, options.signal);
    // A timeout's records say how far the stream had got: the stream's own here, the request's through its failure.
    const timedOut = facts.category === "timeout" && !preAborted ? timeoutProgress() : null;
    if (timedOut) markProviderStreamProgress(error, timedOut);
    observation.finish(facts.category === "aborted" ? "cancelled" : "failed", { ...progress(), ...facts,
      ...(timedOut ? { last_event_ms: timedOut.last_event_ms, response_started: timedOut.response_started } : {}) });
    if (!completed && !terminated) {
      terminate(error);
    }
    throw error;
  } finally {
    observation.finish("cancelled", progress());
    clearControls();
    if (!completed) {
      cancelAndRelease(terminated ? fatalReason : undefined);
    } else if (!released) {
      releaseReader();
    }
  }
}

/** A provider answer stream: `parseSseStream` whose body-read failures name a
 * `reset` drop. Only the read is classified, never the consumer's own frame
 * handling. */
export async function* parseProviderSseStream(
  stream: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {}
): AsyncGenerator<ParsedServerSentEvent> {
  const events = parseSseStream(stream, options);
  try {
    for (;;) {
      let next: IteratorResult<ParsedServerSentEvent>;
      try {
        next = await events.next();
      } catch (error) {
        throw markProviderStreamReset(error, options.signal);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await events.return(undefined);
  }
}
