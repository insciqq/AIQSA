import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type ListToolsResult } from "@modelcontextprotocol/server";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { createMcpSafeFetch } from "./safeFetch";

type Fixture = Readonly<{
  close(): Promise<void>;
  cursors: Array<string | undefined>;
  observedStaticHeaders: Array<string | undefined>;
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
  toolDescription = "Create a task"
): Promise<Fixture> {
  const cursors: Array<string | undefined> = [];
  const observedStaticHeaders: Array<string | undefined> = [];
  const server = new Server(
    { name: "aiqsa-validator-fixture", title: "AIQSA validator fixture", version: "2.1.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  server.setRequestHandler("tools/list", async (request): Promise<ListToolsResult> => {
    const cursor = request.params?.cursor;
    cursors.push(cursor);
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

  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "aiqsa-validator-session"
  });
  await server.connect(transport);
  const httpServer = createServer((request, response) => {
    const value = request.headers["x-validation-secret"];
    observedStaticHeaders.push(Array.isArray(value) ? value[0] : value);
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
    url: new URL(`http://127.0.0.1:${address.port}/mcp`)
  };
  openFixtures.add(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all([...openFixtures].map((fixture) => fixture.close()));
});

describe("remote MCP runtime integration", () => {
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
        issues: [{ code: "mcp_inventory_response_too_large", path: "tools" }],
        kind: "invalid"
      });
      expect(fixture.cursors).toEqual([undefined]);
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(privateBodyMarker);
      expect(serialized).not.toContain(staticSecret);
      expect(serialized).not.toContain(fixture.url.toString());
    } finally {
      if (previousLimit === undefined) {
        delete process.env.AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES;
      } else {
        process.env.AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES = previousLimit;
      }
    }
  });
});
