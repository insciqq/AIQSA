import { isMcpDiscoveryFailureMessage } from "./mcpDiscoveryFailure";
import { isMcpToolFailureMessage } from "./mcpToolFailure";

export const WORKSPACE_SESSION_STATES = Object.freeze([
  "not_started",
  "creating",
  "ready",
  "running",
  "stopped",
  "failed"
] as const);

export const WORKSPACE_UNAVAILABLE_REASONS = Object.freeze([
  "installation_disabled",
  "runtime_unavailable",
  "model_tools_required"
] as const);

export const WORKSPACE_ERROR_CODES = Object.freeze([
  "workspace_disabled",
  "workspace_runtime_unavailable",
  "workspace_model_tools_required",
  "workspace_busy",
  "workspace_session_create_failed",
  "workspace_session_lost",
  "workspace_runtime_incompatible",
  "workspace_tool_timeout",
  "workspace_tool_cancelled",
  "workspace_attachment_unavailable",
  "workspace_secrets_prepare_failed",
  "workspace_output_limit_exceeded",
  "workspace_output_export_failed",
  "workspace_execution_cleanup_failed",
  "workspace_shell_syntax_requires_shell",
  "workspace_reset_conflict",
  "workspace_archive_limit_exceeded",
  "workspace_not_started"
] as const);

export type WorkspaceSessionStateWire = (typeof WORKSPACE_SESSION_STATES)[number];
export type WorkspaceUnavailableReason = (typeof WORKSPACE_UNAVAILABLE_REASONS)[number];
export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export type ChatWorkspaceState = Readonly<{
  agentAvailable?: boolean;
  available: boolean;
  enabled: boolean;
  internetEnabled: boolean | null;
  sessionState: WorkspaceSessionStateWire | null;
  unavailableReason?: WorkspaceUnavailableReason;
  continuationFiles?: Readonly<{
    status: "none" | "pending" | "ready" | "failed";
    reason?: string;
  }>;
}>;

export const UNAVAILABLE_CHAT_WORKSPACE_STATE: ChatWorkspaceState = Object.freeze({
  available: false,
  enabled: false,
  internetEnabled: null,
  sessionState: null,
  unavailableReason: "installation_disabled"
});

export type ThreadGeneratedFile = Readonly<{
  attachmentId: string;
  byteSize: number;
  fileName: string;
  mimeType: string;
  relativePath: string;
}>;

export type WorkspaceRuntimeHealthWire = Readonly<{
  agentReady?: boolean;
  imageReady?: boolean;
  mcpVersion?: string;
  reasonCode?: string;
  runtimeVersion?: string;
  state: "ready" | "unavailable";
  virtualizationReady?: boolean;
}>;

export type WorkspaceStatusResponseWire = Readonly<{
  workspace: ChatWorkspaceState;
}>;

export type WorkspacePolicyWire = Readonly<{
  enabled: boolean;
  internetEnabled: boolean;
  runtime: WorkspaceRuntimeHealthWire;
  version: number;
}>;

export type WorkspacePolicyResponseWire = Readonly<{
  workspace: WorkspacePolicyWire;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function decodeChatWorkspaceState(value: unknown): ChatWorkspaceState | null {
  if (
    !isRecord(value) ||
    (value.agentAvailable !== undefined && typeof value.agentAvailable !== "boolean") ||
    typeof value.available !== "boolean" ||
    typeof value.enabled !== "boolean" ||
    (value.internetEnabled !== null && typeof value.internetEnabled !== "boolean") ||
    (value.sessionState !== null &&
      !(WORKSPACE_SESSION_STATES as readonly unknown[]).includes(value.sessionState)) ||
    (value.unavailableReason !== undefined &&
      !(WORKSPACE_UNAVAILABLE_REASONS as readonly unknown[]).includes(value.unavailableReason))
  ) {
    return null;
  }

  if (value.available && value.unavailableReason !== undefined) return null;

  let continuationFiles: ChatWorkspaceState["continuationFiles"];
  if (value.continuationFiles !== undefined) {
    if (!isRecord(value.continuationFiles) ||
      !["none", "pending", "ready", "failed"].includes(value.continuationFiles.status as string) ||
      (value.continuationFiles.reason !== undefined && !isBoundedString(value.continuationFiles.reason, 64))) return null;
    continuationFiles = {
      status: value.continuationFiles.status as "none" | "pending" | "ready" | "failed",
      ...(value.continuationFiles.reason === undefined ? {} : { reason: value.continuationFiles.reason })
    };
  }

  return {
    ...(typeof value.agentAvailable === "boolean" ? { agentAvailable: value.agentAvailable } : {}),
    available: value.available,
    enabled: value.enabled,
    internetEnabled: value.internetEnabled,
    sessionState: value.sessionState as WorkspaceSessionStateWire | null,
    ...(value.unavailableReason === undefined
      ? {}
      : { unavailableReason: value.unavailableReason as WorkspaceUnavailableReason }),
    ...(continuationFiles ? { continuationFiles } : {})
  };
}

export function decodeThreadGeneratedFile(value: unknown): ThreadGeneratedFile | null {
  if (
    !isRecord(value) ||
    !isBoundedString(value.attachmentId) ||
    !Number.isSafeInteger(value.byteSize) ||
    (value.byteSize as number) < 0 ||
    !isBoundedString(value.fileName, 512) ||
    !isBoundedString(value.mimeType, 255) ||
    !isBoundedString(value.relativePath, 512)
  ) {
    return null;
  }
  return {
    attachmentId: value.attachmentId,
    byteSize: value.byteSize as number,
    fileName: value.fileName,
    mimeType: value.mimeType,
    relativePath: value.relativePath
  };
}

export function decodeWorkspaceRuntimeHealth(
  value: unknown
): WorkspaceRuntimeHealthWire | null {
  if (!isRecord(value) || (value.state !== "ready" && value.state !== "unavailable")) {
    return null;
  }
  const optionalBooleanKeys = ["agentReady", "imageReady", "virtualizationReady"] as const;
  const optionalStringKeys = ["mcpVersion", "reasonCode", "runtimeVersion"] as const;
  if (
    optionalBooleanKeys.some((key) => value[key] !== undefined && typeof value[key] !== "boolean") ||
    optionalStringKeys.some((key) => value[key] !== undefined && !isBoundedString(value[key], 128))
  ) {
    return null;
  }
  return {
    ...(typeof value.agentReady === "boolean" ? { agentReady: value.agentReady } : {}),
    ...(typeof value.imageReady === "boolean" ? { imageReady: value.imageReady } : {}),
    ...(typeof value.mcpVersion === "string" ? { mcpVersion: value.mcpVersion } : {}),
    ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    ...(typeof value.runtimeVersion === "string" ? { runtimeVersion: value.runtimeVersion } : {}),
    state: value.state,
    ...(typeof value.virtualizationReady === "boolean"
      ? { virtualizationReady: value.virtualizationReady }
      : {})
  };
}

export function decodeWorkspacePolicyResponse(value: unknown): WorkspacePolicyWire | null {
  if (!isRecord(value) || !isRecord(value.workspace)) return null;
  const runtime = decodeWorkspaceRuntimeHealth(value.workspace.runtime);
  if (
    !runtime ||
    typeof value.workspace.enabled !== "boolean" ||
    typeof value.workspace.internetEnabled !== "boolean" ||
    !Number.isSafeInteger(value.workspace.version) ||
    (value.workspace.version as number) < 1
  ) {
    return null;
  }
  return {
    enabled: value.workspace.enabled,
    internetEnabled: value.workspace.internetEnabled,
    runtime,
    version: value.workspace.version as number
  };
}

export function isWorkspaceErrorCode(value: unknown): value is WorkspaceErrorCode {
  return (WORKSPACE_ERROR_CODES as readonly unknown[]).includes(value);
}

/**
 * Client-safe Workspace activity. The server sends structure (kind, phase,
 * bounded command/file facts); the client owns every human-readable label, so
 * persisted entries never freeze English copy. Raw tool identifiers, runtime
 * ids, host paths, and unbounded output never appear here.
 */
export const WORKSPACE_ACTIVITY_KINDS = Object.freeze([
  "workspace_start",
  "workspace_recreated",
  "workspace_stopped",
  "attachments_prepare",
  "command",
  "file_read",
  "file_write",
  "file_list",
  "file_copy",
  "file_move",
  "file_remove",
  "folder_create",
  "file_check",
  "outputs_export",
  "file_change",
  "mcp_call",
  "search",
  "agent_note",
  "plan",
  "elided"
] as const);

export const WORKSPACE_ACTIVITY_PHASES = Object.freeze([
  "requested",
  "running",
  "succeeded",
  "failed",
  "cancelled"
] as const);

export type WorkspaceActivityKind = (typeof WORKSPACE_ACTIVITY_KINDS)[number];
export type WorkspaceActivityPhase = (typeof WORKSPACE_ACTIVITY_PHASES)[number];

/** Total UTF-8 budget for one logical command's stdout+stderr preview. */
export const WORKSPACE_ACTIVITY_PREVIEW_MAX_BYTES = 8 * 1_024;
export const WORKSPACE_ACTIVITY_COMMAND_MAX_CHARS = 2_048;
export const WORKSPACE_ACTIVITY_PATH_MAX_CHARS = 512;
export const WORKSPACE_ACTIVITY_MAX_ENTRIES = 512;
export const WORKSPACE_ACTIVITY_NOTE_MAX_BYTES = 2 * 1_024;
export const WORKSPACE_ACTIVITY_MAX_FILE_CHANGES = 64;
export const WORKSPACE_ACTIVITY_MAX_PLAN_ITEMS = 50;

export type ThreadWorkspaceActivityCommand = Readonly<{
  cwd?: string;
  exitCode?: number | null;
  originalByteCount?: number;
  /** Source event of the retained output snapshot, even after a later output-free update. */
  outputSequence?: number;
  preview: string;
  previewTruncated?: boolean;
  stderrPreview?: string;
  stdoutPreview?: string;
  truncated?: boolean;
}>;

export type ThreadWorkspaceActivityFile = Readonly<{
  byteSize?: number;
  displayPath: string;
  targetPath?: string;
}>;

export type ThreadWorkspaceActivityEntry = Readonly<{
  changes?: readonly Readonly<{ action: "add" | "update" | "delete"; displayPath: string }>[];
  command?: ThreadWorkspaceActivityCommand;
  count?: number;
  durationMs?: number;
  errorCode?: WorkspaceErrorCode;
  failedCount?: number;
  file?: ThreadWorkspaceActivityFile;
  firstSequence?: number;
  groupId?: string;
  hasLifecycle?: boolean;
  id: string;
  items?: readonly Readonly<{ completed: boolean; text: string }>[];
  kind: WorkspaceActivityKind;
  mcp?: Readonly<{ discovery?: boolean; serverName?: string; toolName: string }>;
  phase: WorkspaceActivityPhase;
  /** Run-outcome projection of an unfinished entry; does not assert a process exit. */
  runOutcome?: "cancelled" | "failed";
  search?: Readonly<{ query: string; source: string }>;
  /** Assigned by ModelRunEvent persistence and retained when this update is replayed. */
  sequence?: number;
  startedAt?: string;
  text?: string;
  /** Unknown rows at or below this durable boundary have already been elided. */
  throughSequence?: number;
  updateId?: string;
}>;

export type ThreadWorkspaceOutputStatus = Readonly<{
  errorCode?: WorkspaceErrorCode;
  state: "complete" | "exporting" | "failed" | "retrying";
}>;

export type ThreadWorkspaceActivity = Readonly<{
  entries: readonly ThreadWorkspaceActivityEntry[];
  outputStatus?: ThreadWorkspaceOutputStatus;
  truncated?: boolean;
}>;

const ACTIVITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/u;
const ACTIVITY_ENTRY_KEYS = new Set([
  "changes",
  "command",
  "count",
  "durationMs",
  "errorCode",
  "failedCount",
  "file",
  "firstSequence",
  "groupId",
  "hasLifecycle",
  "id",
  "items",
  "kind",
  "mcp",
  "phase",
  "runOutcome",
  "search",
  "sequence",
  "startedAt",
  "text",
  "throughSequence",
  "updateId"
]);
const ACTIVITY_COMMAND_KEYS = new Set([
  "cwd",
  "exitCode",
  "originalByteCount",
  "outputSequence",
  "preview",
  "previewTruncated",
  "stderrPreview",
  "stdoutPreview",
  "truncated"
]);
const ACTIVITY_FILE_KEYS = new Set(["byteSize", "displayPath", "targetPath"]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  if (!allowEmpty && value.length === 0) return null;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? null : value;
}

function boundedCount(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeActivityCommand(value: unknown): ThreadWorkspaceActivityCommand | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTIVITY_COMMAND_KEYS)) return null;
  const preview = boundedText(value.preview, WORKSPACE_ACTIVITY_COMMAND_MAX_CHARS);
  if (!preview) return null;
  const cwd = value.cwd === undefined ? undefined : boundedText(value.cwd, WORKSPACE_ACTIVITY_PATH_MAX_CHARS);
  if (value.cwd !== undefined && !cwd) return null;
  const stdoutPreview = value.stdoutPreview === undefined
    ? undefined
    : boundedText(value.stdoutPreview, WORKSPACE_ACTIVITY_PREVIEW_MAX_BYTES, true);
  const stderrPreview = value.stderrPreview === undefined
    ? undefined
    : boundedText(value.stderrPreview, WORKSPACE_ACTIVITY_PREVIEW_MAX_BYTES, true);
  if (
    stdoutPreview === null ||
    stderrPreview === null ||
    utf8Bytes(stdoutPreview ?? "") + utf8Bytes(stderrPreview ?? "") > WORKSPACE_ACTIVITY_PREVIEW_MAX_BYTES
  ) {
    return null;
  }
  const exitCode = value.exitCode === undefined || value.exitCode === null
    ? value.exitCode
    : typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) &&
      value.exitCode >= -1_024 && value.exitCode <= 1_024
      ? value.exitCode
      : undefined;
  if (value.exitCode !== undefined && value.exitCode !== null && exitCode === undefined) return null;
  const originalByteCount = value.originalByteCount === undefined
    ? undefined
    : boundedCount(value.originalByteCount, Number.MAX_SAFE_INTEGER);
  if (originalByteCount === null) return null;
  const outputSequence = value.outputSequence === undefined ? undefined : boundedCount(value.outputSequence, Number.MAX_SAFE_INTEGER);
  if (outputSequence === null) return null;
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") return null;
  if (value.previewTruncated !== undefined && typeof value.previewTruncated !== "boolean") return null;
  return {
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(originalByteCount !== undefined ? { originalByteCount } : {}),
    ...(outputSequence !== undefined ? { outputSequence } : {}),
    preview,
    ...(value.previewTruncated !== undefined ? { previewTruncated: value.previewTruncated } : {}),
    ...(stderrPreview !== undefined ? { stderrPreview } : {}),
    ...(stdoutPreview !== undefined ? { stdoutPreview } : {}),
    ...(value.truncated !== undefined ? { truncated: value.truncated } : {})
  };
}

function decodeActivityFile(value: unknown): ThreadWorkspaceActivityFile | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTIVITY_FILE_KEYS)) return null;
  const displayPath = boundedText(value.displayPath, WORKSPACE_ACTIVITY_PATH_MAX_CHARS);
  if (!displayPath) return null;
  const targetPath = value.targetPath === undefined
    ? undefined
    : boundedText(value.targetPath, WORKSPACE_ACTIVITY_PATH_MAX_CHARS);
  if (value.targetPath !== undefined && !targetPath) return null;
  const byteSize = value.byteSize === undefined
    ? undefined
    : boundedCount(value.byteSize, Number.MAX_SAFE_INTEGER);
  if (byteSize === null) return null;
  return {
    ...(byteSize !== undefined ? { byteSize } : {}),
    displayPath,
    ...(targetPath ? { targetPath } : {})
  };
}

export function decodeThreadWorkspaceActivityEntry(value: unknown): ThreadWorkspaceActivityEntry | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTIVITY_ENTRY_KEYS)) return null;
  const id = typeof value.id === "string" && ACTIVITY_ID_PATTERN.test(value.id) ? value.id : null;
  const kind = (WORKSPACE_ACTIVITY_KINDS as readonly string[]).includes(String(value.kind))
    ? value.kind as WorkspaceActivityKind
    : null;
  const phase = (WORKSPACE_ACTIVITY_PHASES as readonly string[]).includes(String(value.phase))
    ? value.phase as WorkspaceActivityPhase
    : null;
  if (!id || !kind || !phase) return null;
  const sequence = value.sequence === undefined ? undefined : boundedCount(value.sequence, Number.MAX_SAFE_INTEGER);
  if (sequence === null) return null;
  const firstSequence = value.firstSequence === undefined ? undefined : boundedCount(value.firstSequence, Number.MAX_SAFE_INTEGER);
  if (firstSequence === null || firstSequence !== undefined && (sequence === undefined || firstSequence > sequence)) return null;
  const updateId = value.updateId === undefined ? undefined
    : typeof value.updateId === "string" && ACTIVITY_ID_PATTERN.test(value.updateId) ? value.updateId : null;
  if (updateId === null) return null;
  const runOutcome = value.runOutcome === undefined ? undefined
    : value.runOutcome === "cancelled" || value.runOutcome === "failed" ? value.runOutcome : null;
  if (runOutcome === null || runOutcome !== undefined && phase !== runOutcome) return null;
  const groupId = value.groupId === undefined
    ? undefined
    : typeof value.groupId === "string" && ACTIVITY_ID_PATTERN.test(value.groupId) ? value.groupId : null;
  if (value.groupId !== undefined && !groupId) return null;
  const startedAt = value.startedAt === undefined
    ? undefined
    : typeof value.startedAt === "string" && value.startedAt.length <= 40 &&
      Number.isFinite(Date.parse(value.startedAt))
      ? value.startedAt
      : null;
  if (value.startedAt !== undefined && !startedAt) return null;
  const durationMs = value.durationMs === undefined ? undefined : boundedCount(value.durationMs, 7 * 24 * 3_600_000);
  if (durationMs === null) return null;
  const count = value.count === undefined ? undefined : boundedCount(value.count, 1_000_000);
  if (count === null) return null;
  const errorCode = value.errorCode === undefined
    ? undefined
    : isWorkspaceErrorCode(value.errorCode) ? value.errorCode : null;
  if (value.errorCode !== undefined && !errorCode) return null;
  const command = value.command === undefined ? undefined : decodeActivityCommand(value.command);
  if (value.command !== undefined && !command) return null;
  if (command?.outputSequence !== undefined && (sequence === undefined || command.outputSequence > sequence)) return null;
  const file = value.file === undefined ? undefined : decodeActivityFile(value.file);
  if (value.file !== undefined && !file) return null;
  let changes: ThreadWorkspaceActivityEntry["changes"];
  if (kind === "file_change") {
    if (!Array.isArray(value.changes) || value.changes.length > WORKSPACE_ACTIVITY_MAX_FILE_CHANGES) return null;
    const decoded: NonNullable<ThreadWorkspaceActivityEntry["changes"]>[number][] = [];
    for (const change of value.changes) {
      if (!isRecord(change) || !hasOnlyKeys(change, new Set(["action", "displayPath"])) ||
        !["add", "update", "delete"].includes(String(change.action))) return null;
      const displayPath = boundedText(change.displayPath, WORKSPACE_ACTIVITY_PATH_MAX_CHARS);
      if (!displayPath) return null;
      decoded.push({ action: change.action as "add" | "update" | "delete", displayPath });
    }
    changes = decoded;
  } else if (value.changes !== undefined) return null;
  let items: ThreadWorkspaceActivityEntry["items"];
  if (kind === "plan") {
    if (!Array.isArray(value.items) || value.items.length > WORKSPACE_ACTIVITY_MAX_PLAN_ITEMS) return null;
    const decoded: NonNullable<ThreadWorkspaceActivityEntry["items"]>[number][] = [];
    for (const item of value.items) {
      if (!isRecord(item) || !hasOnlyKeys(item, new Set(["completed", "text"])) || typeof item.completed !== "boolean") return null;
      const text = boundedText(item.text, 512);
      if (!text) return null;
      decoded.push({ completed: item.completed, text });
    }
    items = decoded;
  } else if (value.items !== undefined) return null;
  let mcp: ThreadWorkspaceActivityEntry["mcp"];
  if (kind === "mcp_call") {
    if (!isRecord(value.mcp) || !hasOnlyKeys(value.mcp, new Set(["discovery", "serverName", "toolName"]))) return null;
    const toolName = boundedText(value.mcp.toolName, 160);
    const serverName = value.mcp.serverName === undefined ? undefined : boundedText(value.mcp.serverName, 160);
    if (!toolName || serverName === null || value.mcp.discovery !== undefined && typeof value.mcp.discovery !== "boolean") return null;
    mcp = {
      ...(value.mcp.discovery !== undefined ? { discovery: value.mcp.discovery } : {}),
      ...(serverName !== undefined ? { serverName } : {}), toolName
    };
  } else if (value.mcp !== undefined) return null;
  let search: ThreadWorkspaceActivityEntry["search"];
  if (kind === "search") {
    if (!isRecord(value.search) || !hasOnlyKeys(value.search, new Set(["query", "source"]))) return null;
    const query = boundedText(value.search.query, 200, true);
    const source = boundedText(value.search.source, 160);
    if (query === null || !source) return null;
    search = { query, source };
  } else if (value.search !== undefined) return null;
  let text: string | undefined;
  if (kind === "agent_note") {
    const decoded = boundedText(value.text, WORKSPACE_ACTIVITY_NOTE_MAX_BYTES);
    if (!decoded || utf8Bytes(decoded) > WORKSPACE_ACTIVITY_NOTE_MAX_BYTES) return null;
    text = decoded;
  } else if (kind === "mcp_call" && phase === "failed" && value.text !== undefined) {
    if (mcp?.discovery && isMcpDiscoveryFailureMessage(value.text) || !mcp?.discovery && isMcpToolFailureMessage(value.text)) text = value.text;
    else return null;
  } else if (value.text !== undefined) return null;
  let elided: Pick<ThreadWorkspaceActivityEntry, "failedCount" | "hasLifecycle" | "throughSequence"> = {};
  if (kind === "elided") {
    const failedCount = boundedCount(value.failedCount, 1_000_000);
    const throughSequence = boundedCount(value.throughSequence, Number.MAX_SAFE_INTEGER);
    if (!count || failedCount === null || failedCount > count || throughSequence === null || typeof value.hasLifecycle !== "boolean") return null;
    elided = { failedCount, hasLifecycle: value.hasLifecycle, throughSequence };
  } else if (value.failedCount !== undefined || value.hasLifecycle !== undefined || value.throughSequence !== undefined) return null;
  return {
    ...(changes ? { changes } : {}),
    ...(command ? { command } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(elided.failedCount !== undefined ? { failedCount: elided.failedCount } : {}),
    ...(file ? { file } : {}),
    ...(firstSequence !== undefined ? { firstSequence } : {}),
    ...(groupId ? { groupId } : {}),
    ...(elided.hasLifecycle !== undefined ? { hasLifecycle: elided.hasLifecycle } : {}),
    id,
    ...(items ? { items } : {}),
    kind,
    ...(mcp ? { mcp } : {}),
    phase,
    ...(runOutcome ? { runOutcome } : {}),
    ...(search ? { search } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(elided.throughSequence !== undefined ? { throughSequence: elided.throughSequence } : {}),
    ...(updateId ? { updateId } : {})
  };
}

export function decodeThreadWorkspaceOutputStatus(value: unknown): ThreadWorkspaceOutputStatus | null {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["errorCode", "state"]))) return null;
  const state = value.state === "complete" || value.state === "exporting" ||
    value.state === "failed" || value.state === "retrying"
    ? value.state
    : null;
  if (!state) return null;
  const errorCode = value.errorCode === undefined
    ? undefined
    : isWorkspaceErrorCode(value.errorCode) ? value.errorCode : null;
  if (value.errorCode !== undefined && !errorCode) return null;
  return { ...(errorCode ? { errorCode } : {}), state };
}

export function decodeThreadWorkspaceActivity(value: unknown): ThreadWorkspaceActivity | null {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["entries", "outputStatus", "truncated"]))) return null;
  if (!Array.isArray(value.entries) || value.entries.length > WORKSPACE_ACTIVITY_MAX_ENTRIES) return null;
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") return null;
  const entries: ThreadWorkspaceActivityEntry[] = [];
  for (const candidate of value.entries) {
    const entry = decodeThreadWorkspaceActivityEntry(candidate);
    if (!entry) return null;
    entries.push(entry);
  }
  const outputStatus = value.outputStatus === undefined
    ? undefined
    : decodeThreadWorkspaceOutputStatus(value.outputStatus);
  if (value.outputStatus !== undefined && !outputStatus) return null;
  if (entries.filter((entry) => entry.kind === "elided").length > 1) return null;
  if (entries.some((entry) => entry.kind === "elided") && value.truncated !== true) return null;
  return { entries, ...(outputStatus ? { outputStatus } : {}),
    ...(value.truncated !== undefined ? { truncated: value.truncated } : {}) };
}

const PHYSICAL_BASENAME_MAX_BYTES = 160;

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8Bytes(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

/**
 * Produces a path-safe, bounded display derivative. The opaque attachment id is
 * still the physical identity; an original filename is only retained as
 * metadata in the manifest.
 */
export function safeWorkspaceBasename(originalName: string): string {
  const normalized = originalName.normalize("NFC").trim();
  const replaced = normalized
    .replace(/[\u0000-\u001f\u007f/\\]+/gu, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
  return truncateUtf8(replaced || "file", PHYSICAL_BASENAME_MAX_BYTES);
}
