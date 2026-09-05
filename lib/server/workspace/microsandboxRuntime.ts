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
  WORKSPACE_INBOX_INDEX_MAX_BYTES,
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
  decodeWorkspaceInboxIndexAttachments,
  type WorkspaceMcpToolName,
  type WorkspaceStagedAttachmentEntry
} from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import { resolveRuntimeModulePath } from "../runtimeModulePath";
import { WorkspaceOutputCaptureStore } from "./outputCapture";
import { WORKSPACE_MCP_VERSION, WORKSPACE_RUNTIME_VERSION } from "./config";
import {
  bindOfficialWorkspaceTools,
  injectWorkspaceToolArguments,
  WORKSPACE_BOUND_TOOL_CATALOG_HASH,
  type OfficialWorkspaceTool
} from "./toolCatalog";
import {
  WorkspaceRuntimeError,
  type WorkspaceExecutionTermination,
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
const MCP_BINARY = resolveRuntimeModulePath("microsandbox-mcp/bin/microsandbox-mcp.js");
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
  if (record.isError === true) {
    // Official errors may include runtime identity/status or raw SDK details.
    // They are never lifecycle evidence and never authorize a retry.
    return {
      content: [{ text: "The Workspace operation failed.", type: "text" }],
      status: "error"
    };
  }
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
    status: "complete",
    truncated: bounded.truncated
  };
}

function execPollReportsLeaderExit(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if ((value as { isError?: unknown }).isError === true) return false;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as {
        data?: { done?: unknown; error?: unknown; exitStatus?: { code?: unknown } | null }
      };
      const code = parsed.data?.exitStatus?.code;
      // In the pinned SDK, -1 also represents lost reaper notification. EOF,
      // a reader error, and a signal acknowledgement provide no exit proof.
      if (parsed.data?.done === true && parsed.data.error == null &&
        typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255) return true;
    } catch {
      // Ignore non-JSON content.
    }
  }
  return false;
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
          if (finalized) {
            await stream[Symbol.asyncDispose]().catch(() => undefined);
            return;
          }
          iterator = stream[Symbol.asyncIterator]();
        }
        const next = await iterator!.next();
        if (finalized) return;
        if (next.done) {
          await finalize();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (finalized) return;
        await finalize();
        controller.error(error);
      }
    }
  }, { highWaterMark: 0 });
}

async function consumeGuestFile(
  sandbox: Sandbox, path: string, byteSize: number, consume: (chunk: Uint8Array) => void, signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const stream = await sandbox.fs().readStream(path);
  let bytes = 0;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= stream[Symbol.asyncDispose]().catch(() => undefined);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { rejectAbort(signal!.reason); void dispose(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = signal ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > byteSize) throw new Error("guest_file_size_mismatch");
      consume(next.value);
    }
    if (bytes !== byteSize) throw new Error("guest_file_size_mismatch");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await dispose();
  }
}

async function hashGuestFile(sandbox: Sandbox, path: string, byteSize: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await consumeGuestFile(sandbox, path, byteSize, (chunk) => { hash.update(chunk); }, signal);
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
  private readonly initializing = new Map<string, Promise<WorkspaceRuntimeSession>>();

  private captures: WorkspaceOutputCaptureStore | undefined;

  constructor(private readonly config: WorkspaceConfig, private readonly captureDirectory?: string) {}

  private outputCaptures(): WorkspaceOutputCaptureStore {
    const directory = this.captureDirectory ?? (process.env.MSB_HOME?.trim() ? join(process.env.MSB_HOME.trim(), "workspace-outputs") : null);
    if (!directory) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    return this.captures ??= new WorkspaceOutputCaptureStore(directory, this.config);
  }

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
    const pending = this.initializing.get(input.sessionId);
    if (pending) {
      await pending.catch(() => undefined);
      return this.ensureSession(input);
    }
    const operation = this.initializeSession(input).finally(() => {
      if (this.initializing.get(input.sessionId) === operation) this.initializing.delete(input.sessionId);
    });
    this.initializing.set(input.sessionId, operation);
    return operation;
  }

  private async initializeSession(input: Parameters<WorkspaceRuntime["ensureSession"]>[0]): Promise<WorkspaceRuntimeSession> {
    if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (
        existing.sandboxName !== input.sandboxName ||
        (input.runtimeSandboxId !== null && existing.runtimeSandboxId !== input.runtimeSandboxId)
      ) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      try {
        const handle = await Sandbox.get(existing.sandboxName);
        if (handle.id !== existing.runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        }
        const reconnected = await handle.connectOrStart({ detached: true });
        if (reconnected.id !== existing.runtimeSandboxId || reconnected.name !== existing.sandboxName) {
          throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        }
        existing.sandbox = reconnected;
        return {
          runtimeSandboxId: existing.runtimeSandboxId,
          sandboxName: existing.sandboxName,
          state: "ready"
        };
      } catch (error) {
        if (error instanceof WorkspaceRuntimeError) throw error;
        if (error instanceof SandboxNotFoundError) {
          await this.closeMcp(existing);
          if (this.sessions.get(input.sessionId) === existing) this.sessions.delete(input.sessionId);
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        throw new WorkspaceRuntimeError("workspace_session_create_failed");
      }
    }

    let sandbox: Sandbox;
    let acquired: LocalSession | undefined;
    try {
      const handle = await Sandbox.get(input.sandboxName).catch((error: unknown) => {
        if (error instanceof SandboxNotFoundError) return null;
        throw error;
      });
      if (handle) {
        if (input.runtimeSandboxId !== null && handle.id !== input.runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        }
        sandbox = await handle.connectOrStart({ detached: true });
      } else {
        if (input.runtimeSandboxId !== null) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        let builder = Sandbox.builder(input.sandboxName)
          .detached(true)
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
      if (sandbox.name !== input.sandboxName || (input.runtimeSandboxId !== null && sandbox.id !== input.runtimeSandboxId)) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      // Retain exact cleanup authority before any fallible initialization.
      // A failed stop must not discard the only acquired runtime identity.
      acquired = {
        activeCalls: new Map(), execOwners: new Map(),
        runtimeSandboxId: sandbox.id, sandbox, sandboxName: input.sandboxName
      };
      this.sessions.set(input.sessionId, acquired);
      if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      const initialized = await sandbox.exec("mkdir", [
        "-p",
        `${WORKSPACE_ROOT}/inbox/messages`,
        WORKSPACE_PROJECT_DIRECTORY,
        `${WORKSPACE_ROOT}/output`,
        WORKSPACE_TEMP_DIRECTORY
      ]);
      if (!initialized.success) throw new Error("workspace_init_failed");
    } catch (error) {
      if (acquired) {
        try {
          await acquired.sandbox.stopWithTimeout(10_000);
        } catch {
          throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
        }
      }
      if (error instanceof WorkspaceRuntimeError) throw error;
      if (error instanceof SandboxNotFoundError && input.runtimeSandboxId !== null) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      throw new WorkspaceRuntimeError("workspace_session_create_failed");
    }

    return { runtimeSandboxId: sandbox.id, sandboxName: sandbox.name, state: "ready" };
  }

  private session(sessionId: string, runtimeSandboxId: string): LocalSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.runtimeSandboxId !== runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    return session;
  }

  private async runningSession(input: Readonly<{
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<LocalSession> {
    if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    const cached = this.sessions.get(input.sessionId);
    if (cached && cached.runtimeSandboxId !== input.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const sandboxName = cached?.sandboxName ?? workspaceSandboxName(input.sessionId);
    try {
      const handle = await Sandbox.get(sandboxName);
      if (handle.id !== input.runtimeSandboxId) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      // One structured observation and at most one start. Never infer loss
      // from an MCP error or restart a draining/paused VM. Connecting has an
      // explicit timeout rather than an unbounded wait-for-status loop.
      const sandbox = handle.status === "running" || handle.status === "starting"
        ? await handle.connectWithTimeout(10_000)
        : handle.status === "created" || handle.status === "stopped" || handle.status === "crashed"
          ? await handle.connectOrStart({ detached: true })
          : null;
      if (!sandbox) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
      if (sandbox.id !== input.runtimeSandboxId || sandbox.name !== sandboxName) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      const session: LocalSession = cached ?? {
        activeCalls: new Map(),
        execOwners: new Map(),
        runtimeSandboxId: input.runtimeSandboxId,
        sandbox,
        sandboxName
      };
      session.sandbox = sandbox;
      this.sessions.set(input.sessionId, session);
      return session;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        if (cached) await this.closeMcp(cached);
        if (this.sessions.get(input.sessionId) === cached) this.sessions.delete(input.sessionId);
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    }
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

  async listStagedAttachments(
    input: Parameters<WorkspaceRuntime["listStagedAttachments"]>[0]
  ): Promise<readonly WorkspaceStagedAttachmentEntry[]> {
    const session = await this.runningSession(input);
    const fs = session.sandbox.fs();
    try {
      if (!input.attachments.length) return [];
      if (!(await fs.exists(WORKSPACE_INBOX_INDEX_PATH))) return [];
      const metadata = await fs.stat(WORKSPACE_INBOX_INDEX_PATH);
      if (metadata.kind !== "file" || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > WORKSPACE_INBOX_INDEX_MAX_BYTES) return [];
      const index = new Uint8Array(metadata.size);
      let offset = 0;
      await consumeGuestFile(session.sandbox, WORKSPACE_INBOX_INDEX_PATH, metadata.size, (chunk) => {
        index.set(chunk, offset); offset += chunk.byteLength;
      }, input.signal);
      const entries = decodeWorkspaceInboxIndexAttachments(
        JSON.parse(new TextDecoder().decode(index))
      );
      if (!entries) return [];
      const staged: WorkspaceStagedAttachmentEntry[] = [];
      const indexed = new Map(entries.map((entry) => [entry.attachmentId, entry]));
      for (const entry of input.attachments) {
        input.signal?.throwIfAborted();
        const hint = indexed.get(entry.attachmentId);
        if (!hint || hint.sandboxPath !== entry.sandboxPath || hint.byteSize !== entry.byteSize || hint.checksum !== entry.checksum) continue;
        // Guest index checksums are hints. Read the actual bytes before
        // canonical application metadata can authorize reuse.
        const stat = await fs.stat(entry.sandboxPath).catch(() => null);
        if (!stat || stat.kind !== "file" || stat.size !== entry.byteSize) continue;
        try {
          const checksum = await hashGuestFile(session.sandbox, entry.sandboxPath, entry.byteSize, input.signal);
          const after = await fs.stat(entry.sandboxPath);
          if (after.kind === "file" && after.size === entry.byteSize && checksum === entry.checksum) staged.push(entry);
        } catch {
          input.signal?.throwIfAborted();
          // Restage an unreadable, replaced or changed original.
        }
      }
      return staged;
    } catch {
      input.signal?.throwIfAborted();
      return [];
    }
  }

  async stageAttachments(input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]): Promise<void> {
    const session = await this.runningSession(input);
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
    if (!workspaceToolIsAllowed(input.originalName)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    // Only this preflight can mint a retryable no-dispatch proof. Anything
    // thrown by callTool below is an ambiguous dispatch and never upgraded.
    const session = await this.runningSession(input).catch((error: unknown) => {
      if (error instanceof WorkspaceRuntimeError && error.code === "workspace_session_lost") {
        throw new WorkspaceRuntimeError("workspace_session_lost_before_dispatch");
      }
      throw error;
    });
    const mcp = await this.mcp(session);
    const execSessionId = typeof input.arguments.execSessionId === "string"
      ? input.arguments.execSessionId
      : null;
    if (EXEC_SESSION_TOOL_SET.has(input.originalName)) {
      // The process-local owner map is a cache; the application's durable
      // registry is the authority and may legitimately address an execution
      // this runner process never started (after a restart).
      const cachedOwner = execSessionId ? session.execOwners.get(execSessionId) : undefined;
      if (!execSessionId || (cachedOwner !== undefined && cachedOwner !== input.modelRunId)) {
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
      if (input.signal?.aborted || controller.signal.aborted) {
        throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      }
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
        return { ...boundedMcpResult(result, this.config.toolOutputMaxBytes), execSessionId: id };
      }
      // Closing an MCP observation cannot discharge descendant ownership.
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
    // Best effort only: the application's terminal settlement proves
    // quiescence through the durable registry and falls back to a VM stop.
    await this.terminateExecutionIds(session, this.cachedExecutionIds(session, input.modelRunId))
      .catch(() => undefined);
  }

  private cachedExecutionIds(session: LocalSession, modelRunId: string): string[] {
    return [...session.execOwners.entries()]
      .filter(([, ownerRunId]) => ownerRunId === modelRunId)
      .map(([id]) => id);
  }

  /**
   * Observe the leader after TERM and KILL before releasing its handle.
   * The pinned MCP cannot certify escaped/background descendants even after
   * leader exit, so the durable owner still requires an exact VM stop.
   */
  private async terminateExecutionIds(
    session: LocalSession,
    ids: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly WorkspaceExecutionTermination[]> {
    if (ids.length === 0) return [];
    const unknown = ids.map((runtimeExecSessionId) => ({ outcome: "unknown" as const, runtimeExecSessionId }));
    // Do not turn a large registry into minutes of sequential signal timeouts.
    // The VM fallback covers all commands regardless of batch size.
    if (ids.length > 32 || signal?.aborted) return unknown;
    const mcp = await this.mcp(session);
    const deadline = AbortSignal.timeout(10_000);
    const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const call = (name: WorkspaceMcpToolName, args: Record<string, unknown>) =>
      operationSignal.aborted ? Promise.resolve(null) :
        mcp.client.callTool({ arguments: args, name }, undefined, { signal: operationSignal, timeout: 2_000 })
        .then((result) => result.isError !== true ? result : null)
        .catch(() => null);
    await Promise.all(ids.map((execSessionId) => call("sandbox_exec_signal", { execSessionId, signal: "term" })));
    await delay(1_000);
    await Promise.all(ids.map(async (execSessionId) => {
      let exited = execPollReportsLeaderExit(await call("sandbox_exec_poll", { execSessionId, limit: 1 }));
      if (!exited) {
        await call("sandbox_exec_signal", { execSessionId, signal: "kill" });
        await delay(1_000);
        exited = execPollReportsLeaderExit(await call("sandbox_exec_poll", { execSessionId, limit: 1 }));
      }
      if (exited) await call("sandbox_exec_close", { execSessionId });
      // Retain cached ownership as well: handle disposal cannot erase an
      // unresolved descendant obligation before the disk-preserving stop.
    }));
    return unknown;
  }

  async terminateExecutions(input: Parameters<WorkspaceRuntime["terminateExecutions"]>[0]) {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    return this.terminateExecutionIds(
      session,
      input.executions.map((execution) => execution.runtimeExecSessionId),
      input.signal
    );
  }

  async collectOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    if (input.capture) {
      await this.runningSession(input);
      return this.outputCaptures().collect(input, () => this.collectCurrentOutputs(input));
    }
    return this.collectCurrentOutputs(input);
  }

  async releaseOutputCapture(input: Parameters<NonNullable<WorkspaceRuntime["releaseOutputCapture"]>>[0]): Promise<void> {
    await this.outputCaptures().release(input);
  }

  private async collectCurrentOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    const session = await this.runningSession(input);
    const quiesced = await this.terminateExecutionIds(
      session,
      this.cachedExecutionIds(session, input.modelRunId)
    ).catch(() => null);
    if (!quiesced || quiesced.some((result) => result.outcome === "unknown")) {
      throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
    }
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
      const outputs: WorkspaceOutputStream[] = [];
      for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) outputs.push({
        byteSize: file.byteSize,
        checksum: await hashGuestFile(session.sandbox, file.path, file.byteSize, input.signal),
        body: readStreamBody(() => fs.readStream(file.path)),
        mimeType: mimeTypeForPath(file.relativePath),
        opaqueFileId: createHash("sha256")
          .update(`${session.runtimeSandboxId}\0${input.modelRunId}\0${file.relativePath}`)
          .digest("hex"),
        relativePath: file.relativePath
      });
      return outputs;
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_output_export_failed");
    }
  }

  async createProjectArchive(input: Parameters<WorkspaceRuntime["createProjectArchive"]>[0]): Promise<WorkspaceOutputStream> {
    const session = await this.runningSession(input);
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
      checksum: await hashGuestFile(session.sandbox, archivePath, metadata.size, input.signal),
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

  private async waitForInitialization(sessionId: string): Promise<void> {
    const pending = this.initializing.get(sessionId);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new WorkspaceRuntimeError("workspace_execution_cleanup_failed")), 10_000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stopSession(input: Parameters<WorkspaceRuntime["stopSession"]>[0]): Promise<void> {
    // A cancelled remote ensure may still be creating its VM. Absence before
    // that accepted initializer finishes is not proof of a stopped session.
    await this.waitForInitialization(input.sessionId);
    const session = this.sessions.get(input.sessionId);
    if (session && input.runtimeSandboxId && session.runtimeSandboxId !== input.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    const expectedId = input.runtimeSandboxId ?? session?.runtimeSandboxId;
    await (session ? this.closeMcp(session) : Promise.resolve());
    let stopped = false;
    try {
      const handle = await Sandbox.get(session?.sandboxName ?? workspaceSandboxName(input.sessionId));
      if (expectedId && handle.id !== expectedId) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      await handle.stopWithTimeout(10_000);
      stopped = true;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        stopped = true;
        return;
      }
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    } finally {
      if (stopped && this.sessions.get(input.sessionId) === session) this.sessions.delete(input.sessionId);
    }
  }

  async removeSession(input: Parameters<WorkspaceRuntime["removeSession"]>[0]): Promise<void> {
    await this.waitForInitialization(input.sessionId);
    const session = this.sessions.get(input.sessionId);
    if (session && input.runtimeSandboxId && session.runtimeSandboxId !== input.runtimeSandboxId) {
      throw new WorkspaceRuntimeError("workspace_session_lost");
    }
    let expectedId = input.runtimeSandboxId ?? session?.runtimeSandboxId;
    if (session) await this.closeMcp(session);
    let removed = false;
    try {
      const handle = await Sandbox.get(session?.sandboxName ?? workspaceSandboxName(input.sessionId));
      if (expectedId && handle.id !== expectedId) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      expectedId = handle.id;
      await handle.destroy({ timeoutMs: 10_000 });
      removed = true;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        removed = true;
        return;
      }
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    } finally {
      if (removed) {
        if (this.sessions.get(input.sessionId) === session) this.sessions.delete(input.sessionId);
        if (this.captures || this.captureDirectory || process.env.MSB_HOME?.trim()) {
          await this.outputCaptures().removeSession({ ...input, runtimeSandboxId: expectedId ?? null });
        }
      }
    }
  }
}
