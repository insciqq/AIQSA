import { ProviderSafeFetchError } from "./providerSafeFetch";

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

async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
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

function retryDelayMs(
  failedAttempt: number,
  retryAfterMs: number | null,
  random: () => number
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

/**
 * Retries only failures explicitly classified by the caller, within the one
 * existing provider deadline/cancellation signal. There is no endpoint,
 * credential, model, or provider fallback between attempts.
 */
export async function executeWithProviderRetry<T>(input: Readonly<{
  operation: () => Promise<T>;
  options?: ProviderRetryOptions;
  shouldRetry: (error: unknown) => ProviderRetryDecision | null;
  signal: AbortSignal;
}>): Promise<T> {
  const maxAttempts = boundedMaxAttempts(input.options?.maxAttempts);
  const random = input.options?.random ?? Math.random;
  const sleep = input.options?.sleep ?? sleepWithSignal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      const decision = input.shouldRetry(error);
      if (decision === null || attempt === maxAttempts) throw error;
      const delayMs = retryDelayMs(attempt, decision.retryAfterMs, random);
      if (delayMs === null) throw error;
      await sleep(delayMs, input.signal);
    }
  }

  throw new Error("provider_retry_attempts_invalid");
}
