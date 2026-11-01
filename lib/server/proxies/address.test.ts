import { describe, expect, it, vi } from "vitest";
import {
  buildPersonalMcpNetworkEnvironment,
  degradedPersonalMcpNetworkEnvironment,
  type PersonalMcpNetworkEnvironment
} from "../mcp/personalNetworkPolicy";
import type { McpResolvedAddress } from "../mcp/safeFetch";
import { canonicalProxyHost, checkProxyAddress, isRefusedProxyTarget } from "./address";

const PUBLIC: McpResolvedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: McpResolvedAddress = { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 };
const INSTALLATION: McpResolvedAddress = { address: "198.41.0.7", family: 4 };

/** The real policy's environment of a container deployment with a public application name. */
function containerEnvironment(): Promise<PersonalMcpNetworkEnvironment> {
  return buildPersonalMcpNetworkEnvironment({
    detectContainer: () => true,
    env: {
      AIQSA_APP_BASE_URL: "https://ai.installation.example",
      AIQSA_TIKA_URL: "http://tika.internal.example:9998",
      DATABASE_URL: "postgresql://aiqsa@db.internal.example:5432/aiqsa",
      NODE_ENV: "production",
      S3_ENDPOINT: "http://storage.internal.example:9000",
      S3_PUBLIC_ENDPOINT: "https://files.installation.example"
    },
    interfaces: () => [
      { address: "127.0.0.1", cidr: "127.0.0.1/8", internal: true, name: "lo" },
      { address: "172.20.0.5", cidr: "172.20.0.5/16", internal: false, name: "eth0" }
    ],
    lookupHostname: async (hostname) => {
      if (hostname === "host.docker.internal") return [{ address: "172.17.0.1", family: 4 }];
      if (hostname === "ai.installation.example") return [INSTALLATION];
      if (hostname === "files.installation.example") return [{ address: "198.41.0.8", family: 4 }];
      if (hostname.endsWith(".internal.example")) return [{ address: "172.20.0.9", family: 4 }];
      throw new Error("not found");
    }
  });
}

async function check(
  host: unknown,
  answers: Readonly<Record<string, readonly McpResolvedAddress[]>> = {},
  port: unknown = 1080
) {
  const lookupHostname = vi.fn(async (hostname: string) => {
    const records = answers[hostname];
    if (!records) throw new Error("not found");
    return records;
  });
  const result = await checkProxyAddress({ host, port }, { environment: containerEnvironment, lookupHostname });
  return { lookupHostname, result };
}

describe("a proxy's address", () => {
  it("pins the checked address of a public name", async () => {
    const { result } = await check("proxy.example.com", { "proxy.example.com": [PUBLIC, PUBLIC_V6] });
    expect(result).toEqual({ host: "proxy.example.com", ok: true, pinned: PUBLIC, port: 1080 });
  });

  it("takes a public literal without DNS", async () => {
    const v4 = await check("93.184.216.34");
    expect(v4.result).toEqual({ host: "93.184.216.34", ok: true, pinned: PUBLIC, port: 1080 });
    expect(v4.lookupHostname).not.toHaveBeenCalled();
    const v6 = await check("[2606:2800:21f:cb07:6820:80da:af6b:8b2c]");
    expect(v6.result).toMatchObject({ ok: true, pinned: PUBLIC_V6 });
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["the rest of loopback", "127.8.8.8"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["CGNAT", "100.64.0.9"],
    ["link-local", "169.254.1.1"],
    ["metadata", "169.254.169.254"],
    ["Alibaba metadata", "100.100.100.200"],
    ["Azure WireServer", "168.63.129.16"],
    ["this network", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["documentation", "203.0.113.5"],
    ["IPv6 loopback", "::1"],
    ["IPv6 loopback in brackets", "[::1]"],
    ["IPv6 any", "::"],
    ["IPv6 unique local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 metadata", "fd00:ec2::254"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback in hex", "[::ffff:7f00:1]"],
    ["IPv4-mapped private", "[::ffff:10.0.0.1]"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped metadata in hex", "[::ffff:a9fe:a9fe]"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["NAT64 of a private address", "64:ff9b::a00:1"],
    ["NAT64 of a public address", "64:ff9b::5db8:d822"],
    ["6to4 of a private address", "2002:a00:1::"],
    ["decimal loopback", "2130706433"],
    ["decimal metadata", "2852039166"],
    ["hexadecimal loopback", "0x7f000001"],
    ["hexadecimal parts", "0x7f.0.0.1"],
    ["short form", "127.1"],
    ["short form with hex", "0x7f.1"],
    ["octal", "0177.0.0.1"],
    ["octal whole", "017700000001"],
    ["private in a short form", "10.1"],
    ["full-width digits", "１２７.０.０.１"],
    ["a trailing dot", "127.0.0.1."],
    ["localhost", "localhost"],
    ["localhost in upper case", "LOCALHOST"],
    ["localhost with a trailing dot", "localhost."],
    ["a localhost subdomain", "app.localhost"]
  ])("refuses %s without asking DNS", async (_label, host) => {
    const { lookupHostname, result } = await check(host);
    expect(result).toEqual({ code: "proxy_address_forbidden", ok: false });
    expect(lookupHostname).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", { address: "127.0.0.1", family: 4 }],
    ["a private range", { address: "10.0.0.5", family: 4 }],
    ["CGNAT", { address: "100.64.0.9", family: 4 }],
    ["metadata", { address: "169.254.169.254", family: 4 }],
    ["the app's own network", { address: "172.20.0.5", family: 4 }],
    ["IPv6 loopback", { address: "::1", family: 6 }],
    ["IPv6 unique local", { address: "fd00::1", family: 6 }],
    ["an IPv4-mapped private address", { address: "::ffff:192.168.0.1", family: 6 }]
  ] as const)("refuses a name resolving to %s", async (_label, address) => {
    const only = await check("proxy.example.com", { "proxy.example.com": [address] });
    expect(only.result).toEqual({ code: "proxy_address_forbidden", ok: false });
  });

  it.each([
    ["first", [{ address: "10.0.0.5", family: 4 }, PUBLIC]],
    ["last", [PUBLIC, PUBLIC_V6, { address: "fd00::1", family: 6 }]]
  ] as const)("refuses mixed public and private answers with the private one %s", async (_label, answers) => {
    const { result } = await check("proxy.example.com", { "proxy.example.com": answers });
    expect(result).toEqual({ code: "proxy_address_forbidden", ok: false });
  });

  it("sees a changed DNS answer on the next check", async () => {
    const lookupHostname = vi.fn<(hostname: string) => Promise<readonly McpResolvedAddress[]>>()
      .mockResolvedValueOnce([PUBLIC])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const options = { environment: containerEnvironment, lookupHostname };
    expect(await checkProxyAddress({ host: "proxy.example.com", port: 1080 }, options)).toMatchObject({ ok: true });
    expect(await checkProxyAddress({ host: "proxy.example.com", port: 1080 }, options))
      .toEqual({ code: "proxy_address_forbidden", ok: false });
  });

  it.each([
    ["the application's public name on its own port", "ai.installation.example", 443],
    ["the application's public name on any other port", "ai.installation.example", 1080],
    ["the application's name in upper case with a trailing dot", "AI.Installation.Example.", 1080],
    ["the storage public name on any other port", "files.installation.example", 8080],
    ["a data service", "db.internal.example", 1080],
    ["the parser", "tika.internal.example", 1080],
    ["the Docker host by name", "host.docker.internal", 1080]
  ])("refuses %s", async (_label, host, port) => {
    const { result } = await check(host, {
      "AI.Installation.Example.": [INSTALLATION],
      "ai.installation.example": [INSTALLATION],
      "db.internal.example": [{ address: "172.20.0.9", family: 4 }],
      "files.installation.example": [{ address: "198.41.0.8", family: 4 }],
      "host.docker.internal": [PUBLIC],
      "tika.internal.example": [{ address: "172.20.0.9", family: 4 }]
    }, port);
    expect(result).toEqual({ code: "proxy_address_forbidden", ok: false });
  });

  it("refuses another name for the installation's public address, on any port", async () => {
    const { result } = await check("alias.example.com", { "alias.example.com": [INSTALLATION] });
    expect(result).toEqual({ code: "proxy_address_forbidden", ok: false });
    const literal = await check("198.41.0.7");
    expect(literal.result).toEqual({ code: "proxy_address_forbidden", ok: false });
  });

  it("refuses the host's own public address on a host install", async () => {
    const environment = () => buildPersonalMcpNetworkEnvironment({
      detectContainer: () => false,
      env: { AIQSA_APP_BASE_URL: "http://localhost:3000", NODE_ENV: "production" },
      interfaces: () => [{ address: "198.41.0.9", cidr: "198.41.0.9/24", internal: false, name: "eth0" }],
      lookupHostname: async () => []
    });
    expect(await checkProxyAddress({ host: "198.41.0.9", port: 1080 }, { environment }))
      .toEqual({ code: "proxy_address_forbidden", ok: false });
    expect(await checkProxyAddress({ host: "93.184.216.34", port: 1080 }, { environment })).toMatchObject({ ok: true });
  });

  it("fails closed while the installation's facts are unknown, and a private address keeps its reason", async () => {
    const environment = async () => degradedPersonalMcpNetworkEnvironment();
    expect(await checkProxyAddress({ host: "93.184.216.34", port: 1080 }, { environment }))
      .toEqual({ code: "proxy_address_check_unavailable", ok: false });
    expect(await checkProxyAddress({ host: "10.0.0.1", port: 1080 }, { environment }))
      .toEqual({ code: "proxy_address_forbidden", ok: false });
  });

  it.each([
    ["no answers", async () => []],
    ["a failed lookup", async () => { throw new Error("SERVFAIL"); }],
    ["a malformed family", async () => [{ address: "93.184.216.34", family: 6 }]],
    ["a malformed address", async () => [{ address: "not-an-address", family: 4 }]],
    ["a decimal address in an answer", async () => [{ address: "2130706433", family: 4 }]]
  ] as readonly (readonly [string, () => Promise<readonly McpResolvedAddress[]>])[])(
    "reports %s as a failed lookup", async (_label, lookupHostname) => {
      expect(await checkProxyAddress({ host: "proxy.example.com", port: 1080 }, { environment: containerEnvironment, lookupHostname }))
        .toEqual({ code: "proxy_dns_failed", ok: false });
    }
  );

  it("bounds a lookup that never answers", async () => {
    const result = await checkProxyAddress({ host: "proxy.example.com", port: 1080 }, {
      environment: containerEnvironment,
      lookupHostname: () => new Promise(() => undefined),
      timeoutMs: 5
    });
    expect(result).toEqual({ code: "proxy_dns_failed", ok: false });
  });

  it("keeps the caller's cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(checkProxyAddress({ host: "proxy.example.com", port: 1080 }, {
      environment: containerEnvironment,
      lookupHostname: async () => [PUBLIC],
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([[0], [65_536], [80.5], ["1080"], [null]])("refuses port %s", async (port) => {
    const { lookupHostname, result } = await check("93.184.216.34", {}, port);
    expect(result).toEqual({ code: "proxy_port_invalid", ok: false });
    expect(lookupHostname).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["no text", 7],
    ["a scheme", "http://proxy.example.com"],
    ["userinfo", "user:secret@proxy.example.com"],
    ["a confusing at-sign", "93.184.216.34@127.0.0.1"],
    ["a port", "proxy.example.com:8080"],
    ["a path", "proxy.example.com/path"],
    ["a backslash", "93.184.216.34\\@127.0.0.1"],
    ["a percent escape", "%31%32%37.0.0.1"],
    ["a zone id", "[fe80::1%25eth0]"],
    ["a space inside", "proxy .example.com"],
    ["a single label", "postgres"],
    ["an address out of range", "256.256.256.256"],
    ["unbalanced brackets", "[::1"]
  ])("refuses a host with %s", async (_label, host) => {
    const { lookupHostname, result } = await check(host);
    expect(result).toEqual({ code: "proxy_host_invalid", ok: false });
    expect(lookupHostname).not.toHaveBeenCalled();
  });
});

describe("the canonical form the store saves", () => {
  it.each([
    ["Proxy.Example.COM.", "proxy.example.com"],
    ["  proxy.example.com  ", "proxy.example.com"],
    ["прокси.рф", "xn--h1adldfi.xn--p1ai"],
    ["93.184.216.34", "93.184.216.34"],
    ["1572395042", "93.184.216.34"],
    ["[2606:2800:21F:CB07:6820:80DA:AF6B:8B2C]", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]
  ])("%s becomes %s", (input, output) => {
    expect(canonicalProxyHost(input)).toBe(output);
  });
});

describe("a target sent through a proxy", () => {
  it.each([
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fd00::1]/",
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/"
  ])("%s is refused before the proxy", (url) => {
    expect(isRefusedProxyTarget(new URL(url))).toBe(true);
  });

  it.each(["https://ozon.ru/", "http://93.184.216.34/", "https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/"])(
    "%s goes to the proxy", (url) => {
      expect(isRefusedProxyTarget(new URL(url))).toBe(false);
    }
  );
});
