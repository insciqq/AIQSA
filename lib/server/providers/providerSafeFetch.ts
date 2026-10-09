import {
  McpSafeFetchError,
  mcpSafeFetch,
  networkAddressScope,
  type McpPinnedHttpRequest,
  type McpResolvedAddress
} from "../mcp/safeFetch";
import {
  normalizeProviderConnectionConfiguration,
  type ProviderConnectionConfiguration
} from "./providerConfiguration";

export type ProviderSafeFetchErrorCode =
  | "provider_http_address_forbidden"
  | "provider_http_dns_failed"
  | "provider_http_https_required"
  | "provider_http_invalid_request"
  | "provider_http_origin_forbidden"
  | "provider_http_redirect_forbidden"
  | "provider_http_request_body_too_large"
  | "provider_http_request_failed"
  | "provider_http_tls_failed"
  | "provider_http_url_forbidden";

// Provider requests may contain inline PDFs/images admitted by the run-level
// attachment bounds. Keep their transport ceiling independent from the much
// smaller MCP JSON-RPC request ceiling reused by the pinned-fetch primitive.
const PROVIDER_HTTP_REQUEST_MAX_BYTES = 512 * 1_024 * 1_024;

// Type-only marker merged into the class, as for `McpSafeFetchError`.
export interface ProviderSafeFetchError {
  /** See `McpSafeFetchError.requestNotSent`: set only on proof. */
  readonly requestNotSent?: true;
}

export class ProviderSafeFetchError extends Error {
  readonly code: ProviderSafeFetchErrorCode;

  /** `cause` keeps the transport error for its content-free telemetry facts. */
  constructor(code: ProviderSafeFetchErrorCode, options?: Readonly<{ requestNotSent?: boolean; cause?: unknown }>) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.name = "ProviderSafeFetchError";
    if (options?.requestNotSent === true) {
      Object.defineProperty(this, "requestNotSent", { enumerable: true, value: true });
    }
  }
}

/** True only when the transport proves that the provider never received the
 * request: DNS failed before dispatch, or the pinned connection was never
 * established. Every other transport failure may follow delivery. */
export function providerRequestNotSent(error: unknown): boolean {
  return error instanceof ProviderSafeFetchError &&
    (error.code === "provider_http_dns_failed" || error.requestNotSent === true);
}

export type ProviderSafeFetchOptions = {
  configuration: ProviderConnectionConfiguration;
  dispatch?: (request: McpPinnedHttpRequest) => Promise<Response>;
  lookupHostname?: (hostname: string) => Promise<readonly McpResolvedAddress[]>;
  requestBodyMaxBytes?: number;
};

function inputUrl(input: RequestInfo | URL): URL {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    throw new ProviderSafeFetchError("provider_http_invalid_request");
  }
}

function mapSafeFetchError(error: McpSafeFetchError): ProviderSafeFetchError {
  switch (error.code) {
    case "mcp_http_address_forbidden":
      return new ProviderSafeFetchError("provider_http_address_forbidden");
    case "mcp_http_dns_failed":
      return new ProviderSafeFetchError("provider_http_dns_failed", { cause: error });
    case "mcp_http_https_required":
      return new ProviderSafeFetchError("provider_http_https_required");
    case "mcp_http_redirect_forbidden":
    case "mcp_http_redirect_invalid":
    case "mcp_http_too_many_redirects":
      return new ProviderSafeFetchError("provider_http_redirect_forbidden");
    case "mcp_http_request_failed":
      return new ProviderSafeFetchError("provider_http_request_failed", { requestNotSent: error.requestNotSent, cause: error });
    // A handshake that failed before the session existed keeps that proof.
    case "mcp_http_tls_failed":
      return new ProviderSafeFetchError("provider_http_tls_failed", { requestNotSent: error.requestNotSent, cause: error });
    case "mcp_http_request_body_too_large":
      return new ProviderSafeFetchError("provider_http_request_body_too_large");
    case "mcp_http_protocol_forbidden":
    case "mcp_http_url_credentials_forbidden":
    case "mcp_http_url_fragment_forbidden":
      return new ProviderSafeFetchError("provider_http_url_forbidden");
    default:
      return new ProviderSafeFetchError("provider_http_invalid_request");
  }
}

function addressAllowed(
  address: McpResolvedAddress,
  url: URL,
  allowPrivateNetwork: boolean
): boolean {
  const scope = networkAddressScope(address.address);
  if (scope === "forbidden") {
    return false;
  }
  if (url.protocol === "http:") {
    return allowPrivateNetwork && (scope === "private" || scope === "loopback");
  }
  if (scope === "private" || scope === "loopback") {
    return allowPrivateNetwork;
  }

  return scope === "public";
}

export async function providerSafeFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ProviderSafeFetchOptions
): Promise<Response> {
  const configuration = normalizeProviderConnectionConfiguration(options.configuration);
  const configuredOrigin = new URL(configuration.apiRoot).origin;
  const url = inputUrl(input);
  if (url.origin !== configuredOrigin) {
    throw new ProviderSafeFetchError("provider_http_origin_forbidden");
  }

  try {
    return await mcpSafeFetch(
      input,
      { ...init, redirect: "error" },
      {
        addressAllowed: (address, requestUrl) =>
          addressAllowed(address, requestUrl, configuration.allowPrivateNetwork),
        allowInsecureHttp: configuration.allowPrivateNetwork,
        dispatch: options.dispatch,
        lookupHostname: options.lookupHostname,
        maxRedirects: 0,
        requestBodyMaxBytes:
          options.requestBodyMaxBytes ?? PROVIDER_HTTP_REQUEST_MAX_BYTES
      }
    );
  } catch (error) {
    if (error instanceof McpSafeFetchError) {
      throw mapSafeFetchError(error);
    }
    throw error;
  }
}

export function createProviderSafeFetch(options: ProviderSafeFetchOptions): typeof fetch {
  return (input, init) => providerSafeFetch(input, init, options);
}
