/**
 * Content-free log codes of the Discord transport, REST client and gateway
 * client. The visible reason codes live in `lib/contracts/discord.ts`; both
 * sets are registered in the observability failure-code registry, so neither
 * logs as `unknown`.
 */

export const DISCORD_TRANSPORT_FAILURE_CODES = {
  network_before_send: "discord_network_before_send",
  network_after_send: "discord_network_after_send",
  timeout: "discord_request_timeout",
  too_large: "discord_response_too_large",
  redirect: "discord_redirect_refused",
  forbidden_host: "discord_host_forbidden"
} as const;
export type DiscordTransportFailureKind = keyof typeof DISCORD_TRANSPORT_FAILURE_CODES;

export const DISCORD_API_ORIGIN_INVALID_CODE = "discord_api_origin_invalid";
export const DISCORD_REQUEST_INVALID_CODE = "discord_request_invalid";
export const DISCORD_CONNECT_ADDRESS_INVALID_CODE = "discord_connect_address_invalid";
/** Discord answered with an error status other than 429. */
export const DISCORD_API_ERROR_CODE = "discord_api_error";
export const DISCORD_HTTP_ERROR_CODE = "discord_http_error";
export const DISCORD_RATE_LIMITED_CODE = "discord_rate_limited";
export const DISCORD_INVALID_REQUESTS_CODE = "discord_invalid_requests";
export const DISCORD_DISABLED_CODE = "discord_disabled";
export const DISCORD_TOKEN_MISSING_CODE = "discord_token_missing";
/** A 2xx body that is not the shape the method expects. */
export const DISCORD_INVALID_RESPONSE_CODE = "discord_invalid_response";

export const DISCORD_GATEWAY_CODES = {
  payloadTooLarge: "discord_gateway_payload_too_large",
  rateLimited: "discord_gateway_rate_limited",
  notOpen: "discord_gateway_not_open",
  zombie: "discord_gateway_zombie",
  urlInvalid: "discord_gateway_url_invalid",
  identifyRefused: "discord_session_limit",
  tokenRejected: "discord_token_rejected",
  intentsDisallowed: "discord_intents_disallowed",
  refused: "discord_gateway_refused",
  disconnected: "discord_disconnected"
} as const;

export function discordTransportFailureCode(kind: DiscordTransportFailureKind): string {
  return DISCORD_TRANSPORT_FAILURE_CODES[kind];
}

/** Every log code this module family emits besides the contract's reason codes. */
export const DISCORD_LOG_CODES = [
  ...Object.values(DISCORD_TRANSPORT_FAILURE_CODES),
  DISCORD_API_ORIGIN_INVALID_CODE,
  DISCORD_REQUEST_INVALID_CODE,
  DISCORD_CONNECT_ADDRESS_INVALID_CODE,
  DISCORD_API_ERROR_CODE,
  DISCORD_HTTP_ERROR_CODE,
  DISCORD_RATE_LIMITED_CODE,
  DISCORD_INVALID_REQUESTS_CODE,
  DISCORD_DISABLED_CODE,
  DISCORD_TOKEN_MISSING_CODE,
  DISCORD_INVALID_RESPONSE_CODE,
  ...Object.values(DISCORD_GATEWAY_CODES)
] as const;
