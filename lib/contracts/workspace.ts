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
