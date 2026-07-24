const defaultProviderTimeoutMs = 30_000;
const defaultProviderStreamIdleTimeoutMs = 30_000;
const defaultProviderResponseMaxBytes = 16 * 1024 * 1024;

export class ProviderResponseTooLargeError extends Error {
  readonly code = "provider_response_too_large";
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(input: { maxBytes: number; receivedBytes: number }) {
    super("provider_response_too_large");
    this.name = "ProviderResponseTooLargeError";
    this.maxBytes = input.maxBytes;
    this.receivedBytes = input.receivedBytes;
  }
}

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function providerTimeoutMs(): number {
  return positiveIntegerEnv("AIQSA_PROVIDER_TIMEOUT_MS", defaultProviderTimeoutMs);
}

export function providerStreamIdleTimeoutMs(): number {
  return positiveIntegerEnv("AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS", defaultProviderStreamIdleTimeoutMs);
}

export function providerResponseMaxBytes(): number {
  return positiveIntegerEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", defaultProviderResponseMaxBytes);
}

export function timeoutError(message = "Provider request timed out"): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export function isProviderTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /timed out|timeout/i.test(error.message));
}

export function withTimeoutSignal(parentSignal?: AbortSignal, timeoutMs = providerTimeoutMs()) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;

  return {
    clear() {
      clearTimeout(timeout);
    },
    signal
  };
}

function abortReason(signal: AbortSignal): unknown {
  return typeof signal.reason === "undefined"
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", handleAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown
): void {
  try {
    void reader.cancel(reason).catch(() => {
      // Preserve the original bounded-read failure.
    });
  } catch {
    // Preserve the original bounded-read failure.
  }
}

export async function readBoundedResponseText(
  response: Response,
  options: {
    maxBytes?: number;
    signal?: AbortSignal;
  } = {}
): Promise<string> {
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
  if (!response.body) {
    return "";
  }

  const maxBytes = options.maxBytes ?? providerResponseMaxBytes();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  let receivedBytes = 0;
  let needsCancellation = false;
  let failure: unknown;

  try {
    while (true) {
      const chunk = await readWithSignal(reader, options.signal);
      if (chunk.done) {
        textChunks.push(decoder.decode());
        return textChunks.join("");
      }

      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxBytes) {
        failure = new ProviderResponseTooLargeError({ maxBytes, receivedBytes });
        needsCancellation = true;
        throw failure;
      }

      textChunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    failure = options.signal?.aborted ? abortReason(options.signal) : error;
    needsCancellation = true;
    throw failure;
  } finally {
    if (needsCancellation) {
      cancelReader(reader, failure);
    }
    reader.releaseLock();
  }
}

export function providerHttpErrorMessage(provider: string, status: number): string {
  return `${provider} request failed with status ${status}`;
}
