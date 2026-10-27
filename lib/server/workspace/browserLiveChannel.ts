import { WorkspaceRuntimeError, type WorkspaceBrowserLiveAction, type WorkspaceBrowserLiveReply, type WorkspaceBrowserLiveRequest } from "./runtime";

/**
 * The live browser channel between the application and the runner (`WorkspaceRuntime.browserLive`): the guest's
 * fixed streamer command, the bounds both sides check, and the reading of the pinned MCP's exec poll. The
 * streamer and its wire are in `ops/workspace-guest/python/aiqsa/browser/live.py` and `_live.py`.
 */

/** The streamer; the runner never runs another command on this channel. */
export const WORKSPACE_BROWSER_LIVE_COMMAND = Object.freeze({
  args: Object.freeze(["-I", "-m", "aiqsa.browser.live"]),
  command: "/opt/aiqsa-python/bin/python3"
});

export const WORKSPACE_BROWSER_LIVE_LIMITS = Object.freeze({
  /**
   * Output events one poll reads. The pinned MCP shares one result's data budget across them
   * (`execPollEventMaxBytes`), so its 4 KiB stdout chunks arrive whole up to about 28 (measurement 2026-10-26).
   */
  pollEvents: 28,
  /** Characters of the streamer's first stdin lines and of one write. */
  stdinChars: 64 * 1_024,
  /** A poll's reply on the wire to the application. */
  replyBytes: 1_024 * 1_024,
  /** One request to the runner; a poll answers within it, an empty one too. */
  requestTimeoutMs: 15_000,
  /** How long `close` waits for the streamer to end after its stdin closed, before it kills it. */
  closeGraceMs: 1_500
});

const EXEC_SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stdin(value: unknown): string {
  if (typeof value !== "string" || value.length > WORKSPACE_BROWSER_LIVE_LIMITS.stdinChars) throw new Error("field_invalid");
  return value;
}

function execSessionId(value: unknown): string {
  if (typeof value !== "string" || !EXEC_SESSION_ID.test(value)) throw new Error("field_invalid");
  return value;
}

/** The action part of a runner request body; identity and operation are checked by the route itself. */
export function parseBrowserLiveAction(body: Record<string, unknown>): WorkspaceBrowserLiveAction {
  switch (body.action) {
    case "start":
      return { action: "start", stdin: stdin(body.stdin) };
    case "poll": {
      const cursor = body.cursor;
      if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("field_invalid");
      return { action: "poll", cursor, execSessionId: execSessionId(body.execSessionId) };
    }
    case "write":
      return { action: "write", data: stdin(body.data), execSessionId: execSessionId(body.execSessionId) };
    case "close":
      return { action: "close", execSessionId: execSessionId(body.execSessionId) };
    default:
      throw new Error("field_invalid");
  }
}

/** The data of the pinned MCP's JSON envelope (`{ok, data}`), or null for a failure or anything else. */
export function browserLiveMcpData(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) return null;
  for (const item of result.content) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data)) {
        return { ...parsed.data, ...(parsed.truncated ? { truncated: true } : {}) };
      }
    } catch {
      // Not the envelope.
    }
  }
  return null;
}

/** A poll's events as the application reads them: stdout only, in order; stderr is never relayed. */
export function browserLivePollReply(data: Record<string, unknown>, cursor: number): Extract<WorkspaceBrowserLiveReply, { action: "poll" }> {
  const events = Array.isArray(data.events) ? data.events : null;
  const nextCursor = data.nextCursor;
  if (!events || typeof nextCursor !== "number" || !Number.isSafeInteger(nextCursor) || nextCursor < cursor) {
    throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }
  const chunks: string[] = [];
  for (const entry of events) {
    const event = isRecord(entry) && isRecord(entry.event) ? entry.event : null;
    if (event?.kind === "stdout" && typeof event.data === "string") chunks.push(event.data);
  }
  return { action: "poll", chunks, done: data.done === true, nextCursor, truncated: data.truncated === true };
}

/** The runner's reply, checked by the application before it reads it. */
export function parseBrowserLiveReply(action: WorkspaceBrowserLiveRequest["action"], value: unknown): WorkspaceBrowserLiveReply {
  if (!isRecord(value) || value.action !== action) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  switch (action) {
    case "start":
      if (typeof value.execSessionId !== "string" || !EXEC_SESSION_ID.test(value.execSessionId)) break;
      return { action, execSessionId: value.execSessionId };
    case "poll": {
      const chunks = value.chunks;
      if (!Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === "string") || typeof value.done !== "boolean" ||
        typeof value.truncated !== "boolean" || typeof value.nextCursor !== "number" || !Number.isSafeInteger(value.nextCursor) ||
        value.nextCursor < 0) break;
      return { action, chunks: chunks as string[], done: value.done, nextCursor: value.nextCursor, truncated: value.truncated };
    }
    case "write":
      return { action };
    case "close":
      if (typeof value.exited !== "boolean") break;
      return { action, exited: value.exited };
  }
  throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
}
