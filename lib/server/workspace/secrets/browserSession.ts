import { createHash } from "node:crypto";
import {
  isWorkspaceBrowserSessionFilename, WORKSPACE_BROWSER_SESSION_MAX_BYTES,
  type WorkspaceBrowserAutosaveReport, type WorkspaceBrowserSkipCode
} from "@/lib/contracts/workspaceSecrets";

export { WORKSPACE_BROWSER_SKIP_CODES, type WorkspaceBrowserSkipCode } from "@/lib/contracts/workspaceSecrets";
export type WorkspaceBrowserSaveReport = WorkspaceBrowserAutosaveReport;

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

/**
 * When the guest browser wrote a session file (`aiqsa.savedAt`, Unix milliseconds,
 * `ops/workspace-guest/python/aiqsa/browser/_sessions.py`), or null for a file
 * without it: an upload in Settings or an older guest's.
 */
export function workspaceBrowserSessionSavedAt(bytes: Uint8Array): number | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const meta = record(value) ? value.aiqsa : undefined;
    const stamp = record(meta) ? meta.savedAt : undefined;
    return typeof stamp === "number" && Number.isSafeInteger(stamp) && stamp > 0 ? stamp : null;
  } catch { return null; }
}

export type WorkspaceBrowserSaveOrder = "write" | "unchanged" | "browser_session_stale";

/**
 * Whether a session file a run collected replaces the saved one.
 *
 * - A run accepted before the user's last change in Settings never writes (the
 *   manual fence).
 * - Equal bytes are unchanged, whichever run was accepted first.
 * - A file the guest stamped wins when it was written after the saved one:
 *   every run of a chat shares one VM and its files, so the run that saves last
 *   may hold what an earlier save already took plus newer writes, and a run
 *   accepted earlier but ending later (background sub-agents, wake-ups) must not
 *   lose them to acceptance order. A copy only restored and never rewritten
 *   keeps its old stamp and loses. Stamps come from the guest, so neither one
 *   counts later than the server's own time of its save (`createdAt`, `now`).
 * - A file without a stamp keeps acceptance order.
 */
export function workspaceBrowserSaveOrder(input: Readonly<{
  sequence: bigint;
  manualSequence: bigint;
  now: number;
  incoming: Readonly<{ checksum: string; savedAt: number | null }>;
  current: Readonly<{ checksum: string | null; writerSequence: bigint; createdAt: Date; savedAt: () => number | null }> | null;
}>): WorkspaceBrowserSaveOrder {
  if (input.sequence <= input.manualSequence) return "browser_session_stale";
  const current = input.current;
  if (!current) return "write";
  if (current.checksum === input.incoming.checksum) return "unchanged";
  if (input.incoming.savedAt === null) return input.sequence >= current.writerSequence ? "write" : "browser_session_stale";
  const saved = current.createdAt.getTime();
  const currentAt = Math.min(current.savedAt() ?? saved, saved);
  return Math.min(input.incoming.savedAt, input.now) > currentAt ? "write" : "browser_session_stale";
}
