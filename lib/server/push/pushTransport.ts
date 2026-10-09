import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { PushTransportFailureCategory } from "../observability/events";
import { networkAddressScope } from "../mcp/safeFetch";

export type PushPostRequest = Readonly<{
  body: Buffer;
  endpoint: URL;
  headers: Readonly<Record<string, string>>;
}>;

/** Posts one encrypted message; resolves with the push service status. */
export type PushPost = (request: PushPostRequest) => Promise<Readonly<{ status: number }>>;

export class PushTransportError extends Error {
  readonly category: PushTransportFailureCategory | undefined;

  constructor(readonly code: "push_endpoint_forbidden" | "push_transport_failed", category: PushTransportFailureCategory = "unknown") {
    super(code);
    this.name = "PushTransportError";
    this.category = code === "push_transport_failed" ? category : undefined;
  }
}

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

const DEFAULT_TIMEOUT_MS = 10_000;

function failureCategory(error: unknown): PushTransportFailureCategory {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code !== "string") return "unknown";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) return "dns";
  if (["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN"].includes(code)) return "network_unreachable";
  if (["ECONNREFUSED", "EADDRNOTAVAIL"].includes(code)) return "connect";
  if (code === "ETIMEDOUT") return "timeout";
  if (["ECONNRESET", "ECONNABORTED", "EPIPE"].includes(code)) return "reset";
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || [
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
  ].includes(code)) return "tls";
  return "unknown";
}

async function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
}

/**
 * HTTPS POST pinned to addresses resolved once and all proved public.
 * Only TCP connection failures can try the next address, before writing any
 * request bytes. DNS, connection attempts, TLS and response share one deadline.
 */
export function createPinnedPushPost(options: Readonly<{
  request?: (options: RequestOptions, response: (incoming: IncomingMessage) => void) => ClientRequest;
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  timeoutMs?: number;
}> = {}): PushPost {
  const resolve = options.resolve ?? defaultResolve;
  const request = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async ({ body, endpoint, headers }) => {
    if (endpoint.protocol !== "https:") throw new PushTransportError("push_endpoint_forbidden");
    const hostname = endpoint.hostname.startsWith("[") ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
    return new Promise((resolvePost, reject) => {
      const deadline = performance.now() + timeoutMs;
      let finished = false;
      let cancelAttempt = () => {};
      const timer = setTimeout(() => finish(new PushTransportError("push_transport_failed", "timeout")), timeoutMs);
      function finish(error?: PushTransportError, status = 0): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelAttempt();
        if (error) reject(error);
        else resolvePost({ status });
      }

      function attempt(addresses: readonly ResolvedAddress[], index: number): void {
        if (finished) return;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return finish(new PushTransportError("push_transport_failed", "timeout"));
        const pinned = addresses[index]!;
        const lookup: LookupFunction = (_name, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        };
        let phase: "connect" | "tls" | "sending" = "connect";
        let ended = false;
        let outgoing: ClientRequest | undefined;
        // Leave time for other addresses when a TCP connection silently stalls.
        const connectTimer = setTimeout(() => fail("timeout"), Math.max(1, remaining / (addresses.length - index)));
        cancelAttempt = () => {
          if (ended) return;
          ended = true;
          clearTimeout(connectTimer);
          outgoing?.destroy();
        };
        function fail(category: PushTransportFailureCategory): void {
          if (ended || finished) return;
          cancelAttempt();
          if (phase === "connect" && ["connect", "network_unreachable", "timeout", "reset"].includes(category) && index + 1 < addresses.length) {
            attempt(addresses, index + 1);
          } else {
            finish(new PushTransportError("push_transport_failed", category));
          }
        }
        try {
          outgoing = request({
            agent: false,
            headers: { ...headers, "content-length": String(body.length) },
            host: hostname,
            lookup,
            method: "POST",
            path: `${endpoint.pathname}${endpoint.search}`,
            port: endpoint.port || 443,
            servername: isIP(hostname) ? undefined : hostname
          }, (response) => {
            if (ended || finished) { response.destroy(); return; }
            response.once("end", () => { if (!ended) finish(undefined, response.statusCode ?? 0); });
            response.once("error", (error) => fail(failureCategory(error)));
            response.once("aborted", () => fail("reset"));
            response.resume();
          });
          outgoing.once("error", (error) => fail(failureCategory(error)));
          outgoing.once("socket", (socket) => {
            if (ended || finished) { socket.destroy(); return; }
            socket.once("connect", () => {
              phase = "tls";
              clearTimeout(connectTimer);
            });
            socket.once("secureConnect", () => {
              if (ended || finished) return;
              clearTimeout(connectTimer);
              // Mark before end(): even a synchronous write failure cannot retry.
              phase = "sending";
              try { outgoing!.end(body); } catch (error) { fail(failureCategory(error)); }
            });
          });
        } catch (error) {
          fail(failureCategory(error));
        }
      }

      Promise.resolve().then(() => resolve(hostname)).then((addresses) => {
        if (finished) return;
        if (addresses.length === 0 || addresses.some((entry) =>
          isIP(entry.address) !== entry.family || networkAddressScope(entry.address) !== "public"
        )) {
          finish(new PushTransportError("push_endpoint_forbidden"));
          return;
        }
        attempt(addresses, 0);
      }, () => finish(new PushTransportError("push_transport_failed", "dns")));
    });
  };
}
