import type { AdminProviderCapabilityAttempt, AdminProviderCapabilityCheck } from "../../../contracts/adminProviders";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { isRetryableProviderNetworkError } from "../../providers/providerRetry";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Positive projection only: provider bodies, messages and reasoning are not receipts. */
export function capabilityFailureAttempt(error: unknown, input: {
  attempts: number;
  capability: AdminProviderCapabilityCheck;
  adapterKind: ProviderModelConfiguration["adapterKind"];
  accessVerified: boolean;
  timedOut: boolean;
}): AdminProviderCapabilityAttempt {
  const candidate = record(error);
  const code = typeof candidate.code === "string" ? candidate.code : error instanceof Error ? error.message : "";
  const fallbackStatus = error instanceof Error ? /request failed with status (\d{3})$/u.exec(error.message)?.[1] : undefined;
  const status = candidate.httpStatus ?? candidate.status ?? (fallbackStatus ? Number(fallbackStatus) : undefined);
  const httpStatus = Number.isSafeInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? Number(status) : undefined;
  const explicitUnsupported = code === "provider_capability_unsupported" && (httpStatus === undefined || [400, 404, 405, 415, 422].includes(httpStatus)) &&
    (input.capability !== "directPdf" || candidate.unsupportedInput === true);
  // OpenRouter's capability-only 404 follows successful access on the same
  // pinned route; it means no endpoint satisfies this capability contract.
  const rejectedRoute = input.adapterKind === "openrouter_chat_completions" && httpStatus === 404 && input.accessVerified &&
    code !== "provider_response_not_retryable" && code !== "provider_response_cancelled" &&
    input.capability !== "modelAccess" && input.capability !== "streaming";
  const reason: AdminProviderCapabilityAttempt["reason"] = explicitUnsupported || rejectedRoute ? "route_unsupported"
    : input.timedOut || ["AbortError", "TimeoutError"].includes(String(candidate.name)) ||
      ["provider_request_timed_out", "provider_stream_timeout", "provider_stream_deadline_exceeded"].includes(code) ? "timeout"
    : candidate.capabilityFailureReason === "refusal" ? "refusal"
    : candidate.capabilityFailureReason === "budget_exhausted" ? "budget_exhausted"
    : httpStatus === 401 || httpStatus === 403 ? "authorization"
    : httpStatus === 429 ? "rate_limit"
    : httpStatus === 400 || httpStatus === 422 ? "invalid_input"
    : httpStatus ? "http_error"
    : error instanceof TypeError || isRetryableProviderNetworkError(error) ? "network"
    : "semantic_inconclusive";
  return { attempts: input.attempts, status: explicitUnsupported || rejectedRoute ? "unsupported" : "incomplete", reason,
    ...(httpStatus ? { httpStatus } : {}) };
}

export function retryCapabilityAttempt(attempt: AdminProviderCapabilityAttempt): boolean {
  if (attempt.status !== "incomplete" || attempt.attempts >= 3) return false;
  if (attempt.reason === "network" || attempt.reason === "rate_limit") return true;
  if (attempt.reason === "http_error") return (attempt.httpStatus ?? 0) >= 500;
  return attempt.attempts < 2 && ["refusal", "budget_exhausted", "semantic_inconclusive"].includes(attempt.reason);
}
