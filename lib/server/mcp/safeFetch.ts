import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError
} from "@/lib/server/http/requestBody";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { createTransportFailureObserver, observeMcpFetch, transportFailureFacts } from "../providers/providerObservability";

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

/** Network-policy refusals that keep their own stable code up to the user. */
export type McpNetworkPolicyRefusalCode = "mcp_internal_address_forbidden" | "mcp_local_network_disabled";

/** Why an address policy refused one resolved address; other blocked ranges keep the generic code. */
export type McpAddressDenialCode = McpNetworkPolicyRefusalCode | "mcp_http_address_forbidden";

/**
 * Decides one resolved address of one request hop: null allows it. It replaces
 * the default block list and is consulted again for every connection and
 * redirect hop, so a changed policy or DNS answer applies to the next one.
 */
export type McpAddressPolicy = (
  address: McpResolvedAddress,
  url: URL
) => McpAddressDenialCode | null | Promise<McpAddressDenialCode | null>;

export type McpSafeFetchOptions = {
  addressAllowed?: (address: McpResolvedAddress, url: URL) => boolean;
  /** Reason-returning policy; takes precedence over `addressAllowed` and `allowPrivateNetwork`. */
  addressPolicy?: McpAddressPolicy;
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
  dispatch?: (request: McpPinnedHttpRequest) => Promise<Response>;
  /**
   * Set on every hop after all other headers, so request headers can neither
   * replace nor remove them. A 421 response echoing every one of them is the
   * destination refusing this egress: the AIQSA app itself.
   */
  egressHeaders?: Readonly<Record<string, string>>;
  lookupHostname?: (hostname: string) => Promise<readonly McpResolvedAddress[]>;
  maxRedirects?: number;
  requestBodyMaxBytes?: number;
};

export type McpSafeFetchErrorCode =
  | McpNetworkPolicyRefusalCode
  | "mcp_http_address_forbidden"
  | "mcp_http_dns_failed"
  | "mcp_http_https_required"
  | "mcp_http_invalid_request"
  | "mcp_http_protocol_forbidden"
  | "mcp_http_request_body_too_large"
  | "mcp_http_redirect_forbidden"
  | "mcp_http_redirect_invalid"
  | "mcp_http_request_failed"
  | "mcp_http_tls_failed"
  | "mcp_http_too_many_redirects"
  | "mcp_http_url_credentials_forbidden"
  | "mcp_http_url_fragment_forbidden";

const NETWORK_POLICY_REFUSAL_CODES: ReadonlySet<string> = new Set<McpNetworkPolicyRefusalCode>([
  "mcp_internal_address_forbidden",
  "mcp_local_network_disabled"
]);

/** One address the request can never use outranks one only the policy switch closes. */
const ADDRESS_DENIAL_PRECEDENCE: Readonly<Record<McpAddressDenialCode, number>> = {
  mcp_http_address_forbidden: 2,
  mcp_internal_address_forbidden: 3,
  mcp_local_network_disabled: 1
};

/**
 * The network-policy refusal any MCP error carries (safe fetch, client session,
 * OAuth), or null. Read by code so an error from another bundle still counts.
 */
export function mcpNetworkPolicyRefusal(error: unknown): McpNetworkPolicyRefusalCode | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && NETWORK_POLICY_REFUSAL_CODES.has(code)
    ? code as McpNetworkPolicyRefusalCode
    : null;
}

// Type-only marker merged into the class: it declares no class field, so the
// property stays absent until the constructor proves it.
export interface McpSafeFetchError {
  /** Present only when the transport proves that no request byte left this
   * process: the pinned connection (and its TLS session) was never
   * established. Absence means the request may have reached the server. */
  readonly requestNotSent?: true;
}

export class McpSafeFetchError extends Error {
  readonly code: McpSafeFetchErrorCode;

  constructor(code: McpSafeFetchErrorCode, options?: Readonly<{ requestNotSent?: boolean }>) {
    super(code);
    this.code = code;
    this.name = "McpSafeFetchError";
    if (options?.requestNotSent === true) {
      Object.defineProperty(this, "requestNotSent", { enumerable: true, value: true });
    }
  }
}

type Ipv4Cidr = readonly [network: number, prefixLength: number];
type Ipv6Cidr = readonly [network: bigint, prefixLength: number];

/** Strict dotted-quad IPv4 as an unsigned 32-bit number, or null. */
export function parseIpv4(address: string): number | null {
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

/** IPv6 (optionally bracketed, embedded dotted IPv4 allowed) as a 128-bit value; zone ids are rejected. */
export function parseIpv6(address: string): bigint | null {
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

/**
 * Every record must pass, as with the default list. A failing or malformed
 * policy decision fails closed with the generic code; across records the
 * most definitive reason wins.
 */
async function addressPolicyDenial(
  policy: McpAddressPolicy,
  records: readonly McpResolvedAddress[],
  url: URL
): Promise<McpAddressDenialCode | null> {
  const decisions = await Promise.all(records.map(async (record): Promise<McpAddressDenialCode | null> => {
    try {
      const decision = await policy(record, url);
      if (decision === null) return null;
      return Object.hasOwn(ADDRESS_DENIAL_PRECEDENCE, decision) ? decision : "mcp_http_address_forbidden";
    } catch {
      return "mcp_http_address_forbidden";
    }
  }));
  let denial: McpAddressDenialCode | null = null;
  for (const decision of decisions) {
    if (decision && (!denial || ADDRESS_DENIAL_PRECEDENCE[decision] > ADDRESS_DENIAL_PRECEDENCE[denial])) {
      denial = decision;
    }
  }
  return denial;
}

async function resolvePinnedAddress(
  url: URL,
  options: McpSafeFetchOptions,
  signal: AbortSignal
): Promise<McpResolvedAddress> {
  const hostname = hostnameWithoutBrackets(url);
  const observeFailure = createTransportFailureObserver("mcp");
  let records: readonly McpResolvedAddress[];
  try {
    records = await awaitWithSignal(
      Promise.resolve().then(() => (options.lookupHostname ?? defaultLookupHostname)(hostname)),
      signal
    );
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    const failure = new McpSafeFetchError("mcp_http_dns_failed");
    const facts = transportFailureFacts(error);
    observeFailure({ category: "dns", code: facts.code === "unknown" ? failure.code : facts.code });
    throw failure;
  }
  if (records.length === 0 || records.some((record) =>
    (record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family
  )) {
    throw new McpSafeFetchError("mcp_http_dns_failed");
  }
  if (options.addressPolicy) {
    const denial = await awaitWithSignal(addressPolicyDenial(options.addressPolicy, records, url), signal);
    if (denial) throw new McpSafeFetchError(denial);
    return records[0];
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

/**
 * A socket `lookup` that answers with the pinned address, never synchronously.
 * Node calls `lookup` inside `request()`; a synchronous answer whose `connect()`
 * fails at once (ENETUNREACH without an IPv6 route) emits the socket error
 * before the request listens to its socket, which is an uncaught exception
 * that ends the process. A cancelled attempt gets an abort instead of a connect.
 */
export function pinnedAddressLookup(
  address: McpResolvedAddress,
  cancelled: () => boolean = () => false
): LookupFunction {
  const record = { address: address.address, family: address.family };
  return (_hostname, lookupOptions, callback) => {
    setImmediate(() => {
      if (cancelled()) {
        callback(Object.assign(new Error("The pinned connection was cancelled."), { code: "ABORT_ERR" }), "");
      } else if (lookupOptions.all) {
        callback(null, [record]);
      } else {
        callback(null, record.address, record.family);
      }
    });
  };
}

async function defaultDispatch(input: McpPinnedHttpRequest): Promise<Response> {
  const observeFailure = createTransportFailureObserver("mcp");
  if (input.signal.aborted) throw abortReason(input.signal);
  const request = input.url.protocol === "https:" ? httpsRequest : httpRequest;
  const hostname = hostnameWithoutBrackets(input.url);
  const pinnedLookup = pinnedAddressLookup(input.address, () => input.signal.aborted);

  return new Promise<Response>((resolve, reject) => {
    let headersReceived = false;
    // Node buffers the request until the socket connects, and over HTTPS it
    // writes application data only after the TLS handshake. A failure before
    // that point therefore proves that the server never received the request.
    let connectionEstablished = false;
    const rejectRequest = (cause?: unknown) => {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      const tls = typeof code === "string" && ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"].includes(code);
      const failure = input.signal.aborted
        ? abortReason(input.signal)
        : new McpSafeFetchError(tls ? "mcp_http_tls_failed" : "mcp_http_request_failed",
          { requestNotSent: !connectionEstablished && !headersReceived });
      const facts = transportFailureFacts(cause, input.signal);
      if (!headersReceived) observeFailure({ category: facts.category, code: facts.code === "unknown"
        ? tls ? "mcp_http_tls_failed" : "mcp_http_request_failed" : facts.code, timeout_ms: facts.timeout_ms });
      reject(failure);
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
          const response = new Response(body, {
            headers: responseHeaders(incoming.rawHeaders),
            status,
            statusText: incoming.statusMessage
          });
          headersReceived = true;
          resolve(response);
        } catch {
          incoming.destroy();
          rejectRequest();
        }
      });
      outgoing.once("socket", (socket) => {
        const connected = input.url.protocol === "https:" ? "secureConnect" : "connect";
        if (socket.connecting) socket.once(connected, () => { connectionEstablished = true; });
        // A socket handed over already connected may carry the request at once.
        else connectionEstablished = true;
      });
      outgoing.once("error", rejectRequest);
      outgoing.end(input.body ?? undefined);
    } catch {
      rejectRequest();
    }
  });
}

function withEgressHeaders(headers: Headers, egressHeaders: McpSafeFetchOptions["egressHeaders"]): Headers {
  if (!egressHeaders) return headers;
  const marked = new Headers(headers);
  for (const [name, value] of Object.entries(egressHeaders)) marked.set(name, value);
  return marked;
}

function isEgressRefusal(response: Response, egressHeaders: McpSafeFetchOptions["egressHeaders"]): boolean {
  if (!egressHeaders || response.status !== 421) return false;
  const entries = Object.entries(egressHeaders);
  return entries.length > 0 && entries.every(([name, value]) => response.headers.get(name) === value);
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
  const value = options.requestBodyMaxBytes ?? getMcpRequestMaxBytes();
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
  return observeMcpFetch(() => mcpSafeFetchUnobserved(input, init, options),
    init?.signal ?? (input instanceof Request ? input.signal : undefined));
}

async function mcpSafeFetchUnobserved(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: McpSafeFetchOptions
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
    const pinnedRequest = { ...current, address, headers: withEgressHeaders(current.headers, options.egressHeaders) };
    let response: Response;
    try {
      response = await (options.dispatch ?? defaultDispatch)(pinnedRequest);
    } catch (error) {
      // An earlier hop already reached a server, so a later unsent hop does
      // not prove that the logical request was never delivered.
      if (redirectCount > 0 && error instanceof McpSafeFetchError && error.requestNotSent) {
        throw new McpSafeFetchError(error.code);
      }
      throw error;
    }
    if (isEgressRefusal(response, options.egressHeaders)) {
      await discardResponse(response);
      throw new McpSafeFetchError("mcp_internal_address_forbidden");
    }
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
