import {
  DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  MAX_PROVIDER_RESPONSE_TIMEOUT_MS
} from "./providerConfiguration";
import { beginTransportStage, createProviderAbortObserver, transportFailureFacts } from "./providerObservability";

const defaultProviderResponseMaxBytes = 16 * 1024 * 1024;
const retryableProviderHttpStatuses = new Set([
  408,
  409,
  429,
  500,
  502,
  503,
  504
]);

export type ProviderStreamLimits = Readonly<{
  idleTimeoutMs: number;
  maxBytes: number;
  maxDurationMs: number;
  maxEventBytes: number;
  maxOutputChars: number;
}>;

export const DEFAULT_PROVIDER_STREAM_LIMITS: ProviderStreamLimits = Object.freeze({
  idleTimeoutMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  maxBytes: 64 * 1024 * 1024,
  maxDurationMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  maxEventBytes: 4 * 1024 * 1024,
  maxOutputChars: 8 * 1024 * 1024
});

export const PROVIDER_STREAM_LIMIT_CEILINGS: ProviderStreamLimits = Object.freeze({
  idleTimeoutMs: MAX_PROVIDER_RESPONSE_TIMEOUT_MS,
  maxBytes: 256 * 1024 * 1024,
  maxDurationMs: MAX_PROVIDER_RESPONSE_TIMEOUT_MS,
  maxEventBytes: 16 * 1024 * 1024,
  maxOutputChars: 32 * 1024 * 1024
});

const streamLimitEnvironmentNames = Object.freeze({
  maxBytes: "AIQSA_PROVIDER_STREAM_MAX_BYTES",
  maxEventBytes: "AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES",
  maxOutputChars: "AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS"
} satisfies Record<"maxBytes" | "maxEventBytes" | "maxOutputChars", string>);

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
    idleTimeoutMs: DEFAULT_PROVIDER_STREAM_LIMITS.idleTimeoutMs,
    maxBytes,
    maxDurationMs: DEFAULT_PROVIDER_STREAM_LIMITS.maxDurationMs,
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

/**
 * How long an answer stream may go without a single byte, an SSE comment
 * included, on a route whose provider keeps sending bytes while it works
 * (decision 2026-11-11, PROVIDERS.md): Codex LB sends a keepalive comment
 * every 5-10 s, before the first event as well.
 */
export const PROVIDER_STREAM_KEEPALIVE_IDLE_MS = 60_000;

/** The shortest hard ceiling of a stream whose response started (`providerStreamCeilingMs`). */
export const PROVIDER_STREAM_CEILING_MS = 30 * 60_000;

/**
 * What an adapter knows of its route's stream between events: `keepalive`
 * where the provider documents, or was measured, sending bytes while it
 * works, so a minute of silence is a stuck upstream; otherwise a stream may
 * stay silent as long as the response timeout.
 */
export type ProviderStreamIdle = "keepalive" | "response_timeout";

/**
 * The response timeout bounds only the wait for a response's headers and
 * first event; a stream whose events flow ends only on its idle timeout or
 * this ceiling (decision 2026-11-11: live streams were cut at 300 s).
 */
export function providerStreamCeilingMs(responseTimeoutMs: number = DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS): number {
  return Math.max(responseTimeoutMs, PROVIDER_STREAM_CEILING_MS);
}

export function providerStreamTimingLimits(
  responseTimeoutMs: number = DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  idle: ProviderStreamIdle = "response_timeout"
): Pick<ProviderStreamLimits, "idleTimeoutMs" | "maxDurationMs"> {
  return Object.freeze({
    idleTimeoutMs: idle === "keepalive" ? Math.min(PROVIDER_STREAM_KEEPALIVE_IDLE_MS, responseTimeoutMs) : responseTimeoutMs,
    maxDurationMs: providerStreamCeilingMs(responseTimeoutMs)
  });
}

export function providerTimeoutMs(): number {
  return DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS;
}

export function providerResponseMaxBytes(): number {
  return positiveIntegerEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", defaultProviderResponseMaxBytes);
}

export function isProviderRetryableHttpStatus(
  status: number | null | undefined
): boolean {
  return typeof status === "number" &&
    Number.isSafeInteger(status) &&
    retryableProviderHttpStatuses.has(status);
}

export class ProviderRequestTimeoutError extends Error {
  readonly code = "provider_request_timed_out";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    const seconds = timeoutMs / 1_000;
    super(`Provider response exceeded the configured ${seconds}-second timeout.`);
    this.name = "ProviderRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isProviderDeadlineExceededError(
  error: unknown
): error is ProviderRequestTimeoutError {
  return error instanceof ProviderRequestTimeoutError;
}

export function withTimeoutSignal(parentSignal?: AbortSignal, timeoutMs = providerTimeoutMs(),
  deadlineKind: "request" | "polling" | "operation" = "request",
  owner?: Parameters<typeof createProviderAbortObserver>[0]) {
  const startedAt = performance.now();
  const observeAbort = createProviderAbortObserver(owner);
  const timeoutController = new AbortController();
  let deadlineMs = timeoutMs;
  let cleared = false;
  const expire = () => timeoutController.abort(new ProviderRequestTimeoutError(deadlineMs));
  let timeout = setTimeout(expire, timeoutMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;
  const onAbort = () => observeAbort({
    stage: "delivery",
    abort_source: timeoutController.signal.aborted && signal.reason === timeoutController.signal.reason
      ? "provider_deadline" : parentSignal?.aborted ? "parent_signal" : "unknown",
    duration_ms: Math.max(0, performance.now() - startedAt), timeout_ms: deadlineMs, deadline_kind: deadlineKind
  });
  if (signal.aborted) observeAbort({ stage: "before_start", abort_source: "unknown", timeout_ms: timeoutMs, deadline_kind: deadlineKind });
  else signal.addEventListener("abort", onAbort, { once: true });

  return {
    clear() {
      cleared = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    },
    /**
     * Moves the deadline to `nextTimeoutMs` after the same start: only later,
     * and never once it fired, was cleared or its parent ended.
     */
    extend(nextTimeoutMs: number) {
      if (cleared || signal.aborted || !Number.isFinite(nextTimeoutMs) || nextTimeoutMs <= deadlineMs) return;
      clearTimeout(timeout);
      deadlineMs = nextTimeoutMs;
      timeout = setTimeout(expire, Math.max(0, deadlineMs - (performance.now() - startedAt)));
    },
    /** Time left before this deadline; a parent signal may end sooner. */
    remainingMs: () => Math.max(0, deadlineMs - (performance.now() - startedAt)),
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
  const observation = beginTransportStage("body", response);
  if (options.signal?.aborted) {
    const facts = transportFailureFacts(options.signal.reason, options.signal);
    observation.finish(facts.category === "aborted" ? "cancelled" : "failed", facts);
    throw abortReason(options.signal);
  }
  if (!response.body) {
    observation.finish("completed");
    return "";
  }

  const maxBytes = options.maxBytes ?? providerResponseMaxBytes();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  let receivedBytes = 0;
  let receivedChunks = 0;
  let lastProgressAt: number | undefined;
  const progress = () => ({ bytes: receivedBytes, chunks: receivedChunks,
    last_progress_ms: lastProgressAt === undefined ? undefined : Math.max(0, performance.now() - lastProgressAt) });
  let needsCancellation = false;
  let failure: unknown;

  try {
    while (true) {
      const chunk = await readWithSignal(reader, options.signal);
      if (chunk.done) {
        textChunks.push(decoder.decode());
        observation.finish("completed", progress());
        return textChunks.join("");
      }

      receivedBytes += chunk.value.byteLength;
      receivedChunks += 1;
      if (chunk.value.byteLength > 0) lastProgressAt = performance.now();
      if (receivedBytes > maxBytes) {
        failure = new ProviderResponseTooLargeError({ maxBytes, receivedBytes });
        needsCancellation = true;
        throw failure;
      }

      textChunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    const facts = transportFailureFacts(error, options.signal);
    observation.finish(facts.category === "aborted" ? "cancelled" : "failed", { ...progress(), ...facts });
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
