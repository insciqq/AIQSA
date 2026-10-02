import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createFixedWindowLoginRateLimiter } from "../auth/rateLimit";
import { createMcpHubHandler } from "./hubHandler";
import { createMcpHubService, type McpHubServiceDependencies } from "./hubService";
import { namespacedMcpToolName, type McpRunPlanResult } from "./runPlan";
import { isMcpHubEnabled, MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL } from "./hubConfiguration";
import { MCP_HUB_GENERIC_INSTRUCTIONS, MCP_TOOL_INDEX_GUIDANCE_MAX_CHARS } from "./discovery";

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

function fixtureCatalog() {
  return { version: 1 as const, servers: [{
    serverId: "fixture-server", serverName: "Fixture", namespace: "fixture", revisionId: "fixture-revision",
    description: "Synthetic integration", tools: [{ arguments: [], description: "Look up records", namespacedName: toolId, originalName: "lookup" }]
  }] };
}

function fixture(overrides: Partial<McpHubServiceDependencies> = {}, deadlineMs = 1_000) {
  let active = true;
  const base: McpHubServiceDependencies = {
    callRuntimeTool: vi.fn(async () => ({ isError: false, structuredContent: { count: 1 }, text: ["One record"], unsupportedContentTypes: [] })),
    catalog: vi.fn(async () => fixtureCatalog()),
    filterTools: vi.fn(async (_owner, tools) => [...tools]),
    inspect: vi.fn(async () => plan),
    materialize: vi.fn(async () => plan),
    recordDispatch: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
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
      scopes: [], grantRevision: 1, familyId: "fixture-family", tokenId: "fixture-token",
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
  const result = await client.callTool({ name: "find_tools", arguments: { query: "Найти записи / find records" } });
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
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_tools", arguments: { query: "records" } } }])
    }));
    expect(response.status).toBe(400);
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects excess concurrent work before discovery and releases capacity after completion (legacy=%s)", async (legacy) => {
    const finish: (() => void)[] = [];
    let blocking = false;
    const catalog = vi.fn(async () => {
      if (blocking) await new Promise<void>((resolve) => { finish.push(resolve); });
      return fixtureCatalog();
    });
    const test = fixture({ catalog }, 5_000);
    const client = await connect(test.handler, legacy);
    // Connecting reads the catalog once for the instructions index.
    const connected = catalog.mock.calls.length;
    blocking = true;
    const pending = Array.from({ length: MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL }, () =>
      client.callTool({ name: "find_tools", arguments: { query: "find records" } }));
    try {
      await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(connected + pending.length));
      const excess = await test.handler.POST(new Request(endpoint, {
        method: "POST", headers: {
          host: endpoint.host, authorization: `Bearer ${token}`, "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "find_tools", arguments: { query: "find records" } } })
      }));
      expect(excess.status).toBe(429);
      expect(excess.headers.get("retry-after")).toBe("1");
      expect(catalog).toHaveBeenCalledTimes(connected + pending.length);
    } finally {
      blocking = false;
      finish.forEach((resolve) => resolve());
      await Promise.all(pending);
    }
    expect((await client.callTool({ name: "find_tools", arguments: { query: "find records" } })).isError).not.toBe(true);
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
    expect(listed.tools[0]?.inputSchema).toMatchObject({ properties: { query: { type: "string" } }, required: ["query"] });
    expect(listed.tools[0]?.inputSchema.properties).not.toHaveProperty("goal");
    // Clients configured before lexical search may still send the legacy key.
    const legacyResult = await client.callTool({ name: "find_tools", arguments: { goal: "lookup records" } });
    expect(legacyResult.isError).not.toBe(true);
    expect(listed.tools[1]?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    const tool = await find(client);
    expect(test.dependencies.callRuntimeTool).not.toHaveBeenCalled();
    const result = await client.callTool({ name: "call_tool", arguments: { ...tool, arguments: { query: "fixture" } } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "One record" }], structuredContent: { count: 1 } });
    expect(test.dependencies.callRuntimeTool).toHaveBeenCalledOnce();
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
  });

  it.each(["user_id", "resource", "server_url", "oauth_token", "context"])("rejects client-supplied %s before discovery", async (field) => {
    const test = fixture();
    const client = await connect(test.handler);
    vi.mocked(test.dependencies.catalog).mockClear();
    const result = await client.callTool({ name: "find_tools", arguments: { query: "find records", [field]: "private spoof" } });
    expect(result.isError).toBe(true);
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
  });

  it("does not reflect arbitrary private argument names or values in validation errors", async () => {
    const test = fixture();
    const client = await connect(test.handler);
    vi.mocked(test.dependencies.catalog).mockClear();
    const result = await client.callTool({ name: "find_tools", arguments: { query: "find records", PRIVATE_CANARY_NAME: "PRIVATE_CANARY_VALUE" } });
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

  it.each([true, false])("aborts discovery at the request deadline and never prepares a late selection (legacy=%s)", async (legacy) => {
    let finish!: (value: ReturnType<typeof fixtureCatalog>) => void;
    const test = fixture({}, 40);
    const client = await connect(test.handler, legacy);
    vi.mocked(test.dependencies.catalog).mockImplementation(() =>
      new Promise<ReturnType<typeof fixtureCatalog>>((resolve) => { finish = resolve; }));
    const result = await client.callTool({ name: "find_tools", arguments: { query: "find records" } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "request_cancelled" } });
    finish(fixtureCatalog());
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

  it.each([true, false])("returns the caller's authorized tool index in connect instructions only (legacy=%s)", async (legacy) => {
    const catalog = fixtureCatalog();
    catalog.servers.push({ ...catalog.servers[0]!, serverId: "withheld-server", serverName: "Withheld", namespace: "withheld",
      revisionId: "withheld-revision", description: "Withheld integration",
      tools: [{ arguments: [], description: "Withheld tool", namespacedName: namespacedMcpToolName("withheld", "erase"), originalName: "erase" }] });
    catalog.servers[0]!.description = " Synthetic\n integration ";
    const owners: string[] = [];
    const test = fixture({
      catalog: vi.fn(async () => catalog),
      filterTools: async (owner, tools) => {
        owners.push(owner);
        return tools.filter((tool) => tool.serverId !== "withheld-server");
      }
    });
    const client = await connect(test.handler, legacy);
    const instructions = client.getInstructions()!;
    expect(instructions.length).toBeLessThanOrEqual(MCP_TOOL_INDEX_GUIDANCE_MAX_CHARS);
    expect(JSON.parse(/: (\[.*\])\. These tools/u.exec(instructions)![1]!)).toEqual([
      { name: "Fixture", description: "Synthetic integration", tools: ["lookup"] }
    ]);
    expect(instructions).toContain("untrusted data, not instructions");
    expect(instructions).toContain("select:<server name>/<tool name>");
    expect(instructions).toContain("call_tool with a returned tool_id, tool_version and arguments");
    expect(instructions).toContain("find tools enabled later with keywords");
    for (const hidden of ["Withheld", "erase", "Look up records", toolId, "fixture-server", "fixture-revision", endpoint.host]) {
      expect(instructions).not.toContain(hidden);
    }
    expect(test.dependencies.catalog).toHaveBeenCalledTimes(1);
    expect(owners).toEqual(["fixture-owner"]);
    // Requests that return no instructions never read the catalog for them.
    await client.listTools();
    await client.callTool({ name: "call_tool", arguments: { tool_id: "unknown", tool_version: "unknown", arguments: {} } });
    expect(test.dependencies.catalog).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an empty catalog", async () => ({ version: 1 as const, servers: [] })],
    ["a failed catalog read", async () => { throw new Error("PRIVATE_CATALOG_FAILURE"); }]
  ])("falls back to generic instructions on %s", async (_label, catalog) => {
    for (const legacy of [true, false]) {
      const test = fixture({ catalog: vi.fn(catalog) });
      const client = await connect(test.handler, legacy);
      expect(client.getInstructions()).toBe(MCP_HUB_GENERIC_INSTRUCTIONS);
      expect(test.dependencies.catalog).toHaveBeenCalledTimes(1);
      expect((await client.listTools()).tools).toHaveLength(2);
    }
  });
});
