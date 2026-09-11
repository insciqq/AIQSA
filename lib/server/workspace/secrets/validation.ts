import {
  isWorkspaceEnvName, isWorkspaceSecretId, WORKSPACE_SECRET_FILE_MAX_BYTES,
  WORKSPACE_SECRET_VALUE_MAX_BYTES, WORKSPACE_SECRET_ENV_MAX_BYTES, type WorkspaceSecretMutation, type WorkspaceSecretValue
} from "@/lib/contracts/workspaceSecrets";
import { workspaceBrowserSessionError } from "./browserSession";

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

export function parseWorkspaceSecretValue(value: unknown): WorkspaceSecretValue {
  let valid = false;
  if (record(value)) {
    switch (value.kind) {
      case "ssh_key":
        valid = keys(value, ["kind", "privateKey", "passphrase"]) && text(value.privateKey, 32 * 1024, true) && text(value.passphrase, 1024);
        break;
      case "text": valid = keys(value, ["kind", "text"]) && text(value.text, 256 * 1024, true); break;
      case "env":
        valid = keys(value, ["kind", "entries"]) && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 64 &&
          value.entries.every((entry) => record(entry) && keys(entry, ["name", "value"]) && isWorkspaceEnvName(entry.name) && text(entry.value, 16 * 1024)) &&
          new Set(value.entries.map((entry) => (entry as { name: string }).name)).size === value.entries.length;
        break;
      case "file":
      case "browser_session":
        valid = keys(value, ["kind", "originalName", "base64"]) && text(value.originalName, 255, true) &&
          !/[\u0000-\u001f\u007f/\\]/u.test(value.originalName) && typeof value.base64 === "string" &&
          value.base64.length <= Math.ceil(WORKSPACE_SECRET_FILE_MAX_BYTES / 3) * 4 &&
          Buffer.from(value.base64, "base64").toString("base64") === value.base64 &&
          Buffer.from(value.base64, "base64").byteLength <= WORKSPACE_SECRET_FILE_MAX_BYTES;
        if (value.kind === "browser_session" && (!valid || workspaceBrowserSessionError(value.originalName, Buffer.from(String(value.base64), "base64")))) {
          throw new WorkspaceSecretError("workspace_browser_session_invalid");
        }
        break;
    }
  }
  if (!valid || Buffer.byteLength(JSON.stringify(value), "utf8") > WORKSPACE_SECRET_VALUE_MAX_BYTES) {
    throw new WorkspaceSecretError("workspace_secret_invalid");
  }
  if ((value as WorkspaceSecretValue).kind === "env" && Buffer.byteLength(JSON.stringify(value), "utf8") > WORKSPACE_SECRET_ENV_MAX_BYTES) {
    throw new WorkspaceSecretError("workspace_secret_limit");
  }
  return value as WorkspaceSecretValue;
}

export function parseWorkspaceSecretMutation(value: unknown): WorkspaceSecretMutation {
  const invalid = () => { throw new WorkspaceSecretError("workspace_secret_invalid"); };
  if (!record(value)) return invalid();
  if (value.action === "delete") {
    if (!keys(value, ["action", "id", "expectedVersionId"]) || !isWorkspaceSecretId(value.id) || !isWorkspaceSecretId(value.expectedVersionId)) return invalid();
  } else {
    if (!text(value.name, 480, true) || value.name.length > 120 || !value.name.trim() || /[\u0000-\u001f\u007f]/u.test(value.name) ||
      !text(value.description, 8000) || value.description.length > 2000) return invalid();
    if (value.action === "create") {
      if (!keys(value, ["action", "name", "description", "value"])) return invalid();
      parseWorkspaceSecretValue(value.value);
    } else if (value.action === "update") {
      if (!keys(value, ["action", "id", "expectedVersionId", "name", "description", "value"]) ||
        !isWorkspaceSecretId(value.id) || !isWorkspaceSecretId(value.expectedVersionId) || !record(value.value)) return invalid();
      if (value.value.action === "preserve") {
        if (!keys(value.value, ["action"])) return invalid();
      } else if (value.value.action === "replace") {
        if (!keys(value.value, ["action", "content"])) return invalid();
        parseWorkspaceSecretValue(value.value.content);
      } else return invalid();
    } else return invalid();
  }
  return value as WorkspaceSecretMutation;
}
