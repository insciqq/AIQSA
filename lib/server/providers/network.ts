const defaultProviderTimeoutMs = 30_000;
const defaultProviderResponseMaxBytes = 16 * 1024 * 1024;

export type ProviderStreamLimits = Readonly<{
  idleTimeoutMs: number;
  maxBytes: number;
  maxDurationMs: number;
  maxEventBytes: number;
  maxOutputChars: number;
}>;

export const DEFAULT_PROVIDER_STREAM_LIMITS: ProviderStreamLimits = Object.freeze({
  idleTimeoutMs: 30_000,
  maxBytes: 64 * 1024 * 1024,
  maxDurationMs: 600_000,
  maxEventBytes: 4 * 1024 * 1024,
  maxOutputChars: 8 * 1024 * 1024
});

export const PROVIDER_STREAM_LIMIT_CEILINGS: ProviderStreamLimits = Object.freeze({
  idleTimeoutMs: 120_000,
  maxBytes: 256 * 1024 * 1024,
  maxDurationMs: 660_000,
  maxEventBytes: 16 * 1024 * 1024,
  maxOutputChars: 32 * 1024 * 1024
});

const streamLimitEnvironmentNames = Object.freeze({
  idleTimeoutMs: "AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS",
  maxBytes: "AIQSA_PROVIDER_STREAM_MAX_BYTES",
  maxDurationMs: "AIQSA_PROVIDER_STREAM_MAX_DURATION_MS",
  maxEventBytes: "AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES",
  maxOutputChars: "AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS"
} satisfies Record<keyof ProviderStreamLimits, string>);

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

function boundedPositiveIntegerEnvironmentValue(
  value: string | undefined,
  fallback: number,
  ceiling: number
): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling
    ? parsed
    : fallback;
}

function boundedPositiveIntegerOverride(
  value: number | undefined,
  fallback: number,
  ceiling: number
): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= ceiling
    ? value
    : fallback;
}

export function getProviderStreamLimits(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ProviderStreamLimits {
  const maxBytes = boundedPositiveIntegerEnvironmentValue(
    environment[streamLimitEnvironmentNames.maxBytes],
    DEFAULT_PROVIDER_STREAM_LIMITS.maxBytes,
    PROVIDER_STREAM_LIMIT_CEILINGS.maxBytes
  );
  const configuredMaxEventBytes = boundedPositiveIntegerEnvironmentValue(
    environment[streamLimitEnvironmentNames.maxEventBytes],
    DEFAULT_PROVIDER_STREAM_LIMITS.maxEventBytes,
    PROVIDER_STREAM_LIMIT_CEILINGS.maxEventBytes
  );

  return Object.freeze({
    idleTimeoutMs: boundedPositiveIntegerEnvironmentValue(
      environment[streamLimitEnvironmentNames.idleTimeoutMs],
      DEFAULT_PROVIDER_STREAM_LIMITS.idleTimeoutMs,
      PROVIDER_STREAM_LIMIT_CEILINGS.idleTimeoutMs
    ),
    maxBytes,
    maxDurationMs: boundedPositiveIntegerEnvironmentValue(
      environment[streamLimitEnvironmentNames.maxDurationMs],
      DEFAULT_PROVIDER_STREAM_LIMITS.maxDurationMs,
      PROVIDER_STREAM_LIMIT_CEILINGS.maxDurationMs
    ),
    maxEventBytes: Math.min(configuredMaxEventBytes, maxBytes),
    maxOutputChars: boundedPositiveIntegerEnvironmentValue(
      environment[streamLimitEnvironmentNames.maxOutputChars],
      DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars,
      PROVIDER_STREAM_LIMIT_CEILINGS.maxOutputChars
    )
  });
}

export function resolveProviderStreamLimits(
  overrides: Partial<ProviderStreamLimits> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env
): ProviderStreamLimits {
  const configured = getProviderStreamLimits(environment);
  const maxBytes = boundedPositiveIntegerOverride(
    overrides.maxBytes,
    configured.maxBytes,
    PROVIDER_STREAM_LIMIT_CEILINGS.maxBytes
  );
  const configuredMaxEventBytes = boundedPositiveIntegerOverride(
    overrides.maxEventBytes,
    configured.maxEventBytes,
    PROVIDER_STREAM_LIMIT_CEILINGS.maxEventBytes
  );

  return Object.freeze({
    idleTimeoutMs: boundedPositiveIntegerOverride(
      overrides.idleTimeoutMs,
      configured.idleTimeoutMs,
      PROVIDER_STREAM_LIMIT_CEILINGS.idleTimeoutMs
    ),
    maxBytes,
    maxDurationMs: boundedPositiveIntegerOverride(
      overrides.maxDurationMs,
      configured.maxDurationMs,
      PROVIDER_STREAM_LIMIT_CEILINGS.maxDurationMs
    ),
    maxEventBytes: Math.min(configuredMaxEventBytes, maxBytes),
    maxOutputChars: boundedPositiveIntegerOverride(
      overrides.maxOutputChars,
      configured.maxOutputChars,
      PROVIDER_STREAM_LIMIT_CEILINGS.maxOutputChars
    )
  });
}

export function providerTimeoutMs(): number {
  return positiveIntegerEnv("AIQSA_PROVIDER_TIMEOUT_MS", defaultProviderTimeoutMs);
}

export function providerStreamIdleTimeoutMs(): number {
  return getProviderStreamLimits().idleTimeoutMs;
}

export function providerStreamMaxEventBytes(): number {
  return getProviderStreamLimits().maxEventBytes;
}

export function providerStreamMaxBytes(): number {
  return getProviderStreamLimits().maxBytes;
}

export function providerStreamMaxDurationMs(): number {
  return getProviderStreamLimits().maxDurationMs;
}

export function providerStreamMaxOutputChars(): number {
  return getProviderStreamLimits().maxOutputChars;
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
