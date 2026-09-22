/**
 * Private Codex exec transport. stdout is an untrusted JSONL protocol, not a
 * terminal preview. These private facts must pass through the masked, bounded
 * activity projection before publication. Reasoning and raw results stay out.
 */
import { decodeMcpDiscoveryFailure, type McpDiscoveryFailure } from "../../contracts/mcpDiscoveryFailure";
import { decodeMcpToolFailure, type McpToolFailure } from "../../contracts/mcpToolFailure";
import { getMcpRequestMaxBytes, MCP_RESPONSE_WIRE_LIMIT_CEILINGS } from "../mcp/responseLimits";

export type CodexEvent =
  | Readonly<{ type: "thread_started"; threadId: string }>
  | Readonly<{ type: "turn_started" }>
  | Readonly<{ type: "message"; id: string; text: string }>
  | Readonly<{
      type: "activity";
      id: string;
      kind: "command" | "file_change" | "mcp" | "search" | "plan";
      phase: "running" | "succeeded" | "failed";
      command?: string;
      output?: string;
      exitCode?: number | null;
      changes?: readonly Readonly<{ path: string; action: "add" | "update" | "delete" }>[];
      tool?: string;
      toolId?: string;
      discoveryFailure?: McpDiscoveryFailure;
      toolFailure?: McpToolFailure;
      query?: string;
      source?: string;
      items?: readonly Readonly<{ text: string; completed: boolean }>[];
    }>
  | Readonly<{ type: "turn_completed" }>
  | Readonly<{ type: "turn_failed" }>
  | Readonly<{ type: "runtime_error" }>;

export class CodexProtocolError extends Error {
  constructor(readonly code:
    | "agent_output_limit_exceeded"
    | "agent_protocol_invalid"
    | "agent_protocol_incomplete"
    | "agent_process_failed"
    | "agent_turn_failed"
    | "agent_output_cursor_invalid"
  ) {
    super(code);
    this.name = "CodexProtocolError";
  }
}

export const CODEX_OUTPUT_LIMITS = Object.freeze({
  // Codex exec includes MCP results in JSONL. Accommodate the largest permitted
  // tool response, the gateway envelope, and the outer activity record.
  get lineBytes() { return 2 * (MCP_RESPONSE_WIRE_LIMIT_CEILINGS.callToolResponseMaxBytes + getMcpRequestMaxBytes()) + 64 * 1024; },
  records: 20_000,
  get totalBytes() { return Math.max(64 * 1024 * 1024, 2 * this.lineBytes); }
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failurePayloadFromResult(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  const structured = value.structuredContent ?? value.structured_content;
  if (record(structured)) return structured;
  if (!Array.isArray(value.content) || value.content.length !== 1) return null;
  const block = value.content[0];
  if (!record(block) || block.type !== "text" || typeof block.text !== "string" || block.text.length > 2_048) return null;
  try {
    const parsed: unknown = JSON.parse(block.text);
    return record(parsed) ? parsed : null;
  } catch { return null; }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function invalid(): never {
  throw new CodexProtocolError("agent_protocol_invalid");
}

/** One decoder per registered exec; the caller owns cancellation and cleanup. */
export class CodexJsonlDecoder {
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private totalBytes = 0;
  private records = 0;
  private threadId: string | null = null;
  private started = false;
  private terminal: "completed" | "failed" | null = null;
  private closed = false;
  private readonly activeTools = new Set<string>();
  private unknownActivity = false;

  get nativeThreadId(): string | null { return this.threadId; }
  get toolsSettled(): boolean { return this.activeTools.size === 0 && !this.unknownActivity; }
  get canInterrupt(): boolean {
    return !this.closed && Boolean(this.threadId && this.started) && !this.terminal && this.toolsSettled && this.pendingBytes === 0;
  }

  constructor(private readonly limits: Readonly<{
    lineBytes: number;
    records: number;
    totalBytes: number;
  }> = CODEX_OUTPUT_LIMITS) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) invalid();
    }
  }

  push(bytes: Uint8Array): CodexEvent[] {
    if (this.closed) invalid();
    try {
      return this.consumeBytes(bytes);
    } catch (error) {
      this.closed = true;
      this.pending = [];
      this.pendingBytes = 0;
      throw error;
    }
  }

  private consumeBytes(bytes: Uint8Array): CodexEvent[] {
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > this.limits.totalBytes) this.overflow();
    const events: CodexEvent[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = bytes.indexOf(10, offset);
      const segment = bytes.subarray(offset, end < 0 ? bytes.byteLength : end);
      this.pendingBytes += segment.byteLength;
      if (this.pendingBytes > this.limits.lineBytes) this.overflow();
      // Own a copy: transport buffers can be recycled after this call.
      if (segment.byteLength) this.pending.push(segment.slice());
      if (end < 0) break;
      const event = this.consumeLine();
      if (event) events.push(event);
      offset = end + 1;
    }
    return events;
  }

  /** A terminal JSON event alone is insufficient: exec must also exit zero. */
  finish(exitCode: number | null): CodexEvent[] {
    if (this.closed) invalid();
    this.closed = true;
    const last = this.pendingBytes ? this.consumeLine() : null;
    if (this.terminal === "failed") throw new CodexProtocolError("agent_turn_failed");
    if (exitCode !== 0) throw new CodexProtocolError("agent_process_failed");
    if (!this.threadId || !this.started || this.terminal !== "completed") {
      throw new CodexProtocolError("agent_protocol_incomplete");
    }
    return last ? [last] : [];
  }

  /** Only the owner of an acknowledged SIGINT may use this exit contract. */
  finishInterrupted(exitCode: number | null): CodexEvent[] {
    if (this.closed) invalid();
    this.closed = true;
    const last = this.pendingBytes ? this.consumeLine() : null;
    if (!this.threadId || !this.started || !this.toolsSettled || this.terminal === "failed" ||
      !(exitCode === 1 && this.terminal === null || exitCode === 0 && this.terminal === "completed")) {
      throw new CodexProtocolError("agent_protocol_incomplete");
    }
    return last ? [last] : [];
  }

  private overflow(): never {
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    throw new CodexProtocolError("agent_output_limit_exceeded");
  }

  private consumeLine(): CodexEvent | null {
    const bytes = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const chunk of this.pending) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    let line: string;
    try {
      line = this.utf8.decode(bytes).trim();
    } catch {
      return invalid();
    }
    if (!line) return null;
    if (++this.records > this.limits.records) this.overflow();
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return invalid();
    }
    if (!record(value) || typeof value.type !== "string") return invalid();
    return this.project(value);
  }

  private project(value: Record<string, unknown>): CodexEvent | null {
    if (this.terminal) return invalid();
    switch (value.type) {
      case "thread.started": {
        if (this.threadId || this.started || !identifier(value.thread_id)) return invalid();
        this.threadId = value.thread_id;
        return { type: "thread_started", threadId: this.threadId };
      }
      case "turn.started":
        if (!this.threadId || this.started) return invalid();
        this.started = true;
        return { type: "turn_started" };
      case "turn.completed":
        if (!this.started) return invalid();
        this.terminal = "completed";
        // Guest-reported usage is never billing authority.
        return { type: "turn_completed" };
      case "turn.failed":
        this.terminal = "failed";
        return { type: "turn_failed" };
      case "error":
        // Codex may recover a connection after an error event. Its eventual
        // turn terminal and process exit decide success, not raw error prose.
        return { type: "runtime_error" };
      case "item.started":
      case "item.updated":
      case "item.completed":
        if (!record(value.item)) return invalid();
        // exec emits nonfatal setup/model-metadata diagnostics as error items
        // before turn.started too. They do not establish a failed turn.
        if (value.item.type === "error" && identifier(value.item.id)) return { type: "runtime_error" };
        if (!this.started) return invalid();
        return this.projectItem(value.type, value.item);
      default:
        // Unknown informational events carry no authority or browser payload.
        // Missing/changed completion events still fail closed in finish().
        return null;
    }
  }

  private projectItem(type: string, item: Record<string, unknown>): CodexEvent | null {
    if (typeof item.type !== "string" || !identifier(item.id)) return invalid();
    if (item.type === "agent_message") {
      if (typeof item.text !== "string") return invalid();
      return type === "item.completed" ? { type: "message", id: item.id, text: item.text } : null;
    }
    const kind = (item.type === "command_execution" ? "command"
      : item.type === "file_change" ? "file_change"
        : item.type === "mcp_tool_call" ? "mcp" : item.type === "web_search" ? "search"
          : ["todo_list", "plan", "plan_update"].includes(item.type) ? "plan" : null) as Extract<CodexEvent, { type: "activity" }>["kind"] | null;
    if (!kind) {
      if (item.type !== "reasoning") this.unknownActivity = true;
      return null;
    }
    if (kind !== "plan") {
      if (type !== "item.completed" || kind === "command" && !Number.isSafeInteger(item.exit_code)) this.activeTools.add(item.id);
      else this.activeTools.delete(item.id);
    }
    const phase: Extract<CodexEvent, { type: "activity" }>["phase"] = type !== "item.completed" ? "running"
      : (item.status === "completed" || (kind === "search" || kind === "plan") && item.status !== "failed") && (kind !== "command" || item.exit_code === 0)
        ? "succeeded" : "failed";
    const base = { type: "activity" as const, id: item.id, kind, phase };
    if (kind === "command") {
      if (item.command !== undefined && typeof item.command !== "string" ||
        item.aggregated_output !== undefined && typeof item.aggregated_output !== "string" ||
        item.exit_code !== undefined && item.exit_code !== null && !Number.isSafeInteger(item.exit_code)) return invalid();
      return { ...base,
        ...(typeof item.command === "string" ? { command: item.command } : {}),
        // Pinned exec reports aggregated output only at completion. Never
        // present a started/updated payload as an incremental terminal stream.
        ...(type === "item.completed" ? {
          ...(typeof item.aggregated_output === "string" ? { output: item.aggregated_output } : {}),
          exitCode: typeof item.exit_code === "number" ? item.exit_code : null
        } : {}) };
    }
    if (kind === "file_change") {
      if (item.changes !== undefined && !Array.isArray(item.changes)) return invalid();
      const changes: NonNullable<Extract<CodexEvent, { type: "activity" }>["changes"]>[number][] = [];
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        if (!record(change) || typeof change.path !== "string" ||
          !["add", "update", "delete"].includes(String(change.kind))) return invalid();
        changes.push({ path: change.path, action: change.kind as "add" | "update" | "delete" });
      }
      return { ...base, changes };
    }
    if (kind === "plan") {
      const rawItems = item.items ?? item.plan;
      if (!Array.isArray(rawItems)) return invalid();
      const items: { text: string; completed: boolean }[] = [];
      for (const entry of rawItems) {
        if (!record(entry) || typeof entry.text !== "string" ||
          !(typeof entry.completed === "boolean" || entry.status === "completed" || entry.status === "in_progress" || entry.status === "pending")) return invalid();
        items.push({ text: entry.text, completed: entry.completed === true || entry.status === "completed" });
      }
      return { ...base, items };
    }
    const args = record(item.arguments) ? item.arguments : null;
    const toolName = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : undefined;
    const failurePayload = kind === "mcp" && type === "item.completed" ? failurePayloadFromResult(item.result) : null;
    const discoveryFailure = toolName === "find_tools" && failurePayload?.code === "discovery_unavailable"
      ? decodeMcpDiscoveryFailure(failurePayload.discoveryFailure) : null;
    const toolFailure = toolName !== "find_tools" && failurePayload?.code === "result_unsupported"
      ? decodeMcpToolFailure(failurePayload.toolFailure) : null;
    const mcpError = kind === "mcp" && type === "item.completed" && record(item.result) &&
      (item.result.isError === true || item.result.is_error === true);
    // Select only fields needed to resolve an admitted tool/search identity.
    // Never retain the argument object, MCP result, server id or raw errors.
    // Discovery failures retain only the closed content-free diagnostic codes.
    return { ...base,
      ...(mcpError ? { phase: "failed" as const } : {}),
      ...(discoveryFailure ? { phase: "failed" as const, discoveryFailure } : {}),
      ...(toolFailure ? { phase: "failed" as const, toolFailure } : {}),
      ...(toolName ? { tool: toolName } : {}),
      ...(typeof args?.tool_id === "string" ? { toolId: args.tool_id } : {}),
      ...(typeof item.query === "string" ? { query: item.query }
        : toolName === "aiqsa_search" && typeof args?.query === "string" ? { query: args.query } : {}),
      ...(toolName === "aiqsa_search" && typeof args?.source === "string" ? { source: args.source } : {}) };
  }
}
