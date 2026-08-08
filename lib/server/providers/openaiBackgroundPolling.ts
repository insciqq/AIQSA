import { DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS } from "./providerConfiguration";

export const DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS = 11 * 60_000;
export const MIN_OPENAI_BACKGROUND_POLL_TIMEOUT_MS = 5_000;
export const MAX_OPENAI_BACKGROUND_POLL_TIMEOUT_MS = 24 * 60 * 60_000;

const environmentName = "AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS";

function configuredPollTimeoutMs(
  environment: Readonly<Record<string, string | undefined>>
): number {
  const value = environment[environmentName];
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_OPENAI_BACKGROUND_POLL_TIMEOUT_MS &&
    parsed <= MAX_OPENAI_BACKGROUND_POLL_TIMEOUT_MS
    ? parsed
    : DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS;
}

export function effectiveOpenAIBackgroundPollTimeoutMs(
  responseTimeoutMs: number,
  environment: Readonly<Record<string, string | undefined>> = process.env
): number {
  const effectiveResponseTimeoutMs = Number.isSafeInteger(responseTimeoutMs) && responseTimeoutMs > 0
    ? responseTimeoutMs
    : DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS;
  return Math.max(effectiveResponseTimeoutMs, configuredPollTimeoutMs(environment));
}
