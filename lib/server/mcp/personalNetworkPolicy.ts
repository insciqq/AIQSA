import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import {
  networkAddressScope,
  parseIpv4,
  parseIpv6,
  type McpAddressDenialCode,
  type McpAddressPolicy,
  type McpResolvedAddress,
  type McpSafeFetchOptions
} from "./safeFetch";

/**
 * Personal MCP network policy. A personal connection may reach the local
 * network (private ranges and CGNAT) while the administrator allows it.
 * AIQSA's own services, the app container, AIQSA's ports on the host and
 * cloud metadata stay unreachable either way. Decisions are made per
 * connection from the resolved address, never from stored state.
 */

const INTERNAL = "mcp_internal_address_forbidden" as const;
const DISABLED = "mcp_local_network_disabled" as const;
const FORBIDDEN = "mcp_http_address_forbidden" as const;

/** How long one administrator setting read serves connections; the admin PATCH drops it at once. */
export const PERSONAL_MCP_POLICY_TTL_MS = 5_000;
const ENVIRONMENT_TTL_MS = 60_000;
const ENDPOINT_LOOKUP_TIMEOUT_MS = 2_000;

/** Overrides container detection with `container` or `host`; any other value fails closed to `container`. */
export const PERSONAL_MCP_NETWORK_MODE_ENV = "AIQSA_PERSONAL_MCP_NETWORK_MODE";

export type PersonalMcpNetworkMode = "container" | "host";

type Address = Readonly<{ family: 4; value: number }> | Readonly<{ family: 6; value: bigint }>;

export type PersonalMcpSubnet =
  | Readonly<{ family: 4; network: number; prefix: number }>
  | Readonly<{ family: 6; network: bigint; prefix: number }>;

export type PersonalMcpNetworkInterface = Readonly<{
  address: string;
  /** `address/prefix`, as `os.networkInterfaces()` reports it. */
  cidr: string | null;
  internal: boolean;
  name: string;
}>;

/** The installation facts one policy decides with; built once and cached with it. */
export type PersonalMcpNetworkEnvironment = Readonly<{
  /** The facts could not be read: local network access is treated as off. */
  degraded: boolean;
  /** Denied whole: the app container's own networks, or the host's Docker bridges. */
  deniedSubnets: readonly PersonalMcpSubnet[];
  /** Configured AIQSA endpoints by resolved address and effective port. */
  internalAddressPorts: ReadonlySet<string>;
  /** Configured AIQSA endpoint hostnames denied on their own port only. */
  internalHostnamePorts: ReadonlySet<string>;
  /** Configured AIQSA endpoint hostnames denied on every port. */
  internalHostnames: ReadonlySet<string>;
  mode: PersonalMcpNetworkMode;
  /** AIQSA's ports, denied on the shared hosts. */
  reservedPorts: ReadonlySet<number>;
  /** The host itself (host gateway in a container, its own addresses on a host install): only AIQSA's ports are denied. */
  sharedHosts: ReadonlySet<string>;
}>;

/** Where the environment comes from; injectable for tests. */
export type PersonalMcpNetworkHost = Readonly<{
  detectContainer(): boolean;
  env: Readonly<Record<string, string | undefined>>;
  interfaces(): readonly PersonalMcpNetworkInterface[];
  lookupHostname(hostname: string): Promise<readonly McpResolvedAddress[]>;
  lookupTimeoutMs?: number;
}>;

function v4(address: string): Address {
  const value = parseIpv4(address);
  if (value === null) throw new Error("Invalid built-in IPv4 address.");
  return { family: 4, value };
}

function v6(address: string): Address {
  const value = parseIpv6(address);
  if (value === null) throw new Error("Invalid built-in IPv6 address.");
  return { family: 6, value };
}

function subnetOf(address: Address, prefix: number): PersonalMcpSubnet {
  return address.family === 4
    ? { family: 4, network: address.value, prefix }
    : { family: 6, network: address.value, prefix };
}

const THIS_NETWORK = subnetOf(v4("0.0.0.0"), 8);
const LOOPBACK_V4 = subnetOf(v4("127.0.0.0"), 8);
const LINK_LOCAL_V4 = subnetOf(v4("169.254.0.0"), 16);
const CGNAT = subnetOf(v4("100.64.0.0"), 10);
const LINK_LOCAL_V6 = subnetOf(v6("fe80::"), 10);
const GLOBAL_UNICAST_V6 = subnetOf(v6("2000::"), 3);
const NAT64_WELL_KNOWN = subnetOf(v6("64:ff9b::"), 96);
const NAT64_LOCAL_USE = subnetOf(v6("64:ff9b:1::"), 48);
const SIX_TO_FOUR = subnetOf(v6("2002::"), 16);
const IPV4_COMPATIBLE = subnetOf(v6("::"), 96);

/** Cloud metadata inside ranges the policy otherwise allows: Alibaba (CGNAT); AWS IMDS and DNS, Oracle and Google (ULA). */
const METADATA_ADDRESSES: ReadonlySet<string> = new Set(
  [v4("100.100.100.200"), v6("fd00:ec2::254"), v6("fd00:ec2::253"), v6("fd00:c1::a9fe:a9fe"), v6("fd20:ce::254")]
    .map(addressKey)
);

/** Names of the host as seen from a container (Compose `extra_hosts`, Podman). */
const HOST_GATEWAY_ALIASES: ReadonlySet<string> = new Set([
  "host.containers.internal",
  "host.docker.internal"
]);

/** Docker bridges a host install denies whole: `docker0`, `docker_gwbridge` and `br-<network>`. */
const DOCKER_BRIDGE_INTERFACE = /^(?:docker|br-)/u;

/** Runner-internal Agent gateway relay; never resolvable by the app, denied by name. */
const AGENT_GATEWAY_HOSTNAME = "host.microsandbox.internal";

type EndpointMatch = "any_port" | "name_only" | "own_port";

/**
 * AIQSA's configured internal URLs. Unset values with a parser default deny
 * the default. Service names are denied on every port; the public
 * application and object-storage names only on their own port.
 */
const CONFIGURED_ENDPOINTS: readonly Readonly<{ fallback?: string; match: EndpointMatch; variable: string }>[] = [
  { match: "any_port", variable: "DATABASE_URL" },
  { match: "any_port", variable: "S3_ENDPOINT" },
  { match: "own_port", variable: "S3_PUBLIC_ENDPOINT" },
  { fallback: "http://toolhive-runtime:8080", match: "any_port", variable: "AIQSA_TOOLHIVE_URL" },
  { match: "any_port", variable: "AIQSA_TIKA_URL" },
  { match: "any_port", variable: "AIQSA_DOCLING_URL" },
  { fallback: "http://opensearch:9200", match: "any_port", variable: "AIQSA_OPENSEARCH_URL" },
  { match: "any_port", variable: "AIQSA_WORKSPACE_RUNNER_URL" },
  { fallback: `http://${AGENT_GATEWAY_HOSTNAME}:4311`, match: "name_only", variable: "AIQSA_AGENT_GATEWAY_URL" },
  { fallback: "http://localhost:3000", match: "own_port", variable: "AIQSA_APP_BASE_URL" }
];

/** Ports the development Compose file publishes on host loopback, with its defaults. */
const DEV_PUBLISHED_PORTS: readonly Readonly<{ fallback: number; variable: string }>[] = [
  { fallback: 5432, variable: "AIQSA_DEV_POSTGRES_PORT" },
  { fallback: 19200, variable: "AIQSA_DEV_OPENSEARCH_PORT" },
  { fallback: 9000, variable: "AIQSA_DEV_MINIO_PORT" }
];

const SCHEME_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "postgres:": 5432,
  "postgresql:": 5432
};

function addressKey(address: Address): string {
  return address.family === 4 ? `4:${address.value}` : `6:${address.value.toString(16)}`;
}

function hostPortKey(host: string, port: number): string {
  return `${host}|${port}`;
}

function addressText(address: Address): string {
  if (address.family === 4) {
    return [24, 16, 8, 0].map((shift) => Math.floor(address.value / 2 ** shift) % 256).join(".");
  }
  return Array.from({ length: 8 }, (_unused, index) =>
    ((address.value >> BigInt(112 - index * 16)) & 0xffffn).toString(16)).join(":");
}

function rawAddress(value: string): Address | null {
  const family = isIP(value);
  if (family === 4) {
    const parsed = parseIpv4(value);
    return parsed === null ? null : { family: 4, value: parsed };
  }
  if (family === 6) {
    const parsed = parseIpv6(value);
    return parsed === null ? null : { family: 6, value: parsed };
  }
  return null;
}

/** IPv4-mapped IPv6 reaches the IPv4 host itself, so it is decided as that address. */
function parseAddress(value: string): Address | null {
  const address = rawAddress(value);
  if (address?.family === 6 && address.value >> 32n === 0xffffn) {
    return { family: 4, value: Number(address.value & 0xffff_ffffn) };
  }
  return address;
}

function parseSubnet(cidr: string | null): PersonalMcpSubnet | null {
  if (!cidr) return null;
  const slash = cidr.lastIndexOf("/");
  const address = slash > 0 ? rawAddress(cidr.slice(0, slash)) : null;
  const prefixText = cidr.slice(slash + 1);
  if (!address || !/^\d{1,3}$/u.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= (address.family === 4 ? 32 : 128) ? subnetOf(address, prefix) : null;
}

function inSubnet(subnet: PersonalMcpSubnet, address: Address): boolean {
  if (subnet.family === 4 && address.family === 4) {
    const divisor = 2 ** (32 - subnet.prefix);
    return Math.floor(address.value / divisor) === Math.floor(subnet.network / divisor);
  }
  if (subnet.family === 6 && address.family === 6) {
    const shift = BigInt(128 - subnet.prefix);
    return address.value >> shift === subnet.network >> shift;
  }
  return false;
}

function isLoopback(address: Address): boolean {
  return address.family === 4 ? inSubnet(LOOPBACK_V4, address) : address.value === 1n;
}

/** The IPv4 address an IPv6 transition form carries (NAT64, 6to4, IPv4-compatible); undefined otherwise. */
function embeddedIpv4(address: Address): number | undefined {
  if (address.family !== 6 || address.value <= 1n) return undefined;
  if (inSubnet(NAT64_WELL_KNOWN, address) || inSubnet(NAT64_LOCAL_USE, address) || inSubnet(IPV4_COMPATIBLE, address)) {
    return Number(address.value & 0xffff_ffffn);
  }
  return inSubnet(SIX_TO_FOUR, address) ? Number((address.value >> 80n) & 0xffff_ffffn) : undefined;
}

function normalizedHostname(hostname: string): string {
  const host = hostname.toLowerCase();
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function effectivePort(url: URL): number | null {
  if (url.port) return Number(url.port);
  return SCHEME_PORTS[url.protocol] ?? null;
}

function parsePort(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d{1,5}$/u.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

type Target = Readonly<{ hostname: string; port: number }>;

/** The scope rules once every AIQSA-internal rule has passed. */
function scopeDecision(address: Address, localNetworkEnabled: boolean): McpAddressDenialCode | null {
  const scope = networkAddressScope(addressText(address));
  if (scope === "private" || inSubnet(CGNAT, address)) return localNetworkEnabled ? null : DISABLED;
  // Only global unicast IPv6 is public; reserved and unassigned space never is.
  if (address.family === 6 && !inSubnet(GLOBAL_UNICAST_V6, address)) return FORBIDDEN;
  return scope === "public" ? null : FORBIDDEN;
}

function classifyAddress(
  address: Address,
  target: Target,
  environment: PersonalMcpNetworkEnvironment,
  localNetworkEnabled: boolean
): McpAddressDenialCode | null {
  if (address.family === 6 && address.value === 0n) return INTERNAL;
  const embedded = embeddedIpv4(address);
  if (embedded !== undefined) {
    // Transition forms are never used directly; a form of an always-denied
    // address keeps that reason.
    return classifyAddress({ family: 4, value: embedded }, target, environment, localNetworkEnabled) === INTERNAL
      ? INTERNAL
      : FORBIDDEN;
  }
  const key = addressKey(address);
  if (METADATA_ADDRESSES.has(key) || [THIS_NETWORK, LINK_LOCAL_V4, LINK_LOCAL_V6].some((subnet) => inSubnet(subnet, address))) {
    return INTERNAL;
  }
  if (environment.internalAddressPorts.has(hostPortKey(key, target.port))) return INTERNAL;
  if (isLoopback(address)) {
    // In a container loopback is the app container itself; on a host install it is a shared host.
    if (environment.mode === "container" || environment.reservedPorts.has(target.port)) return INTERNAL;
    return localNetworkEnabled ? null : DISABLED;
  }
  const sharedHost = environment.sharedHosts.has(key) ||
    (environment.mode === "container" && HOST_GATEWAY_ALIASES.has(target.hostname));
  if (sharedHost) {
    if (environment.reservedPorts.has(target.port)) return INTERNAL;
  } else if (environment.deniedSubnets.some((subnet) => inSubnet(subnet, address))) {
    return INTERNAL;
  }
  return scopeDecision(address, localNetworkEnabled);
}

/**
 * One resolved address of one personal MCP request. Precedence: the
 * always-denied (internal) set, then other blocked ranges, then the
 * administrator's local-network switch.
 */
export function classifyPersonalMcpAddress(input: Readonly<{
  address: string;
  environment: PersonalMcpNetworkEnvironment;
  localNetworkEnabled: boolean;
  url: URL;
}>): McpAddressDenialCode | null {
  const address = parseAddress(input.address);
  const port = effectivePort(input.url);
  if (!address || port === null) return FORBIDDEN;
  const hostname = normalizedHostname(input.url.hostname);
  const environment = input.environment;
  if (environment.internalHostnames.has(hostname) ||
    environment.internalHostnamePorts.has(hostPortKey(hostname, port))) return INTERNAL;
  return classifyAddress(address, { hostname, port }, environment, input.localNetworkEnabled);
}

function networkMode(host: PersonalMcpNetworkHost): PersonalMcpNetworkMode {
  const override = host.env[PERSONAL_MCP_NETWORK_MODE_ENV]?.trim();
  if (override) return override === "host" ? "host" : "container";
  try {
    return host.detectContainer() ? "container" : "host";
  } catch {
    return "container";
  }
}

async function boundedLookup(host: PersonalMcpNetworkHost, hostname: string): Promise<Address[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      host.lookupHostname(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("lookup_timeout")), host.lookupTimeoutMs ?? ENDPOINT_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
    return records.flatMap((record) => {
      const address = parseAddress(record.address);
      return address ? [address] : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function endpointUrl(text: string | undefined): URL | null {
  if (!text) return null;
  try {
    const url = new URL(text);
    return Object.hasOwn(SCHEME_PORTS, url.protocol) && url.hostname ? url : null;
  } catch {
    return null;
  }
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** Builds the facts for one policy period. Never throws: unreadable facts degrade it to public-only. */
export async function buildPersonalMcpNetworkEnvironment(
  host: PersonalMcpNetworkHost
): Promise<PersonalMcpNetworkEnvironment> {
  const mode = networkMode(host);
  let interfaces: readonly PersonalMcpNetworkInterface[];
  try {
    interfaces = host.interfaces();
  } catch {
    return degradedPersonalMcpNetworkEnvironment();
  }
  const deniedSubnets = interfaces.flatMap((entry) => {
    if (entry.internal) return [];
    if (mode === "host" && !DOCKER_BRIDGE_INTERFACE.test(entry.name)) return [];
    const subnet = parseSubnet(entry.cidr);
    return subnet ? [subnet] : [];
  });
  const sharedHosts = new Set<string>();
  if (mode === "host") {
    for (const entry of interfaces) {
      const address = parseAddress(entry.address);
      if (address) sharedHosts.add(addressKey(address));
    }
  } else {
    const gateways = await Promise.all([...HOST_GATEWAY_ALIASES].map((alias) => boundedLookup(host, alias)));
    for (const address of gateways.flat()) sharedHosts.add(addressKey(address));
  }
  const env = host.env;
  const reservedPorts = new Set<number>();
  const appPort = parsePort(env.AIQSA_PORT);
  reservedPorts.add(parsePort(env.PORT) ?? 3000);
  if (appPort) reservedPorts.add(appPort);
  for (const { fallback, variable } of DEV_PUBLISHED_PORTS) {
    const port = parsePort(env[variable]) ?? (env.NODE_ENV === "production" ? null : fallback);
    if (port) reservedPorts.add(port);
  }

  const internalAddressPorts = new Set<string>();
  const internalHostnamePorts = new Set<string>();
  const internalHostnames = new Set<string>([AGENT_GATEWAY_HOSTNAME]);
  // A specific published bind address is the host itself.
  const bindAddress = parseAddress(env.AIQSA_BIND_ADDRESS?.trim() ?? "");
  if (bindAddress && !isLoopback(bindAddress) && !(bindAddress.family === 4 ? inSubnet(THIS_NETWORK, bindAddress) : bindAddress.value === 0n)) {
    sharedHosts.add(addressKey(bindAddress));
    internalAddressPorts.add(hostPortKey(addressKey(bindAddress), appPort ?? 3000));
  }

  const endpoints = await Promise.all(CONFIGURED_ENDPOINTS.map(async (endpoint) => {
    const configured = env[endpoint.variable]?.trim();
    const url = endpointUrl(configured || endpoint.fallback);
    const port = url && effectivePort(url);
    if (!url || !port) return null;
    const hostname = normalizedHostname(url.hostname);
    const literal = isIP(hostname) !== 0;
    // The Agent gateway is runner-internal: denied by name, never resolved.
    const addresses = endpoint.match === "name_only" ? []
      : literal ? [parseAddress(hostname)].filter((address): address is Address => address !== null)
        : isLocalhostName(hostname) ? [v4("127.0.0.1"), v6("::1")]
          : await boundedLookup(host, hostname);
    return { addresses, defaulted: !configured, hostname, literal, match: endpoint.match, port };
  }));
  for (const endpoint of endpoints) {
    if (!endpoint) continue;
    const { addresses, hostname, port } = endpoint;
    if (endpoint.match === "name_only") {
      internalHostnames.add(hostname);
      continue;
    }
    if (!endpoint.literal && !isLocalhostName(hostname) && !HOST_GATEWAY_ALIASES.has(hostname)) {
      if (endpoint.match === "any_port") internalHostnames.add(hostname);
      else internalHostnamePorts.add(hostPortKey(hostname, port));
    }
    for (const address of addresses) internalAddressPorts.add(hostPortKey(addressKey(address), port));
    // A service shown to live on the app's private networks cannot be
    // reached through the host by its port; any other one may share the host,
    // including one that does not resolve now. An unset default that resolves
    // nowhere names no service at all.
    const onPrivateNetworks = addresses.length > 0 && addresses.every((address) =>
      !isLoopback(address) && !sharedHosts.has(addressKey(address)) &&
      deniedSubnets.some((subnet) => inSubnet(subnet, address)));
    if (!onPrivateNetworks && !(endpoint.defaulted && addresses.length === 0)) reservedPorts.add(port);
  }

  return {
    degraded: false,
    deniedSubnets,
    internalAddressPorts,
    internalHostnamePorts,
    internalHostnames,
    mode,
    reservedPorts,
    sharedHosts
  };
}

/** Fails closed: container rules, no known host, local network off. */
export function degradedPersonalMcpNetworkEnvironment(): PersonalMcpNetworkEnvironment {
  return {
    degraded: true,
    deniedSubnets: [],
    internalAddressPorts: new Set(),
    internalHostnamePorts: new Set(),
    internalHostnames: new Set([AGENT_GATEWAY_HOSTNAME]),
    mode: "container",
    reservedPorts: new Set(),
    sharedHosts: new Set()
  };
}

/** `/.dockerenv`, Podman's marker, Kubernetes or a container cgroup/mount marker. */
export function detectContainerRuntime(input: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  exists(path: string): boolean;
  readText(path: string): string | null;
}>): boolean {
  if (input.exists("/.dockerenv") || input.exists("/run/.containerenv") || input.env.KUBERNETES_SERVICE_HOST) return true;
  const cgroup = input.readText("/proc/1/cgroup");
  if (cgroup && /docker|containerd|kubepods|libpod|lxc/u.test(cgroup)) return true;
  const mounts = input.readText("/proc/self/mountinfo");
  return Boolean(mounts && /\/docker\/containers\/|\/containers\/storage\//u.test(mounts));
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The running process's interfaces, DNS and environment. */
export function defaultPersonalMcpNetworkHost(
  env: Readonly<Record<string, string | undefined>> = process.env
): PersonalMcpNetworkHost {
  return {
    detectContainer: () => detectContainerRuntime({ env, exists: existsSync, readText: readTextFile }),
    env,
    interfaces: () => Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
      (entries ?? []).map((entry) => ({ address: entry.address, cidr: entry.cidr ?? null, internal: entry.internal, name }))),
    async lookupHostname(hostname) {
      const records = await dnsLookup(hostname, { all: true, verbatim: true });
      return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
    }
  };
}

export type PersonalMcpAddressPolicyState = Readonly<{
  /** The policy every personal MCP transport consults for each resolved address. */
  decide: McpAddressPolicy;
  /** Drops the cached administrator setting; the next connection reads it again. */
  invalidate(): void;
}>;

type Cached<Value> = { expiresAt: number; value: Promise<Value> };

/**
 * Caches the administrator setting briefly and the environment longer. A
 * failed setting read fails closed (local network off) for one period.
 */
export function createPersonalMcpAddressPolicy(input: Readonly<{
  environment(): Promise<PersonalMcpNetworkEnvironment>;
  environmentTtlMs?: number;
  now?(): number;
  onReadFailure?(error: unknown): void;
  policyTtlMs?: number;
  readLocalNetworkEnabled(): Promise<boolean>;
}>): PersonalMcpAddressPolicyState {
  const now = input.now ?? Date.now;
  let setting: Cached<boolean> | null = null;
  let environment: Cached<PersonalMcpNetworkEnvironment> | null = null;
  const localNetworkEnabled = (): Promise<boolean> => {
    const at = now();
    if (!setting || setting.expiresAt <= at) {
      setting = {
        expiresAt: at + (input.policyTtlMs ?? PERSONAL_MCP_POLICY_TTL_MS),
        value: Promise.resolve()
          .then(() => input.readLocalNetworkEnabled())
          .then((enabled) => enabled === true, (error: unknown) => {
            try { input.onReadFailure?.(error); } catch { /* reporting never changes the decision */ }
            return false;
          })
      };
    }
    return setting.value;
  };
  const currentEnvironment = (): Promise<PersonalMcpNetworkEnvironment> => {
    const at = now();
    if (!environment || environment.expiresAt <= at) {
      environment = {
        expiresAt: at + (input.environmentTtlMs ?? ENVIRONMENT_TTL_MS),
        value: Promise.resolve()
          .then(() => input.environment())
          .catch(() => degradedPersonalMcpNetworkEnvironment())
      };
    }
    return environment.value;
  };
  return {
    async decide(address, url) {
      const [enabled, facts] = await Promise.all([localNetworkEnabled(), currentEnvironment()]);
      return classifyPersonalMcpAddress({
        address: address.address,
        environment: facts,
        localNetworkEnabled: enabled && !facts.degraded,
        url
      });
    },
    invalidate() {
      setting = null;
    }
  };
}

/**
 * Transport options for one MCP destination. A personal destination follows
 * the personal network policy and never an installation server's reviewed
 * private-network permission; without a policy it stays public-only.
 */
export function mcpDestinationSafeFetchOptions(
  destination: Readonly<{ allowInsecureHttp: boolean; allowPrivateNetwork: boolean; personal: boolean }>,
  personalAddressPolicy: McpAddressPolicy | undefined
): McpSafeFetchOptions {
  if (!destination.personal) {
    return { allowInsecureHttp: destination.allowInsecureHttp, allowPrivateNetwork: destination.allowPrivateNetwork };
  }
  return personalAddressPolicy
    ? { addressPolicy: personalAddressPolicy, allowInsecureHttp: destination.allowInsecureHttp }
    : { allowInsecureHttp: destination.allowInsecureHttp, allowPrivateNetwork: false };
}
