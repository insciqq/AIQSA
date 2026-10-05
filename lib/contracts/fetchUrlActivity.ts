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
  "fetch_pdf_password_protected",
  "fetch_pdf_invalid",
  "fetch_pdf_too_many_pages",
  "fetch_reader_unavailable",
  "fetch_url_limit_reached",
  "fetch_url_interrupted"
] as const;

export type FetchUrlActivityOutcome = (typeof FETCH_URL_ACTIVITY_OUTCOMES)[number];

/**
 * A body kind an activity row names: `pdf` when the link's body was read as
 * a PDF (its outcome then is the PDF's read or failure). Pages carry none.
 */
export const FETCH_URL_CONTENT_KINDS = ["pdf"] as const;

export type FetchUrlContentKind = (typeof FETCH_URL_CONTENT_KINDS)[number];

export function isFetchUrlContentKind(value: unknown): value is FetchUrlContentKind {
  return typeof value === "string" && (FETCH_URL_CONTENT_KINDS as readonly string[]).includes(value);
}

/** Upper bound of an activity row's "host/path" target, in UTF-16 units. */
export const FETCH_URL_TARGET_MAX_LENGTH = 96;

export function isFetchUrlActivityOutcome(value: unknown): value is FetchUrlActivityOutcome {
  return typeof value === "string" && (FETCH_URL_ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Where a `fetch_url_not_in_conversation` refusal is recovered, when not by
 * sending the link in the chat: `scheduled_run` (a scheduled run; its owner
 * saves the task's instructions to allow the link) or `task_instructions`
 * (another run refused a link only a scheduled task's instructions hold;
 * only that task's scheduled runs read it).
 */
export const FETCH_URL_REFUSAL_SCOPES = ["scheduled_run", "task_instructions"] as const;

export type FetchUrlRefusalScope = (typeof FETCH_URL_REFUSAL_SCOPES)[number];

export function isFetchUrlRefusalScope(value: unknown): value is FetchUrlRefusalScope {
  return typeof value === "string" && (FETCH_URL_REFUSAL_SCOPES as readonly string[]).includes(value);
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
