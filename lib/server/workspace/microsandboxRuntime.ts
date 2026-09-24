import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readStreamWithAbort } from "../http/byteStream";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logEvent } from "../observability";
import { beginWorkspaceToolStage, observeWorkspaceAbort, workspaceToolFailure } from "./toolObservability";
import { workspaceMcpFailure } from "./operationFailure";
import {
  Destination,
  Image,
  NetworkPolicy,
  Rule,
  Sandbox,
  SandboxNotFoundError,
  SandboxNotRunningError,
  isInstalled,
  type ExecHandle,
  type DnsBuilder,
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
import { AgentExecutionOutput } from "../agents/executionOutput";
import { CodexJsonlDecoder } from "../agents/codexProtocol";
import { AGENT_GATEWAY_PORT, AGENT_GATEWAY_ORIGIN } from "../agents/relay";
import { AGENT_PROMPT_MAX_BYTES, INSTALL_CODEX_PROFILE } from "../agents/guest";
import { CODEX_HOME_DIRECTORY, CODEX_RUN_TOKEN_ENV, codexExecArguments, renderCodexManagedProfile } from "../agents/codexProfile";
import type { WorkspaceAgentIdentity, WorkspaceAgentStart } from "../agents/runtime";
import { resolveRuntimeModulePath } from "../runtimeModulePath";
import { isWorkspaceEnvName, WORKSPACE_SECRET_ENV_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_COUNT, isWorkspaceBrowserSessionFilename, workspaceBrowserSessionPath } from "@/lib/contracts/workspaceSecrets";
import { INSTALL_WORKSPACE_SECRETS, READ_WORKSPACE_SECRET_ENV } from "./secrets/guest";
import { LIST_WORKSPACE_BROWSER_SESSIONS } from "./secrets/browserGuest";
import type { WorkspaceBrowserSkipCode } from "./secrets/browserSession";
import { parseAcceptedWorkspaceSecrets, workspaceSecretEnvironment, workspaceSecretsGuide, WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES } from "./secrets/manifest";
import { WorkspaceOutputCaptureStore } from "./outputCapture";
import { outputIdentities, selectedCaptureRequest, type WorkspaceFileSelection } from "./outputManifest";
import { SELECTED_FILE_CAPTURE_GUEST } from "./selectedFileGuest";
import { PROJECT_ARCHIVE_MAX_ENTRIES, PROJECT_RESTORE_SCRIPT } from "./projectArchive";
import { WorkspaceSkillRunState } from "./skillRunState";
import { WORKSPACE_SKILL_GUEST_SCRIPT } from "./skillGuest";
import { parseSkillArchive, readSkillArchive, SKILL_RUNTIME_JSON_MAX_BYTES,
  skillOperationSignal, skillPreparationFailed, WORKSPACE_SKILLS_DIRECTORY } from "./skillBundles";
import { WORKSPACE_MCP_VERSION, WORKSPACE_RUNTIME_VERSION } from "./config";
import {
  bindOfficialWorkspaceTools,
  injectWorkspaceToolArguments,
  WORKSPACE_BOUND_TOOL_CATALOG_HASH,
  type OfficialWorkspaceTool
} from "./toolCatalog";
import {
  WorkspaceRuntimeError,
  WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE,
  type WorkspaceRuntimeInventoryInput,
  type WorkspaceRuntimeInventoryPage,
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
  agents?: Map<string, { modelRunId: string; handle: ExecHandle; output: AgentExecutionOutput; failed: boolean;
    decoder: CodexJsonlDecoder; interrupted: boolean; continuable: boolean; exited: boolean }>;
  lastAgentExecId?: string;
  activeCalls: Map<string, Readonly<{ controller: AbortController; modelRunId: string }>>;
  execOwners: Map<string, string>;
  mcp?: McpConnection;
  runtimeSandboxId: string;
  sandbox: Sandbox;
  sandboxName: string;
  secretEnvironment?: Readonly<{ modelRunId: string; values: Record<string, string> }>;
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

function publicOnlyPolicy(agentGatewayEnabled = false) {
  return {
    defaultEgress: "deny" as const,
    defaultIngress: "deny" as const,
    rules: [
      Rule.allowDns(),
      Rule.allowEgress(Destination.group("public")),
      ...(agentGatewayEnabled ? [{ ...Rule.allowEgress(Destination.group("host")),
        protocols: ["tcp" as const], ports: [{ start: AGENT_GATEWAY_PORT, end: AGENT_GATEWAY_PORT }] }] : [])
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

function boundedMcpResult(value: unknown, maximum: number, tool: WorkspaceMcpToolName): WorkspaceToolResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const failure = workspaceMcpFailure(value, maximum, tool);
  if (failure) return failure;
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

/** Keep guest read leases alive until the receiver has verified its private copy. */
async function openSelectedFiles(sandbox: Sandbox, selection: WorkspaceFileSelection,
  outputDirectory: string, config: WorkspaceConfig, signal: AbortSignal) {
  const failed = () => new WorkspaceRuntimeError("workspace_output_export_failed");
  const paths = selection.files.map(file => `${file.root === "output" ? outputDirectory : `${WORKSPACE_ROOT}/${file.root}`}/${file.relativePath}`);
  const request = Buffer.from(JSON.stringify({ paths, fileMaxBytes: config.outputFileMaxBytes, totalMaxBytes: config.outputTotalMaxBytes }) + "\n");
  if (request.byteLength > 65536) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  signal.throwIfAborted();
  const handle = await sandbox.execStreamWith("/usr/bin/python3", builder => builder
    .args(["-I", "-u", "-c", SELECTED_FILE_CAPTURE_GUEST]).stdinPipe().timeout(30_000));
  let sink: Awaited<ReturnType<ExecHandle["takeStdin"]>> = null;
  let closed = false, exited = false, received = 0, pending = "";
  let pid: number | undefined;
  const abort = () => { void handle.kill().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    await readStreamWithAbort(async () => {
      if (!exited) await handle.kill().catch(() => undefined);
      await sink?.[Symbol.asyncDispose]().catch(() => undefined);
      await handle[Symbol.asyncDispose]().catch(() => undefined);
    }, AbortSignal.timeout(2_000)).catch(() => undefined);
  };
  const reply = () => readStreamWithAbort(async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw failed(); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
        const record = value as Record<string, unknown>;
        if (record.error === "limit") throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
        if (record.error === "timeout") throw new WorkspaceRuntimeError("workspace_tool_timeout");
        if (record.error === "source_busy") throw new WorkspaceRuntimeError("workspace_capture_source_busy");
        if (record.error === "source_invalid") throw new WorkspaceRuntimeError("workspace_capture_source_invalid");
        if (record.error === "unsupported") throw new WorkspaceRuntimeError("workspace_capture_unsupported");
        if (record.error !== undefined) throw failed();
        return record;
      }
      const event = await handle.recv();
      if (!event || event.kind === "exited") throw failed();
      if (event.kind === "started") pid = event.pid;
      if (event.kind === "stderr") throw failed();
      if (event.kind === "stdout") {
        received += event.data.byteLength;
        if (received > 64 * 1024) throw failed();
        // The helper protocol is ASCII metadata, never file bytes or names.
        pending += Buffer.from(event.data).toString("utf8");
      }
    }
  }, signal);
  try {
    signal.throwIfAborted();
    sink = await handle.takeStdin();
    if (!sink) throw failed();
    await readStreamWithAbort(() => sink!.write(request), signal);
    const initial = await reply();
    if (!Number.isSafeInteger(pid) || !pid || pid < 1 || initial.pid !== pid ||
      !Array.isArray(initial.files) || initial.files.length !== selection.files.length) throw failed();
    const descriptors = new Set<number>();
    const outputs = initial.files.map((value: unknown, index): WorkspaceOutputStream => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
      const file = value as Record<string, unknown>;
      if (!Number.isSafeInteger(file.fd) || (file.fd as number) < 3 || (file.fd as number) > 1_048_576 || descriptors.has(file.fd as number)) throw failed();
      descriptors.add(file.fd as number);
      const source = selection.files[index]!;
      const relativePath = `${source.root}/${source.relativePath}`;
      return { byteSize: file.byteSize as number, checksum: file.checksum as string,
        mimeType: mimeTypeForPath(source.relativePath), relativePath,
        opaqueFileId: createHash("sha256").update(relativePath).digest("hex"),
        body: readStreamBody(() => sandbox.fs().readStream(`/proc/${pid}/fd/${file.fd}`)) };
    });
    outputIdentities(outputs, config, true);
    return { outputs, close, validate: async () => {
      signal.throwIfAborted();
      await readStreamWithAbort(() => sink!.write("finish\n"), signal);
      if ((await reply()).complete !== true) throw failed();
      const status = await readStreamWithAbort(() => handle.wait(), signal);
      if (status.code !== 0) throw failed();
      exited = true;
    } };
  } catch (error) {
    await close();
    throw error;
  }
}

async function consumeGuestFile(
  sandbox: Sandbox, path: string, byteSize: number, consume: (chunk: Uint8Array) => void, signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const stream = await sandbox.fs().readStream(path);
  let bytes = 0;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= stream[Symbol.asyncDispose]().catch(() => undefined);
  const onAbort = () => { void dispose(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await readStreamWithAbort(async () => {
      signal?.throwIfAborted();
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        signal?.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > byteSize) throw new Error("guest_file_size_mismatch");
        consume(next.value);
      }
      if (bytes !== byteSize) throw new Error("guest_file_size_mismatch");
    }, signal);
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
    ["HOME", "MSB_HOME", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
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
  private skills: WorkspaceSkillRunState | undefined;

  private captures: WorkspaceOutputCaptureStore | undefined;
  private inventoryRequest: { cursor: string | undefined; promise: Promise<WorkspaceRuntimeInventoryPage> } | null = null;

  constructor(private readonly config: WorkspaceConfig, private readonly captureDirectory?: string, private readonly skillDirectory?: string) {}

  private skillState(): WorkspaceSkillRunState {
    const directory = this.skillDirectory ?? (process.env.MSB_HOME?.trim() ? join(process.env.MSB_HOME.trim(), "workspace-skills") : null);
    if (!directory) return skillPreparationFailed();
    return this.skills ??= new WorkspaceSkillRunState(directory);
  }

  private noAgent(session: LocalSession): void {
    if (session.agents?.size) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }

  private async withSkillGuestOperation<T>(session: LocalSession, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    // Native fs/exec calls have no AbortSignal API. Stop this exact guest on
    // cancellation so an interrupted upload cannot outlive its receiver claim.
    let stopping: Promise<void> | undefined;
    let cleanupFailed = false;
    const abort = () => { stopping ??= session.sandbox.stopWithTimeout(10_000).catch(() => { cleanupFailed = true; }); };
    signal?.addEventListener("abort", abort, { once: true });
    let result!: T; let failed = false; let failure: unknown;
    try { result = await action(); } catch (error) { failed = true; failure = error; } finally {
      signal?.removeEventListener("abort", abort);
      await stopping;
    }
    if (cleanupFailed) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
    if (failed) throw failure;
    return result;
  }

  private async skillGuest(session: LocalSession, data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const payload = Buffer.from(JSON.stringify(data));
    if (payload.byteLength > SKILL_RUNTIME_JSON_MAX_BYTES) return skillPreparationFailed();
    const result = await session.sandbox.execWith("/usr/bin/python3", builder => builder
      .args(["-I", "-c", WORKSPACE_SKILL_GUEST_SCRIPT]).timeout(30_000).stdinBytes(payload));
    signal?.throwIfAborted();
    if (!result.success) throw new WorkspaceRuntimeError(result.code === 67 ? "workspace_skill_bundle_limit_exceeded" : "workspace_skill_bundle_invalid");
  }

  async prepareSkillRun(input: Parameters<WorkspaceRuntime["prepareSkillRun"]>[0]) {
    input = { ...input, signal: skillOperationSignal(input.signal) };
    this.session(input.sessionId, input.runtimeSandboxId);
    return this.skillState().prepare(input, async () => {
      const session = await this.runningSession(input); this.noAgent(session);
      await this.withSkillGuestOperation(session, input.signal, () => this.skillGuest(session, { action: "reset" }, input.signal));
    }, async () => this.noAgent(this.session(input.sessionId, input.runtimeSandboxId)));
  }

  async installSkillBundle(input: Parameters<WorkspaceRuntime["installSkillBundle"]>[0]) {
    input = { ...input, signal: skillOperationSignal(input.signal) };
    return this.skillState().install(input, input.bundle, async () => {
      const session = await this.runningSession(input); this.noAgent(session);
      return this.withSkillGuestOperation(session, input.signal, async () => {
        const archive = await readSkillArchive(input);
        parseSkillArchive(archive);
        const archivePath = `/tmp/aiqsa-skill-${randomUUID()}.tar.gz`;
        const fs = session.sandbox.fs();
        try {
          await this.skillGuest(session, { action: "stage", archivePath }, input.signal);
          const sink = await fs.writeStream(archivePath);
          try { await sink.write(archive); await sink.close(); } finally { await sink[Symbol.asyncDispose]().catch(() => undefined); }
          await this.skillGuest(session, { action: "install", alias: input.bundle.alias, archivePath,
            byteSize: input.byteSize, checksum: input.checksum }, input.signal);
          return { workspacePath: `${WORKSPACE_SKILLS_DIRECTORY}/${input.bundle.alias}` };
        } finally { await fs.remove(archivePath).catch(() => undefined); }
      });
    });
  }

  async completeSkillRunPreparation(input: Parameters<WorkspaceRuntime["completeSkillRunPreparation"]>[0]): Promise<void> {
    input = { ...input, signal: skillOperationSignal(input.signal) };
    await this.skillState().complete(input, async refs => {
      const session = await this.runningSession(input); this.noAgent(session);
      await this.withSkillGuestOperation(session, input.signal, () => this.skillGuest(session, { action: "links", aliases: refs.map(ref => ref.alias) }, input.signal));
    });
  }

  async listSessions(input: WorkspaceRuntimeInventoryInput): Promise<WorkspaceRuntimeInventoryPage> {
    if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    if (this.inventoryRequest) {
      const current = this.inventoryRequest;
      const page = await current.promise;
      if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      return current.cursor === input.cursor ? page : this.listSessions(input);
    }
    const promise = this.readInventoryPage(input.cursor);
    this.inventoryRequest = { cursor: input.cursor, promise };
    try {
      const page = await promise;
      if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      return page;
    } finally {
      if (this.inventoryRequest?.promise === promise) this.inventoryRequest = null;
    }
  }

  private async readInventoryPage(cursor: string | undefined): Promise<WorkspaceRuntimeInventoryPage> {
    try {
      const page = await Sandbox.listWith((list) => {
        list.label("aiqsa.workspace", "true").limit(WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE);
        return cursor ? list.cursor(cursor) : list;
      });
      return {
        entries: page.sandboxes.map((sandbox) => ({
          runtimeSandboxId: sandbox.id,
          sandboxName: sandbox.name,
          state: sandbox.status
        })),
        nextCursor: page.nextCursor ?? null
      };
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    }
  }

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
        agentReady: imageReady && this.config.agentGatewayEnabled === true,
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
          // The SDK's multi-tenant floor forbids even a single host gateway.
          // Agent-capable sessions use our fixed policy below, never guest input.
          .deploymentProfile(input.internetEnabled && this.config.agentGatewayEnabled ? "single-tenant" : "multi-tenant")
          .security("restricted")
          .idleTimeout(this.config.idleTtlSeconds)
          .labels({ "aiqsa.workspace": "true" });
        builder = input.internetEnabled
          ? builder.network((network) => network.policy(publicOnlyPolicy(this.config.agentGatewayEnabled))
            .dns((dns: InstanceType<typeof DnsBuilder>) => dns.rebindProtection(true)).trustHostCAs(false).maxConnections(256))
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
      if (input.attachments.length) {
        input.signal?.throwIfAborted();
        const capacity = await session.sandbox.execWith("/usr/bin/python3", builder => builder
          .args(["-I", "-c", "import os; s=os.statvfs('/workspace'); print(s.f_bavail*s.f_frsize)"])
          .timeout(10_000));
        input.signal?.throwIfAborted();
        const free = capacity.stdout().trim();
        if (!capacity.success || !/^\d{1,16}$/u.test(free) || !Number.isSafeInteger(Number(free))) {
          throw new Error("workspace_disk_check_failed");
        }
        const required = input.attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0);
        if (required + 16 * 1024 * 1024 > Number(free)) throw new WorkspaceRuntimeError("workspace_storage_full");
      }
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
        const temporaryPath = `${expectedDirectory}/.upload-${randomUUID()}`;
        try {
          const sink = await fs.writeStream(temporaryPath);
          const reader = attachment.body.getReader();
          const hash = createHash("sha256");
          let bytes = 0;
          try {
            while (true) {
              input.signal?.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > attachment.byteSize) throw new Error("attachment_size_mismatch");
              hash.update(chunk.value);
              await sink.write(chunk.value);
            }
            await sink.close();
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            await sink[Symbol.asyncDispose]().catch(() => undefined);
          }
          if (bytes !== attachment.byteSize || !HASH_PATTERN.test(attachment.checksum) || hash.digest("hex") !== attachment.checksum) {
            throw new Error("attachment_checksum_mismatch");
          }
          input.signal?.throwIfAborted();
          await fs.rename(temporaryPath, attachment.sandboxPath);
        } finally {
          // A short transfer, disk failure or cancellation never overwrites an
          // already verified original and never leaves a partial final file.
          await fs.remove(temporaryPath).catch(() => undefined);
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

  async syncPersonalSecrets(input: Parameters<WorkspaceRuntime["syncPersonalSecrets"]>[0]): Promise<void> {
    const session = await this.runningSession(input);
    session.secretEnvironment = undefined;
    try {
      const secrets = parseAcceptedWorkspaceSecrets(input.secrets);
      const environment = workspaceSecretEnvironment(secrets);
      const bundle = Buffer.from(JSON.stringify({ secrets, environment, guide: workspaceSecretsGuide(secrets), runId: input.modelRunId }));
      if (bundle.byteLength > WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES) throw new Error("prepare_input_too_large");
      input.signal?.throwIfAborted();
      const prepared = await session.sandbox.execWith("/usr/bin/python3", (builder) => builder
        .args(["-I", "-c", INSTALL_WORKSPACE_SECRETS]).timeout(90_000)
        .stdinBytes(bundle));
      input.signal?.throwIfAborted();
      if (!prepared.success) throw new Error("prepare_failed");
      session.secretEnvironment = { modelRunId: input.modelRunId, values: environment };
    } catch {
      if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      throw new WorkspaceRuntimeError("workspace_secrets_prepare_failed");
    }
  }

  private async secretEnvironment(session: LocalSession, modelRunId: string): Promise<Record<string, string>> {
    if (session.secretEnvironment?.modelRunId === modelRunId) return session.secretEnvironment.values;
    try {
      const result = await session.sandbox.execWith("/usr/bin/python3", (builder) => builder
        .args(["-I", "-c", READ_WORKSPACE_SECRET_ENV, modelRunId]).timeout(10_000));
      if (!result.success || result.stdoutBytes().byteLength > WORKSPACE_SECRET_ENV_MAX_BYTES * 2) throw new Error("invalid");
      const values: unknown = JSON.parse(result.stdout());
      if (!values || typeof values !== "object" || Array.isArray(values) ||
        Object.entries(values).some(([name, value]) => !isWorkspaceEnvName(name) || typeof value !== "string" || value.includes("\0")) ||
        Buffer.byteLength(JSON.stringify(values), "utf8") > WORKSPACE_SECRET_ENV_MAX_BYTES) throw new Error("invalid");
      session.secretEnvironment = { modelRunId, values: values as Record<string, string> };
      return session.secretEnvironment.values;
    } catch { throw new WorkspaceRuntimeError("workspace_secrets_prepare_failed"); }
  }

  async loadBoundTools(input: Parameters<WorkspaceRuntime["loadBoundTools"]>[0]): Promise<WorkspaceToolCatalog> {
    return (await this.mcp(this.session(input.sessionId, input.runtimeSandboxId))).catalog;
  }

  async startAgent(input: WorkspaceAgentStart): Promise<void> {
    return this.skillState().start({ ...input, manifestHash: input.skillManifestHash }, () => this.startPreparedAgent(input));
  }

  private async startPreparedAgent(input: WorkspaceAgentStart): Promise<void> {
    if (!this.config.agentGatewayEnabled || input.profile.gatewayOrigin !== AGENT_GATEWAY_ORIGIN) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    if (!/^agent-[a-f0-9-]{36}$/iu.test(input.runtimeExecSessionId) ||
      !/^[a-zA-Z0-9_-]{43,128}$/u.test(input.runToken) ||
      typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > AGENT_PROMPT_MAX_BYTES ||
      (input.timeoutSeconds !== null && (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 7200))) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const config = renderCodexManagedProfile(input.profile);
    const args = codexExecArguments(input.threadId);
    const session = await this.runningSession(input);
    session.agents ??= new Map();
    // Lost start replies must never dispatch a second agent or replay effects.
    const previous = input.previousExecSessionId ? session.agents.get(input.previousExecSessionId) : null;
    if (session.agents.has(input.runtimeExecSessionId) || (input.previousExecSessionId
      ? session.lastAgentExecId !== input.previousExecSessionId || !previous || previous.modelRunId !== input.modelRunId ||
        previous.failed || !previous.continuable || !input.threadId || previous.decoder.nativeThreadId !== input.threadId
      : session.lastAgentExecId !== undefined || session.agents.size > 0)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    input.signal?.throwIfAborted();
    // Reserve before guest I/O; an ambiguous start cannot be retried even if
    // execStreamWith never returned its handle to this process.
    session.lastAgentExecId = input.runtimeExecSessionId;
    const prepared = await session.sandbox.execWith("/usr/bin/python3", (builder) => builder
      .args(["-I", "-c", INSTALL_CODEX_PROFILE]).timeout(10_000)
      .stdinBytes(Buffer.from(JSON.stringify({ config }))));
    if (!prepared.success) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    const environment = await this.secretEnvironment(session, input.modelRunId);
    input.signal?.throwIfAborted();
    const handle = await session.sandbox.execStreamWith("/usr/local/bin/codex", (builder) => {
      const command = builder.args(args).cwd(WORKSPACE_PROJECT_DIRECTORY)
        .envs({ ...environment, HOME: "/root", CODEX_HOME: CODEX_HOME_DIRECTORY, [CODEX_RUN_TOKEN_ENV]: input.runToken })
        .stdinBytes(Buffer.from(input.prompt));
      return input.timeoutSeconds === null ? command : command.timeout(input.timeoutSeconds * 1000);
    });
    const execution = { modelRunId: input.modelRunId, handle, output: new AgentExecutionOutput(), failed: false,
      decoder: new CodexJsonlDecoder(), interrupted: false, continuable: false, exited: false };
    session.agents.set(input.runtimeExecSessionId, execution);
    session.execOwners.set(input.runtimeExecSessionId, input.modelRunId);
    // The receiver operation and durable registry retain cleanup ownership
    // after this HTTP request ends. Only polling carries these raw bytes.
    void (async () => {
      let exitCode: number | null = null;
      try {
        for (;;) {
          const event = await handle.recv();
          if (!event) break;
          if (event.kind === "stdout") {
            execution.decoder.push(event.data);
            execution.output.stdout(event.data);
          }
          if (event.kind === "stderr") execution.output.stderr(event.data);
          if (event.kind === "exited") exitCode = event.code;
        }
        execution.exited = true;
        try {
          if (execution.interrupted) execution.decoder.finishInterrupted(exitCode);
          else execution.decoder.finish(exitCode);
          execution.continuable = execution.decoder.toolsSettled;
        } catch { /* Polling retains the original protocol/exit failure. */ }
        execution.output.end(exitCode);
      } catch {
        execution.failed = true;
        await handle.kill().catch(() => undefined);
      }
    })();
    if (input.signal?.aborted) {
      await handle.kill().catch(() => undefined);
      throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    }
  }

  async interruptAgent(input: WorkspaceAgentIdentity): Promise<boolean> {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const execution = session.agents?.get(input.runtimeExecSessionId);
    if (!execution || execution.modelRunId !== input.modelRunId || session.lastAgentExecId !== input.runtimeExecSessionId || execution.failed) {
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    }
    input.signal?.throwIfAborted();
    if (execution.interrupted) return true;
    if (execution.exited || !execution.decoder.canInterrupt) return false;
    // The gateway has already frozen executable output under this segment's
    // grant. This operation is deliberately fixed to SIGINT, never Stop.
    execution.interrupted = true;
    try { await execution.handle.signal(2); }
    catch { execution.failed = true; throw new WorkspaceRuntimeError("workspace_runtime_unavailable"); }
    return true;
  }

  async pollAgent(input: WorkspaceAgentIdentity & Readonly<{ cursor: number }>) {
    const session = this.session(input.sessionId, input.runtimeSandboxId);
    const execution = session.agents?.get(input.runtimeExecSessionId);
    if (!execution || execution.modelRunId !== input.modelRunId) {
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    }
    input.signal?.throwIfAborted();
    try {
      if (execution.failed) throw new Error("output_invalid");
      return execution.output.poll(input.cursor);
    } catch { throw new WorkspaceRuntimeError("workspace_agent_output_invalid"); }
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
    const observeAbort = observeWorkspaceAbort();
    const requestTimeoutMs = this.config.syncToolTimeoutSeconds * 1_000 + 5_000;
    const onAbort = () => observeAbort({ stage: "delivery", deadline_kind: "sdk_request", timeout_ms: requestTimeoutMs,
      abort_source: input.signal?.aborted && controller.signal.reason === input.signal.reason ? "parent_signal" : "unknown" });
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) observeAbort({ stage: "before_start", abort_source: "unknown", deadline_kind: "sdk_request", timeout_ms: requestTimeoutMs });
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    session.activeCalls.set(input.modelRunToolCallId, { controller, modelRunId: input.modelRunId });
    let finishRequest: ReturnType<typeof beginWorkspaceToolStage> | undefined;
    try {
      const argumentsWithIdentity = injectWorkspaceToolArguments({
        arguments: input.arguments,
        originalName: input.originalName,
        sandboxName: session.sandboxName
      });
      if (["sandbox_shell", "sandbox_exec", "sandbox_exec_start"].includes(input.originalName)) {
        const environment = await this.secretEnvironment(session, input.modelRunId);
        const requested = argumentsWithIdentity.env;
        if (requested !== undefined && (!requested || typeof requested !== "object" || Array.isArray(requested))) {
          throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        }
        if (Object.keys(environment).length || requested !== undefined) {
          argumentsWithIdentity.env = { ...environment, ...(requested as Record<string, unknown> | undefined) };
        }
      }
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
      const toolTimeoutMs = input.originalName === "sandbox_shell" || input.originalName === "sandbox_exec"
        ? this.config.syncToolTimeoutSeconds * 1_000 : input.originalName === "sandbox_exec_start" ? this.config.turnTimeoutSeconds * 1_000 : undefined;
      logEvent("tool_deadline", { tool_kind: "workspace", configured_timeout_ms: toolTimeoutMs, effective_timeout_ms: toolTimeoutMs,
        request_timeout_ms: requestTimeoutMs });
      finishRequest = beginWorkspaceToolStage("request");
      const result = await mcp.client.callTool({
        arguments: boundedArguments,
        name: input.originalName
      }, undefined, {
        maxTotalTimeout: requestTimeoutMs,
        signal: controller.signal,
        timeout: requestTimeoutMs
      });
      if (input.originalName === "sandbox_exec_start") {
        const failure = workspaceMcpFailure(result, this.config.toolOutputMaxBytes, input.originalName);
        if (failure) {
          finishRequest({ outcome: "failed", code: failure.errorCode });
          return failure;
        }
        const id = execSessionIdFrom(result);
        if (!id) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        session.execOwners.set(id, input.modelRunId);
        const normalized = { ...boundedMcpResult(result, this.config.toolOutputMaxBytes, input.originalName), execSessionId: id };
        finishRequest({ outcome: normalized.status === "error" ? "failed" : "completed", code: normalized.errorCode });
        return normalized;
      }
      // Closing an MCP observation cannot discharge descendant ownership.
      const normalized = boundedMcpResult(result, this.config.toolOutputMaxBytes, input.originalName);
      finishRequest({ outcome: normalized.status === "error" ? "failed" : "completed", code: normalized.errorCode });
      return normalized;
    } catch (error) {
      const timedOut = error instanceof McpError && error.code === ErrorCode.RequestTimeout;
      if (timedOut) observeAbort({ stage: "delivery", abort_source: "workspace_deadline", deadline_kind: "sdk_request", timeout_ms: requestTimeoutMs });
      const facts = timedOut ? { code: "workspace_tool_timeout", reason: "deadline" as const } : workspaceToolFailure(error);
      const outcome = controller.signal.aborted || facts.reason === "cancelled" ? "cancelled" : "failed";
      if (finishRequest) finishRequest({ outcome, ...facts });
      else logEvent("tool_execution", { tool_kind: "workspace", stage: "admission", outcome, ...facts });
      if (error instanceof WorkspaceRuntimeError) throw error;
      if (controller.signal.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      if (timedOut) throw new WorkspaceRuntimeError("workspace_tool_timeout");
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) throw new WorkspaceRuntimeError("workspace_request_invalid");
      throw new WorkspaceRuntimeError("workspace_tool_outcome_unknown");
    } finally {
      input.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
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
    // Native Codex handles cannot certify escaped descendants either. Stop
    // their leaders promptly, then require the existing exact-VM stop proof.
    if (ids.some((id) => id.startsWith("agent-"))) {
      await Promise.all(ids.map((id) => session.agents?.get(id)?.handle.kill().catch(() => undefined)));
      return unknown;
    }
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
    const selection = selectedCaptureRequest(input, this.config.outputMaxFiles);
    if (selection) {
      const deadline = AbortSignal.timeout(30_000);
      const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      let source: Awaited<ReturnType<typeof openSelectedFiles>> | undefined;
      try {
        return await this.outputCaptures().collect({ ...input, selection, signal }, async () => {
          // Lookup never restarts the VM or reopens a mutable source path.
          const session = await this.runningSession({ ...input, signal });
          source = await openSelectedFiles(session.sandbox, selection, input.outputDirectory, this.config, signal);
          return source.outputs;
        }, () => source!.validate(), input.signal ?? null);
      } catch (error) {
        if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
        if (deadline.aborted) throw new WorkspaceRuntimeError("workspace_tool_timeout");
        if (error instanceof WorkspaceRuntimeError) throw error;
        throw new WorkspaceRuntimeError("workspace_output_export_failed");
      } finally { await source?.close(); }
    }
    if (input.capture) {
      await this.runningSession(input);
      return this.outputCaptures().collect(input, () => this.collectCurrentOutputs(input));
    }
    return this.collectCurrentOutputs(input);
  }

  async collectBrowserSessions(input: Parameters<WorkspaceRuntime["collectBrowserSessions"]>[0]): ReturnType<WorkspaceRuntime["collectBrowserSessions"]> {
    const session = await this.runningSession(input);
    const terminated = await this.terminateExecutionIds(session, this.cachedExecutionIds(session, input.modelRunId));
    if (terminated.some((entry) => entry.outcome === "unknown")) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
    const files: WorkspaceOutputStream[] = [];
    const skipped: WorkspaceBrowserSkipCode[] = [];
    const listed = await session.sandbox.execWith("/usr/bin/python3", (builder) => builder.args(["-I", "-c", LIST_WORKSPACE_BROWSER_SESSIONS]).timeout(10_000));
    input.signal?.throwIfAborted();
    if (!listed.success || listed.stdoutBytes().byteLength > 256 * 1024) return { files, skipped: ["browser_session_read_failed"] };
    let listing: { invalid?: boolean; failed?: boolean; overflow?: boolean; entries?: Array<{ name: string; size: number; file: boolean }> };
    try { listing = JSON.parse(listed.stdout()); } catch { return { files, skipped: ["browser_session_read_failed"] }; }
    if (!listing || !Array.isArray(listing.entries) || listing.entries.length > 128 || listing.failed) return { files, skipped: ["browser_session_read_failed"] };
    if (listing.invalid) return { files, skipped: ["browser_session_invalid"] };
    if (listing.overflow) skipped.push("browser_session_limit");
    for (const entry of listing.entries.sort((a, b) => String(a?.name).localeCompare(String(b?.name)))) {
      input.signal?.throwIfAborted();
      if (!entry || !entry.file || !isWorkspaceBrowserSessionFilename(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 1) {
        skipped.push("browser_session_invalid"); continue;
      }
      if (entry.size > WORKSPACE_BROWSER_SESSION_MAX_BYTES) { skipped.push("browser_session_too_large"); continue; }
      if (files.length >= WORKSPACE_BROWSER_SESSION_MAX_COUNT) { skipped.push("browser_session_limit"); continue; }
      const path = workspaceBrowserSessionPath(entry.name);
      try {
        const checksum = await hashGuestFile(session.sandbox, path, entry.size, input.signal);
        files.push({ byteSize: entry.size, checksum, body: readStreamBody(() => session.sandbox.fs().readStream(path)),
          mimeType: "application/json", relativePath: entry.name,
          opaqueFileId: createHash("sha256").update(`${session.runtimeSandboxId}\0${input.modelRunId}\0browser\0${entry.name}`).digest("hex") });
      } catch {
        input.signal?.throwIfAborted();
        skipped.push("browser_session_read_failed");
      }
    }
    return { files, skipped };
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
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        // Empty regular files (for example Python package markers) have no
        // attachment payload. Keep exporting the other files; archives retain
        // any empty members they contain.
        if (entry.size === 0) continue;
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
    if (!output?.success) {
      // Exit 66 is reserved by PROJECT_ARCHIVE_COMMAND for device/socket
      // entries; keep that distinction for the client-safe status.
      throw new WorkspaceRuntimeError(output?.code === 66 ? "workspace_archive_invalid" : "workspace_output_export_failed");
    }
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

  async restoreProjectArchive(input: Parameters<NonNullable<WorkspaceRuntime["restoreProjectArchive"]>>[0]): Promise<void> {
    const session = await this.runningSession(input);
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > this.config.outputTotalMaxBytes || !HASH_PATTERN.test(input.checksum)) {
      throw new WorkspaceRuntimeError("workspace_archive_invalid");
    }
    const archivePath = `${WORKSPACE_TEMP_DIRECTORY}/workspace-restore-${createHash("sha256")
      .update(`${input.sessionId}\0${Date.now()}\0${input.checksum}`)
      .digest("hex")}.tar.gz`;
    const fs = session.sandbox.fs();
    const sink = await fs.writeStream(archivePath);
    const reader = input.archive.getReader();
    const checksum = createHash("sha256");
    let bytes = 0;
    let uploaded = false;
    try {
      while (true) {
        input.signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > input.byteSize) throw new WorkspaceRuntimeError("workspace_archive_limit_exceeded");
        checksum.update(next.value);
        await sink.write(next.value);
      }
      await sink.close();
      uploaded = true;
    } finally {
      if (!uploaded) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await sink[Symbol.asyncDispose]().catch(() => undefined);
      if (!uploaded) await fs.remove(archivePath).catch(() => undefined);
    }
    if (bytes !== input.byteSize || checksum.digest("hex") !== input.checksum) {
      await fs.remove(archivePath).catch(() => undefined);
      throw new WorkspaceRuntimeError("workspace_archive_invalid");
    }
    try {
      const result = await session.sandbox.exec("python3", ["-c", PROJECT_RESTORE_SCRIPT, archivePath, WORKSPACE_PROJECT_DIRECTORY,
        String(Math.min(this.config.outputTotalMaxBytes, this.config.diskMiB * 1_024 * 1_024)), String(PROJECT_ARCHIVE_MAX_ENTRIES)]);
      if (!result.success) throw new WorkspaceRuntimeError(result.code === 65 ? "workspace_archive_invalid" :
        result.code === 67 ? "workspace_archive_limit_exceeded" : result.code === 69 ? "workspace_execution_cleanup_failed" : "workspace_archive_restore_failed");
    } catch (error) {
      const cleanup = await session.sandbox.exec("bash", ["-c", "find \"$1\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +", "aiqsa-workspace-cleanup", WORKSPACE_PROJECT_DIRECTORY]).catch(() => null);
      if (!cleanup?.success) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      if (error instanceof WorkspaceRuntimeError) throw error;
      throw new WorkspaceRuntimeError("workspace_archive_restore_failed");
    } finally {
      await fs.remove(archivePath).catch(() => undefined);
    }
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
      // Stopping an already-stopped persistent disk is idempotent. This is
      // expected when a new operation claims a session after run cleanup (or
      // when the runtime idle timeout stopped it between two fence calls).
      if (error instanceof SandboxNotFoundError || error instanceof SandboxNotRunningError) {
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
        if (this.skills || this.skillDirectory || process.env.MSB_HOME?.trim()) {
          await this.skillState().removeSession({ ...input, runtimeSandboxId: expectedId ?? null });
        }
        if (this.captures || this.captureDirectory || process.env.MSB_HOME?.trim()) {
          await this.outputCaptures().removeSession({ ...input, runtimeSandboxId: expectedId ?? null });
        }
      }
    }
  }
}
