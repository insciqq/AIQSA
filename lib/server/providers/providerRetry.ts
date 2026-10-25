import { ProviderSafeFetchError, providerRequestNotSent } from "./providerSafeFetch";
import { observeProviderRetry, withProviderAttempt } from "./providerObservability";

export const DEFAULT_PROVIDER_REQUEST_MAX_ATTEMPTS = 4;

const MAX_PROVIDER_REQUEST_ATTEMPTS = 6;
const PROVIDER_RETRY_BASE_DELAY_MS = 250;
const PROVIDER_RETRY_MAX_BACKOFF_MS = 4_000;
const PROVIDER_RETRY_MAX_RETRY_AFTER_MS = 5 * 60_000;

export type ProviderRetryDecision = Readonly<{
  retryAfterMs: number | null;
}>;

export type ProviderRetryOptions = Readonly<{
  maxAttempts?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

function abortReason(signal: AbortSignal): unknown {
  return typeof signal.reason === "undefined"
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

/** The default wait between attempts: it ends early with the signal's reason. */
export async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function boundedMaxAttempts(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 &&
    Number(value) <= MAX_PROVIDER_REQUEST_ATTEMPTS
    ? Number(value)
    : DEFAULT_PROVIDER_REQUEST_MAX_ATTEMPTS;
}

function unitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** An exponential backoff schedule: the first wait's ceiling and the cap. */
export type ProviderRetryBackoff = Readonly<{
  baseDelayMs: number;
  maxBackoffMs: number;
}>;

const SHARED_PROVIDER_RETRY_BACKOFF: ProviderRetryBackoff = {
  baseDelayMs: PROVIDER_RETRY_BASE_DELAY_MS,
  maxBackoffMs: PROVIDER_RETRY_MAX_BACKOFF_MS
};

/** A longer retry window for a request that failed before any of its output
 * (PROVIDERS.md, operator decision 2026-10-18): at most `maxAttempts`
 * requests, the first included, and no wait ending more than `windowMs`
 * after the first request started. */
export type ProviderRetryWindow = ProviderRetryBackoff & Readonly<{
  maxAttempts: number;
  windowMs: number;
}>;

/** Waits of about 2, 4, 8, 16 and 30 s (each 50-100% of its ceiling) fit
 * five re-sends into the window: a minute-long provider burst passes, while
 * Stop and the run's deadlines still end every wait at once. */
export const PROVIDER_BEFORE_OUTPUT_RETRY_WINDOW: ProviderRetryWindow = {
  baseDelayMs: 2_000,
  maxAttempts: MAX_PROVIDER_REQUEST_ATTEMPTS,
  maxBackoffMs: 30_000,
  windowMs: 90_000
};

/** The jittered exponential backoff after a failed attempt, never shorter
 * than the provider's Retry-After; null when that asks for more than five
 * minutes. */
export function providerRetryDelayMs(
  failedAttempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
  backoff: ProviderRetryBackoff = SHARED_PROVIDER_RETRY_BACKOFF
): number | null {
  if (retryAfterMs !== null && retryAfterMs > PROVIDER_RETRY_MAX_RETRY_AFTER_MS) {
    return null;
  }
  const ceiling = Math.min(
    backoff.maxBackoffMs,
    backoff.baseDelayMs * (2 ** Math.max(0, failedAttempt - 1))
  );
  const jittered = Math.max(
    1,
    Math.round(ceiling * (0.5 + unitInterval(random()) * 0.5))
  );
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** A binding's Codex LB dropped-request admission (PROVIDERS.md) with the
 * seams of the shared provider backoff, as its live callers use it. */
export type ProviderDroppedRequestRetry = Readonly<{
  /** The clock of the before-output window; `Date.now` by default. */
  now?: () => number;
  policy: import("./types").ProviderDroppedRoundRetry;
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

/** The time on the retry's clock, for the start of a call's first request. */
export function droppedRequestRetryNow(retry: ProviderDroppedRequestRetry): number {
  return (retry.now ?? Date.now)();
}

/** The wait before the next request after a dropped one, or null to keep the
 * failure: only a drop the binding recognizes, before any accepted output,
 * before Stop and within the request bound, which the binding's before-output
 * window replaces when it has one. Every decision on a recognized drop is
 * recorded. */
export function droppedRequestRetryDelay(retry: ProviderDroppedRequestRetry, input: Readonly<{
  acceptedOutput: boolean;
  attempt: number;
  error: unknown;
  /** When the call's first request started, on the retry's clock. */
  firstRequestAt: number;
  signal: AbortSignal | undefined;
}>): number | null {
  const decision = retry.policy.decision(input.error);
  if (!decision) return null;
  const window = retry.policy.beforeOutput;
  const proposed = !input.acceptedOutput && input.signal?.aborted !== true &&
    input.attempt < (window?.maxAttempts ?? retry.policy.maxAttempts)
    ? providerRetryDelayMs(input.attempt, decision.retryAfterMs, retry.random, window) : null;
  // Inside the window a wait, a Retry-After included, must end there too.
  const delayMs = proposed !== null && window !== undefined &&
    droppedRequestRetryNow(retry) - input.firstRequestAt + proposed > window.windowMs ? null : proposed;
  retry.policy.observe(delayMs === null
    ? { action: "stop", attempt: input.attempt, error: input.error }
    : { action: "retry", attempt: input.attempt, delayMs, error: input.error });
  return delayMs;
}

/** Rate limits and server errors, Anthropic's 529 overload included. */
export function isRetryableProviderHttpStatus(status: number | null): boolean {
  return status === 408 || status === 425 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

export function isRetryableProviderNetworkError(error: unknown): boolean {
  if (error instanceof ProviderSafeFetchError) {
    return error.code === "provider_http_dns_failed" ||
      error.code === "provider_http_request_failed";
  }
  // Native fetch implementations reject transport failures with TypeError.
  // Abort/deadline errors are rejected by the caller before this classifier.
  return error instanceof TypeError;
}

export const PROVIDER_REQUEST_OUTCOME_UNKNOWN = "provider_request_outcome_unknown";

/** A paid create lost its transport after the provider may have received it.
 * Neither success, zero usage nor a completed replay may be inferred. */
export class ProviderRequestOutcomeUnknownError extends Error {
  readonly code = PROVIDER_REQUEST_OUTCOME_UNKNOWN;

  constructor(cause: unknown) {
    super(PROVIDER_REQUEST_OUTCOME_UNKNOWN, { cause });
    this.name = "ProviderRequestOutcomeUnknownError";
  }
}

/** Only a transport that owns initial-request replay reports its refusal to
 * replay as an unknown outcome. Callers that disable replay (they own dispatch
 * recovery or their own paid-probe policy) keep the raw transport failure. */
export function ownsInitialRequestReplay(options: ProviderRetryOptions | undefined): boolean {
  return options !== undefined && options.maxAttempts !== 1;
}

/** A transport failure without proof of non-delivery leaves the create's
 * outcome and billing unknown; aborts and deadlines keep their own identity. */
export function initialRequestTransportFailure(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted || providerRequestNotSent(error) || !isRetryableProviderNetworkError(error)
    ? error
    : new ProviderRequestOutcomeUnknownError(error);
}

/**
 * Retries only failures explicitly classified by the caller, within the one
 * existing provider deadline/cancellation signal. There is no endpoint,
 * credential, model, or provider fallback between attempts.
 */
export async function executeWithProviderRetry<T>(input: Readonly<{
  operation: () => Promise<T>;
  options?: ProviderRetryOptions;
  /** Time left before the operation's own deadline: a wait that would
   * outlast it ends the retries with the failure instead of the deadline. */
  remainingMs?: () => number;
  shouldRetry: (error: unknown) => ProviderRetryDecision | null;
  signal: AbortSignal;
}>): Promise<T> {
  const maxAttempts = boundedMaxAttempts(input.options?.maxAttempts);
  const random = input.options?.random ?? Math.random;
  const sleep = input.options?.sleep ?? sleepWithSignal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withProviderAttempt(attempt, input.operation);
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      const decision = input.shouldRetry(error);
      if (decision === null || attempt === maxAttempts) {
        observeProviderRetry(error, attempt, "stop");
        throw error;
      }
      const delayMs = providerRetryDelayMs(attempt, decision.retryAfterMs, random);
      if (delayMs === null || input.remainingMs !== undefined && delayMs >= input.remainingMs()) {
        observeProviderRetry(error, attempt, "stop");
        throw error;
      }
      observeProviderRetry(error, attempt, "retry", delayMs);
      await sleep(delayMs, input.signal);
    }
  }

  throw new Error("provider_retry_attempts_invalid");
}
