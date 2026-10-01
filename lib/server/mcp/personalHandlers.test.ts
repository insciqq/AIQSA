import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration, UserMcpServer } from "@/lib/contracts/mcp";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import type { McpRepository } from "./repositoryContract";
import { createPersonalMcpCreateHandler, createPersonalMcpListHandler, createPersonalMcpUpdateHandler } from "./personalHandlers";
import { preparePersonalMcpOAuthDraft } from "./personalOAuthDiscovery";

const server: UserMcpServer = {
  accountLabel: null,
  description: "Synthetic personal MCP",
  enabled: true,
  fields: [],
  id: "personal-1",
  knownToolCount: 1,
  name: "Synthetic personal MCP",
  oauthAvailable: false,
  oauthState: null,
  readiness: "idle",
  sourceType: "personal",
  tools: [{ description: "Echo", name: "echo" }]
};

function deps() {
  const createPersonalServer = vi.fn(async () => ({ kind: "ok" as const, value: { ...server, runtimeGenerationId: null, errorCode: null } }));
  const updateUserServer = vi.fn(async () => ({ kind: "ok" as const, value: { ...server, runtimeGenerationId: null, errorCode: null } }));
  const repository = { createPersonalServer, updateUserServer } as unknown as McpRepository;
  const resolveAuth = (async () => ({ userId: "user-1", user: { id: "user-1", role: "user", status: "active" } })) as unknown as RequestAuthResolver;
  const rateLimiter = { check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) };
  return { repository, resolveAuth, createPersonalServer, rateLimiter, updateUserServer };
}

/** Discovery against a synthetic MCP origin whose advertised authorization
 * server can change between submissions. */
function oauthDiscovery(initialAuthorizationServer: string) {
  const state = { authorizationServer: initialAuthorizationServer };
  const fetch = vi.fn(async (request: unknown) => {
    const url = new URL(String(request));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ authorization_servers: [state.authorizationServer], resource: "https://mcp.example.test/mcp" });
    }
    if (url.origin === state.authorizationServer && url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        authorization_endpoint: `${state.authorizationServer}/authorize`,
        issuer: state.authorizationServer,
        response_types_supported: ["code"],
        token_endpoint: `${state.authorizationServer}/token`
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return {
    fetch,
    prepareOAuthDraft: (draft: McpDraftConfiguration) => preparePersonalMcpOAuthDraft(draft, { fetch }),
    state
  };
}

function oauthCreate(body: Record<string, unknown> = {}) {
  return new Request("https://aiqsa.test/api/me/mcp-connections", {
    body: JSON.stringify({ auth: { mode: "oauth" }, name: "Hosted", url: "https://mcp.example.test/mcp", ...body }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function storedOrigins(createPersonalServer: ReturnType<typeof deps>["createPersonalServer"]): unknown {
  const call = createPersonalServer.mock.calls[0] as unknown as [{ draft: McpDraftConfiguration }] | undefined;
  const auth = call?.[0].draft.auth;
  return auth?.mode === "oauth" ? auth.allowedAuthorizationServerOrigins : undefined;
}

describe("personal MCP handlers", () => {
  it("requires explicit acknowledgement for plain HTTP", async () => {
    const input = deps();
    const handler = createPersonalMcpCreateHandler(input);
    const response = await handler(new Request("http://aiqsa.test/api/me/mcp-connections", {
      body: JSON.stringify({ name: "Local", url: "http://127.0.0.1:8787/mcp", auth: { mode: "none" } }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(422);
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it("passes an explicitly acknowledged HTTP endpoint to the owner-bound repository", async () => {
    const input = deps();
    const handler = createPersonalMcpCreateHandler(input);
    const response = await handler(new Request("http://aiqsa.test/api/me/mcp-connections", {
      body: JSON.stringify({ insecureHttpAcknowledged: true, name: "Local", url: "http://127.0.0.1:8787/mcp", auth: { mode: "none" } }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(201);
    expect(input.createPersonalServer).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ source: { kind: "remote", url: "http://127.0.0.1:8787/mcp" } }),
      userId: "user-1"
    }));
  });

  it("updates one selected tool through the owner-bound connection", async () => {
    const input = deps();
    const handler = createPersonalMcpUpdateHandler(input);
    const response = await handler(new Request("http://aiqsa.test/api/me/mcp-connections/personal-1", {
      body: JSON.stringify({ tool: { enabled: false, name: "echo" } }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), { params: { connectionId: "personal-1" } });
    expect(response.status).toBe(200);
    expect(input.updateUserServer).toHaveBeenCalledWith({
      personalOnly: true,
      serverId: "personal-1",
      tool: { enabled: false, name: "echo" },
      userId: "user-1"
    });
  });

  it.each([
    { auth: { mode: "static", headerName: "Cookie" }, values: { authorization: "fixture-key" } },
    { auth: { mode: "static", headerName: "Authorization\r\nHost" }, values: { authorization: "fixture-key" } },
    { auth: { mode: "static" }, values: { authorization: "fixture\r\nInjected: true" } },
    { auth: { mode: "static" }, values: { authorization: 42 } },
    { auth: { mode: "none" }, values: { authorization: "unexpected-key" } },
    { auth: "oauth" }
  ])("rejects malformed authentication before repository mutation", async (auth) => {
    const input = deps();
    const response = await createPersonalMcpCreateHandler(input)(new Request("https://aiqsa.test/api/me/mcp-connections", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fixture", url: "https://mcp.example.test/mcp", ...auth })
    }));
    expect(response.status).toBe(422);
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it("awaits mutation startup and returns safe refreshed state without internal identifiers", async () => {
    const input = deps();
    const listUserServers = vi.fn(async () => [{ ...server, errorCode: "private diagnostic", runtimeGenerationId: "private-generation", readiness: "ready" as const }]);
    input.repository.listUserServers = listUserServers;
    const onConnectionChanged = vi.fn(async () => undefined);
    const response = await createPersonalMcpUpdateHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    }), { params: { connectionId: "personal-1" } });
    expect(onConnectionChanged).toHaveBeenCalledWith("user-1", "personal-1");
    expect(listUserServers).toHaveBeenCalledWith("user-1");
    const body = await response.json();
    expect(body.server).toMatchObject({ readiness: "ready" });
    expect(body.server).not.toHaveProperty("runtimeGenerationId");
    expect(body.server).not.toHaveProperty("errorCode");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("never wakes runtimes from settings reads", async () => {
    const input = deps();
    input.repository.listUserServers = vi.fn(async () => [{ ...server, errorCode: null, runtimeGenerationId: null }]);
    const onConnectionChanged = vi.fn(async () => undefined);
    const response = await createPersonalMcpListHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections"));
    expect(response.status).toBe(200);
    expect(onConnectionChanged).not.toHaveBeenCalled();
  });

  it.each([{}, { enabled: "yes" }, { tool: { name: "", enabled: true } }])("rejects invalid empty updates", async (body) => {
    const input = deps();
    const response = await createPersonalMcpUpdateHandler(input)(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }), { params: { connectionId: "personal-1" } });
    expect(response.status).toBe(400);
    expect(input.updateUserServer).not.toHaveBeenCalled();
  });
  it("connects a same-site authorization server with no confirmation step", async () => {
    const input = deps();
    const discovery = oauthDiscovery("https://auth.example.test");
    const response = await createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft: discovery.prepareOAuthDraft })(oauthCreate());
    expect(response.status).toBe(201);
    expect(storedOrigins(input.createPersonalServer)).toEqual(["https://auth.example.test"]);
  });

  it("requires explicit confirmation of exact cross-site origins and stores only the rediscovered set", async () => {
    const input = deps();
    const discovery = oauthDiscovery("https://accounts.foreign.test");
    const handler = createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft: discovery.prepareOAuthDraft });

    const first = await handler(oauthCreate());
    expect(first.status).toBe(422);
    expect(await first.json()).toEqual({
      authorizationOrigins: ["https://accounts.foreign.test"],
      error: "oauth_authorization_origin_confirmation_required",
      issues: [{ code: "oauth_authorization_origin_confirmation_required", path: "authorizationOriginsAcknowledged" }]
    });
    expect(input.createPersonalServer).not.toHaveBeenCalled();

    const confirmed = await handler(oauthCreate({
      authorizationOriginsAcknowledged: ["https://accounts.foreign.test", "https://never-discovered.test"]
    }));
    expect(confirmed.status).toBe(201);
    // The client's list never widens the durable policy.
    expect(storedOrigins(input.createPersonalServer)).toEqual(["https://accounts.foreign.test"]);
    expect(discovery.fetch.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses a resubmit whose rediscovery returns a different cross-site origin", async () => {
    const input = deps();
    const discovery = oauthDiscovery("https://accounts.foreign.test");
    const handler = createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft: discovery.prepareOAuthDraft });
    discovery.state.authorizationServer = "https://accounts.changed.test";
    const response = await handler(oauthCreate({ authorizationOriginsAcknowledged: ["https://accounts.foreign.test"] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      authorizationOrigins: ["https://accounts.changed.test"],
      error: "oauth_authorization_origin_confirmation_required"
    });
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it("rejects http OAuth endpoints under an https MCP endpoint at create", async () => {
    const input = deps();
    const discovery = oauthDiscovery("http://auth.example.test");
    const response = await createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft: discovery.prepareOAuthDraft })(oauthCreate());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "mcp_oauth_insecure_endpoint" });
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it.each([
    "https://accounts.foreign.test",
    ["https://accounts.foreign.test/path"],
    [42],
    Array.from({ length: 33 }, (_value, index) => `https://origin-${index}.test`)
  ])("rejects a malformed origin acknowledgement before discovery", async (authorizationOriginsAcknowledged) => {
    const input = deps();
    const prepareOAuthDraft = vi.fn();
    const response = await createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft })(oauthCreate({ authorizationOriginsAcknowledged }));
    expect(response.status).toBe(400);
    expect(prepareOAuthDraft).not.toHaveBeenCalled();
  });

  it("throttles creates and confirmation resubmits per user without upstream detail", async () => {
    const input = deps();
    const prepareOAuthDraft = vi.fn();
    input.rateLimiter.check.mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 412 });
    const handler = createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft: async (draft: McpDraftConfiguration) => {
      prepareOAuthDraft();
      return { authorizationOrigins: [{ origin: "https://accounts.foreign.test", trust: "cross_site" as const }], draft };
    } });
    expect((await handler(oauthCreate())).status).toBe(422);
    const limited = await handler(oauthCreate({ authorizationOriginsAcknowledged: ["https://accounts.foreign.test"] }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("412");
    expect(await limited.json()).toEqual({ error: "personal_mcp_rate_limited" });
    expect(input.rateLimiter.check).toHaveBeenNthCalledWith(2, "personal-mcp:create:user:user-1", { maxAttempts: 10 });
    expect(prepareOAuthDraft).toHaveBeenCalledOnce();
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it("fails closed when the create limiter is unavailable", async () => {
    const input = deps();
    input.rateLimiter.check.mockRejectedValueOnce(new Error("limiter down"));
    const response = await createPersonalMcpCreateHandler(input)(oauthCreate());
    expect(response.status).toBe(503);
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });
});
