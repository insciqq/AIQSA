const unsupportedCodes = new Set([
  "unsupported_parameter", "unsupported_value", "unsupported_feature", "unsupported_content_type",
  "unsupported_image", "unsupported_file", "unsupported_file_type"
]);
const blockedCodes = new Set([
  "invalid_api_key", "authentication_error", "permission_denied", "insufficient_quota",
  "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded", "content_filter", "invalid_model", "model_not_found",
  "unsupported_model", "model_not_supported", "model_not_available", "unsupported", "not_supported"
]);

const unsupportedMessage = /\b(?:does not support|do not support|not supported|unsupported)\b/iu;
const capabilityMessage = /\b(?:inputs?|output formats?|response formats?|images?|vision|pdfs?|documents?|files?|json|schemas?|structured outputs?|tools?|function calling|response_format|input_image|input_file)\b|\b(?:this|the|requested) (?:request|feature|input|capability)\b/iu;
const blockedMessage = /\b(?:api[ -]?key|authentication|permission|access denied|unauthorized|forbidden|quota|credits?|billing|balance|spend limit|usage limit|policy|safety|moderation|country|region|account|organization|project)\b|\b(?:unknown|invalid|unsupported) model\b|\bmodel(?:\s+\S+){0,3}\s+(?:not found|does not exist|is not available|is not supported)\b/iu;

const accessFailureMessage = /\b(?:invalid|incorrect|expired|revoked) (?:api[ -]?key|credentials?)\b|\b(?:unauthorized|forbidden|permission denied|access denied|insufficient quota|quota exceeded|quota exhausted|insufficient credits|insufficient balance|unknown model|invalid model)\b/iu;

/** Retains only a reviewed failure category, never the upstream message or body. */
export function providerResponseFailure(message: string, response: Readonly<Record<string, unknown>>): Error {
  const detail = typeof response.error === "object" && response.error !== null
    ? response.error as Record<string, unknown> : null;
  const incomplete = typeof response.incomplete_details === "object" && response.incomplete_details !== null
    ? response.incomplete_details as Record<string, unknown> : null;
  const messageText = typeof detail?.message === "string" ? detail.message.slice(0, 2_048) : "";
  const hasUnsupportedMessage = unsupportedMessage.test(messageText);
  const explicitlyBlocked = typeof detail?.code === "string" && blockedCodes.has(detail.code) ||
    incomplete?.reason === "content_filter" || accessFailureMessage.test(messageText) ||
    hasUnsupportedMessage && blockedMessage.test(messageText);
  const explicitlyUnsupported = typeof detail?.code === "string" && unsupportedCodes.has(detail.code) ||
    hasUnsupportedMessage && capabilityMessage.test(messageText);
  const code = response.status === "cancelled" ? "provider_response_cancelled"
    : explicitlyBlocked ? "provider_response_not_retryable"
      : explicitlyUnsupported ? "provider_capability_unsupported"
        : hasUnsupportedMessage ? "provider_response_not_retryable" : undefined;
  return Object.assign(new Error(message), code ? { code } : {});
}
