import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  startMutableMcpEndpoint,
  type MutableMcpEndpointOptions,
  type MutableMcpTool
} from "./mutableMcpEndpoint";

/**
 * A neutral loopback MCP peer whose tools return many large results, for the
 * tool-result recall and context-compaction scenarios: one list of synthetic
 * objects and one detail tool whose bodies are deterministic, 8–64 KB, and
 * alternate between structured JSON text and plain text; every tool declares
 * `readOnlyHint`. A fixed subset of
 * object ids answers with an MCP tool error. Content is generated, never real.
 */
export const BULK_RESULT_LIMITS = Object.freeze({
  objects: 50,
  minDetailBytes: 8 * 1024,
  maxDetailBytes: 64 * 1024,
  /** Every seventh object fails, so errors sit between successful results. */
  errorEvery: 7
});

export const BULK_LIST_TOOL_NAME = "list_records";
export const BULK_DETAIL_TOOL_NAME = "get_record_details";
/** Optional: a status that never changes, for the repeated-call scenario. */
export const BULK_STATUS_TOOL_NAME = "get_sync_status";

const bulkResultToolList: MutableMcpTool[] = [
  {
    annotations: { readOnlyHint: true },
    description: "List every synthetic record with its id and short title.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: BULK_LIST_TOOL_NAME
  },
  {
    annotations: { readOnlyHint: true },
    description: "Return the full details of one synthetic record, including its status and history.",
    inputSchema: {
      additionalProperties: false,
      properties: { id: { description: "A record id from list_records, such as rec-001.", type: "string" } },
      required: ["id"],
      type: "object"
    },
    name: BULK_DETAIL_TOOL_NAME
  }
];

export const bulkResultTools: readonly MutableMcpTool[] = Object.freeze(bulkResultToolList);

const bulkStatusTool: MutableMcpTool = {
  annotations: { readOnlyHint: true },
  description: "Report whether the synthetic record sync has finished and how many records it has processed.",
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  name: BULK_STATUS_TOOL_NAME
};

/** The unchanging answer of the status tool: the sync never finishes. */
export const BULK_STATUS_TEXT = JSON.stringify({ completed: 0, state: "running", total: 50 });

const STATUSES = ["open", "blocked", "in review", "done", "waiting for reply"] as const;
const WORDS = ["alpha", "beacon", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "iris", "juniper",
  "kestrel", "lumen", "meadow", "nimbus", "orchid", "prairie", "quartz", "rivet", "sierra", "tundra"];

export function bulkRecordId(index: number): string {
  return `rec-${String(index + 1).padStart(3, "0")}`;
}

function recordIndex(id: unknown): number | null {
  if (typeof id !== "string") return null;
  const match = /^rec-(\d{3})$/u.exec(id);
  const index = match ? Number(match[1]) - 1 : -1;
  return index >= 0 && index < BULK_RESULT_LIMITS.objects ? index : null;
}

/** Stable pseudo-random bytes per seed, never a security primitive. */
function stream(seed: string): () => number {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  return () => {
    if (offset >= block.length) {
      block = createHash("sha256").update(`${seed}:${counter++}`).digest();
      offset = 0;
    }
    return block[offset++]!;
  };
}

export function bulkRecordTitle(index: number): string {
  const next = stream(`title:${index}`);
  return `${WORDS[next() % WORDS.length]} ${WORDS[next() % WORDS.length]} task ${index + 1}`;
}

export function bulkRecordStatus(index: number): (typeof STATUSES)[number] {
  return STATUSES[stream(`status:${index}`)() % STATUSES.length]!;
}

export function bulkRecordFails(index: number): boolean {
  return (index + 1) % BULK_RESULT_LIMITS.errorEvery === 0;
}

/** The deterministic body size of one record's details. */
export function bulkDetailBytes(index: number): number {
  const next = stream(`size:${index}`);
  const span = BULK_RESULT_LIMITS.maxDetailBytes - BULK_RESULT_LIMITS.minDetailBytes;
  return BULK_RESULT_LIMITS.minDetailBytes + ((next() << 8 | next()) % (span + 1));
}

function sentence(next: () => number): string {
  const length = 6 + next() % 10;
  return `${Array.from({ length }, () => WORDS[next() % WORDS.length]).join(" ")}.`;
}

/** Details of one record within its exact byte size: JSON for even ids, plain text for odd ones. */
export function bulkRecordDetails(index: number): string {
  const target = bulkDetailBytes(index);
  const next = stream(`details:${index}`);
  const id = bulkRecordId(index);
  const status = bulkRecordStatus(index);
  const history: Array<{ author: string; note: string; step: number }> = [];
  const json = index % 2 === 0;
  const render = () => json
    ? JSON.stringify({ history, id, status, title: bulkRecordTitle(index) })
    : [`Record ${id}: ${bulkRecordTitle(index)}`, `Status: ${status}`, "History:",
        ...history.map((entry) => `${entry.step}. ${entry.author}: ${entry.note}`)].join("\n");
  let body = render();
  while (Buffer.byteLength(body, "utf8") < target) {
    history.push({ author: WORDS[next() % WORDS.length]!, note: sentence(next), step: history.length + 1 });
    body = render();
  }
  return body;
}

export function bulkResultCall(name: string, args: Readonly<Record<string, unknown>>): CallToolResult {
  if (name === BULK_LIST_TOOL_NAME) {
    const records = Array.from({ length: BULK_RESULT_LIMITS.objects }, (_value, index) => ({
      id: bulkRecordId(index), title: bulkRecordTitle(index)
    }));
    return { content: [{ text: JSON.stringify({ records, total: records.length }), type: "text" }] };
  }
  if (name === BULK_DETAIL_TOOL_NAME) {
    const index = recordIndex(args.id);
    if (index === null) return { content: [{ text: "Unknown record id.", type: "text" }], isError: true };
    if (bulkRecordFails(index)) {
      return { content: [{ text: `Record ${bulkRecordId(index)} is temporarily unavailable.`, type: "text" }], isError: true };
    }
    return { content: [{ text: bulkRecordDetails(index), type: "text" }] };
  }
  if (name === BULK_STATUS_TOOL_NAME) return { content: [{ text: BULK_STATUS_TEXT, type: "text" }] };
  return { content: [{ text: "Unknown tool.", type: "text" }], isError: true };
}

/** Starts the fixture; `calls(name)` counts received `tools/call` requests.
 * `statusTool` adds the never-changing status tool. */
export function startBulkResultMcpEndpoint(options: Omit<MutableMcpEndpointOptions, "callTool"> & Readonly<{ statusTool?: boolean }> = {}) {
  const { statusTool, ...endpoint } = options;
  return startMutableMcpEndpoint(statusTool ? [...bulkResultTools, bulkStatusTool] : bulkResultTools,
    { ...endpoint, callTool: bulkResultCall });
}

export type BulkResultMcpEndpoint = Awaited<ReturnType<typeof startBulkResultMcpEndpoint>>;

/** The minimal HTTP surface registration needs: a Playwright `APIRequestContext` or an equivalent client. */
export type BulkRegistrationClient = Readonly<{
  delete(path: string): Promise<{ ok(): boolean }>;
  patch(path: string, init: { data: unknown }): Promise<{ ok(): boolean; status(): number }>;
  post(path: string, init: { data: unknown }): Promise<{ json(): Promise<unknown>; ok(): boolean; status(): number }>;
  put(path: string, init: { data: unknown }): Promise<{ ok(): boolean; status(): number }>;
}>;

/**
 * Registers, checks and publishes the fixture as an administrator, grants it
 * to `userId` and enables it for that user, as mcp-published-inventory.spec.ts
 * does. Returns the server id; delete it with `/api/admin/mcp/<id>`.
 */
export async function registerBulkResultMcpServer(client: BulkRegistrationClient, input: Readonly<{
  endpointUrl: string;
  name: string;
  userId: string;
}>): Promise<string> {
  const created = await client.post("/api/admin/mcp", { data: {
    activate: false,
    description: "Synthetic records with large results",
    draft: {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 10_000, startupTimeoutMs: 10_000 },
      slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url: input.endpointUrl },
      transport: "streamable_http"
    },
    name: input.name,
    sharedValues: {}
  } });
  if (created.status() !== 201) throw new Error(`bulk_mcp_create_${created.status()}`);
  const server = (await created.json() as { server?: { id?: unknown; updatedAt?: unknown } }).server;
  if (typeof server?.id !== "string" || typeof server.updatedAt !== "string") throw new Error("bulk_mcp_create_invalid");
  const id = server.id;
  const checked = await client.post(`/api/admin/mcp/${encodeURIComponent(id)}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
  } });
  if (checked.status() !== 200) throw new Error(`bulk_mcp_publish_${checked.status()}`);
  const granted = await client.put(`/api/admin/mcp/${encodeURIComponent(id)}/grants`, { data: {
    canUse: true, personalSlotKeys: [], userId: input.userId
  } });
  if (!granted.ok()) throw new Error(`bulk_mcp_grant_${granted.status()}`);
  const enabled = await client.patch(`/api/me/mcp/${encodeURIComponent(id)}`, { data: { enabled: true } });
  if (!enabled.ok()) throw new Error(`bulk_mcp_enable_${enabled.status()}`);
  return id;
}
