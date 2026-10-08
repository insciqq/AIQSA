// @vitest-environment node
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ldapSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import type { McpResolvedAddress } from "../../mcp/safeFetch";
import { createLdapDestinationPolicy } from "./defaultLdapConnect";
import { createLdapConnect, LdapConnectionError, parseLdapCaCertificates } from "./ldapConnection";

function config(url: string, overrides: Record<string, unknown> = {}) {
  return ldapSignInConfigSchema.parse({ url, userSearchBase: "dc=example,dc=test", ...overrides });
}

/** A Compose app container: its network, the host gateway, and the database by service name. */
const containerHost = {
  detectContainer: () => true,
  env: { DATABASE_URL: "postgresql://aiqsa@postgres:5432/aiqsa", NODE_ENV: "production" },
  interfaces: () => [{ address: "172.18.0.5", cidr: "172.18.0.5/16", internal: false, name: "eth0" }],
  async lookupHostname(hostname: string): Promise<McpResolvedAddress[]> {
    if (hostname === "host.docker.internal") return [{ address: "172.17.0.1", family: 4 }];
    if (hostname === "postgres") return [{ address: "172.18.0.2", family: 4 }];
    if (hostname === "opensearch") return [{ address: "172.18.0.3", family: 4 }];
    return [];
  }
};

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof LdapConnectionError ? error.code : `unexpected: ${String(error)}`;
  }
  return "connected";
}

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = null;
});

describe("directory destination policy", () => {
  it("allows private directories and refuses metadata, link-local and AIQSA's own services", async () => {
    const policy = createLdapDestinationPolicy(containerHost);
    const decide = (address: string, url = "ldap://dc.example.test:389") =>
      policy.decide({ address, family: 4 }, new URL(url));

    await expect(decide("10.20.0.5")).resolves.toBeNull();
    await expect(decide("192.168.1.10")).resolves.toBeNull();
    await expect(decide("169.254.169.254")).resolves.not.toBeNull();
    await expect(decide("172.18.0.2")).resolves.not.toBeNull();
    await expect(decide("10.20.0.5", "ldap://postgres:389")).resolves.not.toBeNull();
  });

  it("checks every resolved address before connecting and connects to none of a refused host", async () => {
    const addressPolicy = vi.fn((address: McpResolvedAddress, _url: URL) => (address.address === "169.254.169.254" ? "mcp_internal_address_forbidden" as const : null));
    const lookupHostname = vi.fn(async () => [
      { address: "10.20.0.5", family: 4 as const },
      { address: "169.254.169.254", family: 4 as const }
    ]);
    const connect = createLdapConnect({ addressPolicy, lookupHostname });

    await expect(failure(connect({ config: config("ldaps://dc.example.test") }))).resolves.toBe("destination_forbidden");
    expect(lookupHostname).toHaveBeenCalledWith("dc.example.test");
    expect(addressPolicy).toHaveBeenCalledTimes(2);
    expect(addressPolicy.mock.calls[0]![1].toString()).toBe("ldaps://dc.example.test:636");
  });

  it("treats a failed or empty lookup as an unreachable directory", async () => {
    const addressPolicy = vi.fn(() => null);
    await expect(failure(createLdapConnect({ addressPolicy, lookupHostname: async () => [] })({ config: config("ldap://dc.example.test") })))
      .resolves.toBe("connect_failed");
    await expect(failure(createLdapConnect({
      addressPolicy,
      lookupHostname: async () => {
        throw new Error("ENOTFOUND");
      }
    })({ config: config("ldap://dc.example.test") }))).resolves.toBe("connect_failed");
    expect(addressPolicy).not.toHaveBeenCalled();
  });
});

describe("directory connections", () => {
  it("refuses a pasted CA that is not an X.509 certificate before connecting", async () => {
    const pem = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----";
    expect(parseLdapCaCertificates(pem)).toBeNull();
    await expect(failure(createLdapConnect({ addressPolicy: () => null })({
      config: config("ldaps://127.0.0.1:1", { caCertificatePem: pem })
    }))).resolves.toBe("tls_failed");
  });

  it("reports a closed port as connect_failed", async () => {
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });

    await expect(failure(createLdapConnect({ addressPolicy: () => null })({ config: config(`ldap://127.0.0.1:${closed}`) })))
      .resolves.toBe("connect_failed");
  });

  it("never puts a blank password on the wire", async () => {
    const received: Buffer[] = [];
    server = createServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk));
      socket.on("error", () => undefined);
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
    });
    const session = await createLdapConnect({ addressPolicy: () => null })({ config: config(`ldap://127.0.0.1:${port}`) });

    expect(session.transport).toBe("plain");
    await expect(session.bind("uid=jdoe,dc=example,dc=test", "  ")).rejects.toThrow("ldap_blank_password_refused");
    await session.close();
    expect(Buffer.concat(received).includes(Buffer.from("uid=jdoe"))).toBe(false);
  });
});
