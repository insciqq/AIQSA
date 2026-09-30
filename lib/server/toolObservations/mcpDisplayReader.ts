import { createHash } from "node:crypto";
import { isUint8Array } from "node:util/types";
import { MCP_CALL_DISPLAY_BYTES, type McpCallDisplaySection } from "../../contracts/mcpCallDetails";
import { readStreamWithAbort } from "../http/byteStream";
import { OBSERVATION_READ_LIMITS, ObservationReadError, type ObservationByteIdentity } from "./byteReader";

const DISPLAY_BYTES = MCP_CALL_DISPLAY_BYTES;
const UNSUPPORTED_TYPES = 16;
const unavailable = () => new ObservationReadError("tool_observation_unavailable");

export type McpDisplayOriginal = Readonly<{
  response: McpCallDisplaySection;
  isError: boolean;
  unsupportedContentTypes: string[];
}>;

/** Exact, longest-first literal replacement. A candidate beginning in the
 * retained tail is never emitted until the rest of that candidate is known. */
class Redactor {
  private pending = "";
  constructor(private readonly pattern: RegExp | null, private readonly overlap: number,
    private readonly write: (value: string) => void) {}
  push(value: string) {
    this.pending += value;
    if (this.pending.length >= this.overlap + 1024) this.flush(false);
  }
  flush(final: boolean) {
    let safe = final ? this.pending.length : Math.max(0, this.pending.length - this.overlap);
    if (!final && safe > 0 && /[\ud800-\udbff]/u.test(this.pending[safe - 1]!) &&
      (safe === this.pending.length || /[\udc00-\udfff]/u.test(this.pending[safe]!))) safe--;
    let consumed = 0;
    if (this.pattern) {
      this.pattern.lastIndex = 0;
      for (let match = this.pattern.exec(this.pending); match && match.index < safe; match = this.pattern.exec(this.pending)) {
        this.write(this.pending.slice(consumed, match.index));
        this.write("[REDACTED]");
        consumed = match.index + match[0].length;
      }
    }
    if (consumed < safe) { this.write(this.pending.slice(consumed, safe)); consumed = safe; }
    this.pending = this.pending.slice(consumed);
  }
}

type Role = "envelope" | "text" | "metadata" | "structured";
type Frame = { kind: "object" | "array"; role: Role; state: "first" | "key" | "colon" | "value" | "comma"; key: string };

/** A push parser keeps no JSON value tree and no complete string tokens. Text
 * blocks are decoded for reading; structured content is indented JSON. Only
 * envelope keys, at most 16 distinct content types and the container stack are retained. */
class DisplayParser {
  private readonly stack: Frame[] = [];
  private readonly fields = new Set<string>();
  private started = false;
  private finished = false;
  private sectionStarted = false;
  private token: "string" | "scalar" | null = null;
  private scalar = "";
  private escape = false;
  private unicode: string | null = null;
  private keyString = false;
  private capture = "";
  private stringRole: Role = "envelope";
  private stringRedactor: Redactor | null = null;
  isError = false;
  unsupportedContentTypes: string[] = [];

  constructor(private readonly write: (value: string) => void,
    private readonly redactor: (write: (value: string) => void) => Redactor) {}

  private section() {
    if (this.sectionStarted) this.write("\n\n");
    this.sectionStarted = true;
  }
  private completeValue() {
    const frame = this.stack.at(-1);
    if (frame) frame.state = "comma";
    else this.finished = true;
  }
  private valueRole(kind: "object" | "array" | "string" | "scalar"): Role {
    const frame = this.stack.at(-1);
    if (!frame) {
      if (this.started || kind !== "object") throw unavailable();
      this.started = true;
      return "envelope";
    }
    if (frame.role === "envelope") {
      if (frame.key === "text" && kind === "array") return "text";
      if (frame.key === "unsupportedContentTypes" && kind === "array") return "metadata";
      if (frame.key === "structuredContent" && (kind === "object" || kind === "scalar")) return "structured";
      if (frame.key === "isError" && kind === "scalar") return "envelope";
      throw unavailable();
    }
    if ((frame.role === "text" || frame.role === "metadata") && kind !== "string") throw unavailable();
    return frame.role;
  }
  private stringPart(value: string) {
    if (this.keyString && this.stringRole === "envelope" || this.stringRole === "metadata") {
      this.capture += value;
      if (this.capture.length > 64) throw unavailable();
    }
    this.stringRedactor?.push(value);
  }
  private endString() {
    if (this.escape || this.unicode !== null) throw unavailable();
    this.stringRedactor?.flush(true);
    this.stringRedactor = null;
    const frame = this.stack.at(-1)!;
    if (this.stringRole === "structured") this.write('"');
    if (this.keyString) {
      if (frame.role === "envelope") {
        if (!["isError", "structuredContent", "text", "unsupportedContentTypes"].includes(this.capture) || this.fields.has(this.capture)) throw unavailable();
        this.fields.add(this.capture);
        frame.key = this.capture;
      }
      frame.state = "colon";
    } else {
      if (this.stringRole === "metadata") {
        // Metadata is user-visible too. Apply the same read-time secret policy.
        let value = "";
        const redact = this.redactor(part => { value += part; });
        redact.push(this.capture);
        redact.flush(true);
        if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) throw unavailable();
        // One entry per dropped block: list each type once, cut to the display limit.
        if (this.unsupportedContentTypes.length < UNSUPPORTED_TYPES && !this.unsupportedContentTypes.includes(value)) {
          this.unsupportedContentTypes.push(value);
        }
      }
      this.completeValue();
    }
    this.token = null;
    this.capture = "";
  }
  private endScalar() {
    const value = this.scalar;
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u.test(value)) throw unavailable();
    const frame = this.stack.at(-1)!;
    if (frame.role === "envelope") {
      if (frame.key === "isError") {
        if (value !== "true" && value !== "false") throw unavailable();
        this.isError = value === "true";
      } else if (frame.key !== "structuredContent" || value !== "null") throw unavailable();
    } else {
      // Scalar credentials follow the existing MCP result redaction policy.
      let redacted = "";
      const redact = this.redactor(part => { redacted += part; });
      redact.push(value);
      redact.flush(true);
      this.write(redacted === value ? value : JSON.stringify(redacted));
    }
    this.scalar = "";
    this.token = null;
    this.completeValue();
  }
  push(text: string) {
    for (const char of text) {
      if (this.token === "string") {
        if (this.unicode !== null) {
          if (!/^[a-fA-F0-9]$/u.test(char)) throw unavailable();
          this.unicode += char;
          if (this.unicode.length === 4) { this.stringPart(String.fromCharCode(parseInt(this.unicode, 16))); this.unicode = null; }
        } else if (this.escape) {
          this.escape = false;
          if (char === "u") this.unicode = "";
          else {
            const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
            if (!Object.hasOwn(escapes, char)) throw unavailable();
            this.stringPart(escapes[char]!);
          }
        } else if (char === "\\") this.escape = true;
        else if (char === '"') this.endString();
        else { if (char.charCodeAt(0) < 32) throw unavailable(); this.stringPart(char); }
        continue;
      }
      if (this.token === "scalar") {
        if (!/[\s,}\]]/u.test(char)) {
          this.scalar += char;
          if (this.scalar.length > 128) throw unavailable();
          continue;
        }
        this.endScalar();
      }
      if (/^[ \r\n\t]$/u.test(char)) continue;
      if (this.finished) throw unavailable();
      const frame = this.stack.at(-1);
      if (frame?.state === "colon") {
        if (char !== ":") throw unavailable();
        if (frame.role === "structured") this.write(": ");
        frame.state = "value";
        continue;
      }
      if (char === "}" || char === "]") {
        if (!frame || (char === "}") !== (frame.kind === "object") || !["first", "comma"].includes(frame.state)) throw unavailable();
        if (frame.role === "structured") {
          if (frame.state !== "first") this.write("\n" + "  ".repeat(this.stack.length - 2));
          this.write(char);
        }
        this.stack.pop();
        this.completeValue();
        continue;
      }
      if (frame?.state === "comma") {
        if (char !== ",") throw unavailable();
        if (frame.role === "structured") this.write(",\n" + "  ".repeat(this.stack.length - 1));
        frame.state = frame.kind === "object" ? "key" : "value";
        continue;
      }
      if (frame?.role === "structured" && frame.state === "first") this.write("\n" + "  ".repeat(this.stack.length - 1));
      this.keyString = frame?.kind === "object" && (frame.state === "first" || frame.state === "key");
      if (this.keyString && char !== '"') throw unavailable();
      if (char === '"') {
        this.token = "string";
        this.stringRole = this.keyString ? frame!.role : this.valueRole("string");
        this.capture = "";
        if (this.stringRole === "text") this.section();
        if (this.stringRole === "structured") this.write('"');
        if (this.stringRole === "text" || this.stringRole === "structured") {
          this.stringRedactor = this.redactor(value => this.write(this.stringRole === "structured" ? JSON.stringify(value).slice(1, -1) : value));
        }
      } else if (char === "{" || char === "[") {
        const kind = char === "{" ? "object" : "array";
        const role = this.valueRole(kind);
        if (this.stack.length >= 128) throw unavailable();
        if (role === "structured") { if (frame?.role === "envelope") this.section(); this.write(char); }
        this.stack.push({ kind, role, state: "first", key: "" });
      } else {
        this.valueRole("scalar");
        this.token = "scalar";
        this.scalar = char;
      }
    }
  }
  finish() {
    if (this.token === "scalar") this.endScalar();
    if (!this.finished || this.token || this.fields.size !== 4) throw unavailable();
  }
}

/** One full immutable-object scan, even when the displayed prefix is full.
 * Storage, syntax and UTF-8 failures never return a partially trusted display. */
export async function readMcpDisplayOriginal(input: Readonly<{
  body: ReadableStream<Uint8Array>;
  identity: ObservationByteIdentity;
  secrets: readonly string[];
  signal?: AbortSignal;
}>): Promise<McpDisplayOriginal> {
  const { identity, signal } = input;
  if (!Number.isSafeInteger(identity.byteSize) || identity.byteSize < 1 || identity.byteSize > OBSERVATION_READ_LIMITS.documentBytes ||
    !/^[a-f0-9]{64}$/u.test(identity.checksum)) throw unavailable();
  const secrets = [...new Set(input.secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (secrets.reduce((sum, value) => sum + value.length, 0) > DISPLAY_BYTES) throw unavailable();
  const pattern = secrets.length ? new RegExp(secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu") : null;
  const redact = (write: (value: string) => void) => new Redactor(pattern, secrets[0]?.length ?? 0, write);
  const output = Buffer.alloc(DISPLAY_BYTES);
  let captured = 0;
  let byteSize = 0;
  let pendingSurrogate = "";
  let full = false;
  const write = (part: string) => {
    // A decoded escape or decoder slice may divide a surrogate pair.
    let value = pendingSurrogate + part;
    pendingSurrogate = "";
    if (/[\ud800-\udbff]$/u.test(value)) { pendingSurrogate = value.slice(-1); value = value.slice(0, -1); }
    const bytes = Buffer.from(value);
    byteSize += bytes.length;
    if (!full) {
      let end = Math.min(bytes.length, DISPLAY_BYTES - captured);
      while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      output.set(bytes.subarray(0, end), captured);
      captured += end;
      if (end < bytes.length) full = true;
    }
  };
  const parser = new DisplayParser(write, redact);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const hash = createHash("sha256");
  const reader = input.body.getReader();
  let total = 0;
  let completed = false;
  try {
    await readStreamWithAbort(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        if (!isUint8Array(next.value) || total + next.value.length > identity.byteSize) throw unavailable();
        total += next.value.length;
        hash.update(next.value);
        for (let offset = 0; offset < next.value.length; offset += 4096) {
          let text: string;
          try { text = decoder.decode(next.value.subarray(offset, offset + 4096), { stream: true }); }
          catch { throw unavailable(); }
          parser.push(text);
        }
      }
    }, signal);
    signal?.throwIfAborted();
    try { parser.push(decoder.decode()); } catch { throw unavailable(); }
    parser.finish();
    if (pendingSurrogate) { pendingSurrogate = ""; write("\ufffd"); }
    if (total !== identity.byteSize || hash.digest("hex") !== identity.checksum) throw unavailable();
    completed = true;
    return { response: { text: output.subarray(0, captured).toString("utf8"), byteSize, truncated: byteSize > captured },
      isError: parser.isError, unsupportedContentTypes: parser.unsupportedContentTypes };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error instanceof ObservationReadError ? error : new ObservationReadError("tool_observation_unavailable", { transient: true });
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
