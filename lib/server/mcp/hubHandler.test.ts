import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createFixedWindowLoginRateLimiter } from "../auth/rateLimit";
import { createMcpHubHandler } from "./hubHandler";
import { createMcpHubService, type McpHubServiceDependencies } from "./hubService";
import { namespacedMcpToolName, type McpRunPlanResult } from "./runPlan";
import { isMcpHubEnabled, MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL } from "./hubConfiguration";

const endpoint = new URL("http://localhost:3000/mcp/hub");
const token = "fixture-hub-access-token";
const toolId = namespacedMcpToolName("fixture", "lookup");
const clients = new Set<Client>();
const plan: Extract<McpRunPlanResult, { ok: true }> = {
  ok: true,
  bindings: [{ fingerprint: "fixture-config", runtimeGenerationId: "fixture-runtime", serverId: "fixture-server" }],
  snapshot: {
    version: 1,
    servers: [{ fingerprint: "fixture-config", revisionId: "fixture-revision", serverId: "fixture-server", serverName: "Fixture" }],
    tools: [{
      definitionHash: "a".repeat(64), description: "Look up records", inputSchema: {
        type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false
      },
      name: "lookup", namespacedName: toolId, originalName: "lookup", serverId: "fixture-server", serverName: "Fixture"
    }]
  }
};

function fixture(overrides: Partial<McpHubServiceDependencies> = {}, deadlineMs = 1_000) {
  let active = true;
  const base: McpHubServiceDependencies = {
    callRuntimeTool: vi.fn(async () => ({ isError: false, structuredContent: { count: 1 }, text: ["One record"], unsupportedContentTypes: [] })),
    catalog: vi.fn(async () => ({ version: 1 as const, servers: [{
      serverId: "fixture-server", serverName: "Fixture", namespace: "fixture", revisionId: "fixture-revision",
      description: "Synthetic integration", tools: [{ arguments: [], description: "Look up records", namespacedName: toolId, originalName: "lookup" }]
    }] })),
    filterTools: vi.fn(async (_owner, tools) => [...tools]),
    inspect: vi.fn(async () => plan),
    materialize: vi.fn(async () => plan),
    recordDispatch: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
    recordDiscoveryAttempt: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
    router: { route: vi.fn(async () => ({ toolNames: [toolId], usageAttribution: null })) },
    ...overrides
  };
  const dependencies: McpHubServiceDependencies = {
    ...base,
    callRuntimeTool: vi.fn(async (input) => {
      await input.beforeDispatch();
      return base.callRuntimeTool(input);
    })
  };
  const resolveAccessToken = vi.fn(async (candidate: string, resource?: string) =>
    active && candidate === token && resource === endpoint.href ? {
      capability: "mcp:hub" as const, resource, clientId: "fixture-client", expiresAt: new Date(Date.now() + 60_000),
      grantId: "fixture-grant", userId: "fixture-owner"
    } : null);
  const handler = createMcpHubHandler({
    deadlineMs,
    getConfig: () => getAuthConfig({ AIQSA_APP_BASE_URL: endpoint.origin, AIQSA_AUTH_SESSION_SECRET: "fixture-hub-session-secret", NODE_ENV: "test" }),
    issuer: endpoint.origin,
    limiter: createFixedWindowLoginRateLimiter({ maxAttempts: 120 }),
    oauthService: { resolveAccessToken },
    service: createMcpHubService(dependencies)
  });
  return { dependencies, handler, resolveAccessToken, revoke() { active = false; } };
}

async function connect(handler: ReturnType<typeof createMcpHubHandler>, legacy = false) {
  const fetch: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set("host", endpoint.host);
    return handler.POST(new Request(request, { headers }));
  };
  const client = new Client({ name: "hub-fixture", version: "1.0.0" }, {
    versionNegotiation: legacy ? { mode: "legacy" } : { mode: { pin: "2026-07-28" } }
  });
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token }, fetch, requestInit: { headers: { host: endpoint.host } }
  }));
  clients.add(client);
  return client;
}

async function find(client: Client) {
  const result = await client.callTool({ name: "find_tools", arguments: { goal: "Найти записи / find records" } });
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as { tools: { tool_id: string; tool_version: string }[] };
  const { tool_id, tool_version } = data.tools[0]!;
  return { tool_id, tool_version };
}

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

describe("MCP Hub protocol boundary", () => {
  it("rejects batched requests before they can multiply admitted work", async () => {
    const test = fixture();
    const response = await test.handler.POST(new Request(endpoint, {
      method: "POST", headers: {
        host: endpoint.host, authorization: `Bearer ${token}`, "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_tools", arguments: { goal: "records" } } }])
    }));
    expect(response.status).toBe(400);
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects excess concurrent work before discovery and releases capacity after completion (legacy=%s)", async (legacy) => {
    const finish: (() => void)[] = [];
    const route = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish.push(resolve); });
      return { toolNames: [], usageAttribution: null };
    });
    const test = fixture({ router: { route } }, 5_000);
    const client = await connect(test.handler, legacy);
    const pending = Array.from({ length: MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL }, () =>
      client.callTool({ name: "find_tools", arguments: { goal: "find records" } }));
    try {
      await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(pending.length));
      const excess = await test.handler.POST(new Request(endpoint, {
        method: "POST", headers: {
          host: endpoint.host, authorization: `Bearer ${token}`, "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "find_tools", arguments: { goal: "find records" } } })
      }));
      expect(excess.status).toBe(429);
      expect(excess.headers.get("retry-after")).toBe("1");
      expect(route).toHaveBeenCalledTimes(pending.length);
    } finally {
      finish.forEach((resolve) => resolve());
      await Promise.all(pending);
    }
    route.mockResolvedValue({ toolNames: [], usageAttribution: null });
    expect((await client.callTool({ name: "find_tools", arguments: { goal: "find records" } })).isError).not.toBe(true);
  });

  it.each(["0", "false", "", "unexpected"])("fails closed when the Hub switch is %j", async (value) => {
    const resolveAccessToken = vi.fn(async () => null);
    const handler = createMcpHubHandler({
      issuer: endpoint.origin, isEnabled: () => isMcpHubEnabled({ AIQSA_MCP_HUB_ENABLED: value }),
      oauthService: { resolveAccessToken }
    });
    const response = await handler.POST(new Request(endpoint, { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "mcp_hub_disabled" });
    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it.each([true, false])("exposes exactly two tools and delivers a useful text/JSON result (legacy=%s)", async (legacy) => {
    const test = fixture();
    const client = await connect(test.handler, legacy);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["find_tools", "call_tool"]);
    expect(listed.tools[1]?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    const tool = await find(client);
    expect(test.dependencies.callRuntimeTool).not.toHaveBeenCalled();
    const result = await client.callTool({ name: "call_tool", arguments: { ...tool, arguments: { query: "fixture" } } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "One record" }], structuredContent: { count: 1 } });
    expect(test.dependencies.callRuntimeTool).toHaveBeenCalledOnce();
    expect(test.dependencies.router.route).toHaveBeenCalledOnce();
    expect(test.dependencies.recordDispatch).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "fixture-client", grantId: "fixture-grant", resourcePath: "/mcp/hub", userId: "fixture-owner"
    }));
  });

  it("challenges absent, foreign and revoked tokens before reading any private catalog", async () => {
    const test = fixture();
    for (const candidate of [null, "fixture-memory-token", token]) {
      if (candidate === token) test.revoke();
      const response = await test.handler.POST(new Request(endpoint, {
        body: "{}", method: "POST", headers: {
          host: endpoint.host, "content-type": "application/json", ...(candidate ? { authorization: `Bearer ${candidate}` } : {})
        }
      }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp/hub");
    }
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
    expect(test.dependencies.router.route).not.toHaveBeenCalled();
  });

  it.each(["user_id", "resource", "server_url", "oauth_token", "context"])("rejects client-supplied %s before discovery", async (field) => {
    const test = fixture();
    const client = await connect(test.handler);
    const result = await client.callTool({ name: "find_tools", arguments: { goal: "find records", [field]: "private spoof" } });
    expect(result.isError).toBe(true);
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
  });

  it("does not reflect arbitrary private argument names or values in validation errors", async () => {
    const test = fixture();
    const client = await connect(test.handler);
    const result = await client.callTool({ name: "find_tools", arguments: { goal: "find records", PRIVATE_CANARY_NAME: "PRIVATE_CANARY_VALUE" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
  });

  it("withholds a completed upstream result after revocation", async () => {
    const test = fixture({ callRuntimeTool: vi.fn(async () => {
      test.revoke();
      return { isError: false, structuredContent: { private: true }, text: ["private fixture result"], unsupportedContentTypes: [] };
    }) });
    const client = await connect(test.handler);
    const tool = await find(client);
    const result = await client.callTool({ name: "call_tool", arguments: { ...tool, arguments: { query: "fixture" } } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "authorization_required" } });
    expect(JSON.stringify(result)).not.toContain("private fixture result");
    expect(test.dependencies.callRuntimeTool).toHaveBeenCalledOnce();
  });

  it.each([true, false])("aborts discovery at the request deadline and never prepares a late model selection (legacy=%s)", async (legacy) => {
    let signal: AbortSignal | undefined;
    let finish!: (value: { toolNames: string[]; usageAttribution: null }) => void;
    const test = fixture({ router: { route: vi.fn(async (input) => {
      signal = input.signal;
      return new Promise<{ toolNames: string[]; usageAttribution: null }>((resolve) => { finish = resolve; });
    }) } }, 40);
    const client = await connect(test.handler, legacy);
    const result = await client.callTool({ name: "find_tools", arguments: { goal: "find records" } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "request_cancelled" } });
    expect(signal?.aborted).toBe(true);
    finish({ toolNames: [toolId], usageAttribution: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.dependencies.materialize).not.toHaveBeenCalled();
  });

  it.each([true, false])("aborts a dispatched call at the deadline, records UNKNOWN and performs no replay (legacy=%s)", async (legacy) => {
    const settle = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    const test = fixture({
      recordDispatch: vi.fn(async () => ({ settle })),
      callRuntimeTool: vi.fn(async (input) => {
        signal = input.signal;
        return new Promise<never>((_resolve, reject) => {
          input.signal!.addEventListener("abort", () => reject(new Error("lost response")), { once: true });
        });
      })
    }, 40);
    const client = await connect(test.handler, legacy);
    const tool = await find(client);
    const result = await client.callTool({ name: "call_tool", arguments: { ...tool, arguments: { query: "fixture" } } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "execution_outcome_unknown" } });
    expect(signal?.aborted).toBe(true);
    expect(test.dependencies.callRuntimeTool).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith("UNKNOWN", "execution_outcome_unknown"));
  });
});
