import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { createMcpSafeFetch } from "./safeFetch";
import { McpClientSession } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { mcpPublishedToolDefinitions, type McpPublishedToolDefinitions } from "./definitions";
import { getMcpRequestMaxBytes } from "./responseLimits";
import {
  McpRuntimeCoordinator,
  type McpRuntimeCoordinatorRepository,
  type McpRuntimeGenerationLaunch,
  type McpRuntimeInventory
} from "./runtimeCoordinator";

type Fixture = Readonly<{
  close(): Promise<void>;
  cursors: Array<string | undefined>;
  observedStaticHeaders: Array<string | undefined>;
  receivedArgumentBytes: number[];
  url: URL;
}>;

const openFixtures = new Set<Fixture>();

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startRemoteFixture(
  secret: string,
  echoSecret = false,
  toolDescription = "Create a task",
  gitlabRecovery = false,
  inventory?: Tool[]
): Promise<Fixture> {
  const cursors: Array<string | undefined> = [];
  const observedStaticHeaders: Array<string | undefined> = [];
  const receivedArgumentBytes: number[] = [];
  const server = new Server(
    { name: "aiqsa-validator-fixture", title: "AIQSA validator fixture", version: "2.1.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  server.setRequestHandler("tools/list", async (request): Promise<ListToolsResult> => {
    const cursor = request.params?.cursor;
    cursors.push(cursor);
    if (inventory) return { tools: inventory };
    return cursor === undefined
      ? {
          nextCursor: "page-2",
          tools: [{
            description: echoSecret ? `Upstream accidentally echoed ${secret}` : toolDescription,
            inputSchema: { properties: { title: { type: "string" } }, type: "object" },
            name: "create_task"
          }]
        }
      : {
          tools: [{
            description: "List available tasks",
            inputSchema: { type: "object" },
            name: "list_tasks"
          }]
        };
  });
  server.setRequestHandler("tools/call", async request => {
    receivedArgumentBytes.push(Buffer.byteLength(JSON.stringify(request.params.arguments)));
    return { content: [{ type: "text", text: "Accepted" }] };
  });

  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "aiqsa-validator-session"
  });
  await server.connect(transport);
  const httpServer = createServer((request, response) => {
    const value = request.headers["x-validation-secret"];
    observedStaticHeaders.push(Array.isArray(value) ? value[0] : value);
    if (gitlabRecovery) {
      const origin = `http://${request.headers.host}`;
      const metadataPath = "/.well-known/oauth-protected-resource/api/v4/mcp";
      if (request.url?.startsWith("/.well-known/oauth-protected-resource")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ resource: `${origin}/api/v4/mcp`, authorization_servers: [origin], scopes_supported: ["mcp"] }));
        return;
      }
      if (request.url !== "/api/v4/mcp") { response.statusCode = 404; response.end(); return; }
      if (value !== secret) {
        response.statusCode = 401;
        response.setHeader("www-authenticate", `Bearer realm="GitLab", resource_metadata="${origin}${metadataPath}"`);
        response.end();
        return;
      }
    }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", onError);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;

  const fixture: Fixture = {
    async close() {
      openFixtures.delete(fixture);
      await server.close().catch(() => undefined);
      await closeHttpServer(httpServer);
    },
    cursors,
    observedStaticHeaders,
    receivedArgumentBytes,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`)
  };
  openFixtures.add(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all([...openFixtures].map((fixture) => fixture.close()));
});

describe("remote MCP runtime integration", () => {
  it.each(["validation", "runtime"] as const)("accepts a 43-tool inventory with large input and output schemas during %s", async mode => {
    const inventory: Tool[] = Array.from({ length: 43 }, (_, index) => ({
      name: `tool_${index}`, inputSchema: { type: "object" }
    }));
    inventory[0] = { name: "tool_0",
      inputSchema: { type: "object", properties: { title: { type: "string", description: "x".repeat(96 * 1024) } } },
      outputSchema: { type: "object", description: "y".repeat(96 * 1024) }
    };
    const fixture = await startRemoteFixture("fixture", false, "Create a task", false, inventory);
    const safeFetch = createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true });
    if (mode === "validation") {
      const outcome = await createRemoteMcpDraftValidator({ fetch: safeFetch }).validate({
        draft: { auth: { mode: "none" }, transport: "streamable_http", slots: [],
          source: { kind: "remote", url: fixture.url.href },
          runtime: { callTimeoutMs: 2_000, startupTimeoutMs: 2_000 } }, values: {}
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") expect(outcome.toolInventory).toHaveLength(43);
    } else {
      const session = new McpClientSession({ fetch: safeFetch, url: fixture.url, requestTimeoutMs: 2_000,
        limits: { maxListPages: 16, maxToolArgumentBytes: getMcpRequestMaxBytes(), maxToolMetadataBytes: 256 * 1024, maxTools: 256 }
      });
      try {
        await session.initialize();
        const tools = await session.listAllTools();
        expect(tools).toHaveLength(43);
        expect(tools[0]).toMatchObject(inventory[0]!);
        expect((await session.listAllTools())[0]!.definitionHash).toBe(tools[0]!.definitionHash);
        expect(session.inventoryStale).toBe(false);
        await expect(session.callTool("tool_1", {})).resolves.toMatchObject({ isError: false, text: ["Accepted"] });
        expect(fixture.receivedArgumentBytes).toEqual([2]);
      } finally { await session.close(); }
    }
  });

  it("sends a request beyond the former small limits and rejects an oversized envelope before a second tool call", async () => {
    const fixture = await startRemoteFixture("fixture");
    const session = new McpClientSession({
      fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true }),
      url: fixture.url, requestTimeoutMs: 900000,
      limits: { maxListPages: 16, maxToolArgumentBytes: getMcpRequestMaxBytes(),
        maxToolMetadataBytes: 256 * 1024, maxTools: 256 }
    });
    try {
      await session.initialize();
      await session.listAllTools();
      await session.callTool("create_task", { title: "x".repeat(256 * 1024) });
      expect(fixture.receivedArgumentBytes).toEqual([256 * 1024 + 12]);
      await expect(session.callTool("create_task", { title: "x".repeat(getMcpRequestMaxBytes()) }))
        .rejects.toMatchObject({ code: "mcp_call_arguments_too_large" });
      expect(fixture.receivedArgumentBytes).toHaveLength(1);
    } finally { await session.close(); }
  });

  it("recovers a GitLab endpoint over real pinned HTTP and completes official-SDK initialize and paginated tools", async () => {
    const secret = "fixture-gitlab-header";
    const fixture = await startRemoteFixture(secret, false, "Create a task", true);
    const validator = createRemoteMcpDraftValidator({ fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true }) });
    const draft: McpDraftConfiguration = {
      auth: { mode: "static" }, transport: "streamable_http", runtime: { callTimeoutMs: 2_000, startupTimeoutMs: 2_000 },
      source: { kind: "remote", url: fixture.url.href, allowPrivateNetwork: true },
      slots: [{ label: "Key", policy: { kind: "shared", allowPersonalOverride: false }, sensitive: true, slotKey: "key",
        target: { kind: "header", name: "X-Validation-Secret" }, valueType: "secret" }]
    };
    const outcome = await validator.validate({ draft, values: { key: secret } });
    expect(outcome).toMatchObject({ kind: "ok", endpointCorrection: { fromUrl: fixture.url.href, toUrl: `${fixture.url.origin}/api/v4/mcp` },
      toolInventory: [{ name: "create_task" }, { name: "list_tasks" }] });
    expect(fixture.cursors).toEqual([undefined, "page-2"]);
    expect(fixture.observedStaticHeaders.slice(0, 4)).toEqual([secret, undefined, undefined, undefined]);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it("validates a paginated official-SDK endpoint through the real safe session", async () => {
    const staticSecret = "integration-static-secret";
    const fixture = await startRemoteFixture(staticSecret);
    const safeFetch = createMcpSafeFetch({
      allowInsecureHttp: true,
      allowPrivateNetwork: true
    });
    const validator = createRemoteMcpDraftValidator({ fetch: safeFetch });
    const draft: McpDraftConfiguration = {
      auth: { mode: "static" },
      runtime: { callTimeoutMs: 2_000, startupTimeoutMs: 2_000 },
      slots: [{
        label: "Validation secret",
        policy: { allowPersonalOverride: false, kind: "shared" },
        sensitive: true,
        slotKey: "validation-secret",
        target: { kind: "header", name: "X-Validation-Secret" },
        valueType: "secret"
      }],
      source: { kind: "remote", url: fixture.url.toString() },
      transport: "streamable_http"
    };

    const outcome = await validator.validate({
      draft,
      values: { "validation-secret": staticSecret }
    });

    expect(outcome).toMatchObject({
      evidence: {
        endpointHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        server: {
          capabilities: { tools: { listChanged: true } },
          implementation: {
            name: "aiqsa-validator-fixture",
            title: "AIQSA validator fixture",
            version: "2.1.0"
          }
        },
        toolCount: 2,
        toolDefinitionHashes: [
          expect.stringMatching(/^[a-f0-9]{64}$/u),
          expect.stringMatching(/^[a-f0-9]{64}$/u)
        ],
        transport: "streamable_http"
      },
      kind: "ok",
      resolvedArtifact: {
        endpointHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        kind: "remote"
      },
      toolInventory: [
        { description: "Create a task", name: "create_task" },
        { description: "List available tasks", name: "list_tasks" }
      ]
    });
    expect(fixture.cursors).toEqual([undefined, "page-2"]);
    expect(fixture.observedStaticHeaders.length).toBeGreaterThanOrEqual(3);
    expect(fixture.observedStaticHeaders.every((value) => value === staticSecret)).toBe(true);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(staticSecret);
    expect(serialized).not.toContain(fixture.url.toString());
  });

  it("rejects an inventory that reproduces an exact static credential", async () => {
    const staticSecret = "integration-static-secret-leak";
    const fixture = await startRemoteFixture(staticSecret, true);
    const validator = createRemoteMcpDraftValidator({
      fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true })
    });
    const outcome = await validator.validate({
      draft: {
        auth: { mode: "static" },
        runtime: { callTimeoutMs: 2_000, startupTimeoutMs: 2_000 },
        slots: [{
          label: "Validation secret",
          policy: { allowPersonalOverride: false, kind: "shared" },
          sensitive: true,
          slotKey: "validation-secret",
          target: { kind: "header", name: "X-Validation-Secret" },
          valueType: "secret"
        }],
        source: { kind: "remote", url: fixture.url.toString() },
        transport: "streamable_http"
      },
      values: { "validation-secret": staticSecret }
    });

    expect(outcome).toEqual({
      issues: [{ code: "mcp_remote_inventory_unsafe", path: "tools" }],
      kind: "invalid"
    });
    expect(JSON.stringify(outcome)).not.toContain(staticSecret);
  });

  it("rejects an oversized tools/list wire response without exposing its body or request context", async () => {
    const staticSecret = "integration-wire-limit-static-secret";
    const privateBodyMarker = "private-inventory-wire-payload";
    const fixture = await startRemoteFixture(
      staticSecret,
      false,
      privateBodyMarker.repeat(512)
    );
    const previousLimit = process.env.AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES;
    process.env.AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES = "1024";

    try {
      const validator = createRemoteMcpDraftValidator({
        fetch: createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true })
      });
      const outcome = await validator.validate({
        draft: {
          auth: { mode: "static" },
          runtime: { callTimeoutMs: 2_000, startupTimeoutMs: 2_000 },
          slots: [{
            label: "Validation secret",
            policy: { allowPersonalOverride: false, kind: "shared" },
            sensitive: true,
            slotKey: "validation-secret",
            target: { kind: "header", name: "X-Validation-Secret" },
            valueType: "secret"
          }],
          source: { kind: "remote", url: fixture.url.toString() },
          transport: "streamable_http"
        },
        values: { "validation-secret": staticSecret }
      });

      expect(outcome).toEqual({
        issues: [{ code: "mcp_inventory_response_too_large", path: "tools", operation: "list_tools", endpoint: fixture.url.href }],
        kind: "invalid"
      });
      expect(fixture.cursors).toEqual([undefined]);
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(privateBodyMarker);
      expect(serialized).not.toContain(staticSecret);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES;
      } else {
        process.env.AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES = previousLimit;
      }
    }
  });
});

type MutableFixture = Readonly<{
  calls: string[];
  close(): Promise<void>;
  /** Replaces the inventory and sends tools/list_changed on every open session. */
  setTools(tools: Tool[]): Promise<void>;
  url: URL;
}>;

/** An official-SDK server with one session per connection and a mutable tool list. */
async function startMutableFixture(initial: Tool[]): Promise<MutableFixture> {
  let tools = initial;
  const calls: string[] = [];
  const sessions = new Map<string, { server: Server; transport: NodeStreamableHTTPServerTransport }>();
  const openSession = async () => {
    const server = new Server(
      { name: "aiqsa-mutable-fixture", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
    server.setRequestHandler("tools/call", async (request) => {
      calls.push(request.params.name);
      return { content: [{ type: "text", text: "Accepted" }] };
    });
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      onsessioninitialized: (sessionId) => { sessions.set(sessionId, { server, transport }); },
      sessionIdGenerator: () => randomUUID()
    });
    await server.connect(transport);
    return transport;
  };
  const httpServer = createServer((request, response) => {
    void (async () => {
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const transport = sessionId ? sessions.get(sessionId)?.transport : request.method === "POST" ? await openSession() : undefined;
      if (!transport) {
        response.statusCode = sessionId ? 404 : 400;
        response.end();
        return;
      }
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  const fixture: Fixture & MutableFixture = {
    calls,
    async close() {
      openFixtures.delete(fixture);
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
      await closeHttpServer(httpServer);
    },
    cursors: [],
    observedStaticHeaders: [],
    receivedArgumentBytes: [],
    async setTools(next) {
      tools = next;
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.sendToolListChanged()));
    },
    url: new URL(`http://127.0.0.1:${address.port}/mcp`)
  };
  openFixtures.add(fixture);
  return fixture;
}

describe("published MCP inventory over real list_changed delivery", () => {
  const readTask: Tool = { description: "Read a task", inputSchema: { type: "object" }, name: "read_task" };
  const createTask: Tool = {
    description: "Create a task",
    inputSchema: { properties: { title: { type: "string" } }, type: "object" },
    name: "create_task"
  };
  const listTasks: Tool = { description: "List tasks", inputSchema: { type: "object" }, name: "list_tasks" };
  const deleteRepo: Tool = { description: "Delete a repository", inputSchema: { type: "object" }, name: "delete_repo" };
  const changedCreateTask: Tool = {
    ...createTask,
    inputSchema: { properties: { owner: { type: "string" }, title: { type: "string" } }, type: "object" }
  };

  it("holds back an added tool, a changed schema and a removed tool until a new check publishes them", async () => {
    const fixture = await startMutableFixture([readTask, createTask, listTasks]);
    const fetch = createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: true });
    const validator = createRemoteMcpDraftValidator({ fetch });
    const check = async () => {
      const outcome = await validator.validate({ draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 5_000, startupTimeoutMs: 5_000 },
        slots: [], source: { allowPrivateNetwork: true, kind: "remote", url: fixture.url.href }, transport: "streamable_http" }, values: {} });
      if (outcome.kind !== "ok") throw new Error("fixture_check_failed");
      return mcpPublishedToolDefinitions({ evidence: outcome.evidence, toolInventory: outcome.toolInventory });
    };
    const inventories = new Map<string, McpRuntimeInventory[]>();
    let launches: McpRuntimeGenerationLaunch[] = [];
    const repository: McpRuntimeCoordinatorRepository = {
      deleteDrainedGeneration: async () => false,
      finalizeDeletedServers: async () => 0,
      listDrainedGenerationIds: async () => [],
      loadAcceptedGeneration: async () => null,
      markFailed: async () => ({ applied: true, retryAt: null }),
      markReady: async ({ generationId, inventory }) => {
        inventories.set(generationId, [...inventories.get(generationId) ?? [], inventory]);
        return true;
      },
      markStarting: async () => true,
      synchronizeDesired: async () => launches,
      touchLastUsed: async () => undefined
    };
    const coordinator = new McpRuntimeCoordinator({
      repository,
      sessions: createMcpClientSessionFactory({ fetch, limits: {
        maxListPages: 16, maxToolArgumentBytes: getMcpRequestMaxBytes(), maxToolMetadataBytes: 256 * 1024, maxTools: 256
      } })
    });
    const launch = (generationId: string, publishedTools: McpPublishedToolDefinitions): McpRuntimeGenerationLaunch => ({
      allowPrivateNetwork: true, callTimeoutMs: 5_000, fingerprint: `fingerprint-${generationId}`, generationId, headers: {},
      publishedTools, redactionValues: [], retryAt: null, startupTimeoutMs: 5_000, url: fixture.url.href
    });
    const call = (generationId: string, name: string) => coordinator.callTool({
      arguments: {}, generationId, inputSchema: { type: "object" }, name
    });
    const latest = (generationId: string) => inventories.get(generationId)?.at(-1);
    // The standalone SSE stream opens after initialization; a notification sent
    // earlier is dropped by the server, so resend until the refresh lands.
    const changeUpstream = async (tools: Tool[], exclusions: McpRuntimeInventory["exclusions"]) => {
      await vi.waitFor(async () => {
        await fixture.setTools(tools);
        expect(latest("generation-1")?.exclusions).toEqual(exclusions);
      }, { interval: 150, timeout: 10_000 });
    };

    try {
      const published = await check();
      expect(published.kind).toBe("definitions");
      launches = [launch("generation-1", published)];
      await coordinator.reconcileNow();
      expect(latest("generation-1")).toMatchObject({ exclusions: [], tools: [{ name: "read_task" }, { name: "create_task" }, { name: "list_tasks" }] });

      await changeUpstream([readTask, createTask, listTasks, deleteRepo], [{ name: "delete_repo", reason: "unpublished_addition" }]);
      await expect(call("generation-1", "delete_repo")).rejects.toMatchObject({ code: "mcp_tool_not_available" });

      await changeUpstream([readTask, changedCreateTask, listTasks, deleteRepo], [
        { name: "create_task", reason: "definition_drift" },
        { name: "delete_repo", reason: "unpublished_addition" }
      ]);
      await expect(call("generation-1", "create_task")).rejects.toMatchObject({ code: "mcp_tool_not_available" });

      await changeUpstream([readTask, changedCreateTask, deleteRepo], [
        { name: "create_task", reason: "definition_drift" },
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "list_tasks", reason: "missing_upstream" }
      ]);
      await expect(call("generation-1", "list_tasks")).rejects.toMatchObject({ code: "mcp_tool_not_available" });
      await expect(call("generation-1", "read_task")).resolves.toMatchObject({ isError: false, text: ["Accepted"] });
      expect(latest("generation-1")?.tools.map(({ name }) => name)).toEqual(["read_task"]);
      expect(fixture.calls).toEqual(["read_task"]);

      // A new check publishes the current server. Its revision starts another
      // generation in the same process; the previous fence stays until drained.
      launches = [launch("generation-2", await check())];
      await coordinator.reconcileNow();
      expect(latest("generation-2")).toMatchObject({ exclusions: [] });
      await expect(call("generation-2", "delete_repo")).resolves.toMatchObject({ isError: false });
      await expect(call("generation-2", "create_task")).resolves.toMatchObject({ isError: false });
      await expect(call("generation-1", "delete_repo")).rejects.toMatchObject({ code: "mcp_tool_not_available" });
      expect(fixture.calls).toEqual(["read_task", "delete_repo", "create_task"]);
    } finally {
      await coordinator.stop();
    }
  });
});
