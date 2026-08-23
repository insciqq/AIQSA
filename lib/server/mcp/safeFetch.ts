import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError
} from "@/lib/server/http/requestBody";
import { MCP_JSON_RPC_REQUEST_MAX_BYTES } from "./responseLimits";

const DEFAULT_MAX_REDIRECTS = 3;
const MAX_CONFIGURED_REDIRECTS = 10;
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type"
]);

export type McpResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type McpPinnedHttpRequest = {
  address: McpResolvedAddress;
  body: Uint8Array | null;
  headers: Headers;
  method: string;
  signal: AbortSignal;
  url: URL;
};

export type McpSafeFetchOptions = {
  addressAllowed?: (address: McpResolvedAddress, url: URL) => boolean;
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
  dispatch?: (request: McpPinnedHttpRequest) => Promise<Response>;
  lookupHostname?: (hostname: string) => Promise<readonly McpResolvedAddress[]>;
  maxRedirects?: number;
  requestBodyMaxBytes?: number;
};

export type McpSafeFetchErrorCode =
  | "mcp_http_address_forbidden"
  | "mcp_http_dns_failed"
  | "mcp_http_https_required"
  | "mcp_http_invalid_request"
  | "mcp_http_protocol_forbidden"
  | "mcp_http_request_body_too_large"
  | "mcp_http_redirect_forbidden"
  | "mcp_http_redirect_invalid"
  | "mcp_http_request_failed"
  | "mcp_http_too_many_redirects"
  | "mcp_http_url_credentials_forbidden"
  | "mcp_http_url_fragment_forbidden";

export class McpSafeFetchError extends Error {
  readonly code: McpSafeFetchErrorCode;

  constructor(code: McpSafeFetchErrorCode) {
    super(code);
    this.code = code;
    this.name = "McpSafeFetchError";
  }
}

type Ipv4Cidr = readonly [network: number, prefixLength: number];
type Ipv6Cidr = readonly [network: bigint, prefixLength: number];

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function parseIpv6(address: string): bigint | null {
  let normalized = address.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (!normalized || normalized.includes("%")) return null;

  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = parseIpv4(normalized.slice(separator + 1));
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, separator)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;

  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv4Cidr(network: string, prefixLength: number): Ipv4Cidr {
  const parsed = parseIpv4(network);
  if (parsed === null) throw new Error("Invalid built-in IPv4 CIDR.");
  return [parsed, prefixLength];
}

function ipv6Cidr(network: string, prefixLength: number): Ipv6Cidr {
  const parsed = parseIpv6(network);
  if (parsed === null) throw new Error("Invalid built-in IPv6 CIDR.");
  return [parsed, prefixLength];
}

const BLOCKED_IPV4_CIDRS: readonly Ipv4Cidr[] = [
  ipv4Cidr("0.0.0.0", 8),
  ipv4Cidr("10.0.0.0", 8),
  ipv4Cidr("100.64.0.0", 10),
  ipv4Cidr("127.0.0.0", 8),
  ipv4Cidr("169.254.0.0", 16),
  ipv4Cidr("172.16.0.0", 12),
  ipv4Cidr("192.0.0.0", 24),
  ipv4Cidr("192.0.2.0", 24),
  ipv4Cidr("192.31.196.0", 24),
  ipv4Cidr("192.52.193.0", 24),
  ipv4Cidr("192.88.99.0", 24),
  ipv4Cidr("192.168.0.0", 16),
  ipv4Cidr("192.175.48.0", 24),
  ipv4Cidr("198.18.0.0", 15),
  ipv4Cidr("198.51.100.0", 24),
  ipv4Cidr("203.0.113.0", 24),
  ipv4Cidr("224.0.0.0", 4),
  ipv4Cidr("240.0.0.0", 4)
];

const BLOCKED_IPV6_CIDRS: readonly Ipv6Cidr[] = [
  ipv6Cidr("::", 96),
  ipv6Cidr("::ffff:0:0", 96),
  ipv6Cidr("64:ff9b::", 96),
  ipv6Cidr("64:ff9b:1::", 48),
  ipv6Cidr("100::", 64),
  ipv6Cidr("2001::", 23),
  ipv6Cidr("2001:db8::", 32),
  ipv6Cidr("2002::", 16),
  ipv6Cidr("2620:4f:8000::", 48),
  ipv6Cidr("3fff::", 20),
  ipv6Cidr("5f00::", 16),
  ipv6Cidr("fc00::", 7),
  ipv6Cidr("fe80::", 10),
  ipv6Cidr("fec0::", 10),
  ipv6Cidr("ff00::", 8)
];

const PRIVATE_IPV4_CIDRS: readonly Ipv4Cidr[] = [
  ipv4Cidr("10.0.0.0", 8),
  ipv4Cidr("172.16.0.0", 12),
  ipv4Cidr("192.168.0.0", 16)
];
const LOOPBACK_IPV4_CIDR = ipv4Cidr("127.0.0.0", 8);
const PRIVATE_IPV6_CIDR = ipv6Cidr("fc00::", 7);
const IPV4_MAPPED_IPV6_CIDR = ipv6Cidr("::ffff:0:0", 96);

function inIpv4Cidr(address: number, [network, prefixLength]: Ipv4Cidr): boolean {
  const divisor = 2 ** (32 - prefixLength);
  return Math.floor(address / divisor) === Math.floor(network / divisor);
}

function inIpv6Cidr(address: bigint, [network, prefixLength]: Ipv6Cidr): boolean {
  const shift = BigInt(128 - prefixLength);
  return (address >> shift) === (network >> shift);
}

export type NetworkAddressScope = "forbidden" | "loopback" | "private" | "public";

function ipv4AddressScope(address: number): NetworkAddressScope {
  if (inIpv4Cidr(address, LOOPBACK_IPV4_CIDR)) {
    return "loopback";
  }
  if (PRIVATE_IPV4_CIDRS.some((cidr) => inIpv4Cidr(address, cidr))) {
    return "private";
  }
  return BLOCKED_IPV4_CIDRS.some((cidr) => inIpv4Cidr(address, cidr))
    ? "forbidden"
    : "public";
}

export function networkAddressScope(address: string): NetworkAddressScope {
  const family = isIP(address);
  if (family === 4) {
    const parsed = parseIpv4(address);
    return parsed === null ? "forbidden" : ipv4AddressScope(parsed);
  }
  if (family === 6) {
    const parsed = parseIpv6(address);
    if (parsed === null) {
      return "forbidden";
    }
    if (parsed === 1n) {
      return "loopback";
    }
    if (inIpv6Cidr(parsed, IPV4_MAPPED_IPV6_CIDR)) {
      return ipv4AddressScope(Number(parsed & 0xffff_ffffn));
    }
    if (inIpv6Cidr(parsed, PRIVATE_IPV6_CIDR)) {
      return "private";
    }
    return BLOCKED_IPV6_CIDRS.some((cidr) => inIpv6Cidr(parsed, cidr))
      ? "forbidden"
      : "public";
  }

  return "forbidden";
}

export function isBlockedMcpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parsed = parseIpv4(address);
    return parsed === null || BLOCKED_IPV4_CIDRS.some((cidr) => inIpv4Cidr(parsed, cidr));
  }
  if (family === 6) {
    const parsed = parseIpv6(address);
    return parsed === null || BLOCKED_IPV6_CIDRS.some((cidr) => inIpv6Cidr(parsed, cidr));
  }
  return true;
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function validateUrl(url: URL, options: McpSafeFetchOptions): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpSafeFetchError("mcp_http_protocol_forbidden");
  }
  if (url.protocol === "http:" && !options.allowInsecureHttp) {
    throw new McpSafeFetchError("mcp_http_https_required");
  }
  if (url.username || url.password) {
    throw new McpSafeFetchError("mcp_http_url_credentials_forbidden");
  }
  if (url.href.includes("#")) {
    throw new McpSafeFetchError("mcp_http_url_fragment_forbidden");
  }
}

async function defaultLookupHostname(hostname: string): Promise<readonly McpResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4
  }));
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function resolvePinnedAddress(
  url: URL,
  options: McpSafeFetchOptions,
  signal: AbortSignal
): Promise<McpResolvedAddress> {
  const hostname = hostnameWithoutBrackets(url);
  let records: readonly McpResolvedAddress[];
  try {
    records = await awaitWithSignal(
      Promise.resolve().then(() => (options.lookupHostname ?? defaultLookupHostname)(hostname)),
      signal
    );
  } catch {
    if (signal.aborted) throw abortReason(signal);
    throw new McpSafeFetchError("mcp_http_dns_failed");
  }
  if (records.length === 0 || records.some((record) =>
    (record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family
  )) {
    throw new McpSafeFetchError("mcp_http_dns_failed");
  }
  const addressPolicy = options.addressAllowed;
  const addressForbidden = addressPolicy
    ? records.some((record) => {
        try {
          return !addressPolicy(record, url);
        } catch {
          return true;
        }
      })
    : !options.allowPrivateNetwork &&
      records.some((record) => isBlockedMcpAddress(record.address));
  if (addressForbidden) {
    throw new McpSafeFetchError("mcp_http_address_forbidden");
  }
  return records[0];
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function nodeHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers) output[name] = value;
  return output;
}

function responseHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name && typeof value === "string") headers.append(name, value);
  }
  return headers;
}

async function defaultDispatch(input: McpPinnedHttpRequest): Promise<Response> {
  if (input.signal.aborted) throw abortReason(input.signal);
  const request = input.url.protocol === "https:" ? httpsRequest : httpRequest;
  const hostname = hostnameWithoutBrackets(input.url);
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const record = { address: input.address.address, family: input.address.family };
    if (lookupOptions.all) {
      callback(null, [record]);
    } else {
      callback(null, record.address, record.family);
    }
  };

  return new Promise<Response>((resolve, reject) => {
    const rejectRequest = () => {
      reject(input.signal.aborted
        ? abortReason(input.signal)
        : new McpSafeFetchError("mcp_http_request_failed"));
    };
    try {
      const outgoing = request({
        agent: false,
        headers: nodeHeaders(input.headers),
        hostname,
        lookup: pinnedLookup,
        method: input.method,
        path: `${input.url.pathname}${input.url.search}`,
        port: input.url.port || undefined,
        protocol: input.url.protocol,
        signal: input.signal
      }, (incoming) => {
        const status = incoming.statusCode;
        if (!status || status < 200 || status > 599) {
          incoming.destroy();
          rejectRequest();
          return;
        }
        try {
          const bodyAllowed = input.method !== "HEAD" && ![204, 205, 304].includes(status);
          const body = bodyAllowed
            ? Readable.toWeb(incoming) as ReadableStream<Uint8Array>
            : null;
          if (!bodyAllowed) incoming.resume();
          resolve(new Response(body, {
            headers: responseHeaders(incoming.rawHeaders),
            status,
            statusText: incoming.statusMessage
          }));
        } catch {
          incoming.destroy();
          rejectRequest();
        }
      });
      outgoing.once("error", rejectRequest);
      outgoing.end(input.body ?? undefined);
    } catch {
      rejectRequest();
    }
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The next hop is independent from cleanup of the rejected redirect body.
  }
}

function redirectRequest(input: McpPinnedHttpRequest, response: Response, nextUrl: URL): Omit<McpPinnedHttpRequest, "address"> {
  const headers = new Headers(input.headers);
  let method = input.method;
  let body = input.body;
  if ((response.status === 301 || response.status === 302) && method === "POST" ||
    response.status === 303 && method !== "GET" && method !== "HEAD") {
    method = "GET";
    body = null;
    headers.delete("content-encoding");
    headers.delete("content-language");
    headers.delete("content-length");
    headers.delete("content-location");
    headers.delete("content-type");
  }
  if (input.url.origin !== nextUrl.origin) {
    for (const name of Array.from(headers.keys())) {
      if (!CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLowerCase())) headers.delete(name);
    }
  }
  return { body, headers, method, signal: input.signal, url: nextUrl };
}

function configuredMaxRedirects(options: McpSafeFetchOptions): number {
  const value = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_CONFIGURED_REDIRECTS) {
    throw new McpSafeFetchError("mcp_http_invalid_request");
  }
  return value;
}

function configuredRequestBodyMaxBytes(options: McpSafeFetchOptions): number {
  const value = options.requestBodyMaxBytes ?? MCP_JSON_RPC_REQUEST_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpSafeFetchError("mcp_http_invalid_request");
  }
  return value;
}

function attachFinalResponseMetadata(response: Response, url: URL, redirected: boolean): Response {
  for (const [property, value] of [
    ["redirected", redirected],
    ["url", url.toString()]
  ] as const) {
    try {
      Object.defineProperty(response, property, {
        configurable: true,
        enumerable: false,
        value
      });
    } catch {
      // The response remains usable on runtimes that do not permit shadowing
      // optional fetch metadata.
    }
  }
  return response;
}

export async function mcpSafeFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined = undefined,
  options: McpSafeFetchOptions = {}
): Promise<Response> {
  const maxRedirects = configuredMaxRedirects(options);
  const requestBodyMaxBytes = configuredRequestBodyMaxBytes(options);
  try {
    const inputUrl = new URL(input instanceof Request ? input.url : input.toString());
    validateUrl(inputUrl, options);
  } catch (error) {
    if (error instanceof McpSafeFetchError) throw error;
    throw new McpSafeFetchError("mcp_http_invalid_request");
  }
  let sourceRequest: Request;
  try {
    sourceRequest = new Request(input, init);
  } catch {
    throw new McpSafeFetchError("mcp_http_invalid_request");
  }
  if (sourceRequest.signal.aborted) throw abortReason(sourceRequest.signal);

  let body: Uint8Array | null = null;
  try {
    if (sourceRequest.body) {
      body = await readBoundedRequestBody(sourceRequest, {
        maxBytes: requestBodyMaxBytes
      });
    }
  } catch (error) {
    if (sourceRequest.signal.aborted) throw abortReason(sourceRequest.signal);
    if (error instanceof RequestBodyTooLargeError) {
      throw new McpSafeFetchError("mcp_http_request_body_too_large");
    }
    throw new McpSafeFetchError("mcp_http_invalid_request");
  }

  let current: Omit<McpPinnedHttpRequest, "address"> = {
    body,
    headers: new Headers(sourceRequest.headers),
    method: sourceRequest.method,
    signal: sourceRequest.signal,
    url: new URL(sourceRequest.url)
  };
  let redirectCount = 0;

  while (true) {
    if (current.signal.aborted) throw abortReason(current.signal);
    validateUrl(current.url, options);
    const address = await resolvePinnedAddress(current.url, options, current.signal);
    const pinnedRequest = { ...current, address };
    const response = await (options.dispatch ?? defaultDispatch)(pinnedRequest);
    if (!isRedirectStatus(response.status) || !response.headers.has("location")) {
      return attachFinalResponseMetadata(response, current.url, redirectCount > 0);
    }
    if (sourceRequest.redirect === "manual") {
      return attachFinalResponseMetadata(response, current.url, redirectCount > 0);
    }
    if (sourceRequest.redirect === "error") {
      await discardResponse(response);
      throw new McpSafeFetchError("mcp_http_redirect_forbidden");
    }
    if (redirectCount >= maxRedirects) {
      await discardResponse(response);
      throw new McpSafeFetchError("mcp_http_too_many_redirects");
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(response.headers.get("location") ?? "", current.url);
    } catch {
      await discardResponse(response);
      throw new McpSafeFetchError("mcp_http_redirect_invalid");
    }
    await discardResponse(response);
    current = redirectRequest(pinnedRequest, response, nextUrl);
    redirectCount += 1;
  }
}

export function createMcpSafeFetch(options: McpSafeFetchOptions = {}): typeof fetch {
  return (input, init) => mcpSafeFetch(input, init, options);
}
