import { isProviderResponseFailure } from "./responseFailure";
import { observedFailure, providerContextRejection } from "./providerObservability";
import { isRetryableProviderHttpStatus } from "./providerRetry";

/**
 * The display names of the model and connection a run was admitted with, as an
 * administrator configured them (`ProviderExecutionSnapshot`). A missing name
 * leaves it out of the text; it is never guessed.
 */
export type ProviderFailureNames = Readonly<{ connection?: string | null; model?: string | null }>;

const TRANSIENT = "This is a problem on the provider's side, not in AIQSA. Try again in a few minutes, or choose another model.";
const REJECTED = "The provider rejected it, not AIQSA, so sending it again will not help: " +
  "change the request or its attachments, or choose another model.";

// The reviewed identities of a typed provider rejection that a user may read.
const rejectionIdentities: Readonly<Record<string, string>> = {
  provider_http_invalid_request: "invalid_request",
  provider_http_parameter_unknown: "parameter_unknown"
};

function displayName(value: string | null | undefined): string | null {
  const name = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return name.length > 0 && name.length <= 120 ? name : null;
}

/** Who failed: the model via its connection, or as much of it as the run's binding names. */
function subject(names: ProviderFailureNames | undefined, startsSentence: boolean): string {
  const model = displayName(names?.model);
  const connection = displayName(names?.connection);
  if (model && connection) return `${model} via ${connection}`;
  const article = startsSentence ? "The" : "the";
  if (model) return `${article} provider of ${model}`;
  return connection ? `${article} model provider ${connection}` : `${article} model provider`;
}

/**
 * What a user reads when a model provider ended the answer: the run's model and
 * connection by name, that the failure is the provider's and not AIQSA's, and
 * what to do. A transient failure (a stream that kept dropping, a server error,
 * a rate limit, a timeout) is worth trying again later; a deterministic
 * rejection is not; credentials and quota are an administrator's. Null when
 * the failure is not the provider's, so the caller keeps its own wording.
 * Built from reviewed codes and statuses only, never provider text.
 */
export function providerFailureMessage(value: unknown, names?: ProviderFailureNames): string | null {
  const who = subject(names, true);
  const whom = subject(names, false);
  const failure = observedFailure(value);
  if (failure.code === "provider_request_outcome_unknown") {
    // No provider evidence exists either way: claim neither a charge nor its absence.
    return `The connection to ${whom} was lost after the request may have been sent. ` +
      "Its outcome and any provider charge are unknown, so it was not repeated automatically. Try again in a few minutes, or choose another model.";
  }
  const rejection = providerContextRejection(value);
  if (rejection) {
    return `${rejection.httpStatus !== undefined
      ? `${who} rejected the request as too long for the model's context window (HTTP ${rejection.httpStatus}).`
      : "The request exceeded the model's context window."} Reduce the context or choose a model with a larger context window.`;
  }
  const status = failure.httpStatus !== undefined ? ` (HTTP ${failure.httpStatus})` : "";
  const identity = rejectionIdentities[failure.code];
  if (identity !== undefined && failure.httpStatus !== undefined && failure.httpStatus >= 400 && failure.httpStatus <= 499) {
    return `${who} rejected the request (HTTP ${failure.httpStatus}: ${identity}). ${REJECTED}`;
  }
  switch (failure.code) {
    case "provider_request_rejected":
    case "provider_response_not_retryable":
      return `${who} rejected this request${status}. ${REJECTED}`;
    case "provider_capability_unsupported":
      return `${who} does not support part of this request, such as an attachment type or a tool. ${REJECTED}`;
    case "provider_refused":
      return `${who} refused to answer this request. ${REJECTED}`;
    case "provider_budget_exhausted":
      return `${who} reached its output limit before the answer was complete. ` +
        "Sending it again will not help: ask for a shorter answer, or choose another model.";
    case "provider_output_too_large":
    case "provider_response_too_large":
    case "provider_stream_event_too_large":
    case "provider_stream_too_large":
      return `${who} sent a larger response than AIQSA accepts. Ask for a shorter answer, or choose another model.`;
    case "provider_auth_rejected":
      return `${who} rejected the configured credentials${status}. Ask an administrator to check the provider key.`;
    case "provider_quota_exhausted":
      return `${who} reports that the account has no remaining quota or balance${status}. Ask an administrator to check the provider account.`;
    case "openrouter_required_parameters_unavailable":
      return `${who} has no OpenRouter endpoint that supports the required request parameters. ` +
        "Ask an administrator to review the selected model's routing and tool support.";
    case "openrouter_routing_unavailable":
      return `${who} has no OpenRouter endpoint matching the request's routing requirements. ` +
        "Ask an administrator to review the selected model's routing settings.";
    case "provider_rate_limited":
      return `${who} is limiting requests${status} and the retries did not succeed. ${TRANSIENT}`;
    // A run fails with these only after any admitted re-send did not help; nothing switches the model on the user's behalf.
    case "provider_server_error":
      return `${who} returned a server error${status} and kept failing when retried. ${TRANSIENT}`;
    case "provider_request_timed_out":
    case "provider_stream_timeout":
    case "provider_stream_deadline_exceeded":
      return `${who} did not answer in time. ${TRANSIENT}`;
    case "provider_http_malformed_function_call":
    case "provider_http_malformed_tool_call":
      return `${who} produced a malformed tool call${status}. ${TRANSIENT}`;
    case "provider_response_cancelled":
    case "openai_response_cancelled":
      return `${who} cancelled the response. ${TRANSIENT}`;
    case "provider_http_dns_failed":
    case "provider_http_request_failed":
    case "provider_http_tls_failed":
      // The network between AIQSA and the provider may be either side's: no claim whose it is.
      return `AIQSA could not reach ${whom}. Try again in a few minutes, or choose another model; ` +
        "if it keeps failing, ask an administrator to check the connection.";
    default:
      break;
  }
  if (failure.stream_drop !== undefined) return `${who} kept failing before the response was complete. ${TRANSIENT}`;
  if (failure.reason === "invalid_response" || failure.code.startsWith("openai_response_") || isProviderResponseFailure(value)) {
    return `${who} could not complete the response. ${TRANSIENT}`;
  }
  // An HTTP status no reviewed code names: a status the retries cover is passing, any other 4xx a rejection.
  if (failure.code === "unknown" && failure.reason === "http" && failure.httpStatus !== undefined) {
    if (isRetryableProviderHttpStatus(failure.httpStatus)) return `${who} kept failing${status}. ${TRANSIENT}`;
    if (failure.httpStatus >= 400 && failure.httpStatus <= 499) return `${who} rejected this request${status}. ${REJECTED}`;
  }
  return null;
}
