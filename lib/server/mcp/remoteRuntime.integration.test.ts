import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { createMcpSafeFetch } from "./safeFetch";
import { McpClientSession } from "./clientSession";
import { getMcpRequestMaxBytes } from "./responseLimits";

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
