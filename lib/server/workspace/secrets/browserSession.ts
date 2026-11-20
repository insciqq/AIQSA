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
 * How far a guest's clock may run ahead of the server's; a stamp later than that is no write time
 * (a clock gone wrong, or a file guest code wrote), so it never orders a save.
 */
export const WORKSPACE_BROWSER_STAMP_SKEW_MS = 5 * 60_000;

type SavedRevision = Readonly<{ checksum: string | null; savedAt: () => number | null }>;

/**
 * Whether a session file a run collected replaces the saved one.
 *
 * - A run accepted before the user's last change in Settings never writes (the
 *   manual fence).
 * - Equal bytes are unchanged, whichever run was accepted first.
 * - What this run was given at admission (`given`, its bound revision) and
 *   collects back unchanged, or with a stamp no later than that revision's, is
 *   no write of its own: it never replaces a revision saved since.
 * - Otherwise a file the guest stamped wins when it was written after the saved
 *   revision: every run of a chat shares one VM and its files, so a run accepted
 *   earlier but ending later (background sub-agents, wake-ups) keeps what its
 *   browser wrote last. The saved revision's time is its own stamp, or the
 *   server's time of its save when its stamp is missing or lies past that.
 * - A file without a stamp, or with one past the server's clock and its skew,
 *   keeps acceptance order: such a stamp is never re-dated to the time it is
 *   collected, so a stale file cannot become new again at each run's end.
 */
export function workspaceBrowserSaveOrder(input: Readonly<{
  sequence: bigint;
  manualSequence: bigint;
  now: number;
  incoming: Readonly<{ checksum: string; savedAt: number | null }>;
  current: Readonly<{ checksum: string | null; writerSequence: bigint; createdAt: Date; savedAt: () => number | null }> | null;
  given?: SavedRevision | null;
}>): WorkspaceBrowserSaveOrder {
  if (input.sequence <= input.manualSequence) return "browser_session_stale";
  const current = input.current;
  if (!current) return "write";
  if (current.checksum === input.incoming.checksum) return "unchanged";
  const given = input.given ?? null;
  if (given?.checksum === input.incoming.checksum) return "browser_session_stale";
  const stamp = input.incoming.savedAt !== null && input.incoming.savedAt <= input.now + WORKSPACE_BROWSER_STAMP_SKEW_MS
    ? input.incoming.savedAt : null;
  if (stamp === null) return input.sequence >= current.writerSequence ? "write" : "browser_session_stale";
  const givenAt = given?.savedAt() ?? null;
  if (givenAt !== null && stamp <= givenAt) return "browser_session_stale";
  const saved = current.createdAt.getTime();
  const currentStamp = current.savedAt();
  const currentAt = currentStamp !== null && currentStamp <= saved + WORKSPACE_BROWSER_STAMP_SKEW_MS ? currentStamp : saved;
  return stamp > currentAt ? "write" : "browser_session_stale";
}
