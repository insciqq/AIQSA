import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  WORKSPACE_INBOX_INDEX_PATH,
  WORKSPACE_PROJECT_DIRECTORY,
  WORKSPACE_ROOT,
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
  modelRunId: string;
  output: string;
};

type DeterministicSession = {
  directories: Set<string>;
  execs: Map<string, DeterministicExec>;
  files: Map<string, Uint8Array>;
  internetEnabled: boolean;
  runtimeSandboxId: string;
  sandboxName: string;
  state: "ready" | "stopped";
};

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
  private readonly sessions = new Map<string, DeterministicSession>();

  constructor(private readonly config: WorkspaceConfig) {}

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
      const runtimeSandboxId = createHash("sha256")
        .update(`deterministic\0${input.sessionId}\0${input.sandboxName}`)
        .digest("hex");
      session = {
        directories: new Set([
          `${WORKSPACE_ROOT}/inbox`,
          `${WORKSPACE_ROOT}/inbox/messages`,
          WORKSPACE_PROJECT_DIRECTORY,
          `${WORKSPACE_ROOT}/output`,
          `${WORKSPACE_ROOT}/tmp`
        ]),
        execs: new Map(),
        files: new Map(),
        internetEnabled: input.internetEnabled,
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

  async stageAttachments(input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]): Promise<void> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    if (input.outputDirectory) session.directories.add(safePath(input.outputDirectory));
    for (const attachment of input.attachments) {
      const content = await readRequestBody(attachment.body, attachment.byteSize);
      if (content.byteLength !== attachment.byteSize || hash(content) !== attachment.checksum) {
        throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
      }
      session.files.set(safePath(attachment.sandboxPath), content);
    }
    for (const manifest of input.manifests) {
      session.files.set(workspaceMessageManifestPath(manifest.messageId), bytes(JSON.stringify(manifest.body)));
    }
    session.files.set(WORKSPACE_INBOX_INDEX_PATH, bytes(JSON.stringify(input.inboxIndex)));
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
        if (command === "sleep 300") {
          await new Promise<never>((_resolve, reject) => {
            const cancelled = () => reject(
              new WorkspaceRuntimeError("workspace_tool_cancelled")
            );
            if (input.signal?.aborted) {
              cancelled();
              return;
            }
            input.signal?.addEventListener("abort", cancelled, { once: true });
          });
        }
        const stdout = command === "pwd" ? `${WORKSPACE_PROJECT_DIRECTORY}\n` : "";
        return {
          ...toolResult({ exitCode: 0, stderr: "", stdout, success: true }),
          exitCode: 0
        };
      }
      case "sandbox_exec_start": {
        const execSessionId = createHash("sha256")
          .update(`${input.modelRunToolCallId}\0${session.execs.size}`)
          .digest("hex")
          .slice(0, 32);
        session.execs.set(execSessionId, {
          closed: false,
          done: true,
          modelRunId: input.modelRunId,
          output: ""
        });
        return toolResult({ execSessionId, sandbox: session.sandboxName, stopSandboxOnExit: null });
      }
      case "sandbox_exec_poll": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId || exec.closed) return toolResult(null, "error");
        return toolResult({ done: exec.done, error: null, events: [], exitStatus: { code: 0 }, nextCursor: 0 });
      }
      case "sandbox_exec_write_stdin":
      case "sandbox_exec_signal": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId || exec.closed) return toolResult(null, "error");
        return toolResult({ execSessionId, accepted: true });
      }
      case "sandbox_exec_close": {
        const execSessionId = stringArgument(args.execSessionId);
        const exec = session.execs.get(execSessionId);
        if (!exec || exec.modelRunId !== input.modelRunId) return toolResult(null, "error");
        exec.closed = true;
        return toolResult({ closed: true, execSessionId });
      }
    }
  }

  async cancelToolCall(input: Parameters<WorkspaceRuntime["cancelToolCall"]>[0]): Promise<void> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    for (const exec of session.execs.values()) {
      if (exec.modelRunId === input.modelRunId) exec.done = true;
    }
  }

  async collectOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    for (const exec of session.execs.values()) {
      if (exec.modelRunId === input.modelRunId) {
        exec.done = true;
        exec.closed = true;
      }
    }
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
    return candidates.map((candidate) => ({
      body: body(candidate.content),
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
    session.state = "stopped";
  }

  async removeSession(input: Parameters<WorkspaceRuntime["removeSession"]>[0]): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    if (input.runtimeSandboxId && input.runtimeSandboxId !== session.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    this.sessions.delete(input.sessionId);
  }
}
