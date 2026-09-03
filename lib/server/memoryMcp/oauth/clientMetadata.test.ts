import { describe, expect, it, vi } from "vitest";
import {
  createInboundMcpClientMetadataResolver,
  INBOUND_MCP_CIMD_CACHE_MAX_AGE_MS,
  InboundMcpClientMetadataError
} from "./clientMetadata";

const NOW = new Date("2026-09-03T01:00:00.000Z");
const CLIENT_ID = "https://client.example/oauth/client.json";

function document(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: "Example client",
    redirect_uris: ["http://127.0.0.1:43119/callback"],
    token_endpoint_auth_method: "none",
    ...overrides
  };
}

describe("inbound Memory MCP CIMD resolver", () => {
  it("fetches a bounded non-redirected public document and caps its cache lifetime", async () => {
    const fetchMetadata = vi.fn(async (_clientId, init, policy) => {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(policy.allowInsecureHttp).toBe(false);
      expect(policy.addressAllowed(
        { address: "93.184.216.34", family: 4 },
        new URL(CLIENT_ID)
      )).toBe(true);
      expect(policy.addressAllowed(
        { address: "10.0.0.4", family: 4 },
        new URL(CLIENT_ID)
      )).toBe(false);
      expect(policy.addressAllowed(
        { address: "127.0.0.1", family: 4 },
        new URL(CLIENT_ID)
      )).toBe(false);
      return Response.json(document(), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    });
    const resolver = createInboundMcpClientMetadataResolver({
      allowLoopbackDevelopment: false,
      appBaseUrl: "https://aiqsa.example",
      clock: () => NOW,
      fetchMetadata
    });

    await expect(resolver.resolve(CLIENT_ID)).resolves.toMatchObject({
      clientId: CLIENT_ID,
      clientName: "Example client",
      metadataExpiresAt: new Date(NOW.getTime() + INBOUND_MCP_CIMD_CACHE_MAX_AGE_MS)
    });
    expect(fetchMetadata).toHaveBeenCalledOnce();
  });

  it("rejects redirects, non-JSON responses, oversized documents, and identity mismatch", async () => {
    for (const response of [
      new Response(null, { headers: { location: "https://other.example/client.json" }, status: 302 }),
      new Response("not json", { headers: { "content-type": "text/plain" } }),
      Response.json(document(), { headers: { "content-length": "5121" } }),
      Response.json(document({ client_id: "https://other.example/client.json" }))
    ]) {
      const resolver = createInboundMcpClientMetadataResolver({
        allowLoopbackDevelopment: false,
        appBaseUrl: "https://aiqsa.example",
        clock: () => NOW,
        fetchMetadata: async () => response
      });
      await expect(resolver.resolve(CLIENT_ID)).rejects.toEqual(
        new InboundMcpClientMetadataError()
      );
    }
  });

  it("permits only loopback addresses in the explicit local development exception", async () => {
    const localClientId = "http://localhost:43119/oauth/client.json";
    const resolver = createInboundMcpClientMetadataResolver({
      allowLoopbackDevelopment: true,
      appBaseUrl: "http://127.0.0.1:3000",
      clock: () => NOW,
      fetchMetadata: async (_clientId, _init, policy) => {
        expect(policy.allowInsecureHttp).toBe(true);
        expect(policy.addressAllowed(
          { address: "127.0.0.1", family: 4 },
          new URL(localClientId)
        )).toBe(true);
        expect(policy.addressAllowed(
          { address: "192.168.1.2", family: 4 },
          new URL(localClientId)
        )).toBe(false);
        return Response.json(document({ client_id: localClientId }));
      }
    });

    await expect(resolver.resolve(localClientId)).resolves.toMatchObject({
      clientId: localClientId,
      clientOrigin: "http://localhost:43119"
    });
  });
});
