import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryConsumerItem } from "../../contracts/memoryConsumer";
import { getAuthConfig } from "../auth/config";
import { createFixedWindowLoginRateLimiter } from "../auth/rateLimit";
import type { MemoryConsumerService } from "../memory/consumer/service";
import { MemoryConsumerServiceError } from "../memory/consumer/service";
import type { MemoryNativeFactSearchService } from
  "../memory/retrieval/nativeFactSearch";
import { createMemoryMcpHandler } from "./handler";
import type { InboundMcpOAuthService } from "./oauth/service";
import { inboundMcpOAuthConfiguration } from "./oauth/service";
import {
  MEMORY_MCP_SERVER_INSTRUCTIONS,
  MEMORY_MCP_TOOL_NAMES
} from "./server";

const endpoint = new URL("http://localhost:3000/mcp");
const activeToken = `aiqsa_ma_${"A".repeat(43)}`;
const openClients = new Set<Client>();

const firstItem: MemoryConsumerItem = {
  allowedActions: ["EDIT", "FORGET"],
  category: "PREFERENCES",
  createdAt: "2026-09-03T01:00:00.000Z",
  memoryRef: "mcm1.first-ref",
  provenance: "SAVED",
  sourceAvailable: true,
  statement: "I prefer aisle seats.",
  updatedAt: "2026-09-03T01:00:00.000Z"
};
const updatedItem = {
  ...firstItem,
  memoryRef: "mcm1.updated-ref",
  statement: "I prefer aisle seats on flights.",
  updatedAt: "2026-09-03T01:01:00.000Z"
};

function memoryService(): MemoryConsumerService {
  return {
    create: vi.fn(async () => ({ item: firstItem })),
    edit: vi.fn(async () => ({ item: updatedItem })),
    forget: vi.fn(async () => ({ status: "FORGOTTEN" as const })),
    get: vi.fn(async () => ({ item: firstItem })),
    list: vi.fn(async () => ({ items: [firstItem], nextCursor: "mcm1.cursor" })),
    patchSettings: vi.fn(async () => { throw new Error("not exposed"); }),
    reset: vi.fn(async () => { throw new Error("not exposed"); }),
    search: vi.fn(async () => ({ items: [firstItem], nextCursor: null })),
    settings: vi.fn(async () => { throw new Error("not exposed"); })
  };
}

function nativeSearchService(): MemoryNativeFactSearchService {
  return {
    search: vi.fn(async () => ({ items: [firstItem] }))
  };
}

function oauthService(
  resolve: (token: string) => Promise<{
    clientId: string;
    expiresAt: Date;
    grantId: string;
    userId: string;
  } | null> = async (token) => token === activeToken ? {
    clientId: "codex-client",
    expiresAt: new Date(Date.now() + 60_000),
    grantId: "grant-1",
    userId: "owner-1"
  } : null
): InboundMcpOAuthService {
  const unsupported = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    approveAuthorization: unsupported,
    configuration: inboundMcpOAuthConfiguration(endpoint.origin, "test"),
    denyAuthorization: unsupported,
    listConnectedApps: vi.fn(async () => []),
    prepareAuthorization: unsupported,
    registerClient: unsupported,
    resolveAccessToken: vi.fn(resolve),
    revokeConnectedApp: vi.fn(async () => false),
    revokeToken: vi.fn(async () => undefined),
    token: unsupported
  };
}

function config() {
  return getAuthConfig({
    AIQSA_APP_BASE_URL: endpoint.origin,
    AIQSA_AUTH_SESSION_SECRET: "test-memory-mcp-session-secret",
    NODE_ENV: "test"
  });
}

function handler(input: Readonly<{
  deadlineMs?: number;
  oauth?: InboundMcpOAuthService;
  searchService?: MemoryNativeFactSearchService;
  service?: MemoryConsumerService;
}> = {}) {
  const service = input.service ?? memoryService();
  const searchService = input.searchService ?? nativeSearchService();
  return {
    route: createMemoryMcpHandler({
      deadlineMs: input.deadlineMs,
      getConfig: config,
      oauthService: input.oauth ?? oauthService(),
      rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 120 }),
      searchService,
      service
    }),
    searchService,
    service
  };
}

async function connect(
  route: ReturnType<typeof createMemoryMcpHandler>,
  token = activeToken,
  protocolVersion: "2026-07-28" | "2025-11-25" = "2026-07-28"
): Promise<Client> {
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("host", endpoint.host);
    return route.POST(new Request(request, { headers }));
  };
  const client = new Client({ name: "memory-mcp-test", version: "1.0.0" }, {
    versionNegotiation: protocolVersion === "2025-11-25"
      ? { mode: "legacy" }
      : { mode: { pin: protocolVersion } }
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token },
    fetch,
    requestInit: { headers: { host: endpoint.host } }
  });
  await client.connect(transport);
  openClients.add(client);
  return client;
}

afterEach(async () => {
  await Promise.all(Array.from(openClients, async (client) => client.close()));
  openClients.clear();
});

describe("Personal Memory MCP handler", () => {
  it("serves the same owner-bound tools to stable 2025-era clients", async () => {
    const { route, service } = handler();
    const client = await connect(route, activeToken, "2025-11-25");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(MEMORY_MCP_TOOL_NAMES);

    await client.callTool({
      name: "add_memory",
      arguments: { text: "I prefer aisle seats." }
    });
    expect(service.create).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({ statement: "I prefer aisle seats." }),
      { authority: "DELEGATED_MCP" }
    );
  });

  it("serves exactly six modern tools and maps every call to the token owner", async () => {
    const { route, searchService, service } = handler();
    const client = await connect(route);
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(MEMORY_MCP_TOOL_NAMES);
    expect(client.getInstructions()).toBe(MEMORY_MCP_SERVER_INSTRUCTIONS);
    expect(listed.tools.every((tool) =>
      JSON.stringify(tool.inputSchema).includes("userId") === false
    )).toBe(true);
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(tools.get("search_memories")?.description).toContain(
      "before claiming that the information is unknown"
    );
    expect(tools.get("search_memories")?.description).toContain(
      "native fact retrieval and ranking"
    );
    expect(tools.get("add_memory")?.description).toContain(
      "current request clearly asks"
    );
    expect(tools.get("delete_memory")?.description).toContain(
      "ask for clarification if the target is ambiguous"
    );
    expect(JSON.stringify(tools.get("search_memories")?.inputSchema)).toContain(
      "natural-language question"
    );
    expect(Object.keys(tools.get("search_memories")?.inputSchema.properties ?? {}))
      .toEqual(["query", "limit"]);
    expect(JSON.stringify(tools.get("update_memory")?.inputSchema)).toContain(
      "Complete replacement fact text"
    );
    expect(listed.tools[0]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
    expect(listed.tools[5]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    });

    const added = await client.callTool({
      name: "add_memory",
      arguments: { text: "  I prefer aisle seats.  " }
    });
    expect(added.isError).not.toBe(true);
    expect(added.structuredContent).toEqual({
      item: {
        memoryRef: firstItem.memoryRef,
        text: firstItem.statement,
        category: firstItem.category,
        provenance: firstItem.provenance,
        createdAt: firstItem.createdAt,
        updatedAt: firstItem.updatedAt
      }
    });
    expect(added.content).toEqual([{
      type: "text",
      text: JSON.stringify(added.structuredContent)
    }]);
    expect(service.create).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        statement: "I prefer aisle seats."
      }),
      { authority: "DELEGATED_MCP" }
    );

    const searched = await client.callTool({
      name: "search_memories",
      arguments: {
        query: "  How do I prefer to travel?  ",
        limit: 5
      }
    });
    expect(searched.structuredContent).toEqual({
      items: [{
        memoryRef: firstItem.memoryRef,
        text: firstItem.statement,
        category: firstItem.category,
        provenance: firstItem.provenance,
        createdAt: firstItem.createdAt,
        updatedAt: firstItem.updatedAt
      }]
    });
    expect(searchService.search).toHaveBeenCalledWith("owner-1", {
      query: "How do I prefer to travel?",
      limit: 5,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      signal: expect.any(AbortSignal)
    });
    expect(service.search).not.toHaveBeenCalled();

    const listedFacts = await client.callTool({
      name: "list_memories",
      arguments: {}
    });
    expect(listedFacts.structuredContent).toMatchObject({
      items: [{ text: firstItem.statement }],
      nextCursor: "mcm1.cursor"
    });
    expect(service.list).toHaveBeenCalledWith("owner-1", {
      pageSize: 20,
      category: undefined,
      provenance: undefined,
      cursor: undefined
    });

    await client.callTool({
      name: "get_memory",
      arguments: { memoryRef: firstItem.memoryRef }
    });
    expect(service.get).toHaveBeenCalledWith("owner-1", firstItem.memoryRef);

    const updated = await client.callTool({
      name: "update_memory",
      arguments: {
        memoryRef: firstItem.memoryRef,
        text: "  I prefer aisle seats on flights.  "
      }
    });
    expect(updated.structuredContent).toMatchObject({
      item: { memoryRef: updatedItem.memoryRef, text: updatedItem.statement }
    });
    expect(service.edit).toHaveBeenCalledWith(
      "owner-1",
      firstItem.memoryRef,
      expect.objectContaining({ statement: updatedItem.statement }),
      { authority: "DELEGATED_MCP" }
    );

    const deleted = await client.callTool({
      name: "delete_memory",
      arguments: { memoryRef: updatedItem.memoryRef }
    });
    expect(deleted.structuredContent).toEqual({ status: "FORGOTTEN" });
    expect(deleted.content).toEqual([{
      type: "text",
      text: JSON.stringify(deleted.structuredContent)
    }]);
    expect(service.forget).toHaveBeenCalledWith(
      "owner-1",
      updatedItem.memoryRef,
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u)
      }),
      { authority: "DELEGATED_MCP" }
    );
  });

  it("returns stable content-free application errors", async () => {
    const service = memoryService();
    vi.mocked(service.get).mockRejectedValueOnce(
      new MemoryConsumerServiceError("memory_not_found")
    );
    const client = await connect(handler({ service }).route);
    await client.listTools();
    const result = await client.callTool({
      name: "get_memory",
      arguments: { memoryRef: firstItem.memoryRef }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "memory_not_found" });
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify(result.structuredContent)
    }]);
  });

  it("rejects unknown input fields before a memory operation", async () => {
    const { route, service } = handler();
    const client = await connect(route);
    await client.listTools();
    const result = await client.callTool({
      name: "add_memory",
      arguments: { text: "fact", userId: "other-owner" }
    });
    expect(result.isError).toBe(true);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("fails missing, invalid, and expired bearer tokens before tools", async () => {
    const service = memoryService();
    const expiredOAuth = oauthService(async (token) => token === activeToken ? {
      clientId: "codex-client",
      expiresAt: new Date(Date.now() - 1_000),
      grantId: "grant-1",
      userId: "owner-1"
    } : null);
    const expiredRoute = handler({ oauth: expiredOAuth, service }).route;

    for (const token of ["", "unknown-token", activeToken]) {
      const request = new Request(endpoint, {
        body: "{}",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          host: endpoint.host
        },
        method: "POST"
      });
      const response = await expiredRoute.POST(request);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.search).not.toHaveBeenCalled();
  });

  it("returns OAuth discovery from the GET probe without creating a session", async () => {
    const { route } = handler();
    const anonymous = await route.GET(new Request(endpoint, {
      headers: { host: endpoint.host }
    }));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      "resource_metadata"
    );

    const authenticated = await route.GET(new Request(endpoint, {
      headers: {
        authorization: `Bearer ${activeToken}`,
        host: endpoint.host
      }
    }));
    expect(authenticated.status).toBe(405);
  });

  it("rejects oversized bodies, invalid hosts, and cross-origin requests", async () => {
    const oauth = oauthService();
    const { route } = handler({ oauth });
    const baseHeaders = {
      authorization: `Bearer ${activeToken}`,
      "content-type": "application/json",
      host: endpoint.host
    };
    const oversizedRoute = createMemoryMcpHandler({
      bodyMaxBytes: 8,
      getConfig: config,
      oauthService: oauthService(),
      rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 120 }),
      searchService: nativeSearchService(),
      service: memoryService()
    });
    const oversized = await oversizedRoute.POST(new Request(endpoint, {
      body: "{\"more\":\"than eight bytes\"}",
      headers: baseHeaders,
      method: "POST"
    }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "request_body_too_large" });

    const crossOrigin = await route.POST(new Request(endpoint, {
      body: "{}",
      headers: { ...baseHeaders, origin: "https://attacker.example" },
      method: "POST"
    }));
    expect(crossOrigin.status).toBe(403);

    const invalidHost = await route.POST(new Request(endpoint, {
      body: "{}",
      headers: { ...baseHeaders, host: "attacker.example" },
      method: "POST"
    }));
    expect(invalidHost.status).toBe(403);
    expect(oauth.resolveAccessToken).not.toHaveBeenCalled();
  });

  it("rate-limits repeated bearer requests before another token verification", async () => {
    const oauth = oauthService();
    const service = memoryService();
    const route = createMemoryMcpHandler({
      getConfig: config,
      oauthService: oauth,
      rateLimiter: createFixedWindowLoginRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000
      }),
      searchService: nativeSearchService(),
      service
    });
    const request = () => new Request(endpoint, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "rate-limit-test", version: "1.0.0" },
          protocolVersion: "2026-07-28"
        }
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${activeToken}`,
        "content-type": "application/json",
        host: endpoint.host
      },
      method: "POST"
    });

    expect((await route.POST(request())).status).toBe(200);
    const limited = await route.POST(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(oauth.resolveAccessToken).toHaveBeenCalledTimes(1);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("turns a bounded memory timeout into a safe tool error", async () => {
    const service = memoryService();
    vi.mocked(service.list).mockImplementationOnce(() => new Promise(() => undefined));
    const client = await connect(handler({ deadlineMs: 25, service }).route);
    await client.listTools();
    const result = await client.callTool({ name: "list_memories", arguments: {} }, {
      timeout: 1_000
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "memory_unavailable" });
  });
});
