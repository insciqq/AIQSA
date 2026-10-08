import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type CallToolResult, type ListToolsResult, type Tool } from "@modelcontextprotocol/server";

export type MutableMcpTool = Tool;

/** One received `tools/call`: the tool name and its arguments as canonical JSON. */
export type MutableMcpDispatch = Readonly<{ name: string; arguments: string }>;

/** Sorted-key JSON, so equal arguments compare equal whatever their key order. */
function canonicalArguments(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry !== null && typeof entry === "object"
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonical((entry as Record<string, unknown>)[key])]))
      : entry;
  return JSON.stringify(canonical(value)) ?? "null";
}

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
  const dispatched: MutableMcpDispatch[] = [];
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
      dispatched.push({ name: request.params.name, arguments: canonicalArguments(request.params.arguments ?? {}) });
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
    /** `tools/call` requests of `name`, only those with exactly `args` when given. */
    dispatches(name: string, args?: Readonly<Record<string, unknown>>): number {
      const key = args === undefined ? null : canonicalArguments(args);
      return dispatched.filter((entry) => entry.name === name && (key === null || entry.arguments === key)).length;
    },
    /** Every `tools/call` request in arrival order. */
    dispatched: (): readonly MutableMcpDispatch[] => [...dispatched],
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

/**
 * The synthetic peer of the MCP write-approval scenarios: `read_record` the
 * server annotates read-only and `delete_record` it annotates destructive.
 * Each record exists until a dispatched delete removes it, so the endpoint's
 * `dispatches(name, args)` and `deleted()` are the oracles.
 */
export function createWriteApprovalFixture() {
  const deleted: string[] = [];
  const idSchema = { additionalProperties: false, properties: { id: { maxLength: 64, type: "string" } }, required: ["id"],
    type: "object" as const };
  const tools: MutableMcpTool[] = [
    { annotations: { readOnlyHint: true }, description: "Read one synthetic record by id.", inputSchema: idSchema,
      name: "read_record" },
    { annotations: { destructiveHint: true }, description: "Delete one synthetic record by id.", inputSchema: idSchema,
      name: "delete_record" }
  ];
  const callTool = (name: string, args: Readonly<Record<string, unknown>>): CallToolResult => {
    const id = typeof args.id === "string" ? args.id : null;
    if (name === "read_record" && id) {
      return { content: [{ text: JSON.stringify({ id, state: deleted.includes(id) ? "deleted" : "open" }), type: "text" }] };
    }
    if (name === "delete_record" && id) {
      deleted.push(id);
      return { content: [{ text: JSON.stringify({ deleted: id }), type: "text" }] };
    }
    return { content: [{ text: "Unknown synthetic tool or arguments.", type: "text" }], isError: true };
  };
  return { callTool, deleted: (): readonly string[] => [...deleted], tools: tools as readonly MutableMcpTool[] };
}

export const TOOL_HISTORY_FIXTURE = Object.freeze({
  writeTool: "create_record",
  readTool: "get_item",
  /** Distinguishable read results, items 1..items. */
  items: 10
});

/** The code only the end of item `index`'s report carries: an answer naming it
 * read past any short excerpt of that exact call. Synthetic, deterministic. */
export function toolHistoryItemCode(index: number): string {
  return `ITEM-${String(index).padStart(2, "0")}-${createHash("sha256").update(`aiqsa-tool-history-item-${index}`).digest("hex").slice(0, 8).toUpperCase()}`;
}

/** About 2 KB of neutral report lines with the item's code only at the end. */
export function toolHistoryItemReport(index: number): string {
  const lines = Array.from({ length: 36 }, (_, line) =>
    `Item ${index}, report line ${line + 1}: synthetic status text, nothing to verify here.`);
  return `${lines.join("\n")}\nVerification code of item ${index}: ${toolHistoryItemCode(index)}`;
}

/**
 * The synthetic peer of the cross-turn tool-history scenarios: one write tool
 * whose every call creates a new record (no read-only hint), and one read
 * tool with ten distinguishable reports. Oracles read the endpoint's
 * `dispatches(name, args)` and `records()`, never the model's wording.
 */
export function createToolHistoryFixture() {
  const records: Array<Readonly<{ id: string; title: string }>> = [];
  let readDelayMs = 0;
  const tools: MutableMcpTool[] = [
    {
      annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
      description: "Create one new synthetic record with the given title. Every call creates another record.",
      inputSchema: { additionalProperties: false, properties: { title: { maxLength: 200, type: "string" } },
        required: ["title"], type: "object" },
      name: TOOL_HISTORY_FIXTURE.writeTool
    },
    {
      annotations: { readOnlyHint: true },
      description: `Return the full report of one synthetic item, 1 to ${TOOL_HISTORY_FIXTURE.items}. A report ends with the item's verification code.`,
      inputSchema: { additionalProperties: false,
        properties: { index: { maximum: TOOL_HISTORY_FIXTURE.items, minimum: 1, type: "integer" } },
        required: ["index"], type: "object" },
      name: TOOL_HISTORY_FIXTURE.readTool
    }
  ];
  const callTool = async (name: string, args: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
    if (name === TOOL_HISTORY_FIXTURE.writeTool && typeof args.title === "string") {
      const record = { id: `rec-${String(records.length + 1).padStart(3, "0")}`, title: args.title };
      records.push(record);
      return { content: [{ text: JSON.stringify({ created: record.id, title: record.title }), type: "text" }] };
    }
    const index = args.index;
    if (name === TOOL_HISTORY_FIXTURE.readTool && typeof index === "number" && Number.isInteger(index) &&
      index >= 1 && index <= TOOL_HISTORY_FIXTURE.items) {
      if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      return { content: [{ text: toolHistoryItemReport(index), type: "text" }] };
    }
    return { content: [{ text: "Unknown synthetic tool or arguments.", type: "text" }], isError: true };
  };
  return {
    callTool,
    records: (): readonly Readonly<{ id: string; title: string }>[] => [...records],
    /** Slows every later read, so a Stop can land while a run still reads. */
    setReadDelayMs(value: number) { readDelayMs = Math.max(0, value); },
    tools: tools as readonly MutableMcpTool[]
  };
}
