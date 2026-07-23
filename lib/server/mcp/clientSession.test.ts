import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpClientSession,
  McpClientSessionError,
  type McpClientSessionLimits
} from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";

type FixtureOptions = Readonly<{
  callTool?: (input: Readonly<{
    arguments: Record<string, unknown>;
    name: string;
    signal: AbortSignal;
  }>) => CallToolResult | Promise<CallToolResult>;
  listTools?: (cursor: string | undefined) => ListToolsResult | Promise<ListToolsResult>;
}>;

type Fixture = Readonly<{
  close(): Promise<void>;
  requestHeaders: Array<Readonly<{
    authorization: string | undefined;
    method: string;
    staticValue: string | undefined;
  }>>;
  sendToolListChanged(): Promise<void>;
  url: URL;
}>;

const openFixtures = new Set<Fixture>();

const defaultLimits: McpClientSessionLimits = {
  maxListPages: 4,
  maxToolArgumentBytes: 1_024,
  maxToolMetadataBytes: 2_048,
  maxToolResultBytes: 2_048,
  maxToolSchemaBytes: 2_048,
  maxTools: 16
};
const privateCancellationReason = "private-cancellation-reason";

function tool(
  name: string,
  inputSchema: Tool["inputSchema"] = { type: "object" },
  description = `Description for ${name}`
): Tool {
  return { description, inputSchema, name };
}

function deferred<Value = void>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture_wait_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const requestHeaders: Fixture["requestHeaders"] = [];
  const server = new Server(
    { name: "aiqsa-test-mcp", title: "AIQSA test MCP", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    options.listTools?.(request.params?.cursor) ?? { tools: [tool("echo")] }
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    options.callTool?.({
      arguments: request.params.arguments ?? {},
      name: request.params.name,
      signal: extra.signal
    }) ?? {
      content: [{ text: request.params.name, type: "text" }]
    }
  );

  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "aiqsa-test-session"
  });
  await server.connect(transport);
  const httpServer = createServer((request, response) => {
    requestHeaders.push({
      authorization: Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization,
      method: request.method ?? "",
      staticValue: Array.isArray(request.headers["x-aiqsa-static"])
        ? request.headers["x-aiqsa-static"][0]
        : request.headers["x-aiqsa-static"]
    });
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
    requestHeaders,
    sendToolListChanged: () => server.sendToolListChanged(),
    url: new URL(`http://127.0.0.1:${address.port}/mcp`)
  };
  openFixtures.add(fixture);
  return fixture;
}

function createSession(
  fixture: Fixture,
  input: Readonly<{
    fetch?: FetchLike;
    limits?: Partial<McpClientSessionLimits>;
    onInventoryStale?: () => void;
    requestTimeoutMs?: number;
  }> = {}
): McpClientSession {
  const fetchImplementation: FetchLike = input.fetch ?? ((url, init) => fetch(url, init));
  return new McpClientSession({
    fetch: fetchImplementation,
    headers: { "X-AIQSA-Static": "static-secret" },
    limits: { ...defaultLimits, ...input.limits },
    onInventoryStale: input.onInventoryStale,
    requestTimeoutMs: input.requestTimeoutMs ?? 1_000,
    url: fixture.url
  });
}

afterEach(async () => {
  await Promise.all([...openFixtures].map((fixture) => fixture.close()));
});

describe("McpClientSession", () => {
  it("uses the official SDK lifecycle, paginates canonical tools, and marks inventory stale without auto-refresh", async () => {
    const listCursors: Array<string | undefined> = [];
    let schemaOrderReversed = false;
    const changed = deferred();
    const fixture = await startFixture({
      listTools(cursor) {
        listCursors.push(cursor);
        if (cursor === undefined) {
          const properties = schemaOrderReversed
            ? { zeta: { type: "string" }, alpha: { type: "number" } }
            : { alpha: { type: "number" }, zeta: { type: "string" } };
          const outputProperties = schemaOrderReversed
            ? { result: { type: "string" }, count: { type: "number" } }
            : { count: { type: "number" }, result: { type: "string" } };
          return {
            nextCursor: "page-2",
            tools: [{
              annotations: {
                destructiveHint: false,
                readOnlyHint: true,
                title: "Safe first tool"
              },
              description: "Description for first",
              inputSchema: { properties, type: "object" },
              name: "first",
              outputSchema: { properties: outputProperties, type: "object" },
              title: "First tool"
            }]
          };
        }
        return { tools: [tool("second")] };
      }
    });
    const injectedFetch = vi.fn<FetchLike>((url, init) => fetch(url, init));
    const session = createSession(fixture, {
      fetch: injectedFetch,
      onInventoryStale: () => changed.resolve()
    });

    expect(session.serverEvidence).toBeNull();
    await session.initialize();
    expect(session.serverEvidence).toEqual({
      capabilities: {
        completions: false,
        logging: false,
        prompts: null,
        resources: null,
        tasks: false,
        tools: { listChanged: true }
      },
      implementation: {
        name: "aiqsa-test-mcp",
        title: "AIQSA test MCP",
        version: "1.0.0"
      }
    });
    const firstInventory = await session.listAllTools();

    expect(firstInventory.map(({ name }) => name)).toEqual(["first", "second"]);
    expect(firstInventory[0]).toMatchObject({
      definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      annotations: {
        destructiveHint: false,
        readOnlyHint: true,
        title: "Safe first tool"
      },
      description: "Description for first",
      inputSchema: {
        properties: { alpha: { type: "number" }, zeta: { type: "string" } },
        type: "object"
      },
      outputSchema: {
        properties: { count: { type: "number" }, result: { type: "string" } },
        type: "object"
      },
      title: "First tool"
    });
    expect(session.inventoryStale).toBe(false);
    expect(listCursors).toEqual([undefined, "page-2"]);
    expect(injectedFetch).toHaveBeenCalled();
    expect(fixture.requestHeaders.every(({ staticValue }) => staticValue === "static-secret")).toBe(true);

    await waitFor(() => fixture.requestHeaders.some(({ method }) => method === "GET"));
    await fixture.sendToolListChanged();
    await changed.promise;
    expect(session.inventoryStale).toBe(true);
    expect(listCursors).toEqual([undefined, "page-2"]);

    schemaOrderReversed = true;
    const refreshed = await session.listAllTools();
    expect(refreshed[0]?.definitionHash).toBe(firstInventory[0]?.definitionHash);
    expect(session.inventoryStale).toBe(false);

    await session.close();
    await session.close();
    await expect(session.listAllTools()).rejects.toMatchObject({
      code: "mcp_session_closed",
      operation: "list_tools"
    });
  });

  it("rejects pagination cursor cycles before issuing an unbounded request sequence", async () => {
    const cursors: Array<string | undefined> = [];
    const fixture = await startFixture({
      listTools(cursor) {
        cursors.push(cursor);
        return { nextCursor: "same-cursor", tools: [] };
      }
    });
    const session = createSession(fixture);
    await session.initialize();

    await expect(session.listAllTools()).rejects.toMatchObject({
      code: "mcp_inventory_cursor_cycle",
      operation: "list_tools",
      retryable: false
    });
    expect(cursors).toEqual([undefined, "same-cursor"]);
    expect(session.inventoryStale).toBe(true);
    await session.close();
  });

  it.each([
    {
      code: "mcp_inventory_page_limit",
      limits: { maxListPages: 1 },
      listTools: () => ({ nextCursor: "another-page", tools: [] }),
      name: "page"
    },
    {
      code: "mcp_inventory_tool_limit",
      limits: { maxTools: 1 },
      listTools: () => ({ tools: [tool("one"), tool("two")] }),
      name: "tool"
    },
    {
      code: "mcp_inventory_metadata_limit",
      limits: { maxToolMetadataBytes: 64 },
      listTools: () => ({
        tools: [tool("large-metadata", { type: "object" }, "x".repeat(256))]
      }),
      name: "metadata"
    },
    {
      code: "mcp_inventory_schema_limit",
      limits: { maxToolSchemaBytes: 64 },
      listTools: () => ({
        tools: [tool("large-schema", { description: "x".repeat(256), type: "object" })]
      }),
      name: "schema"
    }
  ])("enforces the configured $name inventory bound", async ({ code, limits, listTools }) => {
    const fixture = await startFixture({ listTools });
    const session = createSession(fixture, { limits });
    await session.initialize();

    await expect(session.listAllTools()).rejects.toMatchObject({ code, operation: "list_tools" });
    await session.close();
  });

  it("rejects a discovered tool whose JSON Schema cannot be compiled", async () => {
    const fixture = await startFixture({
      listTools: () => ({
        tools: [tool("broken-schema", {
          properties: { value: { type: "not-a-json-schema-type" } },
          type: "object"
        } as Tool["inputSchema"])]
      })
    });
    const session = createSession(fixture);
    await session.initialize();

    await expect(session.listAllTools()).rejects.toMatchObject({
      code: "mcp_inventory_tool_invalid",
      operation: "list_tools"
    });
    await session.close();
  });

  it("allows concurrent SDK calls and returns bounded canonical text and structured JSON", async () => {
    const release = deferred();
    const bothStarted = deferred();
    let active = 0;
    let maximumActive = 0;
    const fixture = await startFixture({
      async callTool({ arguments: toolArguments, name }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 2) bothStarted.resolve();
        await release.promise;
        active -= 1;
        return {
          content: [{ text: `text:${name}`, type: "text" }],
          structuredContent: { echoed: toolArguments.value, name }
        };
      }
    });
    const session = createSession(fixture);
    await session.initialize();

    const first = session.callTool("first", { value: 1 });
    const second = session.callTool("second", { value: 2 });
    await bothStarted.promise;
    expect(maximumActive).toBe(2);
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        isError: false,
        structuredContent: { echoed: 1, name: "first" },
        text: ["text:first"],
        unsupportedContentTypes: []
      },
      {
        isError: false,
        structuredContent: { echoed: 2, name: "second" },
        text: ["text:second"],
        unsupportedContentTypes: []
      }
    ]);
    await session.close();
  });

  it("bounds arguments and results while redacting upstream errors", async () => {
    const privateValue = "private-upstream-value";
    const calledNames: string[] = [];
    const fixture = await startFixture({
      callTool({ name }) {
        calledNames.push(name);
        if (name === "throws") throw new Error(privateValue);
        return { content: [{ text: privateValue.repeat(20), type: "text" }] };
      }
    });
    const session = createSession(fixture, {
      limits: { maxToolArgumentBytes: 48, maxToolResultBytes: 128 }
    });
    await session.initialize();

    await expect(session.callTool("never-dispatched", { value: "x".repeat(100) })).rejects.toMatchObject({
      code: "mcp_call_arguments_too_large",
      retryable: false
    });
    expect(calledNames).toEqual([]);

    for (const name of ["throws", "large-result"]) {
      try {
        await session.callTool(name, {});
        throw new Error("expected_call_failure");
      } catch (error) {
        expect(error).toBeInstanceOf(McpClientSessionError);
        expect(JSON.stringify(error)).not.toContain(privateValue);
        expect((error as McpClientSessionError).code).toBe(
          name === "throws" ? "mcp_call_failed" : "mcp_call_result_too_large"
        );
      }
    }
    await session.close();
  });

  it("maps explicit SDK timeouts and AbortSignal cancellation to stable errors", async () => {
    const starts = new Map([
      ["timeout", deferred()],
      ["cancel", deferred()]
    ]);
    const fixture = await startFixture({
      callTool({ name, signal }) {
        starts.get(name)?.resolve();
        return new Promise<CallToolResult>((resolve) => {
          const timeout = setTimeout(
            () => resolve({ content: [{ text: "late", type: "text" }] }),
            2_000
          );
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              resolve({ content: [{ text: "cancelled", type: "text" }], isError: true });
            },
            { once: true }
          );
        });
      }
    });
    const session = createSession(fixture);
    await session.initialize();

    const timedOut = session.callTool("timeout", {}, { timeoutMs: 20 });
    await starts.get("timeout")?.promise;
    await expect(timedOut).rejects.toMatchObject({
      code: "mcp_request_timeout",
      operation: "call_tool",
      retryable: true
    });

    const controller = new AbortController();
    const cancelled = session.callTool("cancel", {}, { signal: controller.signal });
    await starts.get("cancel")?.promise;
    controller.abort(new Error(privateCancellationReason));
    await expect(cancelled).rejects.toMatchObject({
      code: "mcp_request_cancelled",
      operation: "call_tool",
      retryable: false
    });
    await session.close();
  });

  it("adapts runtime launches with distinct startup/call timeouts and list-change scheduling", async () => {
    const changed = deferred();
    const fixture = await startFixture({
      callTool({ signal }) {
        return new Promise<CallToolResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ content: [{ text: "stopped", type: "text" }], isError: true }),
            { once: true }
          );
        });
      }
    });
    let firstPost = true;
    const delayedInitializeFetch: FetchLike = async (url, init) => {
      const response = await fetch(url, init);
      if (firstPost && init?.method === "POST") {
        firstPost = false;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return response;
    };
    const factory = createMcpClientSessionFactory({
      fetch: delayedInitializeFetch,
      limits: defaultLimits
    });

    const runtime = await factory.create({
      callTimeoutMs: 20,
      fingerprint: "test-fingerprint",
      generationId: "test-generation",
      headers: { "X-AIQSA-Static": "static-secret" },
      onToolsChanged: () => changed.resolve(),
      redactionValues: [],
      retryAt: null,
      startupTimeoutMs: 200,
      url: fixture.url.toString()
    });
    await expect(runtime.listTools()).resolves.toMatchObject([
      { definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/u), name: "echo" }
    ]);
    await expect(runtime.callTool({ arguments: {}, name: "slow" })).rejects.toMatchObject({
      code: "mcp_request_timeout"
    });

    await waitFor(() => fixture.requestHeaders.some(({ method }) => method === "GET"));
    await fixture.sendToolListChanged();
    await changed.promise;
    await runtime.close();
  });

  it("injects an OAuth provider only for an explicitly bound remote runtime launch", async () => {
    const accessSecret = "runtime-access";
    const refreshSecret = "runtime-refresh";
    const fixture = await startFixture({
      callTool: () => ({
        content: [{ text: `tokens:${accessSecret}:${refreshSecret}`, type: "text" }],
        structuredContent: { access: accessSecret, refresh: refreshSecret }
      })
    });
    const provider = {
      exactKnownSecrets: () => [accessSecret, refreshSecret],
      tokens: vi.fn(async () => ({ access_token: accessSecret, token_type: "Bearer" }))
    } as unknown as OAuthClientProvider;
    const authProviderForLaunch = vi.fn(async () => provider);
    const factory = createMcpClientSessionFactory({
      authProviderForLaunch,
      fetch: (url, init) => fetch(url, init),
      limits: defaultLimits
    });

    const runtime = await factory.create({
      callTimeoutMs: 500,
      fingerprint: "oauth-fingerprint",
      generationId: "oauth-generation",
      headers: {},
      oauthConnectionId: "oauth-connection-1",
      onToolsChanged: () => undefined,
      redactionValues: [],
      retryAt: null,
      startupTimeoutMs: 1_000,
      url: fixture.url.toString()
    });
    await runtime.listTools();
    const result = await runtime.callTool({ arguments: {}, name: "echo" });

    expect(authProviderForLaunch).toHaveBeenCalledWith(expect.objectContaining({
      oauthConnectionId: "oauth-connection-1",
      url: fixture.url.toString()
    }));
    expect(fixture.requestHeaders.length).toBeGreaterThan(0);
    expect(fixture.requestHeaders.every(({ authorization }) =>
      authorization === `Bearer ${accessSecret}`
    )).toBe(true);
    expect(result).toEqual({
      isError: false,
      structuredContent: { access: "[REDACTED]", refresh: "[REDACTED]" },
      text: ["tokens:[REDACTED]:[REDACTED]"],
      unsupportedContentTypes: []
    });
    expect(JSON.stringify(result)).not.toContain(accessSecret);
    expect(JSON.stringify(result)).not.toContain(refreshSecret);
    await runtime.close();
  });
});
