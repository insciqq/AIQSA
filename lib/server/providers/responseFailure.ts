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
// Bare "input" may refer to an unrelated input parameter such as reasoning.
// Require an input modality/file marker before claiming PDF incompatibility.
const inputMessage = /\b(?:images?|vision|pdfs?|documents?|files?|input_image|input_file)\b/iu;
const unsupportedInputCodes = new Set(["unsupported_content_type", "unsupported_image", "unsupported_file", "unsupported_file_type"]);
const blockedMessage = /\b(?:api[ -]?key|authentication|permission|access denied|unauthorized|forbidden|quota|credits?|billing|balance|spend limit|usage limit|policy|safety|moderation|country|region|account|organization|project)\b|\b(?:unknown|invalid|unsupported) model\b|\bmodel(?:\s+\S+){0,3}\s+(?:not found|does not exist|is not available|is not supported)\b/iu;

const accessFailureMessage = /\b(?:invalid|incorrect|expired|revoked) (?:api[ -]?key|credentials?)\b|\b(?:unauthorized|forbidden|permission denied|access denied|insufficient quota|quota exceeded|quota exhausted|insufficient credits|insufficient balance|unknown model|invalid model)\b/iu;

const openRouterRoutingMessages = {
  openrouter_required_parameters_unavailable:
    "OpenRouter has no endpoint that supports the required request parameters. Ask an administrator to review the selected model's routing and tool support before retrying.",
  openrouter_routing_unavailable:
    "OpenRouter has no endpoint matching the request's routing requirements. Ask an administrator to review the selected model's routing settings before retrying."
} as const;

export function openRouterRoutingFailureCode(value: unknown): keyof typeof openRouterRoutingMessages | null {
  const code = typeof value === "object" && value !== null && "code" in value ? value.code : null;
  return typeof code === "string" && Object.hasOwn(openRouterRoutingMessages, code)
    ? code as keyof typeof openRouterRoutingMessages : null;
}

export function openRouterRoutingFailureMessage(code: keyof typeof openRouterRoutingMessages): string {
  return openRouterRoutingMessages[code];
}

/** Retains only a reviewed failure category, never the upstream message or body. */
export function providerResponseFailure(
  message: string,
  response: Readonly<Record<string, unknown>>,
  context?: Readonly<{ httpStatus: number; providerName: string }>
): Error {
  const detail = typeof response.error === "object" && response.error !== null
    ? response.error as Record<string, unknown> : null;
  const incomplete = typeof response.incomplete_details === "object" && response.incomplete_details !== null
    ? response.incomplete_details as Record<string, unknown> : null;
  const messageText = typeof detail?.message === "string" ? detail.message.slice(0, 2_048) : "";
  // OpenRouter's routing 404 is distinct from a missing model. Only known
  // no-eligible-endpoint messages and a closed routing-step vocabulary qualify;
  // raw messages, funnels and private metadata never leave this decoder.
  if (context?.providerName === "OpenRouter" && context.httpStatus === 404 &&
    !(typeof detail?.code === "string" && blockedCodes.has(detail.code)) &&
    !accessFailureMessage.test(messageText) &&
    /^No endpoints found that (?:support |match (?:your|the requested) (?:data policy|privacy|routing))/iu.test(messageText)) {
    const metadata = typeof detail?.metadata === "object" && detail.metadata !== null
      ? detail.metadata as Record<string, unknown> : null;
    const step = metadata?.failed_routing_step;
    const parameters = /^No endpoints found that support (?:the provided|(?:all )?(?:the )?requested) parameters\b/iu.test(messageText) ||
      step === "parameters" || step === "required_parameters";
    const code = parameters ? "openrouter_required_parameters_unavailable" : "openrouter_routing_unavailable";
    return Object.assign(new Error(openRouterRoutingFailureMessage(code)), { code });
  }
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
  const unsupportedInput = code === "provider_capability_unsupported" &&
    (typeof detail?.code === "string" && unsupportedInputCodes.has(detail.code) ||
      hasUnsupportedMessage && inputMessage.test(messageText));
  const choice = Array.isArray(response.choices) ? response.choices[0] : null;
  const choiceRecord = choice && typeof choice === "object" ? choice as Record<string, unknown> : null;
  const choiceMessage = choiceRecord?.message && typeof choiceRecord.message === "object" ? choiceRecord.message as Record<string, unknown> : null;
  const refusal = incomplete?.reason === "content_filter" || detail?.code === "content_filter" ||
    choiceRecord?.finish_reason === "content_filter" || typeof choiceMessage?.refusal === "string" && choiceMessage.refusal.length > 0;
  const capabilityFailureReason = refusal ? "refusal" : incomplete?.reason === "max_output_tokens" || choiceRecord?.finish_reason === "length" ? "budget_exhausted" : undefined;
  return Object.assign(new Error(message), code ? { code } : {}, unsupportedInput ? { unsupportedInput: true } : {},
    capabilityFailureReason ? { capabilityFailureReason } : {});
}
