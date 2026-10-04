import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { networkAddressScope } from "../mcp/safeFetch";

export type PushPostRequest = Readonly<{
  body: Buffer;
  endpoint: URL;
  headers: Readonly<Record<string, string>>;
}>;

/** Posts one encrypted message; resolves with the push service status. */
export type PushPost = (request: PushPostRequest) => Promise<Readonly<{ status: number }>>;

export class PushTransportError extends Error {
  constructor(readonly code: "push_endpoint_forbidden" | "push_transport_failed") {
    super(code);
    this.name = "PushTransportError";
  }
}

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

const DEFAULT_TIMEOUT_MS = 10_000;

async function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
}

/**
 * HTTPS POST to a push service, pinned to an address that was resolved once
 * and proved public, so DNS cannot redirect the connection to a private
 * network. Redirects are not followed and the response body is discarded.
 */
export function createPinnedPushPost(options: Readonly<{
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  timeoutMs?: number;
}> = {}): PushPost {
  const resolve = options.resolve ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async ({ body, endpoint, headers }) => {
    if (endpoint.protocol !== "https:") throw new PushTransportError("push_endpoint_forbidden");
    const hostname = endpoint.hostname.startsWith("[") ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new PushTransportError("push_transport_failed");
    }
    if (addresses.length === 0 || addresses.some((entry) => networkAddressScope(entry.address) !== "public")) {
      throw new PushTransportError("push_endpoint_forbidden");
    }
    const pinned = addresses[0]!;
    const lookup: LookupFunction = (_name, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    return new Promise((resolvePost, reject) => {
      const request = httpsRequest({
        headers: { ...headers, "content-length": String(body.length) },
        host: hostname,
        lookup,
        method: "POST",
        path: `${endpoint.pathname}${endpoint.search}`,
        port: endpoint.port || 443,
        servername: isIP(hostname) ? undefined : hostname,
        timeout: timeoutMs
      }, (response) => {
        response.resume();
        response.once("end", () => resolvePost({ status: response.statusCode ?? 0 }));
        response.once("error", () => reject(new PushTransportError("push_transport_failed")));
      });
      request.once("timeout", () => request.destroy(new PushTransportError("push_transport_failed")));
      request.once("error", () => reject(new PushTransportError("push_transport_failed")));
      request.end(body);
    });
  };
}
