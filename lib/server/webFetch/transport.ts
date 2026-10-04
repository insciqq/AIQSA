import { brotliDecompressSync, inflateRawSync, unzipSync } from "node:zlib";
import { mcpSafeFetch, McpSafeFetchError, networkAddressScope, type McpSafeFetchOptions } from "../mcp/safeFetch";

/**
 * The page transport of `fetch_url`: GET only, over the pinned SSRF-safe
 * transport (`mcpSafeFetch`: DNS pinned per hop, every resolved address
 * checked). Only public addresses are reachable, with no administrator
 * exception; ports 80 and 443 only; no userinfo, cookies or auth headers; one
 * fixed user agent. Redirects are followed manually so each hop is checked
 * again. One deadline covers the whole exchange and the body is bounded while
 * it streams.
 */
export const WEB_FETCH_LIMITS = Object.freeze({
  deadlineMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5
});

export const WEB_FETCH_USER_AGENT = "AIQSA-PageReader/1.0 (+https://github.com/insciqq/AIQSA)";
const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,application/json;q=0.8,*/*;q=0.1";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

export type WebFetchFailureCode =
  | "fetch_url_invalid"
  | "fetch_url_credentials"
  | "fetch_port_not_allowed"
  | "fetch_blocked_address"
  | "fetch_redirect_invalid"
  | "fetch_redirect_limit"
  | "fetch_timeout"
  | "fetch_too_large"
  | "fetch_unsupported_content_type"
  | "fetch_http_status"
  | "fetch_network_error";

export class WebFetchError extends Error {
  readonly code: WebFetchFailureCode;
  readonly httpStatus?: number;
  /** Whether a request may have reached a server before the failure. */
  readonly dispatched: boolean;

  constructor(code: WebFetchFailureCode, options: Readonly<{ dispatched: boolean; httpStatus?: number }>) {
    super(code);
    this.name = "WebFetchError";
    this.code = code;
    this.dispatched = options.dispatched;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}

export type WebFetchResponse = Readonly<{
  body: Uint8Array;
  /** The media type and parameters as the server sent them, or null. */
  contentType: string | null;
  finalUrl: string;
  status: number;
}>;

export type WebFetchOptions = Readonly<{
  /** Refuses a response by its media type before its body is read. */
  acceptsContentType(contentType: string | null): boolean;
  signal?: AbortSignal;
  /** Test seams of the pinned transport; never a policy override. */
  dispatch?: McpSafeFetchOptions["dispatch"];
  lookupHostname?: McpSafeFetchOptions["lookupHostname"];
  /** Tighter bounds for tests; production uses `WEB_FETCH_LIMITS`. */
  limits?: Partial<Readonly<{ deadlineMs: number; maxBytes: number; maxRedirects: number }>>;
}>;

/** The request policy of one hop: http(s), no userinfo, a default web port. Null allows it. */
export function webFetchUrlRefusal(url: URL): WebFetchFailureCode | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "fetch_url_invalid";
  if (url.username || url.password) return "fetch_url_credentials";
  if (!ALLOWED_PORTS.has(url.port)) return "fetch_port_not_allowed";
  return null;
}

function transportFailure(error: McpSafeFetchError, dispatched: boolean): WebFetchError {
  switch (error.code) {
    case "mcp_http_address_forbidden":
    case "mcp_internal_address_forbidden":
    case "mcp_local_network_disabled":
      return new WebFetchError("fetch_blocked_address", { dispatched });
    case "mcp_http_url_credentials_forbidden":
      return new WebFetchError("fetch_url_credentials", { dispatched });
    case "mcp_http_invalid_request":
    case "mcp_http_protocol_forbidden":
    case "mcp_http_url_fragment_forbidden":
    case "mcp_http_https_required":
      return new WebFetchError("fetch_url_invalid", { dispatched });
    default:
      // DNS, connection, TLS and protocol failures: a request may have left
      // unless the transport proved otherwise.
      return new WebFetchError("fetch_network_error", { dispatched: dispatched || error.requestNotSent !== true });
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup of a rejected body never replaces the refusal.
  }
}

/** The raw body, refused as soon as it exceeds the bound. */
async function readBounded(response: Response, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebFetchError("fetch_too_large", { dispatched: true });
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Content codings the request offered; the decoded body has the same bound as the raw one. */
function decodeContent(raw: Uint8Array, encoding: string | null, maxBytes: number): Uint8Array {
  const coding = encoding?.trim().toLowerCase() ?? "";
  if (!coding || coding === "identity" || raw.byteLength === 0) return raw;
  const options = { maxOutputLength: maxBytes };
  try {
    if (coding === "gzip" || coding === "x-gzip") return unzipSync(raw, options);
    if (coding === "br") return brotliDecompressSync(raw, options);
    if (coding === "deflate") {
      try {
        return unzipSync(raw, options);
      } catch (error) {
        if (error instanceof RangeError) throw error;
        return inflateRawSync(raw, options);
      }
    }
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new WebFetchError("fetch_too_large", { dispatched: true });
    }
    throw new WebFetchError("fetch_network_error", { dispatched: true });
  }
  throw new WebFetchError("fetch_unsupported_content_type", { dispatched: true });
}

/**
 * Fetches one page. Throws `WebFetchError` for every refusal and failure, or
 * the caller's abort reason when its signal ended the exchange.
 */
export async function fetchWebPage(url: string, options: WebFetchOptions): Promise<WebFetchResponse> {
  const limits = { ...WEB_FETCH_LIMITS, ...options.limits };
  const deadline = new AbortController();
  // A native TimeoutError keeps transport observability classifying it as a deadline.
  const timer = setTimeout(() => deadline.abort(new DOMException("Page fetch deadline exceeded", "TimeoutError")),
    limits.deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let dispatched = false;
  let response: Response | undefined;
  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new WebFetchError("fetch_url_invalid", { dispatched: false });
    }
    for (let redirects = 0; ; redirects += 1) {
      current.hash = "";
      const refusal = webFetchUrlRefusal(current);
      if (refusal) throw new WebFetchError(refusal, { dispatched });
      try {
        response = await mcpSafeFetch(current.href, {
          headers: { accept: ACCEPT, "accept-encoding": "gzip, deflate, br", "user-agent": WEB_FETCH_USER_AGENT },
          method: "GET",
          redirect: "manual",
          signal
        }, {
          addressAllowed: (address) => networkAddressScope(address.address) === "public",
          allowInsecureHttp: true,
          ...(options.dispatch ? { dispatch: options.dispatch } : {}),
          ...(options.lookupHostname ? { lookupHostname: options.lookupHostname } : {}),
          maxRedirects: 0
        });
      } catch (error) {
        if (error instanceof McpSafeFetchError) throw transportFailure(error, dispatched);
        throw error;
      }
      dispatched = true;
      if (!REDIRECT_STATUSES.has(response.status) || !response.headers.has("location")) break;
      const location = response.headers.get("location") ?? "";
      await discard(response);
      response = undefined;
      if (redirects >= limits.maxRedirects) throw new WebFetchError("fetch_redirect_limit", { dispatched });
      try {
        current = new URL(location, current);
      } catch {
        throw new WebFetchError("fetch_redirect_invalid", { dispatched });
      }
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new WebFetchError("fetch_redirect_invalid", { dispatched });
      }
    }
    if (response.status < 200 || response.status > 299) {
      throw new WebFetchError("fetch_http_status", { dispatched, httpStatus: response.status });
    }
    const contentType = response.headers.get("content-type");
    if (!options.acceptsContentType(contentType)) {
      throw new WebFetchError("fetch_unsupported_content_type", { dispatched });
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/u.test(declared.trim()) && Number(declared.trim()) > limits.maxBytes) {
      throw new WebFetchError("fetch_too_large", { dispatched });
    }
    const raw = await readBounded(response, signal, limits.maxBytes);
    const body = decodeContent(raw, response.headers.get("content-encoding"), limits.maxBytes);
    return { body, contentType, finalUrl: current.href, status: response.status };
  } catch (error) {
    if (response) await discard(response);
    // A deadline during connection setup cannot prove that nothing was sent.
    if (deadline.signal.aborted && !(options.signal?.aborted)) throw new WebFetchError("fetch_timeout", { dispatched: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
