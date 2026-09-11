import { safeWorkspaceBasename } from "./workspace";

export const WORKSPACE_SECRET_KINDS = ["ssh_key", "env", "text", "file", "browser_session"] as const;
export type WorkspaceSecretKind = (typeof WORKSPACE_SECRET_KINDS)[number];
export const WORKSPACE_SECRET_MAX_COUNT = 32;
export const WORKSPACE_BROWSER_SESSION_MAX_COUNT = 50;
export const WORKSPACE_BROWSER_SESSION_MAX_BYTES = 512 * 1024;
export const WORKSPACE_SECRET_FILE_MAX_BYTES = 512 * 1024;
export const WORKSPACE_SECRET_VALUE_MAX_BYTES = 768 * 1024;
export const WORKSPACE_SECRET_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_SECRET_ENV_MAX_BYTES = 128 * 1024;
export const WORKSPACE_SECRETS_PATH = "/workspace/secrets";
export const WORKSPACE_SECRETS_GUIDE_PATH = "/workspace/SECRETS.md";
export const WORKSPACE_BROWSER_SESSIONS_PATH = `${WORKSPACE_SECRETS_PATH}/browser`;

export type WorkspaceSecretValue =
  | Readonly<{ kind: "ssh_key"; privateKey: string; passphrase: string }>
  | Readonly<{ kind: "env"; entries: readonly Readonly<{ name: string; value: string }>[] }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "file"; originalName: string; base64: string }>
  | Readonly<{ kind: "browser_session"; originalName: string; base64: string }>;

/** Write-only content. Reading settings returns only WorkspaceSecretSummary. */
export type WorkspaceSecretMutation =
  | Readonly<{ action: "create"; name: string; description: string; value: WorkspaceSecretValue }>
  | Readonly<{ action: "update"; id: string; expectedVersionId: string; name: string; description: string;
      value: Readonly<{ action: "preserve" }> | Readonly<{ action: "replace"; content: WorkspaceSecretValue }> }>
  | Readonly<{ action: "delete"; id: string; expectedVersionId: string }>;

export type WorkspaceSecretSummary = Readonly<{
  id: string;
  versionId: string;
  kind: WorkspaceSecretKind;
  name: string;
  description: string;
  byteSize: number;
  updatedAt: string;
  envNames: readonly string[];
  originalName: string | null;
  sshProtected: boolean;
  browserSession?: Readonly<{ autoSaved: boolean }>;
}>;

export type WorkspaceSecretErrorCode =
  | "workspace_secret_invalid"
  | "workspace_secret_limit"
  | "workspace_secret_conflict"
  | "workspace_secret_env_conflict"
  | "workspace_secret_ssh_invalid"
  | "workspace_browser_session_invalid"
  | "workspace_browser_session_conflict"
  | "workspace_secret_unavailable";

export function workspaceSecretErrorMessage(code: unknown): string {
  switch (code) {
    case "workspace_secret_invalid": return "Check the name, value and file size. Environment names must be unique and use letters, digits and underscores.";
    case "workspace_secret_limit": return "Workspace secrets allow up to 32 entries and 4 MiB in total, including up to 128 KiB of environment variables, plus 50 browser sessions. Each file or browser session can be up to 512 KiB.";
    case "workspace_browser_session_invalid": return "Choose a Playwright storage_state JSON file with cookies and origins, up to 512 KiB. Use a safe filename such as shop.example.json.";
    case "workspace_browser_session_conflict": return "A browser session with this filename already exists. Edit that session to replace it.";
    case "workspace_secret_conflict": return "This secret changed in another window. Refresh the list before saving again. Your input is still here.";
    case "workspace_secret_env_conflict": return "An environment name is already used by another saved secret.";
    case "workspace_secret_ssh_invalid": return "Enter a valid private SSH key and its matching passphrase, if encrypted. A public key alone is not enough.";
    default: return "Workspace secrets are unavailable. Try again; your input is still here.";
  }
}

export function isWorkspaceSecretId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function isWorkspaceEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value) &&
    !["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH_COMMAND"].includes(value);
}

export function workspaceSecretAssetPath(id: string, kind: "ssh_key" | "file"): string {
  if (!isWorkspaceSecretId(id)) throw new Error("workspace_secret_invalid");
  return `${WORKSPACE_SECRETS_PATH}/${kind === "ssh_key" ? "ssh" : "files"}/${id}`;
}

export function isWorkspaceBrowserSessionFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 5 && value.endsWith(".json") &&
    safeWorkspaceBasename(value) === value;
}

export function workspaceBrowserSessionPath(fileName: string): string {
  if (!isWorkspaceBrowserSessionFilename(fileName)) throw new Error("workspace_browser_session_invalid");
  return `${WORKSPACE_BROWSER_SESSIONS_PATH}/${fileName}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeWorkspaceSecretList(value: unknown): readonly WorkspaceSecretSummary[] | null {
  if (!Array.isArray(value) || value.length > WORKSPACE_SECRET_MAX_COUNT + WORKSPACE_BROWSER_SESSION_MAX_COUNT) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (!record(item) || Object.keys(item).some((key) => ![
      "id", "versionId", "kind", "name", "description", "byteSize", "updatedAt", "envNames", "originalName", "sshProtected", "browserSession"
    ].includes(key)) || !isWorkspaceSecretId(item.id) || ids.has(item.id) || !isWorkspaceSecretId(item.versionId) ||
      !WORKSPACE_SECRET_KINDS.includes(item.kind as WorkspaceSecretKind) ||
      typeof item.name !== "string" || !item.name.trim() || item.name.length > 120 ||
      typeof item.description !== "string" || item.description.length > 2000 ||
      typeof item.byteSize !== "number" || !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 || item.byteSize > WORKSPACE_SECRET_VALUE_MAX_BYTES ||
      typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt)) ||
      !Array.isArray(item.envNames) || item.envNames.length > 64 || !item.envNames.every(isWorkspaceEnvName) ||
      new Set(item.envNames).size !== item.envNames.length ||
      !(item.originalName === null || typeof item.originalName === "string" && item.originalName.length <= 255) ||
      typeof item.sshProtected !== "boolean" ||
      (item.kind === "browser_session" ? !isWorkspaceBrowserSessionFilename(item.originalName) ||
        !record(item.browserSession) || Object.keys(item.browserSession).length !== 1 || typeof item.browserSession.autoSaved !== "boolean"
        : item.browserSession !== undefined)) return null;
    ids.add(item.id);
  }
  const browserCount = value.filter((entry) => entry.kind === "browser_session").length;
  if (browserCount > WORKSPACE_BROWSER_SESSION_MAX_COUNT || value.length - browserCount > WORKSPACE_SECRET_MAX_COUNT) return null;
  return value as WorkspaceSecretSummary[];
}
