import { isIP } from "node:net";
import { isProxyPort, PROXY_LIMITS, type ProxyAddressFailureCode } from "@/lib/contracts/proxies";
import { normalizeProxySiteHost } from "@/lib/domain/proxySelection";
import {
  buildPersonalMcpNetworkEnvironment,
  classifyPersonalMcpAddress,
  defaultPersonalMcpNetworkHost,
  degradedPersonalMcpNetworkEnvironment,
  type PersonalMcpNetworkEnvironment
} from "../mcp/personalNetworkPolicy";
import { networkAddressScope, type McpResolvedAddress } from "../mcp/safeFetch";

/**
 * The address rule of a proxy's own endpoint, shared by the store and
 * `fetch_url`: a proxy must not become a path into the installation's network.
 * A second list would drift, so it is the page transport's public-only scope
 * (`lib/server/webFetch/transport.ts`) together with the personal MCP policy's
 * knowledge of the installation with its local-network switch held off. Unlike
 * personal MCP there is no switch and no owner exception: an administrator's
 * proxy obeys it too.
 *
 * The check holds for one connection: connect to `pinned` and to nothing else,
 * and check again before the next connection, so a changed DNS answer is seen.
 */

const LOOKUP_TIMEOUT_MS = 5_000;
const ENVIRONMENT_TTL_MS = 60_000;
const DEGRADED_ENVIRONMENT_TTL_MS = 5_000;
/** Hides nothing: only for the URL the classifier reads its name and port from. */
const CHECK_SCHEME = "http:";
/** Characters a host field never has, each of which a URL parser would read as something else. */
const NOT_HOST_SYNTAX = /[\s/\\?#@%]/u;

export type ProxyAddressOptions = Readonly<{
  /** Test seams; never a policy override. */
  environment?: () => Promise<PersonalMcpNetworkEnvironment>;
  lookupHostname?: (hostname: string) => Promise<readonly McpResolvedAddress[]>;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type ProxyAddressCheck = Readonly<
  | { host: string; ok: true; pinned: McpResolvedAddress; port: number }
  | { code: ProxyAddressFailureCode; ok: false }
>;

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function withoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * The canonical form of a host field, or null when it is none. A URL parser
 * reads it, so `2130706433`, `0x7f.1`, `127.1`, `0177.0.0.1` and full-width
 * digits all become the IPv4 address they mean and cannot slip past a check or
 * reach another parser as something else. The store saves this form.
 */
export function canonicalProxyHost(value: unknown): string | null {
  if (typeof value !== "string" || value.length > PROXY_LIMITS.hostMaxLength * 4) return null;
  const text = value.trim();
  if (!text || NOT_HOST_SYNTAX.test(text)) return null;
  const literal = isIP(text) === 6 ? `[${text}]` : text;
  if (literal.includes(":") && !(literal.startsWith("[") && literal.endsWith("]"))) return null;
  let parsed: URL;
  try {
    parsed = new URL(`${CHECK_SCHEME}//${literal}/`);
  } catch {
    return null;
  }
  const hostname = withoutBrackets(parsed.hostname);
  if (isIP(hostname) !== 0) return hostname;
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (isLocalhostName(name)) return name;
  return normalizeProxySiteHost(name);
}

function urlOf(host: string, port: number): URL {
  return new URL(`${CHECK_SCHEME}//${isIP(host) === 6 ? `[${host}]` : host}:${port}/`);
}

/**
 * The installation's own ports. The personal policy allows a service's public
 * name or the host itself on other ports, because a personal MCP server may
 * live there; a proxy may not, so an address counts as the installation's when
 * the policy denies it on any of them. The policy's keys end in `|<port>`.
 */
function installationPorts(environment: PersonalMcpNetworkEnvironment, port: number): readonly number[] {
  const keyed = [...environment.internalAddressPorts, ...environment.internalHostnamePorts].flatMap((key) => {
    const keyedPort = Number(key.slice(key.lastIndexOf("|") + 1));
    return isProxyPort(keyedPort) ? [keyedPort] : [];
  });
  return [...new Set([port, ...environment.reservedPorts, ...keyed])];
}

function addressRefused(address: string, host: string, port: number, environment: PersonalMcpNetworkEnvironment): boolean {
  if (networkAddressScope(address) !== "public") return true;
  return installationPorts(environment, port).some((candidate) =>
    classifyPersonalMcpAddress({ address, environment, localNetworkEnabled: false, url: urlOf(host, candidate) }) !== null);
}

let cachedEnvironment: { expiresAt: number; value: Promise<PersonalMcpNetworkEnvironment> } | null = null;

function defaultEnvironment(): Promise<PersonalMcpNetworkEnvironment> {
  const now = Date.now();
  if (cachedEnvironment && cachedEnvironment.expiresAt > now) return cachedEnvironment.value;
  const building: Promise<PersonalMcpNetworkEnvironment> = buildPersonalMcpNetworkEnvironment(defaultPersonalMcpNetworkHost())
    .catch(() => degradedPersonalMcpNetworkEnvironment())
    .then((environment) => {
      if (environment.degraded && cachedEnvironment?.value === building) {
        cachedEnvironment.expiresAt = Math.min(cachedEnvironment.expiresAt, Date.now() + DEGRADED_ENVIRONMENT_TTL_MS);
      }
      return environment;
    });
  cachedEnvironment = { expiresAt: now + ENVIRONMENT_TTL_MS, value: building };
  return building;
}

/** Bounded, cancellable DNS. A cancelled caller keeps its own reason; anything else is a failed lookup. */
async function lookup(
  hostname: string,
  options: ProxyAddressOptions
): Promise<readonly McpResolvedAddress[]> {
  const lookupHostname = options.lookupHostname ?? defaultPersonalMcpNetworkHost().lookupHostname;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => lookupHostname(hostname))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Checks one proxy endpoint and pins the address to connect to. Every answer
 * must pass, so a name with one public and one private address is refused. Only
 * the caller's own cancellation throws.
 */
export async function checkProxyAddress(
  target: Readonly<{ host: unknown; port: unknown }>,
  options: ProxyAddressOptions = {}
): Promise<ProxyAddressCheck> {
  if (!isProxyPort(target.port)) return { code: "proxy_port_invalid", ok: false };
  const host = canonicalProxyHost(target.host);
  if (host === null) return { code: "proxy_host_invalid", ok: false };
  if (isLocalhostName(host)) return { code: "proxy_address_forbidden", ok: false };
  const port = target.port;

  const family = isIP(host);
  let records: readonly McpResolvedAddress[];
  if (family === 4 || family === 6) {
    records = [{ address: host, family }];
  } else {
    try {
      records = await lookup(host, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { code: "proxy_dns_failed", ok: false };
    }
    if (records.length === 0 || records.some((record) =>
      (record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family)) {
      return { code: "proxy_dns_failed", ok: false };
    }
  }

  if (records.some((record) => networkAddressScope(record.address) !== "public")) {
    return { code: "proxy_address_forbidden", ok: false };
  }
  const environment = await (options.environment ?? defaultEnvironment)();
  if (records.some((record) => addressRefused(record.address, host, port, environment))) {
    return { code: "proxy_address_forbidden", ok: false };
  }
  // Without every installation fact a public address might still be its own.
  if (environment.degraded) return { code: "proxy_address_check_unavailable", ok: false };
  return { host, ok: true, pinned: { address: records[0]!.address, family: records[0]!.family }, port };
}

/**
 * A target that goes through a proxy is resolved by the proxy, so only a target
 * that names its address can be refused here: never send a private one, or a
 * local name, to a proxy. Hostnames are the proxy's to resolve.
 */
export function isRefusedProxyTarget(url: URL): boolean {
  const hostname = withoutBrackets(url.hostname);
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (isLocalhostName(name)) return true;
  return isIP(name) !== 0 && networkAddressScope(name) !== "public";
}
