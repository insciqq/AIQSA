/** Wire contract of `/api/client-errors`: a signed-in page reports that it crashed. */

export const CLIENT_ERRORS_PATH = "/api/client-errors";

/** Closed crash classes; the browser never sends a message, stack, URL or user agent. */
export const CLIENT_ERROR_KINDS = ["render", "error", "unhandled_rejection", "chunk_load"] as const;

export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** Longer pathnames are left out by the browser instead of truncated. */
export const CLIENT_ERROR_PATHNAME_MAX_LENGTH = 400;

/** The whole JSON body; anything larger is refused before parsing. */
export const CLIENT_ERROR_REPORT_MAX_BYTES = 512;

/**
 * POST body. `pathname` is the page's own path without query or fragment; the
 * server only matches it against build route templates and never stores it.
 */
export type ClientErrorReportRequest = Readonly<{
  kind: ClientErrorKind;
  pathname?: string;
}>;

export type ClientErrorReportErrorCode = "client_error_report_invalid" | "rate_limited";
