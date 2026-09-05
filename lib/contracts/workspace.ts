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
  available: boolean;
  enabled: boolean;
  internetEnabled: boolean | null;
  sessionState: WorkspaceSessionStateWire | null;
  unavailableReason?: WorkspaceUnavailableReason;
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

  return {
    available: value.available,
    enabled: value.enabled,
    internetEnabled: value.internetEnabled,
    sessionState: value.sessionState as WorkspaceSessionStateWire | null,
    ...(value.unavailableReason === undefined
      ? {}
      : { unavailableReason: value.unavailableReason as WorkspaceUnavailableReason })
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
  const optionalBooleanKeys = ["imageReady", "virtualizationReady"] as const;
  const optionalStringKeys = ["mcpVersion", "reasonCode", "runtimeVersion"] as const;
  if (
    optionalBooleanKeys.some((key) => value[key] !== undefined && typeof value[key] !== "boolean") ||
    optionalStringKeys.some((key) => value[key] !== undefined && !isBoundedString(value[key], 128))
  ) {
    return null;
  }
  return {
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
  "outputs_export"
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

export type ThreadWorkspaceActivityCommand = Readonly<{
  cwd?: string;
  exitCode?: number | null;
  originalByteCount?: number;
  /** Source event of the retained output snapshot, even after a later output-free update. */
  outputSequence?: number;
  preview: string;
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
  command?: ThreadWorkspaceActivityCommand;
  count?: number;
  durationMs?: number;
  errorCode?: WorkspaceErrorCode;
  file?: ThreadWorkspaceActivityFile;
  firstSequence?: number;
  groupId?: string;
  id: string;
  kind: WorkspaceActivityKind;
  phase: WorkspaceActivityPhase;
  /** Run-outcome projection of an unfinished entry; does not assert a process exit. */
  runOutcome?: "cancelled" | "failed";
  /** Assigned by ModelRunEvent persistence and retained when this update is replayed. */
  sequence?: number;
  startedAt?: string;
  updateId?: string;
}>;

export type ThreadWorkspaceOutputStatus = Readonly<{
  errorCode?: WorkspaceErrorCode;
  state: "complete" | "exporting" | "failed" | "retrying";
}>;

export type ThreadWorkspaceActivity = Readonly<{
  entries: readonly ThreadWorkspaceActivityEntry[];
  outputStatus?: ThreadWorkspaceOutputStatus;
}>;

const ACTIVITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/u;
const ACTIVITY_ENTRY_KEYS = new Set([
  "command",
  "count",
  "durationMs",
  "errorCode",
  "file",
  "firstSequence",
  "groupId",
  "id",
  "kind",
  "phase",
  "runOutcome",
  "sequence",
  "startedAt",
  "updateId"
]);
const ACTIVITY_COMMAND_KEYS = new Set([
  "cwd",
  "exitCode",
  "originalByteCount",
  "outputSequence",
  "preview",
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
  return {
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(originalByteCount !== undefined ? { originalByteCount } : {}),
    ...(outputSequence !== undefined ? { outputSequence } : {}),
    preview,
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
  return {
    ...(command ? { command } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(file ? { file } : {}),
    ...(firstSequence !== undefined ? { firstSequence } : {}),
    ...(groupId ? { groupId } : {}),
    id,
    kind,
    phase,
    ...(runOutcome ? { runOutcome } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(startedAt ? { startedAt } : {}),
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
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["entries", "outputStatus"]))) return null;
  if (!Array.isArray(value.entries) || value.entries.length > WORKSPACE_ACTIVITY_MAX_ENTRIES) return null;
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
  return { entries, ...(outputStatus ? { outputStatus } : {}) };
}
