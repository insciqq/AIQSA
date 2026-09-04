import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  WORKSPACE_INBOX_INDEX_MAX_BYTES,
  WORKSPACE_INBOX_INDEX_PATH,
  WORKSPACE_PROJECT_DIRECTORY,
  WORKSPACE_ROOT,
  decodeWorkspaceInboxIndexAttachments,
  isSafeWorkspaceRelativePath,
  workspaceMessageManifestPath,
  workspaceToolIsAllowed
} from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import { loadPinnedOfficialWorkspaceToolCatalog } from "./microsandboxRuntime";
import {
  WorkspaceRuntimeError,
  type WorkspaceOutputStream,
  type WorkspaceRuntime,
  type WorkspaceRuntimeSession,
  type WorkspaceToolCatalog,
  type WorkspaceToolResult
} from "./runtime";

type DeterministicExec = {
  closed: boolean;
  done: boolean;
  exitCode: number | null;
  modelRunId: string;
  output: string;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Test-only faults a deterministic scenario can arm through the
 * `aiqsa-test fault <name>` shell directive. Each fires once.
 */
type DeterministicFault = "export_list_once" | "export_stream_once";

/** Content-free counters that scenarios read back through `aiqsa-test metrics`. */
export type DeterministicWorkspaceMetrics = Readonly<{
  guestFileWrites: number;
  indexWrites: number;
  lastStagedAttachmentIds: readonly string[];
  stageCalls: number;
  stagedAttachmentBodies: number;
}>;

type DeterministicSession = {
  /** Every process ever started in this VM; a VM stop ends all of them, forgotten or not. */
  allExecs: Set<DeterministicExec>;
  directories: Set<string>;
  execs: Map<string, DeterministicExec>;
  faults: Set<DeterministicFault>;
  files: Map<string, Uint8Array>;
  internetEnabled: boolean;
  metrics: {
    guestFileWrites: number;
    indexWrites: number;
    lastStagedAttachmentIds: string[];
    stageCalls: number;
    stagedAttachmentBodies: number;
  };
  runtimeSandboxId: string;
  sandboxName: string;
  state: "ready" | "stopped";
};

/**
 * Deterministic command grammar. Real guests run arbitrary shell; the
 * deterministic runtime only models the shapes tests need:
 *
 * - `pwd` prints the project directory;
 * - `sleep <seconds>` blocks until the delay elapses or the call is aborted;
 * - `sleep <seconds> && echo <text> > <path>` / `; touch <path>` additionally
 *   writes a marker after the delay unless the execution was quiesced first;
 * - `aiqsa-test <directive>` arms faults or reports metrics.
 */
const SLEEP_COMMAND = /^sleep\s+(\d+(?:\.\d+)?)\s*$/u;
const DELAYED_WRITE_COMMAND =
  /^sleep\s+(\d+(?:\.\d+)?)\s*(?:;|&&)\s*(?:touch\s+(\/\S+)|echo\s+(\S+)\s*>\s*(\/\S+))\s*$/u;
const TEST_DIRECTIVE = /^aiqsa-test\s+([a-z-]+)(?:\s+([a-z-]+))?\s*$/u;

type DelayedCommand = Readonly<{
  delayMs: number;
  write: Readonly<{ content: string; path: string }> | null;
}>;

function parseDelayedCommand(command: string): DelayedCommand | null {
  const sleep = SLEEP_COMMAND.exec(command);
  if (sleep) return { delayMs: Math.round(Number(sleep[1]) * 1_000), write: null };
  const delayed = DELAYED_WRITE_COMMAND.exec(command);
  if (!delayed) return null;
  const path = delayed[2] ?? delayed[4]!;
  return {
    delayMs: Math.round(Number(delayed[1]) * 1_000),
    write: { content: delayed[2] ? "" : `${delayed[3]!}\n`, path }
  };
}

function waitOrAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      reject(new WorkspaceRuntimeError("workspace_tool_cancelled"));
    };
    if (signal?.aborted) {
      cancelled();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function terminateExec(exec: DeterministicExec, exitCode: number): void {
  if (exec.timer) {
    clearTimeout(exec.timer);
    exec.timer = null;
  }
  if (!exec.done) {
    exec.done = true;
    exec.exitCode = exitCode;
  }
}

function shellResult(stdout: string, exitCode = 0, stderr = ""): WorkspaceToolResult {
  return {
    ...toolResult({ exitCode, stderr, stdout, success: exitCode === 0 }, "complete"),
    exitCode
  };
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mimeTypeForPath(relativePath: string): string {
  const extension = relativePath.toLowerCase().split(".").pop();
  const known: Record<string, string> = {
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gz: "application/gzip",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    tar: "application/x-tar",
    tgz: "application/gzip",
    txt: "text/plain",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip"
  };
  return extension ? known[extension] ?? "application/octet-stream" : "application/octet-stream";
}

function tarPathFields(path: string): Readonly<{ name: string; prefix: string }> {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new WorkspaceRuntimeError("workspace_archive_limit_exceeded");
}

function writeTarText(header: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.byteLength > length) {
    throw new WorkspaceRuntimeError("workspace_archive_limit_exceeded");
  }
  header.set(encoded, offset);
}

function writeTarOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  writeTarText(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarArchive(entries: readonly Readonly<{
  content: Uint8Array;
  path: string;
  type: "directory" | "file";
}>[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const path = entry.type === "directory" && !entry.path.endsWith("/")
      ? `${entry.path}/`
      : entry.path;
    const fields = tarPathFields(path);
    writeTarText(header, 0, 100, fields.name);
    writeTarOctal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.type === "directory" ? 0 : entry.content.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.type === "directory" ? 0x35 : 0x30;
    writeTarText(header, 257, 6, "ustar\0");
    writeTarText(header, 263, 2, "00");
    writeTarText(header, 345, 155, fields.prefix);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header);
    if (entry.type === "file") {
      chunks.push(entry.content);
      const padding = (512 - entry.content.byteLength % 512) % 512;
      if (padding > 0) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(1_024));
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function body(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value.slice());
      controller.close();
    }
  });
}

/** Streams a first chunk and then fails, like a runner that died mid-transfer. */
function faultedBody(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value.slice(0, Math.max(1, Math.floor(value.byteLength / 2))));
      controller.error(new WorkspaceRuntimeError("workspace_output_export_failed"));
    }
  });
}

function toolResult(data: unknown, status: "complete" | "error" = "complete"): WorkspaceToolResult {
  const text = JSON.stringify(status === "complete"
    ? { data, ok: true }
    : { error: { code: "operation_failed", message: "Deterministic operation failed." }, ok: false });
  return {
    content: [{ text, type: "text" }],
    originalByteCount: bytes(text).byteLength,
    status,
    truncated: false
  };
}

function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${WORKSPACE_ROOT}/`) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((segment) => segment === "..")
  ) {
    throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }
  return value.replace(/\/{2,}/gu, "/").replace(/\/$/u, "");
}

function stringArgument(value: unknown): string {
  if (typeof value !== "string") throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  return value;
}

function decodeContent(argumentsValue: Record<string, unknown>): Uint8Array {
  const content = stringArgument(argumentsValue.content);
  return argumentsValue.encoding === "base64"
    ? Buffer.from(content, "base64")
    : bytes(content);
}

async function readRequestBody(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class DeterministicWorkspaceRuntime implements WorkspaceRuntime {
  private catalogPromise: Promise<WorkspaceToolCatalog> | null = null;
  private readonly generations = new Map<string, number>();
  private readonly sessions = new Map<string, DeterministicSession>();

  constructor(private readonly config: WorkspaceConfig) {}

  /** Content-free staging/write counters for the session, for focused tests. */
  metrics(sessionId: string): DeterministicWorkspaceMetrics | null {
    const session = this.sessions.get(sessionId);
    return session
      ? { ...session.metrics, lastStagedAttachmentIds: [...session.metrics.lastStagedAttachmentIds] }
      : null;
  }

  async health() {
    try {
      await this.catalog();
      return {
        imageReady: true,
        mcpVersion: this.config.mcpVersion,
        // Deterministic mode implements the same pinned protocol contract as
        // the production runner.  The mode is server configuration, not a
        // different accepted runtime version.
        runtimeVersion: "0.6.16",
        state: "ready" as const,
        virtualizationReady: true
      };
    } catch {
      return {
        imageReady: false,
        reasonCode: "workspace_runtime_incompatible",
        state: "unavailable" as const,
        virtualizationReady: false
      };
    }
  }

  private catalog(): Promise<WorkspaceToolCatalog> {
    this.catalogPromise ??= loadPinnedOfficialWorkspaceToolCatalog();
    return this.catalogPromise;
  }

  async ensureSession(input: Parameters<WorkspaceRuntime["ensureSession"]>[0]): Promise<WorkspaceRuntimeSession> {
    let session = this.sessions.get(input.sessionId);
    if (!session) {
      if (input.runtimeSandboxId !== null) throw new WorkspaceRuntimeError("workspace_session_lost");
      // A recreated sandbox gets a new runtime identity, exactly like a real
      // microVM that replaced a lost disk.
      const generation = (this.generations.get(input.sessionId) ?? 0) + 1;
      this.generations.set(input.sessionId, generation);
      const runtimeSandboxId = createHash("sha256")
        .update(`deterministic\0${input.sessionId}\0${input.sandboxName}\0${generation}`)
        .digest("hex");
      session = {
        allExecs: new Set(),
        directories: new Set([
          `${WORKSPACE_ROOT}/inbox`,
          `${WORKSPACE_ROOT}/inbox/messages`,
          WORKSPACE_PROJECT_DIRECTORY,
          `${WORKSPACE_ROOT}/output`,
          `${WORKSPACE_ROOT}/tmp`
        ]),
        execs: new Map(),
        faults: new Set(),
        files: new Map(),
        internetEnabled: input.internetEnabled,
        metrics: {
          guestFileWrites: 0,
          indexWrites: 0,
          lastStagedAttachmentIds: [],
          stageCalls: 0,
          stagedAttachmentBodies: 0
        },
        runtimeSandboxId,
        sandboxName: input.sandboxName,
        state: "ready"
      };
      this.sessions.set(input.sessionId, session);
    }
    if (
      session.sandboxName !== input.sandboxName ||
      (input.runtimeSandboxId !== null && input.runtimeSandboxId !== session.runtimeSandboxId)
    ) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    session.state = "ready";
    return {
      runtimeSandboxId: session.runtimeSandboxId,
      sandboxName: session.sandboxName,
      state: "ready"
    };
  }

  private session(sessionId: string, runtimeSandboxId: string): DeterministicSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.runtimeSandboxId !== runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    return session;
  }

  async listStagedAttachments(input: Parameters<WorkspaceRuntime["listStagedAttachments"]>[0]) {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const raw = session.files.get(WORKSPACE_INBOX_INDEX_PATH);
    if (!raw || raw.byteLength > WORKSPACE_INBOX_INDEX_MAX_BYTES) return [];
    let entries;
    try {
      entries = decodeWorkspaceInboxIndexAttachments(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return [];
    }
    if (!entries) return [];
    return entries.filter((entry) => session.files.get(entry.sandboxPath)?.byteLength === entry.byteSize);
  }

  async stageAttachments(input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]): Promise<void> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    session.metrics.stageCalls += 1;
    session.metrics.lastStagedAttachmentIds = [];
    if (input.outputDirectory) session.directories.add(safePath(input.outputDirectory));
    for (const attachment of input.attachments) {
      const content = await readRequestBody(attachment.body, attachment.byteSize);
      if (content.byteLength !== attachment.byteSize || hash(content) !== attachment.checksum) {
        throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
      }
      session.files.set(safePath(attachment.sandboxPath), content);
      session.metrics.stagedAttachmentBodies += 1;
      session.metrics.guestFileWrites += 1;
      session.metrics.lastStagedAttachmentIds.push(attachment.attachmentId);
    }
    for (const manifest of input.manifests) {
      session.files.set(workspaceMessageManifestPath(manifest.messageId), bytes(JSON.stringify(manifest.body)));
    }
    session.files.set(WORKSPACE_INBOX_INDEX_PATH, bytes(JSON.stringify(input.inboxIndex)));
    session.metrics.indexWrites += 1;
  }

  private directive(
    sessionId: string,
    session: DeterministicSession,
    name: string,
    argument: string | undefined
  ): WorkspaceToolResult {
    if (name === "metrics") {
      return shellResult(`${JSON.stringify(session.metrics)}\n`);
    }
    if (name === "fault" && (argument === "export-list-once" || argument === "export-stream-once")) {
      session.faults.add(argument === "export-list-once" ? "export_list_once" : "export_stream_once");
      return shellResult("armed\n");
    }
    if (name === "forget-executions") {
      // Models an MCP child restart: the guest processes keep running but the
      // runner no longer knows their execution sessions.
      session.execs.clear();
      return shellResult("forgotten\n");
    }
    if (name === "lose-session") {
      // Simulates a microVM whose disk disappeared: every later call for the
      // old runtime identity reports the session as lost.
      for (const exec of session.allExecs) terminateExec(exec, 137);
      this.sessions.delete(sessionId);
      return shellResult("lost\n");
    }
    return shellResult("", 127, `aiqsa-test: unknown directive\n`);
  }

  async loadBoundTools(input: Parameters<WorkspaceRuntime["loadBoundTools"]>[0]) {
    this.session(input.sessionId, input.runtimeSandboxId);
    return this.catalog();
  }

  async callBoundTool(input: Parameters<WorkspaceRuntime["callBoundTool"]>[0]): Promise<WorkspaceToolResult> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    if (!workspaceToolIsAllowed(input.originalName)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    const args = input.arguments;
    switch (input.originalName) {
      case "sandbox_fs_write": {
        const path = safePath(args.path);
        const content = decodeContent(args);
        session.files.set(path, content);
        return toolResult({ encoding: args.encoding ?? "utf8", path, written: content.byteLength });
      }
      case "sandbox_fs_read": {
        const path = safePath(args.path);
        const content = session.files.get(path);
        if (!content) return toolResult(null, "error");
        return toolResult({
          content: args.encoding === "base64"
            ? Buffer.from(content).toString("base64")
            : new TextDecoder().decode(content),
          encoding: args.encoding ?? "utf8",
          path
        });
      }
      case "sandbox_fs_exists": {
        const path = safePath(args.path);
        return toolResult({ path, exists: session.files.has(path) || session.directories.has(path) });
      }
      case "sandbox_fs_mkdir": {
        const path = safePath(args.path);
        session.directories.add(path);
        return toolResult({ created: true, path });
      }
      case "sandbox_fs_list": {
        const path = safePath(args.path);
        const prefix = `${path}/`;
        const entries = new Map<string, { kind: "directory" | "file"; size: number }>();
        for (const [candidate, content] of session.files) {
          if (!candidate.startsWith(prefix)) continue;
          const suffix = candidate.slice(prefix.length);
          const first = suffix.split("/", 1)[0]!;
          entries.set(first, suffix.includes("/")
            ? { kind: "directory", size: 0 }
            : { kind: "file", size: content.byteLength });
        }
        for (const candidate of session.directories) {
          if (!candidate.startsWith(prefix)) continue;
          const suffix = candidate.slice(prefix.length);
          if (suffix && !suffix.includes("/")) entries.set(suffix, { kind: "directory", size: 0 });
        }
        return toolResult([...entries.entries()].sort().map(([name, metadata]) => ({
          kind: metadata.kind,
          mode: metadata.kind === "file" ? 0o644 : 0o755,
          path: `${path}/${name}`,
          size: metadata.size
        })));
      }
      case "sandbox_fs_copy": {
        const from = safePath(args.from);
        const to = safePath(args.to);
        const content = session.files.get(from);
        if (!content) return toolResult(null, "error");
        session.files.set(to, content.slice());
        return toolResult({ copied: true, from: { path: from }, to: { path: to } });
      }
      case "sandbox_fs_rename": {
        const from = safePath(args.from);
        const to = safePath(args.to);
        const content = session.files.get(from);
        if (!content) return toolResult(null, "error");
        session.files.delete(from);
        session.files.set(to, content);
        return toolResult({ from, renamed: true, to });
      }
      case "sandbox_fs_remove": {
        const path = safePath(args.path);
        session.files.delete(path);
        for (const candidate of [...session.files.keys()]) {
          if (candidate.startsWith(`${path}/`)) session.files.delete(candidate);
        }
        session.directories.delete(path);
        return toolResult({ path, removed: true });
      }
      case "sandbox_fs_stat": {
        const path = safePath(args.path);
        const content = session.files.get(path);
        if (!content && !session.directories.has(path)) return toolResult(null, "error");
        return toolResult({
          kind: content ? "file" : "directory",
          mode: content ? 0o644 : 0o755,
          readonly: false,
          size: content?.byteLength ?? 0
        });
      }
      case "sandbox_shell":
      case "sandbox_exec": {
        const command = stringArgument(args.command);
        const directive = TEST_DIRECTIVE.exec(command);
        if (directive) return this.directive(input.sessionId, session, directive[1]!, directive[2]);
        const delayed = parseDelayedCommand(command);
        if (delayed) {
          await waitOrAbort(delayed.delayMs, input.signal);
          if (delayed.write) {
            session.files.set(safePath(delayed.write.path), bytes(delayed.write.content));
            session.metrics.guestFileWrites += 1;
          }
          return shellResult("");
        }
        return shellResult(command === "pwd" ? `${WORKSPACE_PROJECT_DIRECTORY}\n` : "");
      }
      case "sandbox_exec_start": {
        const command = stringArgument(args.command);
        const execSessionId = createHash("sha256")
          .update(`${input.modelRunToolCallId}\0${session.execs.size}`)
          .digest("hex")
          .slice(0, 32);
        const delayed = parseDelayedCommand(command);
        const exec: DeterministicExec = {
          closed: false,
          done: delayed === null,
          exitCode: delayed === null ? 0 : null,
          modelRunId: input.modelRunId,
          output: "",
          timer: null
        };
        if (delayed) {
          // The delayed side effect models a still-running guest process; it
          // must never fire once the execution was quiesced or the VM stopped.
          exec.timer = setTimeout(() => {
            exec.timer = null;
            if (exec.done || session.state !== "ready") return;
            if (delayed.write) {
              session.files.set(safePath(delayed.write.path), bytes(delayed.write.content));
              session.metrics.guestFileWrites += 1;
            }
            exec.done = true;
            exec.exitCode = 0;
          }, delayed.delayMs);
          exec.timer.unref?.();
        }
        session.execs.set(execSessionId, exec);
        session.allExecs.add(exec);
        return {
          ...toolResult({ execSessionId, sandbox: session.sandboxName, stopSandboxOnExit: null }),
          execSessionId
        };
      }
      case "sandbox_exec_poll": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId || exec.closed) return toolResult(null, "error");
        return toolResult({
          done: exec.done,
          error: null,
          events: [],
          exitStatus: exec.done ? { code: exec.exitCode ?? 0 } : null,
          nextCursor: 0
        });
      }
      case "sandbox_exec_write_stdin": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId || exec.closed) return toolResult(null, "error");
        return toolResult({ execSessionId, accepted: true });
      }
      case "sandbox_exec_signal": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId || exec.closed) return toolResult(null, "error");
        const signal = typeof args.signal === "string" ? args.signal.toLowerCase() : "";
        if (signal === "term" || signal === "kill" || signal === "int") {
          terminateExec(exec, signal === "kill" ? 137 : 143);
        }
        return toolResult({ execSessionId, accepted: true });
      }
      case "sandbox_exec_close": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId) return toolResult(null, "error");
        terminateExec(exec, 137);
        exec.closed = true;
        return toolResult({ closed: true, execSessionId });
      }
    }
  }

  async terminateExecutions(input: Parameters<WorkspaceRuntime["terminateExecutions"]>[0]) {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    return input.executions.map(({ runtimeExecSessionId }) => {
      const exec = session.execs.get(runtimeExecSessionId);
      if (!exec) return { outcome: "unknown" as const, runtimeExecSessionId };
      terminateExec(exec, 137);
      exec.closed = true;
      return { outcome: "closed" as const, runtimeExecSessionId };
    });
  }

  async cancelToolCall(input: Parameters<WorkspaceRuntime["cancelToolCall"]>[0]): Promise<void> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    for (const exec of session.execs.values()) {
      if (exec.modelRunId === input.modelRunId) terminateExec(exec, 143);
    }
  }

  async collectOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    for (const exec of session.execs.values()) {
      if (exec.modelRunId === input.modelRunId) {
        terminateExec(exec, 137);
        exec.closed = true;
      }
    }
    if (session.faults.delete("export_list_once")) {
      throw new WorkspaceRuntimeError("workspace_output_export_failed");
    }
    const streamFault = session.faults.delete("export_stream_once");
    const prefix = `${safePath(input.outputDirectory)}/`;
    const candidates = [...session.files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => ({ content, relativePath: path.slice(prefix.length) }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const total = candidates.reduce((sum, candidate) => sum + candidate.content.byteLength, 0);
    if (
      candidates.length > this.config.outputMaxFiles ||
      total > this.config.outputTotalMaxBytes ||
      candidates.some((candidate) =>
        !isSafeWorkspaceRelativePath(candidate.relativePath) ||
        candidate.content.byteLength <= 0 ||
        candidate.content.byteLength > this.config.outputFileMaxBytes
      )
    ) {
      throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
    }
    return candidates.map((candidate, index) => ({
      body: streamFault && index === candidates.length - 1
        ? faultedBody(candidate.content)
        : body(candidate.content),
      byteSize: candidate.content.byteLength,
      checksum: hash(candidate.content),
      mimeType: mimeTypeForPath(candidate.relativePath),
      opaqueFileId: createHash("sha256")
        .update(`${session.runtimeSandboxId}\0${input.modelRunId}\0${candidate.relativePath}`)
        .digest("hex"),
      relativePath: candidate.relativePath
    }));
  }

  async createProjectArchive(input: Parameters<WorkspaceRuntime["createProjectArchive"]>[0]): Promise<WorkspaceOutputStream> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const prefix = `${WORKSPACE_PROJECT_DIRECTORY}/`;
    const directories = [...session.directories]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter(Boolean)
      .map((path) => ({ content: new Uint8Array(), path, type: "directory" as const }));
    const files = [...session.files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => ({ content, path: path.slice(prefix.length), type: "file" as const }));
    const archive = new Uint8Array(gzipSync(tarArchive(
      [...directories, ...files].sort((left, right) => left.path.localeCompare(right.path))
    )));
    if (archive.byteLength > this.config.outputTotalMaxBytes) {
      throw new WorkspaceRuntimeError("workspace_archive_limit_exceeded");
    }
    return {
      body: body(archive),
      byteSize: archive.byteLength,
      checksum: hash(archive),
      mimeType: "application/gzip",
      opaqueFileId: hash(bytes(`${input.sessionId}\0workspace.tar.gz`)),
      relativePath: "workspace.tar.gz"
    };
  }

  async stopSession(input: Parameters<WorkspaceRuntime["stopSession"]>[0]): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    if (input.runtimeSandboxId && input.runtimeSandboxId !== session.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    // Stopping the VM ends every guest process while the disk survives, even
    // ones the runner no longer tracks.
    for (const exec of session.allExecs) terminateExec(exec, 137);
    session.state = "stopped";
  }

  async removeSession(input: Parameters<WorkspaceRuntime["removeSession"]>[0]): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    if (input.runtimeSandboxId && input.runtimeSandboxId !== session.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    for (const exec of session.allExecs) terminateExec(exec, 137);
    this.sessions.delete(input.sessionId);
  }
}
