import type { ProxyAddressFailureCode, ProxyConnectionFailureCode, ProxySelectionFailureCode, PROXY_UNAVAILABLE_CODE } from "../../contracts/proxies";

export type WebFetchFailureCode =
  | "fetch_url_invalid" | "fetch_url_credentials" | "fetch_port_not_allowed" | "fetch_blocked_address"
  | "fetch_redirect_invalid" | "fetch_redirect_limit" | "fetch_timeout" | "fetch_too_large"
  | "fetch_unsupported_content_type" | "fetch_http_status" | "fetch_network_error"
  | ProxyAddressFailureCode | ProxyConnectionFailureCode | ProxySelectionFailureCode | typeof PROXY_UNAVAILABLE_CODE;

/** Never retain a socket error, its message, cause, endpoint or credentials. */
export class WebFetchError extends Error {
  readonly code: WebFetchFailureCode;
  readonly httpStatus?: number;
  readonly dispatched: boolean;

  constructor(code: WebFetchFailureCode, options: Readonly<{ dispatched: boolean; httpStatus?: number }>) {
    super(code);
    this.name = "WebFetchError";
    this.code = code;
    this.dispatched = options.dispatched;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}
