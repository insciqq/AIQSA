import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  Destination,
  Image,
  NetworkPolicy,
  Rule,
  Sandbox,
  SandboxNotFoundError,
  isInstalled,
  type FsReadStream
} from "microsandbox";
import {
  WORKSPACE_EXEC_SESSION_TOOL_NAMES,
  WORKSPACE_INBOX_INDEX_PATH,
  WORKSPACE_PROJECT_DIRECTORY,
  WORKSPACE_ROOT,
  WORKSPACE_TEMP_DIRECTORY,
  isSafeWorkspaceRelativePath,
  workspaceMessageDirectory,
  workspaceMessageManifestPath,
  workspaceAttachmentPath,
  workspaceSandboxName,
  workspaceToolIsAllowed,
  type WorkspaceMcpToolName
} from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import { WORKSPACE_MCP_VERSION, WORKSPACE_RUNTIME_VERSION } from "./config";
import {
  bindOfficialWorkspaceTools,
  injectWorkspaceToolArguments,
  WORKSPACE_BOUND_TOOL_CATALOG_HASH,
  type OfficialWorkspaceTool
} from "./toolCatalog";
import {
  WorkspaceRuntimeError,
  type WorkspaceOutputStream,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHealth,
  type WorkspaceRuntimeSession,
  type WorkspaceToolCatalog,
  type WorkspaceToolResult
} from "./runtime";

type McpConnection = Readonly<{
  catalog: WorkspaceToolCatalog;
  client: Client;
  transport: StdioClientTransport;
}>;

type LocalSession = {
  activeCalls: Map<string, Readonly<{ controller: AbortController; modelRunId: string }>>;
  execOwners: Map<string, string>;
  mcp?: McpConnection;
  runtimeSandboxId: string;
  sandbox: Sandbox;
  sandboxName: string;
};

const EXEC_SESSION_TOOL_SET = new Set<WorkspaceMcpToolName>(WORKSPACE_EXEC_SESSION_TOOL_NAMES);
const EXEC_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MCP_BINARY = join(process.cwd(), "node_modules", "microsandbox-mcp", "bin", "microsandbox-mcp.js");
const PROJECT_ARCHIVE_COMMAND =
  "set -o pipefail; cd \"$2\"; " +
  "if find . -xdev \\( -type b -o -type c -o -type s \\) -print -quit | IFS= read -r _; " +
  "then exit 66; fi; " +
  "find . -xdev -print0 | " +
  "tar --null --verbatim-files-from --no-recursion -czf \"$1\" -T -";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function contentFreeReason(error: unknown): string {
  if (error instanceof WorkspaceRuntimeError) return error.code;
  if (error instanceof SandboxNotFoundError) return "workspace_session_lost";
  return "workspace_runtime_unavailable";
}

function publicOnlyPolicy() {
  return {
    defaultEgress: "deny" as const,
    defaultIngress: "deny" as const,
    rules: [
      Rule.allowDns(),
      Rule.allowEgress(Destination.group("public"))
    ]
  };
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function boundedBytes(value: Uint8Array, maximum: number): Readonly<{
  bytes: Uint8Array;
  originalByteCount: number;
  truncated: boolean;
}> {
  if (value.byteLength <= maximum) {
    return { bytes: value, originalByteCount: value.byteLength, truncated: false };
  }
  const marker = new TextEncoder().encode("\n… workspace output truncated …\n");
  const remaining = Math.max(0, maximum - marker.byteLength);
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return {
    bytes: concatBytes([
      value.subarray(0, head),
      marker.subarray(0, Math.min(marker.byteLength, maximum - head - tail)),
      value.subarray(value.byteLength - tail)
    ]),
    originalByteCount: value.byteLength,
    truncated: true
  };
}

function boundedMcpResult(value: unknown, maximum: number): WorkspaceToolResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const chunks: Uint8Array[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      chunks.push(new TextEncoder().encode(candidate.text));
    } else if (candidate.type === "resource_link") {
      chunks.push(new TextEncoder().encode(JSON.stringify({
        mimeType: candidate.mimeType,
        name: candidate.name,
        type: "resource_link",
        uri: candidate.uri
      })));
    }
  }
  const bounded = boundedBytes(concatBytes(chunks), maximum);
  const text = new TextDecoder().decode(bounded.bytes);
  let exitCode: number | null | undefined;
  try {
    const parsed = JSON.parse(text) as { data?: { exitCode?: unknown } };
    if (typeof parsed.data?.exitCode === "number" || parsed.data?.exitCode === null) {
      exitCode = parsed.data.exitCode;
    }
  } catch {
    // Text remains the client-safe bounded result when the official tool did
    // not return its ordinary JSON envelope.
  }
  return {
    content: [{ text, type: "text" }],
    ...(exitCode === undefined ? {} : { exitCode }),
    originalByteCount: bounded.originalByteCount,
    status: record.isError === true ? "error" : "complete",
    truncated: bounded.truncated
  };
}

function execSessionIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as { data?: { execSessionId?: unknown } };
      const id = parsed.data?.execSessionId;
      if (typeof id === "string" && EXEC_SESSION_ID_PATTERN.test(id)) return id;
    } catch {
      // Ignore non-JSON content.
    }
  }
  return null;
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

function readStreamBody(
  open: () => Promise<FsReadStream>,
  onFinalize?: () => Promise<void>
): ReadableStream<Uint8Array> {
  let stream: FsReadStream | null = null;
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let finalized = false;
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    if (stream) await stream[Symbol.asyncDispose]().catch(() => undefined);
    await onFinalize?.().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async cancel() {
      await finalize();
    },
    async pull(controller) {
      try {
        if (!stream) {
          stream = await open();
          iterator = stream[Symbol.asyncIterator]();
        }
        const next = await iterator!.next();
        if (next.done) {
          await finalize();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        await finalize();
        controller.error(error);
      }
    }
  });
}

async function hashGuestFile(sandbox: Sandbox, path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = await sandbox.fs().readStream(path);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    await stream[Symbol.asyncDispose]().catch(() => undefined);
  }
  return hash.digest("hex");
}

function safeChildEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["HOME", "MSB_HOME", "PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

async function openPinnedOfficialMcp(mcpVersion: string): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    args: [MCP_BINARY],
    command: process.execPath,
    env: safeChildEnvironment(),
    maxBufferSize: 2 * 1_024 * 1_024,
    stderr: "pipe"
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "aiqsa-workspace-runner", version: "1" });
  try {
    await client.connect(transport);
    const version = client.getServerVersion()?.version;
    if (version !== mcpVersion || version !== WORKSPACE_MCP_VERSION) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const official: OfficialWorkspaceTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000 });
      for (const tool of page.tools) {
        official.push({
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          name: tool.name
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const catalog = bindOfficialWorkspaceTools({
      mcpVersion: version,
      runtimeVersion: WORKSPACE_RUNTIME_VERSION,
      tools: official
    });
    if (catalog.hash !== WORKSPACE_BOUND_TOOL_CATALOG_HASH) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return { catalog, client, transport };
  } catch (error) {
    await transport.close().catch(() => undefined);
    if (error instanceof WorkspaceRuntimeError) throw error;
    throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }
}

export async function loadPinnedOfficialWorkspaceToolCatalog(): Promise<WorkspaceToolCatalog> {
  const connection = await openPinnedOfficialMcp(WORKSPACE_MCP_VERSION);
  try {
    return connection.catalog;
  } finally {
    await connection.transport.close().catch(() => undefined);
  }
}

export class MicrosandboxWorkspaceRuntime implements WorkspaceRuntime {
  private readonly sessions = new Map<string, LocalSession>();

  constructor(private readonly config: WorkspaceConfig) {}

  async health(): Promise<WorkspaceRuntimeHealth> {
    try {
      if (!isInstalled()) throw new Error("runtime_missing");
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
      await Sandbox.list();
      let imageReady = false;
      try {
        await Image.get(this.config.imageRef);
        imageReady = true;
      } catch {
        imageReady = false;
      }
      const mcp = await this.openMcpConnection();
      await mcp.transport.close();
      return {
        imageReady,
        mcpVersion: WORKSPACE_MCP_VERSION,
        ...(imageReady ? {} : { reasonCode: "workspace_image_unavailable" }),
        runtimeVersion: WORKSPACE_RUNTIME_VERSION,
        state: imageReady ? "ready" : "unavailable",
        virtualizationReady: true
      };
    } catch (error) {
      return {
        imageReady: false,
        mcpVersion: WORKSPACE_MCP_VERSION,
        reasonCode: contentFreeReason(error),
        runtimeVersion: WORKSPACE_RUNTIME_VERSION,
        state: "unavailable",
        virtualizationReady: false
      };
    }
  }

  async ensureSession(input: Parameters<WorkspaceRuntime["ensureSession"]>[0]): Promise<WorkspaceRuntimeSession> {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (
        existing.sandboxName !== input.sandboxName ||
        (input.runtimeSandboxId !== null && existing.runtimeSandboxId !== input.runtimeSandboxId)
      ) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      try {
        const handle = await Sandbox.get(existing.sandboxName);
        if (handle.id !== existing.runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        existing.sandbox = await handle.connectOrStart();
        return {
          runtimeSandboxId: existing.runtimeSandboxId,
          sandboxName: existing.sandboxName,
          state: "ready"
        };
      } catch (error) {
        if (error instanceof WorkspaceRuntimeError) throw error;
        if (error instanceof SandboxNotFoundError) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        throw new WorkspaceRuntimeError("workspace_session_create_failed");
      }
    }

    let sandbox: Sandbox;
    try {
      const handle = await Sandbox.get(input.sandboxName).catch((error: unknown) => {
        if (error instanceof SandboxNotFoundError) return null;
        throw error;
      });
      if (handle) {
        if (input.runtimeSandboxId !== null && handle.id !== input.runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        sandbox = await handle.connectOrStart();
      } else {
        if (input.runtimeSandboxId !== null) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        let builder = Sandbox.builder(input.sandboxName)
          .image(input.imageRef)
          .rootDisk(input.diskMiB)
          .cpus(input.cpus)
          .memory(input.memoryMiB)
          .workdir(WORKSPACE_PROJECT_DIRECTORY)
          .deploymentProfile("multi-tenant")
          .security("restricted")
          .idleTimeout(this.config.idleTtlSeconds)
          .labels({ "aiqsa.workspace": "true" });
        builder = input.internetEnabled
          ? builder.network((network) => network.policy(publicOnlyPolicy()))
          : builder.network((network) => network.policy(NetworkPolicy.none()));
        sandbox = await builder.connectOrCreate();
      }
      if (input.runtimeSandboxId !== null && sandbox.id !== input.runtimeSandboxId) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      const initialized = await sandbox.exec("mkdir", [
        "-p",
        `${WORKSPACE_ROOT}/inbox/messages`,
        WORKSPACE_PROJECT_DIRECTORY,
        `${WORKSPACE_ROOT}/output`,
        WORKSPACE_TEMP_DIRECTORY
      ]);
      if (!initialized.success) throw new Error("workspace_init_failed");
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_session_create_failed");
    }

    const session: LocalSession = {
      activeCalls: new Map(),
      execOwners: new Map(),
      runtimeSandboxId: sandbox.id,
      sandbox,
      sandboxName: input.sandboxName
    };
    this.sessions.set(input.sessionId, session);
    return { runtimeSandboxId: sandbox.id, sandboxName: sandbox.name, state: "ready" };
  }

  private session(sessionId: string, runtimeSandboxId: string): LocalSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.runtimeSandboxId !== runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    return session;
  }

  private async mcp(session: LocalSession): Promise<McpConnection> {
    if (session.mcp) return session.mcp;
    const connection = await this.openMcpConnection();
    session.mcp = connection;
    return connection;
  }

  private async openMcpConnection(): Promise<McpConnection> {
    return openPinnedOfficialMcp(this.config.mcpVersion);
  }

  async stageAttachments(input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]): Promise<void> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const fs = session.sandbox.fs();
    try {
      if (input.outputDirectory) {
        const outputDirectory = input.outputDirectory;
        if (!outputDirectory.startsWith(`${WORKSPACE_ROOT}/output/`) ||
          outputDirectory.includes("..") || outputDirectory.includes("\\")) {
          throw new Error("output_directory_invalid");
        }
        const made = await session.sandbox.exec("mkdir", ["-p", outputDirectory]);
        if (!made.success) throw new Error("mkdir_failed");
      }
      for (const attachment of input.attachments) {
        const expectedDirectory = workspaceMessageDirectory(attachment.messageId);
        if (attachment.sandboxPath !== workspaceAttachmentPath({
          attachmentId: attachment.attachmentId,
          messageId: attachment.messageId,
          originalName: attachment.originalName
        })) {
          throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
        }
        const made = await session.sandbox.exec("mkdir", ["-p", expectedDirectory]);
        if (!made.success) throw new Error("mkdir_failed");
        const sink = await fs.writeStream(attachment.sandboxPath);
        const reader = attachment.body.getReader();
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          while (true) {
            if (input.signal?.aborted) throw input.signal.reason;
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > attachment.byteSize) throw new Error("attachment_size_mismatch");
            hash.update(chunk.value);
            await sink.write(chunk.value);
          }
          await sink.close();
        } finally {
          reader.releaseLock();
          await sink[Symbol.asyncDispose]().catch(() => undefined);
        }
        if (
          bytes !== attachment.byteSize ||
          !HASH_PATTERN.test(attachment.checksum) ||
          hash.digest("hex") !== attachment.checksum
        ) {
          await fs.remove(attachment.sandboxPath).catch(() => undefined);
          throw new Error("attachment_checksum_mismatch");
        }
      }
      for (const manifest of input.manifests) {
        const encoded = JSON.stringify(manifest.body);
        if (new TextEncoder().encode(encoded).byteLength > 256 * 1_024) {
          throw new Error("manifest_too_large");
        }
        const directory = workspaceMessageDirectory(manifest.messageId);
        const made = await session.sandbox.exec("mkdir", ["-p", directory]);
        if (!made.success) throw new Error("mkdir_failed");
        await fs.write(workspaceMessageManifestPath(manifest.messageId), encoded);
      }
      const index = JSON.stringify(input.inboxIndex);
      if (new TextEncoder().encode(index).byteLength > 2 * 1_024 * 1_024) {
        throw new Error("index_too_large");
      }
      await fs.write(WORKSPACE_INBOX_INDEX_PATH, index);
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
    }
  }

  async loadBoundTools(input: Parameters<WorkspaceRuntime["loadBoundTools"]>[0]): Promise<WorkspaceToolCatalog> {
    return (await this.mcp(this.session(input.sessionId, input.runtimeSandboxId))).catalog;
  }

  async callBoundTool(input: Parameters<WorkspaceRuntime["callBoundTool"]>[0]): Promise<WorkspaceToolResult> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    if (!workspaceToolIsAllowed(input.originalName)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const mcp = await this.mcp(session);
    const execSessionId = typeof input.arguments.execSessionId === "string"
      ? input.arguments.execSessionId
      : null;
    if (EXEC_SESSION_TOOL_SET.has(input.originalName)) {
      if (!execSessionId || session.execOwners.get(execSessionId) !== input.modelRunId) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
    }

    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    session.activeCalls.set(input.modelRunToolCallId, { controller, modelRunId: input.modelRunId });
    try {
      const argumentsWithIdentity = injectWorkspaceToolArguments({
        arguments: input.arguments,
        originalName: input.originalName,
        sandboxName: session.sandboxName
      });
      const boundedArguments = input.originalName === "sandbox_shell" || input.originalName === "sandbox_exec"
        ? {
            ...argumentsWithIdentity,
            maxBytes: this.config.toolOutputMaxBytes,
            timeoutMs: this.config.syncToolTimeoutSeconds * 1_000
          }
        : input.originalName === "sandbox_exec_start"
          ? {
              ...argumentsWithIdentity,
              maxBytes: this.config.toolOutputMaxBytes,
              timeoutMs: this.config.turnTimeoutSeconds * 1_000
            }
          : input.originalName === "sandbox_exec_poll" || input.originalName === "sandbox_fs_read"
            ? { ...argumentsWithIdentity, maxBytes: this.config.toolOutputMaxBytes }
            : argumentsWithIdentity;
      const result = await mcp.client.callTool({
        arguments: boundedArguments,
        name: input.originalName
      }, undefined, {
        maxTotalTimeout: this.config.syncToolTimeoutSeconds * 1_000 + 5_000,
        signal: controller.signal,
        timeout: this.config.syncToolTimeoutSeconds * 1_000 + 5_000
      });
      if (input.originalName === "sandbox_exec_start") {
        const id = execSessionIdFrom(result);
        if (!id) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        session.execOwners.set(id, input.modelRunId);
      } else if (input.originalName === "sandbox_exec_close" && execSessionId) {
        session.execOwners.delete(execSessionId);
      }
      return boundedMcpResult(result, this.config.toolOutputMaxBytes);
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      if (controller.signal.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      throw new WorkspaceRuntimeError("workspace_tool_timeout");
    } finally {
      input.signal?.removeEventListener("abort", abort);
      session.activeCalls.delete(input.modelRunToolCallId);
    }
  }

  async cancelToolCall(input: Parameters<WorkspaceRuntime["cancelToolCall"]>[0]): Promise<void> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const active = session.activeCalls.get(input.modelRunToolCallId);
    if (active?.modelRunId === input.modelRunId) active.controller.abort();
    await this.quiesceRunExecSessions(session, input.modelRunId);
  }

  private async quiesceRunExecSessions(session: LocalSession, modelRunId: string): Promise<void> {
    const ids = [...session.execOwners.entries()]
      .filter(([, ownerRunId]) => ownerRunId === modelRunId)
      .map(([id]) => id);
    if (ids.length === 0) return;
    const mcp = await this.mcp(session);
    for (const execSessionId of ids) {
      await mcp.client.callTool({
        arguments: { execSessionId, signal: "term" },
        name: "sandbox_exec_signal"
      }, undefined, { timeout: 5_000 }).catch(() => undefined);
    }
    if (ids.length > 0) await delay(1_000);
    for (const execSessionId of ids) {
      const killed = await mcp.client.callTool({
        arguments: { execSessionId, signal: "kill" },
        name: "sandbox_exec_signal"
      }, undefined, { timeout: 5_000 }).catch(() => null);
      const closed = await mcp.client.callTool({
        arguments: { execSessionId },
        name: "sandbox_exec_close"
      }, undefined, { timeout: 5_000 }).catch(() => null);
      if (
        (!killed || killed.isError === true) &&
        (!closed || closed.isError === true)
      ) {
        throw new WorkspaceRuntimeError("workspace_output_export_failed");
      }
      session.execOwners.delete(execSessionId);
    }
  }

  async collectOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    await this.quiesceRunExecSessions(session, input.modelRunId);
    const fs = session.sandbox.fs();
    const files: Array<{ byteSize: number; path: string; relativePath: string }> = [];
    const outputPrefix = `${input.outputDirectory.replace(/\/+$/u, "")}/`;
    const maximumTraversedEntries = Math.max(256, this.config.outputMaxFiles * 16);
    let traversedEntries = 0;
    const visit = async (directory: string) => {
      for (const entry of await fs.list(directory)) {
        traversedEntries += 1;
        if (traversedEntries > maximumTraversedEntries) {
          throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
        }
        if (files.length > this.config.outputMaxFiles) {
          throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
        }
        const path = entry.path.startsWith("/") ? entry.path : `${directory}/${entry.path}`;
        if (!path.startsWith(outputPrefix)) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        const relativePath = path.slice(outputPrefix.length);
        if (!isSafeWorkspaceRelativePath(relativePath)) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        if (entry.kind === "directory") {
          await visit(path);
          continue;
        }
        if (entry.kind !== "file") {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        if (entry.size <= 0) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        files.push({ byteSize: entry.size, path, relativePath });
      }
    };
    try {
      if (!(await fs.exists(input.outputDirectory))) return [];
      await visit(input.outputDirectory);
      const total = files.reduce((sum, file) => sum + file.byteSize, 0);
      if (
        files.length > this.config.outputMaxFiles ||
        total > this.config.outputTotalMaxBytes ||
        files.some((file) => file.byteSize > this.config.outputFileMaxBytes)
      ) {
        throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
      }
      return Promise.all(files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map(async (file) => ({
        body: readStreamBody(() => fs.readStream(file.path)),
        byteSize: file.byteSize,
        checksum: await hashGuestFile(session.sandbox, file.path),
        mimeType: mimeTypeForPath(file.relativePath),
        opaqueFileId: createHash("sha256")
          .update(`${session.runtimeSandboxId}\0${input.modelRunId}\0${file.relativePath}`)
          .digest("hex"),
        relativePath: file.relativePath
      })));
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_output_export_failed");
    }
  }

  async createProjectArchive(input: Parameters<WorkspaceRuntime["createProjectArchive"]>[0]): Promise<WorkspaceOutputStream> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const archivePath = `${WORKSPACE_TEMP_DIRECTORY}/workspace-export-${createHash("sha256")
      .update(`${input.sessionId}\0${Date.now()}`)
      .digest("hex")}.tar.gz`;
    const output = await session.sandbox.exec("bash", [
      "-c",
      PROJECT_ARCHIVE_COMMAND,
      "aiqsa-workspace-archive",
      archivePath,
      WORKSPACE_PROJECT_DIRECTORY
    ]).catch(() => null);
    if (!output?.success) throw new WorkspaceRuntimeError("workspace_output_export_failed");
    const metadata = await session.sandbox.fs().stat(archivePath);
    if (
      metadata.kind !== "file" ||
      metadata.size <= 0 ||
      metadata.size > this.config.outputTotalMaxBytes
    ) {
      await session.sandbox.fs().remove(archivePath).catch(() => undefined);
      throw new WorkspaceRuntimeError("workspace_archive_limit_exceeded");
    }
    return {
      body: readStreamBody(
        () => session.sandbox.fs().readStream(archivePath),
        () => session.sandbox.fs().remove(archivePath)
      ),
      byteSize: metadata.size,
      checksum: await hashGuestFile(session.sandbox, archivePath),
      mimeType: "application/gzip",
      opaqueFileId: createHash("sha256").update(archivePath).digest("hex"),
      relativePath: "workspace.tar.gz"
    };
  }

  private async closeMcp(session: LocalSession): Promise<void> {
    const mcp = session.mcp;
    session.mcp = undefined;
    if (mcp) await mcp.transport.close().catch(() => undefined);
  }

  async stopSession(input: Parameters<WorkspaceRuntime["stopSession"]>[0]): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (session && input.runtimeSandboxId && session.runtimeSandboxId !== input.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    await (session ? this.closeMcp(session) : Promise.resolve());
    try {
      const handle = await Sandbox.get(session?.sandboxName ?? workspaceSandboxName(input.sessionId));
      if (input.runtimeSandboxId && handle.id !== input.runtimeSandboxId) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      await handle.stopWithTimeout(10_000);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    } finally {
      this.sessions.delete(input.sessionId);
    }
  }

  async removeSession(input: Parameters<WorkspaceRuntime["removeSession"]>[0]): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (session && input.runtimeSandboxId && session.runtimeSandboxId !== input.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    if (session) await this.closeMcp(session);
    try {
      const handle = await Sandbox.get(session?.sandboxName ?? workspaceSandboxName(input.sessionId));
      if (input.runtimeSandboxId && handle.id !== input.runtimeSandboxId) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      await handle.destroy({ timeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    } finally {
      this.sessions.delete(input.sessionId);
    }
  }
}
