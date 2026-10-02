import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type CallToolResult, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";

export type MutableMcpTool = Tool;

export type MutableMcpEndpointOptions = Readonly<{
  /** Answers `tools/call`; the default returns one fixed synthetic text. */
  callTool?(name: string, args: Readonly<Record<string, unknown>>): CallToolResult | Promise<CallToolResult>;
  /** Listen address; loopback by default. */
  host?: string;
  /** Host placed in `url`, for a stand that reaches the fixture by another name. */
  publicHost?: string;
}>;

/**
 * A real loopback MCP peer on the official SDK whose tool list changes while
 * clients stay connected. Every connection gets its own session; a mutation
 * notifies each open session through `notifications/tools/list_changed`.
 */
export async function startMutableMcpEndpoint(initial: readonly MutableMcpTool[], options: MutableMcpEndpointOptions = {}) {
  let tools = [...initial];
  const calls = new Map<string, number>();
  const counts = { initialize: 0, list: 0 };
  const sessions = new Map<string, { server: Server; transport: NodeStreamableHTTPServerTransport }>();

  const openSession = async () => {
    const server = new Server(
      { name: "aiqsa-mutable-fixture", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => {
      counts.list += 1;
      return { tools };
    });
    server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
      calls.set(request.params.name, (calls.get(request.params.name) ?? 0) + 1);
      return options.callTool
        ? options.callTool(request.params.name, request.params.arguments ?? {})
        : { content: [{ type: "text", text: "Synthetic fixture result" }] };
    });
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      onsessionclosed: (sessionId) => { sessions.delete(sessionId); },
      onsessioninitialized: (sessionId) => {
        counts.initialize += 1;
        sessions.set(sessionId, { server, transport });
      },
      sessionIdGenerator: () => randomUUID()
    });
    await server.connect(transport);
    return transport;
  };

  const http = createServer((request, response) => {
    void (async () => {
      if (new URL(request.url ?? "/", "http://fixture.invalid").pathname !== "/mcp") {
        response.statusCode = 404;
        response.end();
        return;
      }
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const transport = sessionId
        ? sessions.get(sessionId)?.transport
        : request.method === "POST" ? await openSession() : undefined;
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
    http.once("error", reject);
    http.listen(0, options.host ?? "127.0.0.1", () => resolve());
  });

  const notify = async () => {
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.sendToolListChanged()));
  };

  return {
    /** `tools/call` requests received per tool name. */
    calls(name?: string): number {
      return name === undefined
        ? [...calls.values()].reduce((total, count) => total + count, 0)
        : calls.get(name) ?? 0;
    },
    counts,
    async close() {
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
    /** Resends list_changed; a session opens its notification stream shortly after initializing. */
    notify,
    openSessions: () => sessions.size,
    /** Replaces the tool list, then notifies every open session. */
    async setTools(next: readonly MutableMcpTool[]) {
      tools = [...next];
      await notify();
    },
    url: `http://${options.publicHost ?? options.host ?? "127.0.0.1"}:${(http.address() as AddressInfo).port}/mcp`
  };
}

export type MutableMcpEndpoint = Awaited<ReturnType<typeof startMutableMcpEndpoint>>;
