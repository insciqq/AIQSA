import { createHash } from "node:crypto";
import { isWorkspaceBrowserSessionFilename, WORKSPACE_BROWSER_SESSION_MAX_BYTES } from "@/lib/contracts/workspaceSecrets";

export const WORKSPACE_BROWSER_SKIP_CODES = [
  "browser_session_invalid", "browser_session_too_large", "browser_session_limit",
  "browser_session_stale", "browser_session_read_failed"
] as const;
export type WorkspaceBrowserSkipCode = (typeof WORKSPACE_BROWSER_SKIP_CODES)[number];
export type WorkspaceBrowserSaveReport = Readonly<{
  saved: number;
  unchanged: number;
  skipped: Partial<Record<WorkspaceBrowserSkipCode, number>>;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate portable storage_state data without normalizing its original bytes. */
export function workspaceBrowserSessionError(fileName: unknown, bytes: Uint8Array): WorkspaceBrowserSkipCode | null {
  if (bytes.byteLength > WORKSPACE_BROWSER_SESSION_MAX_BYTES) return "browser_session_too_large";
  if (!isWorkspaceBrowserSessionFilename(fileName) || bytes.byteLength === 0) return "browser_session_invalid";
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return "browser_session_invalid";
    for (const cookie of value.cookies) {
      if (!record(cookie) || !["name", "value", "domain", "path"].every((field) => typeof cookie[field] === "string") ||
        typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || typeof cookie.httpOnly !== "boolean" ||
        typeof cookie.secure !== "boolean" || !["Strict", "Lax", "None"].includes(String(cookie.sameSite))) return "browser_session_invalid";
    }
    for (const origin of value.origins) {
      if (!record(origin) || typeof origin.origin !== "string" || !Array.isArray(origin.localStorage) ||
        !origin.localStorage.every((item) => record(item) && typeof item.name === "string" && typeof item.value === "string")) return "browser_session_invalid";
      const url = new URL(origin.origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.origin) return "browser_session_invalid";
    }
    return null;
  } catch { return "browser_session_invalid"; }
}

export function workspaceBrowserSessionChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
