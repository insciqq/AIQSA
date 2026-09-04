import { createHash } from "node:crypto";
import {
  WORKSPACE_ACTIVITY_COMMAND_MAX_CHARS,
  WORKSPACE_ACTIVITY_PATH_MAX_CHARS,
  WORKSPACE_ACTIVITY_PREVIEW_MAX_BYTES,
  isWorkspaceErrorCode,
  type ThreadWorkspaceActivityEntry,
  type WorkspaceActivityKind,
  type WorkspaceActivityPhase,
  type WorkspaceErrorCode
} from "@/lib/contracts/workspace";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import {
  WORKSPACE_INBOX_DIRECTORY,
  WORKSPACE_ROOT,
  type WorkspaceMcpToolName
} from "@/lib/domain/workspace";
import type { ToolExecutionResult } from "@/lib/server/tools/types";

/**
 * Tool-specific, client-safe projection of Workspace activity. The browser
 * never receives raw arguments or results: commands become a bounded preview
 * plus a head+tail output excerpt, file operations become `/workspace`-relative
 * display paths, and long-lived executions collapse into one entry keyed by a
 * durable group id. Labels are the client's job (kind + phase).
 */

const FILE_TOOL_KINDS: Partial<Record<WorkspaceMcpToolName, WorkspaceActivityKind>> = {
  sandbox_fs_copy: "file_copy",
  sandbox_fs_exists: "file_check",
  sandbox_fs_list: "file_list",
  sandbox_fs_mkdir: "folder_create",
  sandbox_fs_read: "file_read",
  sandbox_fs_remove: "file_remove",
  sandbox_fs_rename: "file_move",
  sandbox_fs_stat: "file_check",
  sandbox_fs_write: "file_write"
};
const OUTPUT_BUFFER_MAX_BYTES = 64 * 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaque(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

export function workspaceActivityEntryId(callId: string): string {
  return `call:${opaque(callId)}`;
}

export function workspaceExecutionGroupId(runId: string, execSessionId: string): string {
  return `exec:${opaque(runId, execSessionId)}`;
}

export function workspaceLifecycleEntryId(
  runId: string,
  kind: WorkspaceActivityKind,
  ordinal = 0
): string {
  return `${kind}:${opaque(runId, String(ordinal))}`;
}

function cleanText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "");
}

/** Bounded, single-line command preview: the first non-empty line plus bounded args. */
export function commandPreview(input: Readonly<{
  args?: unknown;
  command: unknown;
}>): string | null {
  if (typeof input.command !== "string") return null;
  const firstLine = input.command.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  const args = Array.isArray(input.args)
    ? input.args.filter((entry): entry is string => typeof entry === "string").slice(0, 64)
    : [];
  const joined = [firstLine, ...args.map((entry) => /[\s"']/u.test(entry) ? JSON.stringify(entry) : entry)]
    .join(" ")
    .trim();
  const preview = cleanText(joined).slice(0, WORKSPACE_ACTIVITY_COMMAND_MAX_CHARS);
  return preview || null;
}

/** `/workspace`-relative display path; inbox physical names map back to originals when known. */
export function displayPath(
  value: unknown,
  inboxNames?: ReadonlyMap<string, string>
): string | null {
  if (typeof value !== "string" || !value) return null;
  const path = cleanText(value.replace(/\/{2,}/gu, "/").replace(/\/$/u, ""));
  const original = inboxNames?.get(path);
  if (original) return `inbox/${original}`.slice(0, WORKSPACE_ACTIVITY_PATH_MAX_CHARS);
  if (path === WORKSPACE_ROOT) return ".";
  const relative = path.startsWith(`${WORKSPACE_ROOT}/`) ? path.slice(WORKSPACE_ROOT.length + 1) : path;
  const inboxMessages = `${WORKSPACE_INBOX_DIRECTORY.slice(WORKSPACE_ROOT.length + 1)}/messages/`;
  if (relative.startsWith(inboxMessages) && relative.split("/").length >= 4) {
    // Unknown physical inbox name: drop the opaque id prefix, keep the safe basename.
    const basename = relative.split("/").at(-1) ?? relative;
    const dashed = basename.indexOf("--");
    return `inbox/${dashed > 0 ? basename.slice(dashed + 2) : basename}`
      .slice(0, WORKSPACE_ACTIVITY_PATH_MAX_CHARS);
  }
  return relative.slice(0, WORKSPACE_ACTIVITY_PATH_MAX_CHARS) || ".";
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Keeps `bytes` UTF-8 bytes from the head and tail of a string without splitting characters. */
function headTail(value: string, bytes: number): Readonly<{ text: string; truncated: boolean }> {
  if (utf8Bytes(value) <= bytes) return { text: value, truncated: false };
  if (bytes <= 0) return { text: "", truncated: true };
  const characters = [...value];
  const headBudget = Math.floor(bytes / 2);
  const tailBudget = bytes - headBudget;
  let head = "";
  let used = 0;
  for (const character of characters) {
    const size = utf8Bytes(character);
    if (used + size > headBudget) break;
    head += character;
    used += size;
  }
  let tail = "";
  used = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const size = utf8Bytes(characters[index]!);
    if (used + size > tailBudget) break;
    tail = characters[index] + tail;
    used += size;
  }
  return { text: `${head}\n…\n${tail}`, truncated: true };
}

/**
 * 8 KiB UTF-8 budget shared by stdout and stderr with head+tail retention.
 * A failed command gives stderr priority so its tail is what the reader sees.
 */
export function boundedOutputPreview(input: Readonly<{
  failed: boolean;
  stderr: string;
  stdout: string;
}>): Readonly<{ stderrPreview: string; stdoutPreview: string; truncated: boolean }> {
  const budget = WORKSPACE_ACTIVITY_PREVIEW_MAX_BYTES - 16;
  const stdout = cleanText(input.stdout);
  const stderr = cleanText(input.stderr);
  if (utf8Bytes(stdout) + utf8Bytes(stderr) <= budget) {
    return { stderrPreview: stderr, stdoutPreview: stdout, truncated: false };
  }
  const first = input.failed ? stderr : stdout;
  const second = input.failed ? stdout : stderr;
  const firstShare = Math.min(
    utf8Bytes(first),
    Math.max(Math.floor(budget * 0.75), budget - utf8Bytes(second))
  );
  const firstText = headTail(first, firstShare);
  const secondText = headTail(second, Math.max(0, budget - utf8Bytes(firstText.text)));
  return {
    stderrPreview: input.failed ? firstText.text : secondText.text,
    stdoutPreview: input.failed ? secondText.text : firstText.text,
    truncated: true
  };
}

function resultData(result: ToolExecutionResult): Record<string, unknown> | null {
  for (const entry of result.content) {
    if (entry.type === "json" && isRecord(entry.value)) return entry.value;
    if (entry.type !== "text" || typeof entry.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(entry.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not the official JSON envelope; nothing to project.
    }
  }
  return null;
}

function errorCodeFrom(result: ToolExecutionResult): WorkspaceErrorCode | undefined {
  const data = resultData(result);
  const code = data && isRecord(data.error) ? data.error.code : undefined;
  return isWorkspaceErrorCode(code) ? code : undefined;
}

export type ExecOutputBuffer = {
  done: boolean;
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

function emptyBuffer(): ExecOutputBuffer {
  return { done: false, exitCode: null, stderr: "", stdout: "" };
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  if (utf8Bytes(next) <= OUTPUT_BUFFER_MAX_BYTES) return next;
  const characters = [...next];
  let tail = "";
  let used = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const size = utf8Bytes(characters[index]!);
    if (used + size > OUTPUT_BUFFER_MAX_BYTES) break;
    tail = characters[index] + tail;
    used += size;
  }
  return tail;
}

/** Folds an official `sandbox_exec_poll` result into the execution's bounded buffer. */
export function applyExecPoll(buffer: ExecOutputBuffer, result: ToolExecutionResult): ExecOutputBuffer {
  const data = resultData(result);
  const payload = data && isRecord(data.data) ? data.data : null;
  if (!payload) return buffer;
  const next = { ...buffer };
  if (Array.isArray(payload.events)) {
    for (const entry of payload.events.slice(0, 1_000)) {
      const event = isRecord(entry) && isRecord(entry.event) ? entry.event : null;
      if (!event || typeof event.data !== "string") continue;
      if (event.kind === "stdout") next.stdout = appendBounded(next.stdout, event.data);
      if (event.kind === "stderr") next.stderr = appendBounded(next.stderr, event.data);
    }
  }
  if (payload.done === true) {
    next.done = true;
    const status = isRecord(payload.exitStatus) ? payload.exitStatus : null;
    next.exitCode = status && typeof status.code === "number" && Number.isSafeInteger(status.code)
      ? status.code
      : next.exitCode;
  }
  return next;
}

export type WorkspaceActivityProjectionInput = Readonly<{
  arguments: Record<string, unknown>;
  callId: string;
  durationMs?: number;
  execOutputs?: Map<string, ExecOutputBuffer>;
  inboxNames?: ReadonlyMap<string, string>;
  originalName: WorkspaceMcpToolName;
  result?: ToolExecutionResult;
  runId: string;
  startedAt?: Date;
}>;

function baseFields(input: WorkspaceActivityProjectionInput, id: string) {
  return {
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    id,
    ...(input.startedAt ? { startedAt: input.startedAt.toISOString() } : {})
  };
}

function commandEntry(
  input: WorkspaceActivityProjectionInput,
  phase: WorkspaceActivityPhase
): ThreadWorkspaceActivityEntry | null {
  const preview = commandPreview({ args: input.arguments.args, command: input.arguments.command });
  if (!preview) return null;
  const cwd = displayPath(input.arguments.cwd) ?? undefined;
  const base = { ...baseFields(input, workspaceActivityEntryId(input.callId)), kind: "command" as const };
  if (!input.result || phase === "running" || phase === "requested") {
    return { ...base, command: { ...(cwd ? { cwd } : {}), preview }, phase };
  }
  const data = resultData(input.result);
  const payload = data && isRecord(data.data) ? data.data : null;
  const rawExit = input.result.rawPreview?.exitCode;
  const exitCode = payload && typeof payload.exitCode === "number" && Number.isSafeInteger(payload.exitCode)
    ? payload.exitCode
    : typeof rawExit === "number" && Number.isSafeInteger(rawExit) ? rawExit : null;
  const failed = input.result.status === "error" || (exitCode !== null && exitCode !== 0);
  // A rejected call carries its actionable message in the official error
  // envelope; the reader sees it where stderr would be.
  const errorMessage = data && isRecord(data.error) && typeof data.error.message === "string"
    ? data.error.message
    : "";
  const output = boundedOutputPreview({
    failed,
    stderr: payload && typeof payload.stderr === "string" ? payload.stderr : errorMessage,
    stdout: payload && typeof payload.stdout === "string" ? payload.stdout : ""
  });
  const truncated = output.truncated || input.result.rawPreview?.truncated === true;
  const errorCode = errorCodeFrom(input.result);
  const originalByteCount = input.result.rawPreview?.originalByteCount;
  return {
    ...base,
    command: {
      ...(cwd ? { cwd } : {}),
      exitCode,
      ...(typeof originalByteCount === "number" && Number.isSafeInteger(originalByteCount)
        ? { originalByteCount }
        : {}),
      preview,
      ...(output.stderrPreview ? { stderrPreview: output.stderrPreview } : {}),
      ...(output.stdoutPreview ? { stdoutPreview: output.stdoutPreview } : {}),
      ...(truncated ? { truncated: true } : {})
    },
    ...(errorCode ? { errorCode } : {}),
    phase: failed ? "failed" : "succeeded"
  };
}

function fileEntry(
  input: WorkspaceActivityProjectionInput,
  kind: WorkspaceActivityKind,
  phase: WorkspaceActivityPhase
): ThreadWorkspaceActivityEntry | null {
  const source = displayPath(input.arguments.path ?? input.arguments.from, input.inboxNames);
  if (!source) return null;
  const target = kind === "file_copy" || kind === "file_move"
    ? displayPath(input.arguments.to, input.inboxNames) ?? undefined
    : undefined;
  const written = kind === "file_write" && typeof input.arguments.content === "string"
    ? input.arguments.encoding === "base64"
      ? Math.floor(input.arguments.content.replace(/=+$/u, "").length * 3 / 4)
      : utf8Bytes(input.arguments.content)
    : undefined;
  const settledPhase = input.result
    ? input.result.status === "error" ? "failed" : "succeeded"
    : phase;
  const errorCode = input.result ? errorCodeFrom(input.result) : undefined;
  return {
    ...baseFields(input, workspaceActivityEntryId(input.callId)),
    ...(errorCode ? { errorCode } : {}),
    file: {
      ...(written !== undefined ? { byteSize: written } : {}),
      displayPath: source,
      ...(target ? { targetPath: target } : {})
    },
    kind,
    phase: settledPhase
  };
}

function execSessionIdOf(input: WorkspaceActivityProjectionInput): string | null {
  if (typeof input.arguments.execSessionId === "string") return input.arguments.execSessionId;
  const data = input.result ? resultData(input.result) : null;
  const payload = data && isRecord(data.data) ? data.data : null;
  return payload && typeof payload.execSessionId === "string" ? payload.execSessionId : null;
}

/**
 * Entry for a tool call before it runs (`running`) or after it settled.
 * Returns null for calls that are not user-visible steps on their own
 * (`write_stdin`, and polls that add nothing new).
 */
export function projectWorkspaceActivity(
  input: WorkspaceActivityProjectionInput,
  phase: "running" | "settled"
): ThreadWorkspaceActivityEntry | null {
  const name = input.originalName;
  if (name === "sandbox_shell" || name === "sandbox_exec") {
    return commandEntry(input, phase === "running" ? "running" : "succeeded");
  }
  if (name === "sandbox_exec_start") {
    if (phase === "running" || !input.result || input.result.status === "error") {
      return commandEntry(input, phase === "running" ? "running" : "failed");
    }
    const execSessionId = execSessionIdOf(input);
    const preview = commandPreview({ args: input.arguments.args, command: input.arguments.command });
    if (!execSessionId || !preview) return null;
    const groupId = workspaceExecutionGroupId(input.runId, execSessionId);
    input.execOutputs?.set(groupId, emptyBuffer());
    const cwd = displayPath(input.arguments.cwd) ?? undefined;
    return {
      command: { ...(cwd ? { cwd } : {}), preview },
      groupId,
      id: groupId,
      kind: "command",
      phase: "running",
      ...(input.startedAt ? { startedAt: input.startedAt.toISOString() } : {})
    };
  }
  if (name === "sandbox_exec_poll" || name === "sandbox_exec_close" || name === "sandbox_exec_signal") {
    if (phase === "running" || !input.result) return null;
    const execSessionId = execSessionIdOf(input);
    if (!execSessionId) return null;
    const groupId = workspaceExecutionGroupId(input.runId, execSessionId);
    const previous = input.execOutputs?.get(groupId) ?? emptyBuffer();
    const buffer = name === "sandbox_exec_poll" ? applyExecPoll(previous, input.result) : previous;
    const closed = name === "sandbox_exec_close" && input.result.status === "complete";
    const signal = typeof input.arguments.signal === "string" ? input.arguments.signal.toLowerCase() : "";
    const terminated = name === "sandbox_exec_signal" && input.result.status === "complete" &&
      (signal === "kill" || signal === "term" || signal === "int");
    const settled = buffer.done || closed || terminated;
    input.execOutputs?.set(groupId, { ...buffer, done: settled });
    if (!settled && buffer.stdout === previous.stdout && buffer.stderr === previous.stderr) {
      // A poll that produced neither output nor completion is transport noise.
      return null;
    }
    const failed = buffer.done && buffer.exitCode !== null && buffer.exitCode !== 0;
    const output = boundedOutputPreview({ failed, stderr: buffer.stderr, stdout: buffer.stdout });
    return {
      command: {
        ...(buffer.done ? { exitCode: buffer.exitCode } : {}),
        preview: "…",
        ...(output.stderrPreview ? { stderrPreview: output.stderrPreview } : {}),
        ...(output.stdoutPreview ? { stdoutPreview: output.stdoutPreview } : {}),
        ...(output.truncated ? { truncated: true } : {})
      },
      groupId,
      id: groupId,
      kind: "command",
      phase: !settled ? "running" : failed ? "failed" : !buffer.done ? "cancelled" : "succeeded"
    };
  }
  if (name === "sandbox_exec_write_stdin") return null;
  const kind = FILE_TOOL_KINDS[name];
  return kind ? fileEntry(input, kind, phase === "running" ? "running" : "succeeded") : null;
}

/** Async group updates carry a placeholder preview; keep the command text from the start entry. */
export function mergeWorkspaceActivityEntry(
  previous: ThreadWorkspaceActivityEntry | undefined,
  next: ThreadWorkspaceActivityEntry
): ThreadWorkspaceActivityEntry {
  if (!previous || !next.command || next.command.preview !== "…") return next;
  return {
    ...next,
    command: {
      ...next.command,
      ...(previous.command?.cwd ? { cwd: previous.command.cwd } : {}),
      preview: previous.command?.preview ?? next.command.preview
    },
    ...(previous.startedAt && !next.startedAt ? { startedAt: previous.startedAt } : {})
  };
}

export type WorkspaceLifecycleKind = Extract<
  WorkspaceActivityKind,
  "attachments_prepare" | "outputs_export" | "workspace_recreated" | "workspace_start" | "workspace_stopped"
>;

export function workspaceLifecycleActivity(input: Readonly<{
  count?: number;
  durationMs?: number;
  errorCode?: WorkspaceErrorCode;
  kind: WorkspaceLifecycleKind;
  ordinal?: number;
  phase: WorkspaceActivityPhase;
  runId: string;
  startedAt?: Date;
}>): ThreadWorkspaceActivityEntry {
  return {
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    id: workspaceLifecycleEntryId(input.runId, input.kind, input.ordinal),
    kind: input.kind,
    phase: input.phase,
    ...(input.startedAt ? { startedAt: input.startedAt.toISOString() } : {})
  };
}

export function workspaceActivityEvent(entry: ThreadWorkspaceActivityEntry): ModelRunSseEvent {
  return { data: { artifactType: "workspace_activity", payload: entry }, type: "artifact" };
}

/**
 * Reload projection: replays persisted entries in order, keeps the latest
 * state per id (merging async chunks onto their start entry), and settles
 * entries a crashed or stopped run left `running`.
 */
export function foldWorkspaceActivityEntries(
  entries: readonly ThreadWorkspaceActivityEntry[],
  runTerminal: "cancelled" | "failed" | null
): ThreadWorkspaceActivityEntry[] {
  const byId = new Map<string, ThreadWorkspaceActivityEntry>();
  for (const entry of entries) {
    byId.set(entry.id, mergeWorkspaceActivityEntry(byId.get(entry.id), entry));
  }
  return [...byId.values()].map((entry) =>
    runTerminal && (entry.phase === "running" || entry.phase === "requested")
      ? { ...entry, phase: runTerminal === "cancelled" ? "cancelled" : "failed" }
      : entry
  );
}
