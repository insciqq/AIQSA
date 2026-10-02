import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import {
  classifyPersonalMcpAuthorizationOrigin,
  crossSitePersonalMcpAuthorizationOrigins,
  preparePersonalMcpOAuthDraft
} from "./personalOAuthDiscovery";
import { McpSafeFetchError } from "./safeFetch";

function draftFor(url: string): McpDraftConfiguration {
  return {
    auth: { mode: "oauth", allowedAuthorizationServerOrigins: [new URL(url).origin], scopes: [] },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
    slots: [],
    source: { kind: "remote", url },
    transport: "streamable_http"
  };
}

/** Serves protected-resource metadata on the MCP origin and authorization
 * server metadata for `issuer`; records every requested URL. */
function metadataFetch(input: Readonly<{
  authorizationServer: string;
  endpoints?: Partial<Record<"authorization_endpoint" | "registration_endpoint" | "revocation_endpoint" | "token_endpoint", string>>;
  mcpUrl: string;
}>) {
  const requested: string[] = [];
  const fetch = vi.fn(async (request: unknown, init?: RequestInit) => {
    const url = new URL(String(request));
    requested.push(url.toString());
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.origin === new URL(input.mcpUrl).origin && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ authorization_servers: [input.authorizationServer], resource: input.mcpUrl });
    }
    if (url.origin === new URL(input.authorizationServer).origin && url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        authorization_endpoint: `${input.authorizationServer}/authorize`,
        issuer: input.authorizationServer,
        registration_endpoint: `${input.authorizationServer}/register`,
        response_types_supported: ["code"],
        token_endpoint: `${input.authorizationServer}/token`,
        ...input.endpoints
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return { fetch, requested };
}

describe("personal MCP OAuth discovery", () => {
  it("keeps a network-policy refusal the SDK swallows as the discovery outcome", async () => {
    const mcpUrl = "http://nas.lan:8080/mcp";
    const { fetch: metadata } = metadataFetch({ authorizationServer: "http://nas.lan:8080", mcpUrl });
    // The protected-resource lookup is refused; the SDK falls back to the
    // origin's own authorization metadata, which answers.
    const fetch = vi.fn(async (request: unknown, init?: RequestInit) => {
      if (new URL(String(request)).pathname.startsWith("/.well-known/oauth-protected-resource")) {
        throw new McpSafeFetchError("mcp_local_network_disabled");
      }
      return metadata(request, init);
    });
    await expect(preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch }))
      .rejects.toMatchObject({ code: "mcp_local_network_disabled", name: "PersonalMcpOAuthDiscoveryError" });
    expect(fetch.mock.calls.map(([request]) => new URL(String(request)).pathname))
      .toContain("/.well-known/oauth-authorization-server");
  });

  it("builds its own transport under the personal address policy", async () => {
    const addressPolicy = vi.fn(async () => "mcp_internal_address_forbidden" as const);
    await expect(preparePersonalMcpOAuthDraft(draftFor("http://127.0.0.1:3000/mcp"), { addressPolicy }))
      .rejects.toMatchObject({ code: "mcp_internal_address_forbidden" });
    expect(addressPolicy).toHaveBeenCalledWith({ address: "127.0.0.1", family: 4 }, expect.any(URL));
  });

  it("stores the exact discovered origin set and classifies same-site origins as trusted", async () => {
    const mcpUrl = "https://mcp.example.test/mcp";
    const { fetch } = metadataFetch({
      authorizationServer: "https://auth.example.test",
      endpoints: { token_endpoint: "https://tokens.example.test/token" },
      mcpUrl
    });
    const prepared = await preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch });
    expect(prepared.draft.auth).toMatchObject({
      allowedAuthorizationServerOrigins: ["https://auth.example.test", "https://tokens.example.test"]
    });
    expect(prepared.authorizationOrigins).toEqual([
      { origin: "https://auth.example.test", trust: "same_site" },
      { origin: "https://tokens.example.test", trust: "same_site" }
    ]);
    expect(crossSitePersonalMcpAuthorizationOrigins(prepared.authorizationOrigins)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a foreign authorization server as cross-site so it needs confirmation", async () => {
    const mcpUrl = "https://evil.example/mcp";
    const { fetch } = metadataFetch({ authorizationServer: "https://mcp.notion.com", mcpUrl });
    const prepared = await preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch });
    expect(crossSitePersonalMcpAuthorizationOrigins(prepared.authorizationOrigins)).toEqual(["https://mcp.notion.com"]);
    expect(prepared.draft.auth).toMatchObject({ allowedAuthorizationServerOrigins: ["https://mcp.notion.com"] });
  });

  it.each([
    ["same origin", "https://mcp.example.test/mcp", "https://mcp.example.test", "same_origin"],
    ["same registrable domain", "https://mcp.example.com/mcp", "https://auth.example.com:8443", "same_site"],
    ["http MCP endpoint with an https same-site server", "http://mcp.example.com/mcp", "https://auth.example.com", "same_site"],
    ["private-suffix siblings", "https://a.workers.dev/mcp", "https://b.workers.dev", "cross_site"],
    ["private-suffix siblings on github.io", "https://alice.github.io/mcp", "https://mallory.github.io", "cross_site"],
    ["subdomain under one private-suffix site", "https://mcp.alice.github.io/mcp", "https://auth.alice.github.io", "same_site"],
    ["foreign site", "https://evil.example/mcp", "https://mcp.notion.com", "cross_site"],
    ["IP literal on another port", "https://127.0.0.1:8443/mcp", "https://127.0.0.1:9443", "cross_site"],
    ["IP literal on the same origin", "https://192.0.2.10/mcp", "https://192.0.2.10", "same_origin"],
    ["localhost names", "https://mcp.localhost/mcp", "https://auth.localhost", "cross_site"],
    ["localhost same origin over http", "http://localhost:8787/mcp", "http://localhost:8787", "same_origin"],
    ["single-label hosts", "https://intranet/mcp", "https://auth-intranet", "cross_site"],
    ["same-site http authorization server", "http://mcp.example.com/mcp", "http://mcp.example.com:9000", "cross_site"]
  ] as const)("classifies %s", (_label, endpoint, origin, trust) => {
    expect(classifyPersonalMcpAuthorizationOrigin(endpoint, origin)).toBe(trust);
  });

  it.each([
    ["an http authorization server", { authorizationServer: "http://auth.example.test" }],
    ["an http token endpoint", { authorizationServer: "https://auth.example.test", endpoints: { token_endpoint: "http://auth.example.test/token" } }],
    ["an http authorization endpoint", { authorizationServer: "https://auth.example.test", endpoints: { authorization_endpoint: "http://auth.example.test/authorize" } }],
    ["an http revocation endpoint", { authorizationServer: "https://auth.example.test", endpoints: { revocation_endpoint: "http://auth.example.test/revoke" } }]
  ] as const)("rejects %s under an https MCP endpoint as insecure", async (_label, fixture) => {
    const mcpUrl = "https://mcp.example.test/mcp";
    const { fetch, requested } = metadataFetch({ ...fixture, mcpUrl });
    await expect(preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch }))
      .rejects.toMatchObject({ code: "mcp_oauth_insecure_endpoint" });
    // Plain-HTTP metadata is refused before any request leaves AIQSA.
    expect(requested.every((url) => url.startsWith("https:"))).toBe(true);
  });

  it("lets an acknowledged http endpoint use http OAuth endpoints on its own hostname only", async () => {
    const mcpUrl = "http://mcp.example.test:8787/mcp";
    const own = metadataFetch({ authorizationServer: "http://mcp.example.test:9000", mcpUrl });
    const prepared = await preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch: own.fetch });
    expect(prepared.authorizationOrigins).toEqual([{ origin: "http://mcp.example.test:9000", trust: "cross_site" }]);

    const other = metadataFetch({ authorizationServer: "http://auth.example.test", mcpUrl });
    await expect(preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch: other.fetch }))
      .rejects.toMatchObject({ code: "mcp_oauth_insecure_endpoint" });
    expect(other.requested.some((url) => url.startsWith("http://auth.example.test"))).toBe(false);
  });

  describe("metadata size cap", () => {
    const METADATA_CAP = 512 * 1_024;
    const mcpUrl = "https://mcp.example.test/mcp";
    const authorizationServer = "https://auth.example.test";
    const authorizationMetadata = {
      authorization_endpoint: `${authorizationServer}/authorize`,
      issuer: authorizationServer,
      response_types_supported: ["code"],
      token_endpoint: `${authorizationServer}/token`
    };

    /** Valid authorization-server metadata of exactly `bytes` ASCII bytes. */
    function paddedMetadata(bytes: number): string {
      const empty = JSON.stringify({ ...authorizationMetadata, service_documentation_padding: "" });
      const padded = JSON.stringify({ ...authorizationMetadata, service_documentation_padding: "a".repeat(bytes - empty.length) });
      expect(Buffer.byteLength(padded)).toBe(bytes);
      return padded;
    }

    /** Valid protected-resource metadata, then `metadata` for the authorization server. */
    function servingAuthorizationMetadata(metadata: () => Response) {
      return vi.fn(async (request: unknown) => {
        const url = new URL(String(request));
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          return Response.json({ authorization_servers: [authorizationServer], resource: mcpUrl });
        }
        if (url.origin === authorizationServer && url.pathname.startsWith("/.well-known/oauth-authorization-server")) return metadata();
        return Response.json({ error: "not_found" }, { status: 404 });
      });
    }

    const json = (body: BodyInit) => new Response(body, { headers: { "content-type": "application/json" } });

    it("accepts valid metadata at the cap", async () => {
      const body = paddedMetadata(METADATA_CAP);
      const prepared = await preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch: servingAuthorizationMetadata(() => json(body)) });
      expect(prepared.draft.auth).toMatchObject({ allowedAuthorizationServerOrigins: [authorizationServer] });
    });

    it("rejects valid metadata one byte over the cap", async () => {
      const body = paddedMetadata(METADATA_CAP + 1);
      expect(() => JSON.parse(body) as unknown).not.toThrow();
      await expect(preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch: servingAuthorizationMetadata(() => json(body)) }))
        .rejects.toMatchObject({ code: "mcp_oauth_discovery_failed", name: "PersonalMcpOAuthDiscoveryError" });
    });

    it("stops reading a 64 MiB valid metadata stream shortly after the cap", async () => {
      const chunk = new TextEncoder().encode("a".repeat(64 * 1_024));
      const total = 64 * 1_024 * 1_024;
      let delivered = 0;
      const stream = () => new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered === 0) {
            const prefix = new TextEncoder().encode(JSON.stringify(authorizationMetadata).slice(0, -1) + ',"service_documentation_padding":"');
            delivered += prefix.byteLength;
            controller.enqueue(prefix);
          } else if (delivered < total) {
            delivered += chunk.byteLength;
            controller.enqueue(chunk);
          } else {
            controller.enqueue(new TextEncoder().encode('"}'));
            controller.close();
          }
        }
      });
      await expect(preparePersonalMcpOAuthDraft(draftFor(mcpUrl), { fetch: servingAuthorizationMetadata(() => json(stream())) }))
        .rejects.toMatchObject({ code: "mcp_oauth_discovery_failed" });
      expect(delivered).toBeGreaterThan(METADATA_CAP);
      expect(delivered).toBeLessThan(2 * METADATA_CAP);
    });
  });
});
