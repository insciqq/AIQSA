/**
 * Browser-safe facts of one `fetch_url` call: the outcome codes an activity
 * row may carry and the bounds of its "host/path" target. The row never
 * carries the full URL, its query or any page content.
 */
export const FETCH_URL_ACTIVITY_OUTCOMES = [
  "read",
  "fetch_url_not_in_conversation",
  "fetch_url_invalid",
  "fetch_url_credentials",
  "fetch_port_not_allowed",
  "fetch_blocked_address",
  "fetch_redirect_invalid",
  "fetch_redirect_limit",
  "fetch_timeout",
  "fetch_too_large",
  "fetch_unsupported_content_type",
  "fetch_http_status",
  "fetch_network_error",
  "fetch_no_readable_text",
  "fetch_url_limit_reached",
  "fetch_url_interrupted"
] as const;

export type FetchUrlActivityOutcome = (typeof FETCH_URL_ACTIVITY_OUTCOMES)[number];

/** Upper bound of an activity row's "host/path" target, in UTF-16 units. */
export const FETCH_URL_TARGET_MAX_LENGTH = 96;

export function isFetchUrlActivityOutcome(value: unknown): value is FetchUrlActivityOutcome {
  return typeof value === "string" && (FETCH_URL_ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}

/** A bounded single-line target without a scheme, or null. */
export function decodeFetchUrlTarget(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > FETCH_URL_TARGET_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return null;
  return value.trim();
}

export function isFetchUrlHttpStatus(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599;
}
