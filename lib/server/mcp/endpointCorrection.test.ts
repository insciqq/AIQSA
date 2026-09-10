// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { McpClientSessionError } from "./clientSession";
import { correctedMcpDraft, discoverGitLabMcpEndpoint, type McpValidationOAuthProvider } from "./endpointCorrection";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";

const origin = "https://tools.example.test";
const endpoint = `${origin}/api/v4/mcp`;
const metadataUrl = `${origin}/.well-known/oauth-protected-resource/api/v4/mcp`;
const metadata = { resource: endpoint, authorization_servers: [origin], scopes_supported: ["mcp"] };
const draft: McpDraftConfiguration = {
  auth: { mode: "oauth", allowedAuthorizationServerOrigins: [], scopes: ["mcp"] }, slots: [],
  source: { kind: "remote", url: `${origin}/`, allowPrivateNetwork: true }, transport: "streamable_http",
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 30_000 }
};
const binding = { connectionId: "validation-1", policyFingerprint: "a".repeat(64), tokenVersion: "1" };
const provider = (overrides: Record<string, unknown> = {}): McpValidationOAuthProvider => ({
  discoveryState: () => ({ resourceMetadata: metadata, authorizationServerUrl: origin }),
  validateResourceURL: async () => new URL(endpoint), validationBinding: () => binding,
  exactKnownSecrets: () => ["fixture-access-token"], ...overrides
}) as unknown as McpValidationOAuthProvider;

function transport(options: { challenge?: string; resource?: unknown; status?: number; fail?: boolean } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (options.fail) throw new Error("network-policy-forbidden");
    if (String(url) === endpoint) return new Response(null, { status: options.status ?? 401, headers: {
      "www-authenticate": options.challenge ?? `Bearer realm="GitLab", resource_metadata="${metadataUrl}"`
    } });
    return Response.json(options.resource ?? metadata);
  });
}

describe("bounded GitLab MCP endpoint discovery", () => {
  it("uses validated discovery and one unauthenticated challenge before checking fresh path metadata", async () => {
    const fetch = transport();
    expect(await discoverGitLabMcpEndpoint({ draft, fetch, authProvider: provider() })).toBe(endpoint);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([endpoint, metadataUrl]);
  });

  it("supports root metadata discovery without interpreting arbitrary resource identifiers as transport URLs", async () => {
    const fetch = transport();
    expect(await discoverGitLabMcpEndpoint({ draft, fetch, authProvider: null })).toBe(endpoint);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([`${origin}/.well-known/oauth-protected-resource`, endpoint, metadataUrl]);
  });

  it.each([
    { resource: { ...metadata, resource: "https://other.example.test/api/v4/mcp" } },
    { resource: { ...metadata, resource: [endpoint] } },
    { resource: { ...metadata, resource: `${origin}/audience` } },
    { resource: { ...metadata, resource: `${origin}//other.example.test/api/v4/mcp` } },
    { resource: { ...metadata, resource: `${endpoint}?token=secret` } },
    { resource: { ...metadata, scopes_supported: [] } },
    { resource: { ...metadata, authorization_servers: [origin, "https://other.example.test"] } },
    { challenge: `Bearer realm="Generic", resource_metadata="${metadataUrl}"` },
    { challenge: `Bearer realm="GitLab", resource_metadata="https://other.example.test/metadata"` },
    { challenge: `Bearer realm="GitLab", resource_metadata="${metadataUrl}", resource_metadata="${metadataUrl}"` },
    { status: 302 }, { status: 404 }, { fail: true }
  ])("rejects ambiguous/spoofed/redirected or policy-forbidden discovery %#", async (options) => {
    const fetch = transport(options);
    expect(await discoverGitLabMcpEndpoint({ draft, fetch, authProvider: null })).toBeNull();
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).origin === origin)).toBe(true);
  });

  it("does not read an unbounded metadata document", async () => {
    let canceled = false;
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(33 * 1_024)); }, cancel() { canceled = true; }
    }), { headers: { "content-type": "application/json" } }));
    expect(await discoverGitLabMcpEndpoint({ draft, fetch, authProvider: null })).toBeNull();
    expect(canceled).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains private-network consent and rejects a different origin or missing OAuth binding at publication", () => {
    const correction = { kind: "gitlab" as const, fromUrl: `${origin}/`, toUrl: endpoint, oauthBinding: binding };
    expect(correctedMcpDraft(draft, correction)).toMatchObject({ source: { url: endpoint, allowPrivateNetwork: true } });
    expect(correctedMcpDraft(draft, { ...correction, oauthBinding: undefined })).toBeNull();
    expect(correctedMcpDraft(draft, { ...correction, toUrl: "https://other.example.test/api/v4/mcp" })).toBeNull();
  });
});

describe("endpoint validation before publication", () => {
  function harness(authProvider = provider(), listError?: Error) {
    const events: string[] = [];
    const validator = createRemoteMcpDraftValidator({
      fetch: transport(), oauthProviderForDraft: async () => authProvider,
      sessionFactory(options) {
        const path = options.url.pathname;
        events.push(`open:${path}`);
        return {
          async initialize() {
            events.push(`initialize:${path}`);
            if (path === "/") throw new McpClientSessionError({ code: "mcp_initialize_failed", operation: "initialize", httpStatus: 404 });
          },
          async listAllTools() { events.push("tools"); if (listError) throw listError; return []; },
          async close() { events.push(`close:${path}`); }
        };
      }
    });
    return { events, validate: () => validator.validate({ draft, values: {}, serverId: "server-1", validationUserId: "admin-1" }) };
  }

  it("closes the failed connection, checks the canonical endpoint and returns the exact final token binding", async () => {
    const run = harness();
    expect(await run.validate()).toMatchObject({ kind: "ok", endpointCorrection: { fromUrl: `${origin}/`, toUrl: endpoint, oauthBinding: binding },
      evidence: { endpointCorrection: { kind: "gitlab", endpoint } } });
    expect(run.events).toEqual(["open:/", "initialize:/", "close:/", "open:/api/v4/mcp", "initialize:/api/v4/mcp", "tools", "close:/api/v4/mcp"]);
  });

  it("requires reauthorization before sending any authenticated candidate request for a mismatched audience", async () => {
    const run = harness(provider({ validateResourceURL: async () => new URL(`${origin}/different-audience`) }));
    expect(await run.validate()).toMatchObject({ kind: "invalid", issues: [{ code: "mcp_gitlab_reauthorization_required" }] });
    expect(run.events).toEqual(["open:/", "initialize:/", "close:/"]);
  });

  it("does not publish or retry another candidate when tools discovery fails", async () => {
    const run = harness(provider(), new McpClientSessionError({ code: "mcp_list_tools_failed", operation: "list_tools", httpStatus: 403 }));
    expect(await run.validate()).toMatchObject({ kind: "invalid", issues: [
      { httpStatus: 403, operation: "list_tools", endpoint }, { code: "mcp_gitlab_endpoint_failed" }
    ] });
    expect(run.events.filter((event) => event.startsWith("open:"))).toHaveLength(2);
  });
});
