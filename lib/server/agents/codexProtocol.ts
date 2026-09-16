/**
 * Private Codex exec transport. stdout is an untrusted JSONL protocol, not a
 * terminal preview: never truncate it or forward command output/reasoning.
 * Provider accounting is deliberately absent from this projection.
 */
export type CodexEvent =
  | Readonly<{ type: "thread_started"; threadId: string }>
  | Readonly<{ type: "turn_started" }>
  | Readonly<{ type: "message"; id: string; text: string }>
  | Readonly<{
      type: "activity";
      id: string;
      kind: "command" | "file_change" | "mcp" | "search";
      phase: "running" | "succeeded" | "failed";
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
  lineBytes: 2 * 1024 * 1024,
  records: 20_000,
  totalBytes: 64 * 1024 * 1024
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const kind = item.type === "command_execution" ? "command"
      : item.type === "file_change" ? "file_change"
        : item.type === "mcp_tool_call" ? "mcp" : item.type === "web_search" ? "search" : null;
    if (!kind) return null;
    const phase = type !== "item.completed" ? "running"
      : (item.status === "completed" || kind === "search" && item.status !== "failed") && (kind !== "command" || item.exit_code === 0)
        ? "succeeded" : "failed";
    return { type: "activity", id: item.id, kind, phase };
  }
}
