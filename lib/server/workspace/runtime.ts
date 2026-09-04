import type {
  WorkspaceMcpToolName,
  WorkspaceStagedAttachmentEntry
} from "@/lib/domain/workspace";

export type WorkspaceRuntimeHealth = Readonly<{
  imageReady?: boolean;
  mcpVersion?: string;
  reasonCode?: string;
  runtimeVersion?: string;
  state: "ready" | "unavailable";
  virtualizationReady?: boolean;
}>;

export type WorkspaceRuntimeSession = Readonly<{
  runtimeSandboxId: string;
  sandboxName: string;
  state: "ready" | "running";
}>;

export type WorkspaceBoundTool = Readonly<{
  description: string;
  inputSchema: Record<string, unknown>;
  namespacedName: string;
  originalName: WorkspaceMcpToolName;
}>;

export type WorkspaceToolCatalog = Readonly<{
  hash: string;
  mcpVersion: string;
  runtimeVersion: string;
  tools: readonly WorkspaceBoundTool[];
}>;

export type WorkspaceToolResult = Readonly<{
  content: readonly Readonly<{
    text?: string;
    type: "json" | "text";
    value?: unknown;
  }>[];
  /** Official long-lived execution id returned by a successful `sandbox_exec_start`. */
  execSessionId?: string;
  exitCode?: number | null;
  originalByteCount?: number;
  status: "complete" | "error";
  truncated?: boolean;
}>;

export type WorkspaceAttachmentStream = Readonly<{
  attachmentId: string;
  body: ReadableStream<Uint8Array>;
  byteSize: number;
  checksum: string;
  kind: "document" | "file" | "image" | "pdf";
  messageId: string;
  mimeType: string;
  originalName: string;
  sandboxPath: string;
}>;

export type WorkspaceOutputStream = Readonly<{
  body: ReadableStream<Uint8Array>;
  byteSize: number;
  checksum: string;
  mimeType: string;
  opaqueFileId: string;
  relativePath: string;
}>;

/**
 * Result of quiescing one long-lived execution. `closed` proves the guest
 * process is gone; `unknown` means the runtime could not prove it, so the
 * caller must stop the VM to guarantee quiescence.
 */
export type WorkspaceExecutionTermination = Readonly<{
  outcome: "closed" | "unknown";
  runtimeExecSessionId: string;
}>;

export interface WorkspaceRuntime {
  health(signal?: AbortSignal): Promise<WorkspaceRuntimeHealth>;
  ensureSession(input: Readonly<{
    cpus: number;
    diskMiB: number;
    imageRef: string;
    internetEnabled: boolean;
    memoryMiB: number;
    runtimeSandboxId: string | null;
    sandboxName: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<WorkspaceRuntimeSession>;
  /**
   * Originals already present in the guest inbox according to its index,
   * verified against real regular files. Any read/parse problem yields an
   * empty list so the caller restages everything instead of failing.
   */
  listStagedAttachments(input: Readonly<{
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<readonly WorkspaceStagedAttachmentEntry[]>;
  stageAttachments(input: Readonly<{
    attachments: readonly WorkspaceAttachmentStream[];
    inboxIndex: unknown;
    manifests: readonly Readonly<{ body: unknown; messageId: string }>[];
    outputDirectory?: string;
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<void>;
  loadBoundTools(input: Readonly<{
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<WorkspaceToolCatalog>;
  callBoundTool(input: Readonly<{
    arguments: Record<string, unknown>;
    modelRunId: string;
    modelRunToolCallId: string;
    originalName: WorkspaceMcpToolName;
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<WorkspaceToolResult>;
  cancelToolCall(input: Readonly<{
    modelRunId: string;
    modelRunToolCallId: string;
    runtimeSandboxId: string;
    sessionId: string;
  }>): Promise<void>;
  /**
   * Terminates the given executions on behalf of the application's durable
   * registry: TERM, a bounded grace period, KILL, then close. The runner's own
   * ownership cache must not block this after a restart.
   */
  terminateExecutions(input: Readonly<{
    executions: readonly Readonly<{ modelRunId: string; runtimeExecSessionId: string }>[];
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<readonly WorkspaceExecutionTermination[]>;
  collectOutputs(input: Readonly<{
    modelRunId: string;
    outputDirectory: string;
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<readonly WorkspaceOutputStream[]>;
  createProjectArchive(input: Readonly<{
    runtimeSandboxId: string;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<WorkspaceOutputStream>;
  stopSession(input: Readonly<{
    runtimeSandboxId: string | null;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<void>;
  removeSession(input: Readonly<{
    runtimeSandboxId: string | null;
    sessionId: string;
    signal?: AbortSignal;
  }>): Promise<void>;
}

export class WorkspaceRuntimeError extends Error {
  readonly code:
    | "workspace_attachment_unavailable"
    | "workspace_archive_limit_exceeded"
    | "workspace_execution_cleanup_failed"
    | "workspace_output_limit_exceeded"
    | "workspace_output_export_failed"
    | "workspace_runtime_incompatible"
    | "workspace_runtime_unavailable"
    | "workspace_session_create_failed"
    | "workspace_session_lost"
    | "workspace_tool_cancelled"
    | "workspace_tool_timeout";

  constructor(code: WorkspaceRuntimeError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceRuntimeError";
  }
}
