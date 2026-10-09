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

/** The jittered exponential backoff after a failed attempt, never shorter
 * than the provider's Retry-After; null when that asks for more than five
 * minutes. */
export function providerRetryDelayMs(
  failedAttempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random
): number | null {
  if (retryAfterMs !== null && retryAfterMs > PROVIDER_RETRY_MAX_RETRY_AFTER_MS) {
    return null;
  }
  const ceiling = Math.min(
    PROVIDER_RETRY_MAX_BACKOFF_MS,
    PROVIDER_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, failedAttempt - 1))
  );
  const jittered = Math.max(
    1,
    Math.round(ceiling * (0.5 + unitInterval(random()) * 0.5))
  );
  return Math.max(jittered, retryAfterMs ?? 0);
}

export function isRetryableProviderHttpStatus(status: number | null): boolean {
  return status === 408 || status === 425 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504;
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
