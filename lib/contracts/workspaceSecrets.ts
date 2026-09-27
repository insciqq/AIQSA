import { safeWorkspaceBasename } from "./workspace";

export const WORKSPACE_SECRET_KINDS = ["ssh_key", "env", "text", "file", "browser_session"] as const;
export type WorkspaceSecretKind = (typeof WORKSPACE_SECRET_KINDS)[number];
export const WORKSPACE_SECRET_MAX_COUNT = 32;
export const WORKSPACE_BROWSER_SESSION_MAX_COUNT = 50;
/** Raw storage_state bytes of one browser session. */
export const WORKSPACE_BROWSER_SESSION_MAX_BYTES = 8 * 1024 * 1024;
/** Raw bytes across all saved browser sessions, separate from the ordinary total. */
export const WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_SECRET_FILE_MAX_BYTES = 512 * 1024;
/** Serialized ordinary value: the largest file as base64 plus its JSON envelope. */
export const WORKSPACE_SECRET_VALUE_MAX_BYTES = 768 * 1024;
/** Serialized browser value: the largest state as base64 plus its kind and filename. */
export const WORKSPACE_BROWSER_SESSION_VALUE_MAX_BYTES = Math.ceil(WORKSPACE_BROWSER_SESSION_MAX_BYTES / 3) * 4 + 4 * 1024;
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

export const WORKSPACE_BROWSER_SKIP_CODES = [
  "browser_session_invalid", "browser_session_too_large", "browser_session_total_limit", "browser_session_limit",
  "browser_session_stale", "browser_session_read_failed"
] as const;
export type WorkspaceBrowserSkipCode = (typeof WORKSPACE_BROWSER_SKIP_CODES)[number];
/** Outcome of one accepted run's browser autosave: counts only, never names, origins or cookies. */
export type WorkspaceBrowserAutosaveReport = Readonly<{
  saved: number;
  unchanged: number;
  skipped: Partial<Record<WorkspaceBrowserSkipCode, number>>;
  /** The save stopped early; sessions committed before it and all older versions remain. */
  failure?: "browser_session_save_failed";
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

/** Binary units for limit copy, for example 512 KiB or 8 MiB. */
export function formatWorkspaceSecretLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

const browserLimit = formatWorkspaceSecretLimit(WORKSPACE_BROWSER_SESSION_MAX_BYTES);
const browserTotalLimit = formatWorkspaceSecretLimit(WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES);
/** Shared by settings, the guest guide and the model guidance. */
export const WORKSPACE_BROWSER_SESSION_LIMIT_TEXT =
  `Each browser session can be up to ${browserLimit}, with up to ${browserTotalLimit} across at most ${WORKSPACE_BROWSER_SESSION_MAX_COUNT} saved sessions.`;

export function workspaceSecretErrorMessage(code: unknown): string {
  switch (code) {
    case "workspace_secret_invalid": return "Check the name, value and file size. Environment names must be unique and use letters, digits and underscores.";
    case "workspace_secret_limit": return `Workspace secrets allow up to ${WORKSPACE_SECRET_MAX_COUNT} entries and ${formatWorkspaceSecretLimit(WORKSPACE_SECRET_TOTAL_MAX_BYTES)} in total, including up to ${formatWorkspaceSecretLimit(WORKSPACE_SECRET_ENV_MAX_BYTES)} of environment variables. Each file can be up to ${formatWorkspaceSecretLimit(WORKSPACE_SECRET_FILE_MAX_BYTES)}. ${WORKSPACE_BROWSER_SESSION_LIMIT_TEXT}`;
    case "workspace_browser_session_invalid": return `Choose a Playwright storage_state JSON file with cookies and origins, up to ${browserLimit}. Use a safe filename such as shop.example.json.`;
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
      typeof item.byteSize !== "number" || !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 ||
      item.byteSize > (item.kind === "browser_session" ? WORKSPACE_BROWSER_SESSION_MAX_BYTES : WORKSPACE_SECRET_VALUE_MAX_BYTES) ||
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

function reportCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000;
}

/** An unreadable report is shown as absent; it never fails the secrets list. */
export function decodeWorkspaceBrowserAutosaveReport(value: unknown): WorkspaceBrowserAutosaveReport | null {
  if (!record(value) || Object.keys(value).some((key) => !["saved", "unchanged", "skipped", "failure"].includes(key)) ||
    !reportCount(value.saved) || !reportCount(value.unchanged) || !record(value.skipped) ||
    !Object.entries(value.skipped).every(([code, total]) =>
      WORKSPACE_BROWSER_SKIP_CODES.includes(code as WorkspaceBrowserSkipCode) && reportCount(total)) ||
    !(value.failure === undefined || value.failure === "browser_session_save_failed")) return null;
  return value as WorkspaceBrowserAutosaveReport;
}

function counted(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

/** Exact, content-free copy for the latest browser autosave outcome. */
export function workspaceBrowserAutosaveMessage(report: WorkspaceBrowserAutosaveReport): Readonly<{ attention: boolean; text: string }> {
  const skipped = (code: WorkspaceBrowserSkipCode) => report.skipped[code] ?? 0;
  const kept = "any previously saved version was kept.";
  const parts = [`Last browser autosave: ${report.saved} saved, ${report.unchanged} unchanged.`];
  if (skipped("browser_session_too_large")) parts.push(`${counted(skipped("browser_session_too_large"), "session")} larger than ${browserLimit} skipped; ${kept}`);
  if (skipped("browser_session_total_limit")) parts.push(`${counted(skipped("browser_session_total_limit"), "session")} skipped because saved sessions would exceed ${browserTotalLimit} in total; ${kept}`);
  if (skipped("browser_session_limit")) parts.push(`${counted(skipped("browser_session_limit"), "session")} skipped because at most ${WORKSPACE_BROWSER_SESSION_MAX_COUNT} sessions can be saved; ${kept}`);
  if (skipped("browser_session_invalid")) parts.push(`${counted(skipped("browser_session_invalid"), "file")} skipped: not a Playwright storage_state JSON with a safe filename.`);
  if (skipped("browser_session_read_failed")) parts.push(`${counted(skipped("browser_session_read_failed"), "session")} could not be read from Workspace; ${kept}`);
  if (skipped("browser_session_stale")) parts.push(`${counted(skipped("browser_session_stale"), "session")} not saved because a newer save or a settings change took precedence.`);
  if (report.failure) parts.push("The autosave did not finish; sessions saved before it stopped and all other previous versions were kept.");
  const attention = report.failure !== undefined ||
    WORKSPACE_BROWSER_SKIP_CODES.some((code) => code !== "browser_session_stale" && skipped(code) > 0);
  return { attention, text: parts.join(" ") };
}
