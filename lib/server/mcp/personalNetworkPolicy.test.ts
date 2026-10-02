import { describe, expect, it, vi } from "vitest";
import {
  buildPersonalMcpNetworkEnvironment,
  classifyPersonalMcpAddress,
  createPersonalMcpAddressPolicy,
  detectContainerRuntime,
  mcpDestinationSafeFetchOptions,
  type PersonalMcpNetworkEnvironment,
  type PersonalMcpNetworkHost,
  type PersonalMcpNetworkInterface
} from "./personalNetworkPolicy";
import { PERSONAL_MCP_EGRESS_HEADERS } from "./personalEgress";
import type { McpResolvedAddress } from "./safeFetch";

const INTERNAL = "mcp_internal_address_forbidden";
const DISABLED = "mcp_local_network_disabled";
const FORBIDDEN = "mcp_http_address_forbidden";

function record(address: string): McpResolvedAddress {
  return { address, family: address.includes(":") ? 6 : 4 };
}

function host(input: Readonly<{
  container: boolean;
  dns?: Readonly<Record<string, readonly string[]>>;
  env?: Readonly<Record<string, string | undefined>>;
  interfaces: readonly PersonalMcpNetworkInterface[];
  /** Names whose lookup never answers. */
  stalled?: readonly string[];
}>): PersonalMcpNetworkHost & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    detectContainer: () => input.container,
    env: input.env ?? {},
    interfaces: () => input.interfaces,
    lookups,
    lookupTimeoutMs: 20,
    async lookupHostname(hostname) {
      lookups.push(hostname);
      if (input.stalled?.includes(hostname)) return new Promise<never>(() => undefined);
      const addresses = input.dns?.[hostname];
      if (!addresses) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return addresses.map(record);
    }
  };
}

const iface = (name: string, cidr: string, internal = false): PersonalMcpNetworkInterface =>
  ({ address: cidr.slice(0, cidr.lastIndexOf("/")), cidr, internal, name });

/** The app container on the Compose networks, the host behind host.docker.internal. */
const containerHost = host({
  container: true,
  dns: {
    "aiqsa.example.test": ["93.184.216.34"],
    "host.docker.internal": ["172.17.0.1"],
    minio: ["172.20.0.11"],
    opensearch: ["192.168.73.9"],
    postgres: ["172.20.0.10"],
    "toolhive-runtime": ["192.168.73.7"]
  },
  env: {
    AIQSA_APP_BASE_URL: "https://aiqsa.example.test",
    AIQSA_PORT: "3100",
    AIQSA_TOOLHIVE_URL: "http://toolhive-runtime:8080",
    DATABASE_URL: "postgresql://aiqsa:private-password@postgres:5432/aiqsa?schema=public",
    NODE_ENV: "development",
    S3_ENDPOINT: "http://minio:9000"
  },
  interfaces: [
    iface("lo", "127.0.0.1/8", true),
    iface("lo", "::1/128", true),
    iface("eth0", "172.20.0.5/16"),
    iface("eth1", "192.168.73.4/24"),
    iface("eth1", "fd00:aa::4/64"),
    iface("eth1", "fe80::42:acff:fe14:5/64")
  ]
});

/** `npm run dev` on a workstation with Docker and the dev data services published on loopback. */
const workstation = host({
  container: false,
  env: {
    AIQSA_APP_BASE_URL: "http://localhost:3000",
    AIQSA_OPENSEARCH_URL: "http://localhost:19200",
    DATABASE_URL: "postgresql://aiqsa:private-password@localhost:5432/aiqsa",
    NODE_ENV: "development",
    S3_ENDPOINT: "http://localhost:9000"
  },
  interfaces: [
    iface("lo", "127.0.0.1/8", true),
    iface("lo", "::1/128", true),
    iface("enp3s0", "192.168.1.10/24"),
    iface("docker0", "172.17.0.1/16"),
    iface("br-5f2a9c1d7e4b", "172.18.0.1/16")
  ]
});

function decide(environment: PersonalMcpNetworkEnvironment, url: string, address: string, localNetworkEnabled = true) {
  return classifyPersonalMcpAddress({ address, environment, localNetworkEnabled, url: new URL(url) });
}

describe("personal MCP address policy in a container", async () => {
  const environment = await buildPersonalMcpNetworkEnvironment(containerHost);

  it.each([
    ["LAN", "http://nas.lan:8080/mcp", "192.168.1.20"],
    ["private 10/8", "https://tools.corp.example/mcp", "10.1.2.3"],
    ["Tailscale CGNAT", "http://laptop.tailnet.example:8080/mcp", "100.101.102.103"],
    ["ULA", "http://[fd12:3456::1]:8080/mcp", "fd12:3456::1"],
    ["the host gateway on a non-AIQSA port", "http://host.docker.internal:8080/mcp", "172.17.0.1"],
    ["a public address", "https://mcp.example.test/mcp", "93.184.216.35"],
    ["the AIQSA hostname on another port", "https://aiqsa.example.test:8443/mcp", "93.184.216.34"],
    ["an IPv4-mapped LAN address", "http://nas.lan:8080/mcp", "::ffff:192.168.1.20"]
  ])("allows %s", (_label, url, address) => {
    expect(decide(environment, url, address)).toBeNull();
  });

  it.each([
    ["loopback", "http://localhost:8080/mcp", "127.0.0.1"],
    ["IPv6 loopback", "http://localhost:8080/mcp", "::1"],
    ["IPv4-mapped loopback", "http://loop.example:8080/mcp", "::ffff:127.0.0.1"],
    ["the container's own address", "http://192.168.73.4:8080/mcp", "192.168.73.4"],
    ["a sibling on the default network", "http://10.0.0.1.nip.example:8080/mcp", "172.20.0.30"],
    ["a sibling on an IPv6 Compose network", "http://[fd00:aa::9]/mcp", "fd00:aa::9"],
    ["OpenSearch by name on another port", "http://opensearch:9300/", "203.0.113.200"],
    ["OpenSearch through its address", "http://search.internal.example:9200/", "192.168.73.9"],
    ["Postgres by name", "http://postgres:5432/", "172.20.0.10"],
    ["the ToolHive controller", "http://toolhive-runtime:8080/mcp", "192.168.73.7"],
    ["the object storage relay", "http://minio:9000/", "172.20.0.11"],
    ["the host gateway on the published app port", "http://host.docker.internal:3100/mcp", "172.17.0.1"],
    ["the host gateway on the listener port", "http://host.docker.internal:3000/mcp", "172.17.0.1"],
    ["the host gateway on a dev-published port", "http://host.docker.internal:19200/", "172.17.0.1"],
    ["the host gateway on the public application port", "https://host.docker.internal/", "172.17.0.1"],
    ["the public application name on its port", "https://aiqsa.example.test/mcp", "93.184.216.99"],
    ["the public application address on its port", "https://other-name.example.test/", "93.184.216.34"],
    ["the Agent gateway", "http://host.microsandbox.internal:4311/", "93.184.216.36"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["the Azure WireServer", "http://168.63.129.16/machine?comp=goalstate", "168.63.129.16"],
    ["ECS task metadata", "http://169.254.170.2/v2/metadata", "169.254.170.2"],
    ["IPv6 link-local", "http://[fe80::1]/", "fe80::1"],
    ["Alibaba metadata inside CGNAT", "http://100.100.100.200/latest/meta-data", "100.100.100.200"],
    ["AWS IPv6 metadata inside ULA", "http://[fd00:ec2::254]/latest/meta-data", "fd00:ec2::254"],
    ["AWS IPv6 DNS inside ULA", "http://[fd00:ec2::253]/", "fd00:ec2::253"],
    ["Google IPv6 metadata inside ULA", "http://[fd20:ce::254]/", "fd20:ce::254"],
    ["IPv4-mapped metadata", "http://meta.example/", "::ffff:169.254.169.254"],
    ["NAT64 metadata", "http://meta.example/", "64:ff9b::a9fe:a9fe"],
    ["local-use NAT64 metadata", "http://meta.example/", "64:ff9b:1::a9fe:a9fe"],
    ["NAT64 loopback", "http://loop.example/", "64:ff9b::7f00:1"],
    ["6to4 metadata", "http://meta.example/", "2002:a9fe:a9fe::1"],
    ["IPv4-compatible metadata", "http://meta.example/", "::169.254.169.254"],
    ["the unspecified address", "http://zero.example/", "0.0.0.0"],
    ["the IPv6 unspecified address", "http://zero.example/", "::"]
  ])("denies %s as AIQSA-internal", (_label, url, address) => {
    expect(decide(environment, url, address)).toBe(INTERNAL);
  });

  it.each([
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["documentation", "192.0.2.1"],
    ["benchmarking", "198.18.0.1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["Teredo", "2001::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv6 site-local", "fec0::1"],
    ["IPv6 discard", "100::1"],
    ["unassigned IPv6", "4000::1"],
    ["NAT64 of a public address", "64:ff9b::808:808"],
    ["NAT64 of a LAN address", "64:ff9b::c0a8:114"],
    ["6to4 of a public address", "2002:808:808::1"],
    ["an address with a zone", "fe80::1%eth0"]
  ])("keeps the generic refusal for %s", (_label, address) => {
    expect(decide(environment, "http://mcp.example.test/", address)).toBe(FORBIDDEN);
  });

  it("refuses private and CGNAT addresses with the disabled reason when the switch is off", () => {
    for (const [url, address] of [
      ["http://nas.lan:8080/mcp", "192.168.1.20"],
      ["http://laptop.tailnet.example/mcp", "100.101.102.103"],
      ["http://[fd12:3456::1]/mcp", "fd12:3456::1"],
      ["http://host.docker.internal:8080/mcp", "172.17.0.1"]
    ] as const) {
      expect(decide(environment, url, address, false)).toBe(DISABLED);
    }
    expect(decide(environment, "https://mcp.example.test/mcp", "93.184.216.35", false)).toBeNull();
  });

  it("puts the internal reason before the disabled one", () => {
    for (const [url, address] of [
      ["http://localhost:8080/mcp", "127.0.0.1"],
      ["http://100.100.100.200/", "100.100.100.200"],
      ["http://168.63.129.16/", "168.63.129.16"],
      ["http://sibling.example:8080/", "172.20.0.30"],
      ["http://host.docker.internal:3100/", "172.17.0.1"],
      ["http://meta.example/", "64:ff9b::a9fe:a9fe"]
    ] as const) {
      expect(decide(environment, url, address, false)).toBe(INTERNAL);
    }
  });

  it("does not reserve the port of a service shown on the app's own networks", () => {
    expect(environment.degraded).toBe(false);
    expect(environment.reservedPorts.has(8080)).toBe(false);
    expect(environment.reservedPorts.has(5432)).toBe(true);
    expect(environment.reservedPorts.has(443)).toBe(true);
    expect(containerHost.lookups).not.toContain("host.microsandbox.internal");
  });
});

describe("personal MCP address policy on a host install", async () => {
  const environment = await buildPersonalMcpNetworkEnvironment(workstation);

  it.each([
    ["localhost on a non-AIQSA port", "http://localhost:8080/mcp", "127.0.0.1"],
    ["IPv6 loopback on a non-AIQSA port", "http://localhost:8080/mcp", "::1"],
    ["the host's LAN address on a non-AIQSA port", "http://192.168.1.10:8080/mcp", "192.168.1.10"],
    ["the host's Docker bridge address", "http://172.17.0.1:8080/mcp", "172.17.0.1"],
    ["another LAN machine", "http://192.168.1.20:8080/mcp", "192.168.1.20"]
  ])("allows %s", (_label, url, address) => {
    expect(decide(environment, url, address)).toBeNull();
  });

  it.each([
    ["the dev app", "http://localhost:3000/", "127.0.0.1"],
    ["Postgres on loopback", "http://localhost:5432/", "127.0.0.1"],
    ["the dev-published OpenSearch on the LAN address", "http://192.168.1.10:19200/", "192.168.1.10"],
    ["the dev-published object storage", "http://127.0.0.1:9000/", "127.0.0.1"],
    ["a container on the default bridge", "http://172.17.0.2:8080/mcp", "172.17.0.2"],
    ["a container on a Compose bridge", "http://172.18.0.5:8080/mcp", "172.18.0.5"]
  ])("denies %s", (_label, url, address) => {
    expect(decide(environment, url, address)).toBe(INTERNAL);
  });

  it("does not reserve the port of an unset default that resolves nowhere", () => {
    expect(environment.reservedPorts.has(8080)).toBe(false);
    expect(environment.internalHostnames.has("toolhive-runtime")).toBe(true);
  });

  it("closes the shared hosts and the LAN when the switch is off", () => {
    expect(decide(environment, "http://localhost:8080/mcp", "127.0.0.1", false)).toBe(DISABLED);
    expect(decide(environment, "http://192.168.1.20:8080/mcp", "192.168.1.20", false)).toBe(DISABLED);
    expect(decide(environment, "http://localhost:5432/", "127.0.0.1", false)).toBe(INTERNAL);
  });
});

describe("personal MCP address policy without every host fact", () => {
  const compose = (input: Readonly<{ dns?: Record<string, readonly string[]>; stalled?: readonly string[] }>) => host({
    container: true,
    dns: { postgres: ["172.20.0.10"], ...input.dns },
    env: { AIQSA_PORT: "3100", DATABASE_URL: "postgresql://aiqsa:private-password@postgres:5432/aiqsa", NODE_ENV: "production" },
    interfaces: [iface("lo", "127.0.0.1/8", true), iface("eth0", "172.20.0.5/16")],
    ...(input.stalled ? { stalled: input.stalled } : {})
  });

  it.each([
    ["fails", compose({})],
    ["never answers", compose({ stalled: ["host.docker.internal", "host.containers.internal"] })]
  ])("refuses every local destination with the generic reason when the gateway lookup %s", async (_label, network) => {
    const environment = await buildPersonalMcpNetworkEnvironment(network);
    expect(environment.degraded).toBe(true);
    for (const [url, address] of [
      ["http://172.17.0.1:3100/", "172.17.0.1"],
      ["http://192.168.65.254:19200/", "192.168.65.254"],
      ["http://nas.lan:8080/mcp", "192.168.1.20"],
      ["http://laptop.tailnet.example/mcp", "100.101.102.103"]
    ] as const) {
      expect(decide(environment, url, address)).toBe(FORBIDDEN);
    }
    // The administrator's own choice keeps its reason; always-denied keeps its own.
    expect(decide(environment, "http://nas.lan:8080/mcp", "192.168.1.20", false)).toBe(DISABLED);
    expect(decide(environment, "http://localhost:8080/", "127.0.0.1")).toBe(INTERNAL);
    expect(decide(environment, "http://172.20.0.10:5432/", "172.20.0.10")).toBe(INTERNAL);
    expect(decide(environment, "http://169.254.169.254/", "169.254.169.254")).toBe(INTERNAL);
    // Public destinations never depended on the gateway.
    expect(decide(environment, "https://mcp.example.test/mcp", "93.184.216.35")).toBeNull();
  });

  it("is whole once one gateway name resolves", async () => {
    const environment = await buildPersonalMcpNetworkEnvironment(compose({ dns: { "host.docker.internal": ["172.17.0.1"] } }));
    expect(environment.degraded).toBe(false);
    expect(decide(environment, "http://172.17.0.1:3100/", "172.17.0.1")).toBe(INTERNAL);
    expect(decide(environment, "http://172.17.0.1:8080/", "172.17.0.1")).toBeNull();
  });

  it("degrades a host install whose configured service does not resolve, never an unset default", async () => {
    const network = (env: Readonly<Record<string, string>>) => host({
      container: false, dns: { "tika.lan": ["192.168.1.30"] }, env: { NODE_ENV: "production", ...env },
      interfaces: [iface("lo", "127.0.0.1/8", true), iface("enp3s0", "192.168.1.10/24")]
    });
    const resolved = await buildPersonalMcpNetworkEnvironment(network({ AIQSA_TIKA_URL: "http://tika.lan:9998" }));
    expect(resolved.degraded).toBe(false);
    expect(decide(resolved, "http://192.168.1.30:9998/", "192.168.1.30")).toBe(INTERNAL);
    expect(decide(resolved, "http://192.168.1.30:8080/", "192.168.1.30")).toBeNull();

    const unresolved = await buildPersonalMcpNetworkEnvironment(network({ AIQSA_TIKA_URL: "http://tika.missing.lan:9998" }));
    expect(unresolved.degraded).toBe(true);
    expect(decide(unresolved, "http://192.168.1.30:9998/", "192.168.1.30")).toBe(FORBIDDEN);
    expect(decide(unresolved, "http://localhost:8080/", "127.0.0.1")).toBe(FORBIDDEN);

    // The parser defaults (toolhive-runtime, opensearch) resolve nowhere on a host install.
    expect((await buildPersonalMcpNetworkEnvironment(network({}))).degraded).toBe(false);
  });
});

describe("personal MCP network mode", () => {
  it("detects a container from its markers", () => {
    const none = { env: {}, exists: () => false, readText: () => null };
    expect(detectContainerRuntime(none)).toBe(false);
    expect(detectContainerRuntime({ ...none, exists: (path) => path === "/.dockerenv" })).toBe(true);
    expect(detectContainerRuntime({ ...none, exists: (path) => path === "/run/.containerenv" })).toBe(true);
    expect(detectContainerRuntime({ ...none, readText: (path) => path === "/proc/1/cgroup" ? "0::/system.slice/docker-abc.scope" : null })).toBe(true);
    expect(detectContainerRuntime({ ...none, readText: (path) => path === "/proc/self/mountinfo"
      ? "512 498 0:25 /docker/containers/abc/hostname /etc/hostname rw" : null })).toBe(true);
    expect(detectContainerRuntime({ ...none, env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } })).toBe(true);
  });

  it("lets the override select the mode and fails closed on an unknown value", async () => {
    const interfaces = [iface("enp3s0", "192.168.1.10/24")];
    const asHost = await buildPersonalMcpNetworkEnvironment(host({
      container: true, env: { AIQSA_PERSONAL_MCP_NETWORK_MODE: "host" }, interfaces
    }));
    expect(asHost.mode).toBe("host");
    expect(decide(asHost, "http://192.168.1.20/", "192.168.1.20")).toBeNull();
    const unknown = await buildPersonalMcpNetworkEnvironment(host({
      container: false, env: { AIQSA_PERSONAL_MCP_NETWORK_MODE: "bridge" }, interfaces
    }));
    expect(unknown.mode).toBe("container");
    expect(decide(unknown, "http://192.168.1.20/", "192.168.1.20")).toBe(INTERNAL);
  });

  it("degrades to public-only when the interfaces cannot be read", async () => {
    const environment = await buildPersonalMcpNetworkEnvironment({
      ...host({ container: false, interfaces: [] }),
      interfaces: () => { throw new Error("unavailable"); }
    });
    expect(environment.degraded).toBe(true);
    expect(decide(environment, "http://localhost:8080/", "127.0.0.1")).toBe(INTERNAL);
  });
});

describe("personal MCP address policy cache", () => {
  const environment = buildPersonalMcpNetworkEnvironment(containerHost);
  const lan = record("192.168.1.20");
  const url = new URL("http://nas.lan:8080/mcp");

  it("reads the administrator setting once per period and again after invalidation", async () => {
    let now = 0;
    let enabled = true;
    const readLocalNetworkEnabled = vi.fn(async () => enabled);
    const policy = createPersonalMcpAddressPolicy({ environment: () => environment, now: () => now, readLocalNetworkEnabled });
    await expect(Promise.all([policy.decide(lan, url), policy.decide(lan, url)])).resolves.toEqual([null, null]);
    expect(readLocalNetworkEnabled).toHaveBeenCalledOnce();
    enabled = false;
    await expect(policy.decide(lan, url)).resolves.toBeNull();
    policy.invalidate();
    await expect(policy.decide(lan, url)).resolves.toBe(DISABLED);
    enabled = true;
    now += 5_000;
    await expect(policy.decide(lan, url)).resolves.toBeNull();
    expect(readLocalNetworkEnabled).toHaveBeenCalledTimes(3);
  });

  it("fails closed for one period when the setting cannot be read", async () => {
    const onReadFailure = vi.fn();
    const policy = createPersonalMcpAddressPolicy({
      environment: () => environment,
      onReadFailure,
      readLocalNetworkEnabled: async () => { throw new Error("database unavailable"); }
    });
    await expect(policy.decide(lan, url)).resolves.toBe(DISABLED);
    await expect(policy.decide(record("93.184.216.35"), new URL("https://mcp.example.test/"))).resolves.toBeNull();
    expect(onReadFailure).toHaveBeenCalledOnce();
  });

  it("refuses local destinations generically when the environment cannot be built", async () => {
    const policy = createPersonalMcpAddressPolicy({
      environment: async () => { throw new Error("unavailable"); },
      readLocalNetworkEnabled: async () => true
    });
    await expect(policy.decide(lan, url)).resolves.toBe(FORBIDDEN);
  });

  it("rebuilds a degraded environment after a few seconds and a whole one after a minute", async () => {
    let now = 0;
    let gateway: readonly string[] | undefined;
    const network = () => host({
      container: true,
      dns: gateway ? { "host.docker.internal": gateway } : {},
      interfaces: [iface("eth0", "172.20.0.5/16")]
    });
    const built = vi.fn(() => buildPersonalMcpNetworkEnvironment(network()));
    const observed = vi.fn();
    const policy = createPersonalMcpAddressPolicy({
      environment: built, now: () => now, onEnvironment: observed, readLocalNetworkEnabled: async () => true
    });
    await expect(policy.decide(lan, url)).resolves.toBe(FORBIDDEN);
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ degraded: true }));
    gateway = ["172.17.0.1"];
    now += 4_000;
    await expect(policy.decide(lan, url)).resolves.toBe(FORBIDDEN);
    expect(built).toHaveBeenCalledOnce();
    now += 1_000;
    await expect(policy.decide(lan, url)).resolves.toBeNull();
    expect(built).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ degraded: false }));
    now += 59_000;
    await policy.decide(lan, url);
    expect(built).toHaveBeenCalledTimes(2);
    now += 1_000;
    await policy.decide(lan, url);
    expect(built).toHaveBeenCalledTimes(3);
  });
});

describe("MCP destination transport options", () => {
  const addressPolicy = vi.fn(async () => null);

  it("keeps an installation server's reviewed permission", () => {
    expect(mcpDestinationSafeFetchOptions({ allowInsecureHttp: true, allowPrivateNetwork: true, personal: false }, addressPolicy))
      .toEqual({ allowInsecureHttp: true, allowPrivateNetwork: true });
  });

  it("applies the personal policy and the egress marker, never a stored private-network permission", () => {
    expect(mcpDestinationSafeFetchOptions({ allowInsecureHttp: false, allowPrivateNetwork: true, personal: true }, addressPolicy))
      .toEqual({ addressPolicy, allowInsecureHttp: false, egressHeaders: PERSONAL_MCP_EGRESS_HEADERS });
    expect(mcpDestinationSafeFetchOptions({ allowInsecureHttp: true, allowPrivateNetwork: true, personal: true }, undefined))
      .toEqual({ allowInsecureHttp: true, allowPrivateNetwork: false, egressHeaders: PERSONAL_MCP_EGRESS_HEADERS });
  });
});
