import {
  isWorkspaceEnvName, isWorkspaceSavedEnvName, isWorkspaceSecretId, WORKSPACE_SECRET_FILE_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_BYTES,
  WORKSPACE_BROWSER_SESSION_VALUE_MAX_BYTES, WORKSPACE_SECRET_VALUE_MAX_BYTES, WORKSPACE_SECRET_ENV_MAX_BYTES,
  type WorkspaceSecretMutation, type WorkspaceSecretRevealRequest, type WorkspaceSecretValue
} from "@/lib/contracts/workspaceSecrets";
import { workspaceBrowserSessionError } from "./browserSession";

/**
 * One settings mutation: the largest value (a browser session) plus id, name
 * and a description whose control characters JSON escapes up to six times.
 */
export const WORKSPACE_SECRET_MUTATION_MAX_BYTES = WORKSPACE_BROWSER_SESSION_VALUE_MAX_BYTES + 64 * 1024;

export class WorkspaceSecretError extends Error {
  constructor(readonly code: import("@/lib/contracts/workspaceSecrets").WorkspaceSecretErrorCode) {
    super(code);
    this.name = "WorkspaceSecretError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, maxBytes: number, nonempty = false): value is string {
  return typeof value === "string" && (!nonempty || value.length > 0) &&
    Buffer.byteLength(value, "utf8") <= maxBytes && !value.includes("\0") &&
    Buffer.from(value, "utf8").toString("utf8") === value;
}

/**
 * A secret value in the shape AIQSA stores. A value being saved may not use the reserved environment names
 * (`isWorkspaceSavedEnvName`); a stored one is read as it was saved, so an older secret keeps loading.
 */
export function parseWorkspaceSecretValue(value: unknown, purpose: "save" | "stored" = "save"): WorkspaceSecretValue {
  const envName = purpose === "save" ? isWorkspaceSavedEnvName : isWorkspaceEnvName;
  let valid = false;
  if (record(value)) {
    switch (value.kind) {
      case "ssh_key":
        valid = keys(value, ["kind", "privateKey", "passphrase"]) && text(value.privateKey, 32 * 1024, true) && text(value.passphrase, 1024);
        break;
      case "text": valid = keys(value, ["kind", "text"]) && text(value.text, 256 * 1024, true); break;
      case "env":
        valid = keys(value, ["kind", "entries"]) && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 64 &&
          value.entries.every((entry) => record(entry) && keys(entry, ["name", "value"]) && envName(entry.name) && text(entry.value, 16 * 1024)) &&
          new Set(value.entries.map((entry) => (entry as { name: string }).name)).size === value.entries.length;
        break;
      case "file":
      case "browser_session": {
        const maxBytes = value.kind === "browser_session" ? WORKSPACE_BROWSER_SESSION_MAX_BYTES : WORKSPACE_SECRET_FILE_MAX_BYTES;
        const bytes = typeof value.base64 === "string" && value.base64.length <= Math.ceil(maxBytes / 3) * 4
          ? Buffer.from(value.base64, "base64") : null;
        valid = keys(value, ["kind", "originalName", "base64"]) && text(value.originalName, 255, true) &&
          !/[\u0000-\u001f\u007f/\\]/u.test(value.originalName) && bytes !== null &&
          bytes.toString("base64") === value.base64 && bytes.byteLength <= maxBytes;
        if (value.kind === "browser_session" && (!valid || workspaceBrowserSessionError(value.originalName, bytes!))) {
          throw new WorkspaceSecretError("workspace_browser_session_invalid");
        }
        break;
      }
    }
  }
  if (!valid || Buffer.byteLength(JSON.stringify(value), "utf8") > ((value as WorkspaceSecretValue).kind === "browser_session"
    ? WORKSPACE_BROWSER_SESSION_VALUE_MAX_BYTES : WORKSPACE_SECRET_VALUE_MAX_BYTES)) {
    throw new WorkspaceSecretError("workspace_secret_invalid");
  }
  if ((value as WorkspaceSecretValue).kind === "env" && Buffer.byteLength(JSON.stringify(value), "utf8") > WORKSPACE_SECRET_ENV_MAX_BYTES) {
    throw new WorkspaceSecretError("workspace_secret_limit");
  }
  return value as WorkspaceSecretValue;
}

/** A settings mutation; `stored` reads an accepted revision as it was saved (`parseWorkspaceSecretValue`). */
export function parseWorkspaceSecretMutation(value: unknown, purpose: "save" | "stored" = "save"): WorkspaceSecretMutation {
  const invalid = () => { throw new WorkspaceSecretError("workspace_secret_invalid"); };
  if (!record(value)) return invalid();
  if (value.action === "delete") {
    if (!keys(value, ["action", "id", "expectedVersionId"]) || !isWorkspaceSecretId(value.id) || !isWorkspaceSecretId(value.expectedVersionId)) return invalid();
  } else {
    if (!text(value.name, 480, true) || value.name.length > 120 || !value.name.trim() || /[\u0000-\u001f\u007f]/u.test(value.name) ||
      !text(value.description, 8000) || value.description.length > 2000) return invalid();
    if (value.action === "create") {
      if (!keys(value, ["action", "name", "description", "value"])) return invalid();
      parseWorkspaceSecretValue(value.value, purpose);
    } else if (value.action === "update") {
      if (!keys(value, ["action", "id", "expectedVersionId", "name", "description", "value"]) ||
        !isWorkspaceSecretId(value.id) || !isWorkspaceSecretId(value.expectedVersionId) || !record(value.value)) return invalid();
      if (value.value.action === "preserve") {
        if (!keys(value.value, ["action"])) return invalid();
      } else if (value.value.action === "replace") {
        if (!keys(value.value, ["action", "content"])) return invalid();
        parseWorkspaceSecretValue(value.value.content, purpose);
      } else return invalid();
    } else return invalid();
  }
  return value as WorkspaceSecretMutation;
}

/** A reveal request, or null when the body asks for something else; a malformed reveal is invalid. */
export function parseWorkspaceSecretReveal(value: unknown): WorkspaceSecretRevealRequest | null {
  if (!record(value) || value.action !== "reveal") return null;
  if (!keys(value, ["action", "id"]) || !isWorkspaceSecretId(value.id)) throw new WorkspaceSecretError("workspace_secret_invalid");
  return value as WorkspaceSecretRevealRequest;
}
