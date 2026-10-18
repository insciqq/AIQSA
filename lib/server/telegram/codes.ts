import type { TelegramFailureKind } from "./transport";

/**
 * Content-free log codes for Bot API call failures, by outcome kind. The
 * user-facing reason codes live in `lib/contracts/telegram.ts`; both sets are
 * registered in the observability failure-code registry.
 */
export const TELEGRAM_TRANSPORT_FAILURE_CODES = {
  http: "telegram_http_error",
  telegram: "telegram_api_error",
  network_before_send: "telegram_network_before_send",
  network_after_send: "telegram_network_after_send",
  timeout: "telegram_request_timeout",
  too_large: "telegram_response_too_large"
} as const satisfies Record<TelegramFailureKind, string>;

export const TELEGRAM_RATE_LIMITED_CODE = "telegram_rate_limited";
export const TELEGRAM_API_ORIGIN_INVALID_CODE = "telegram_api_origin_invalid";
export const TELEGRAM_REQUEST_INVALID_CODE = "telegram_request_invalid";

export type TelegramTransportFailureCode = (typeof TELEGRAM_TRANSPORT_FAILURE_CODES)[TelegramFailureKind];

export function telegramFailureCode(kind: TelegramFailureKind, errorCode?: number): string {
  return kind === "telegram" && errorCode === 429 ? TELEGRAM_RATE_LIMITED_CODE : TELEGRAM_TRANSPORT_FAILURE_CODES[kind];
}

/** Every log code this module family emits besides the contract's reason codes. */
export const TELEGRAM_LOG_CODES = [
  ...Object.values(TELEGRAM_TRANSPORT_FAILURE_CODES),
  TELEGRAM_RATE_LIMITED_CODE,
  TELEGRAM_API_ORIGIN_INVALID_CODE,
  TELEGRAM_REQUEST_INVALID_CODE
] as const;
