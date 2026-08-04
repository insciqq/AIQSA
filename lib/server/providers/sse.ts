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
  let totalStreamBytes = 0;
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
          ensureActive();
          yield attachProviderStreamSafetySnapshot(event, snapshot());
          ensureActive();
        }
      }
      ensureActive();
    }

    const trailing = parseSseChunk(decoder.decode(framer.finish()).trim());
    if (trailing) {
      yield attachProviderStreamSafetySnapshot(trailing, snapshot());
    }
  } catch (error) {
    if (!completed && !terminated) {
      terminate(error);
    }
    throw error;
  } finally {
    clearControls();
    if (!completed) {
      cancelAndRelease(terminated ? fatalReason : undefined);
    } else if (!released) {
      releaseReader();
    }
  }
}
