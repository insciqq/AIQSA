export const WORKSPACE_POLICY_ID = "installation";
export const WORKSPACE_MCP_NAMESPACE = "workspace";

export const WORKSPACE_ROOT = "/workspace";
export const WORKSPACE_INBOX_DIRECTORY = `${WORKSPACE_ROOT}/inbox`;
export const WORKSPACE_INBOX_INDEX_PATH = `${WORKSPACE_INBOX_DIRECTORY}/index.json`;
export const WORKSPACE_PROJECT_DIRECTORY = `${WORKSPACE_ROOT}/project`;
export const WORKSPACE_OUTPUT_DIRECTORY = `${WORKSPACE_ROOT}/output`;
export const WORKSPACE_TEMP_DIRECTORY = `${WORKSPACE_ROOT}/tmp`;

export const WORKSPACE_MCP_TOOL_ALLOWLIST = Object.freeze([
  "sandbox_shell",
  "sandbox_exec",
  "sandbox_exec_start",
  "sandbox_exec_poll",
  "sandbox_exec_write_stdin",
  "sandbox_exec_signal",
  "sandbox_exec_close",
  "sandbox_fs_read",
  "sandbox_fs_write",
  "sandbox_fs_list",
  "sandbox_fs_mkdir",
  "sandbox_fs_copy",
  "sandbox_fs_remove",
  "sandbox_fs_rename",
  "sandbox_fs_stat",
  "sandbox_fs_exists"
] as const);

export type WorkspaceMcpToolName = (typeof WORKSPACE_MCP_TOOL_ALLOWLIST)[number];

export const WORKSPACE_EXEC_SESSION_TOOL_NAMES = Object.freeze([
  "sandbox_exec_poll",
  "sandbox_exec_write_stdin",
  "sandbox_exec_signal",
  "sandbox_exec_close"
] as const satisfies readonly WorkspaceMcpToolName[]);

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PHYSICAL_BASENAME_MAX_BYTES = 160;
export const WORKSPACE_RELATIVE_PATH_MAX_BYTES = 512;
export const WORKSPACE_PATH_SEGMENT_MAX_BYTES = 255;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8Length(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

export function isWorkspaceOpaqueId(value: string): boolean {
  return OPAQUE_ID_PATTERN.test(value);
}

function requireWorkspaceOpaqueId(value: string, kind: string): string {
  if (!isWorkspaceOpaqueId(value)) {
    throw new Error(`workspace_${kind}_invalid`);
  }
  return value;
}

export function workspaceSandboxName(sessionId: string): string {
  const safeId = requireWorkspaceOpaqueId(sessionId, "session_id").toLowerCase();
  return `aiqsa-ws-${safeId}`;
}

export function workspaceMessageDirectory(messageId: string): string {
  return `${WORKSPACE_INBOX_DIRECTORY}/messages/${requireWorkspaceOpaqueId(messageId, "message_id")}`;
}

export function workspaceMessageManifestPath(messageId: string): string {
  return `${workspaceMessageDirectory(messageId)}/manifest.json`;
}

export function workspaceRunOutputDirectory(modelRunId: string): string {
  return `${WORKSPACE_OUTPUT_DIRECTORY}/${requireWorkspaceOpaqueId(modelRunId, "run_id")}`;
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

export function workspaceAttachmentPath(input: Readonly<{
  attachmentId: string;
  messageId: string;
  originalName: string;
}>): string {
  const attachmentId = requireWorkspaceOpaqueId(input.attachmentId, "attachment_id");
  return `${workspaceMessageDirectory(input.messageId)}/${attachmentId}--${safeWorkspaceBasename(input.originalName)}`;
}

export function isSafeWorkspaceRelativePath(value: string): boolean {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    utf8Length(value) > WORKSPACE_RELATIVE_PATH_MAX_BYTES
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    utf8Length(segment) <= WORKSPACE_PATH_SEGMENT_MAX_BYTES
  );
}

export function workspaceToolIsAllowed(value: string): value is WorkspaceMcpToolName {
  return (WORKSPACE_MCP_TOOL_ALLOWLIST as readonly string[]).includes(value);
}

/**
 * Output export failures that no retry can repair: the run's output set is
 * invalid, or the guest disk that held it is gone. Everything else (storage,
 * runner, or network trouble) is retried by export recovery.
 */
export const WORKSPACE_PERMANENT_EXPORT_ERROR_CODES = Object.freeze([
  "workspace_output_limit_exceeded",
  "workspace_runtime_incompatible",
  "workspace_session_lost"
] as const);

export function isRetryableWorkspaceExportErrorCode(code: string | null | undefined): boolean {
  return !code || !(WORKSPACE_PERMANENT_EXPORT_ERROR_CODES as readonly string[]).includes(code);
}

const RUNTIME_EXEC_SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/u;

/**
 * Guest-visible inbox index written on every staging pass. The application
 * reads it back to stage only missing or changed originals, so it is decoded
 * strictly: any malformed index simply means "restage everything".
 */
export const WORKSPACE_INBOX_INDEX_VERSION = 1;
export const WORKSPACE_INBOX_INDEX_MAX_ENTRIES = 1_024;
export const WORKSPACE_INBOX_INDEX_MAX_BYTES = 2 * 1_024 * 1_024;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_STAGED_BYTE_SIZE = 1_073_741_824;

export type WorkspaceStagedAttachmentEntry = Readonly<{
  attachmentId: string;
  byteSize: number;
  checksum: string;
  sandboxPath: string;
}>;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeWorkspaceStagedAttachmentEntry(
  value: unknown
): WorkspaceStagedAttachmentEntry | null {
  if (
    !isRecordValue(value) ||
    typeof value.attachmentId !== "string" ||
    !isWorkspaceOpaqueId(value.attachmentId) ||
    typeof value.byteSize !== "number" ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAX_STAGED_BYTE_SIZE ||
    typeof value.checksum !== "string" ||
    !CHECKSUM_PATTERN.test(value.checksum) ||
    typeof value.sandboxPath !== "string" ||
    !value.sandboxPath.startsWith(`${WORKSPACE_INBOX_DIRECTORY}/messages/`) ||
    !isSafeWorkspaceRelativePath(value.sandboxPath.slice(WORKSPACE_ROOT.length + 1))
  ) {
    return null;
  }
  return {
    attachmentId: value.attachmentId,
    byteSize: value.byteSize,
    checksum: value.checksum,
    sandboxPath: value.sandboxPath
  };
}

export function decodeWorkspaceInboxIndexAttachments(
  value: unknown
): readonly WorkspaceStagedAttachmentEntry[] | null {
  if (
    !isRecordValue(value) ||
    value.version !== WORKSPACE_INBOX_INDEX_VERSION ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > WORKSPACE_INBOX_INDEX_MAX_ENTRIES
  ) {
    return null;
  }
  const entries: WorkspaceStagedAttachmentEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value.attachments) {
    const entry = decodeWorkspaceStagedAttachmentEntry(candidate);
    if (!entry || seen.has(entry.attachmentId)) return null;
    seen.add(entry.attachmentId);
    entries.push(entry);
  }
  return entries;
}

export function isWorkspaceRuntimeExecSessionId(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_EXEC_SESSION_ID_PATTERN.test(value);
}
