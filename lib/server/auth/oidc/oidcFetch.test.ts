// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { PersonalMcpNetworkEnvironment } from "../../mcp/personalNetworkPolicy";
import { boundedOidcFetch, createOidcAddressPolicy } from "./oidcFetch";

const environment: PersonalMcpNetworkEnvironment = {
  degraded: false,
  // The app container's own network, 172.18.0.0/16.
  deniedSubnets: [{ family: 4, network: 172 * 2 ** 24 + 18 * 2 ** 16, prefix: 16 }],
  internalAddressPorts: new Set(),
  internalHostnamePorts: new Set(),
  internalHostnames: new Set(["postgres"]),
  mode: "container",
  reservedPorts: new Set([3000]),
  sharedHosts: new Set()
};

describe("OIDC address policy", () => {
  const decide = createOidcAddressPolicy(async () => environment);
  const ask = (address: string, url: string) => decide({ address, family: address.includes(":") ? 6 : 4 }, new URL(url));

  it("reaches identity providers on the LAN and the internet", async () => {
    await expect(ask("192.168.1.20", "https://keycloak.lan/realms/main/.well-known/openid-configuration")).resolves.toBeNull();
    await expect(ask("10.0.0.5", "http://authentik.lan:9000/application/o/aiqsa/")).resolves.toBeNull();
    await expect(ask("20.190.160.1", "https://login.microsoftonline.com/tenant/v2.0")).resolves.toBeNull();
  });

  it("never reaches metadata, link-local, the app container or AIQSA's services", async () => {
    await expect(ask("169.254.169.254", "http://metadata/latest")).resolves.toBe("mcp_internal_address_forbidden");
    await expect(ask("127.0.0.1", "http://localhost:3000/")).resolves.toBe("mcp_internal_address_forbidden");
    await expect(ask("172.18.0.4", "http://postgres:5432/")).resolves.toBe("mcp_internal_address_forbidden");
    await expect(ask("172.18.0.9", "https://sidecar.internal/")).resolves.toBe("mcp_internal_address_forbidden");
  });

  it("keeps plain HTTP off the internet, since codes and tokens travel in it", async () => {
    await expect(ask("20.190.160.1", "http://idp.example.com/")).resolves.toBe("mcp_http_address_forbidden");
  });
});

describe("bounded OIDC fetch", () => {
  it("refuses a body over the limit and keeps the status of a smaller one", async () => {
    const big = boundedOidcFetch(async () => new Response("x".repeat(2_048)), 1_024);
    await expect(big("https://idp.example/certs")).rejects.toThrow();
    const small = boundedOidcFetch(async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 404 }), 1_024);
    const response = await small("https://idp.example/certs");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({});
  });
});
