/*
 * `apply_patch`: edits Workspace text files with Codex's patch format.
 *
 * The tool contract follows OpenAI Codex's apply_patch tool instructions
 * (codex-rs/prompts/templates/apply_patch_tool_instructions.md, commit
 * ba2b67f9cda954bcdda43c2a65ac58e807b996bd). Copyright 2025 OpenAI, Apache
 * License 2.0 (lib/server/engine/prompts/THIRD_PARTY_NOTICES.txt).
 *
 * Changes by AIQSA: paths resolve inside the Workspace directories; Add File
 * refuses an existing file and a move refuses an existing destination; every
 * file is read and every hunk matched before anything is written; files are
 * read and written through the Workspace's own file and command tools.
 */
import { posix } from "node:path";
import {
  WORKSPACE_INBOX_DIRECTORY,
  WORKSPACE_OUTPUT_DIRECTORY,
  WORKSPACE_PROJECT_DIRECTORY,
  WORKSPACE_TEMP_DIRECTORY,
  type WorkspaceMcpToolName
} from "@/lib/domain/workspace";
import { WORKSPACE_SECRETS_GUIDE_PATH, WORKSPACE_SECRETS_PATH } from "@/lib/contracts/workspaceSecrets";
import { ApplyPatchError, applyChunks, parsePatch, type PatchHunk } from "./applyPatchFormat";
import { harnessToolError, type HarnessToolDescriptor } from "./harnessTool";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionResult } from "./types";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export const APPLY_PATCH_LIMITS = Object.freeze({
  /** UTF-8 bytes of one patch. */
  patchBytes: 512 * 1_024,
  /** File sections in one patch. */
  files: 64
});

const WRITABLE_ROOTS = [WORKSPACE_PROJECT_DIRECTORY, WORKSPACE_OUTPUT_DIRECTORY, WORKSPACE_TEMP_DIRECTORY] as const;

const DESCRIPTION = `Edit text files in this chat's Workspace with a patch. Starts the Workspace if it is not running.

The patch is a stripped-down, file-oriented diff:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Each file section starts with one of these headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents). Fails if the file exists.
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place, optionally followed by "*** Move to: <new path>" to rename it.

An update has one or more hunks, each introduced by @@ (optionally "@@ <line to find>"). Within a hunk each line starts with " " (unchanged context), "-" (removed) or "+" (added):
- Show 3 lines of context immediately above and below each change. If a change is within 3 lines of a previous one, do not repeat the shared context lines.
- If 3 lines of context do not identify the place uniquely, add "@@ <a line before it>", for example "@@ class BaseClass" or "@@ def method():"; several @@ lines narrow it further.
- Hunks apply in file order. "*** End of File" after a hunk anchors it to the end of the file.

Example:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Rules:
- Every section needs its header; prefix every new line with + even when creating a file.
- Paths are relative to ${WORKSPACE_PROJECT_DIRECTORY}, or absolute inside ${WRITABLE_ROOTS.join(", ")}. Attachments in ${WORKSPACE_INBOX_DIRECTORY} and managed secrets are read-only: copy a file into the project to change it.
- Only UTF-8 text files the Workspace can return whole can be updated; create or change binary and very large files with code.
- All sections are checked before anything is written: if one fails, no file changes, and the error names the patch line and what was expected. Fix the patch and send it again; do not re-read files after a successful patch.
- Result: "Success." with one line per file: A (added), M (modified or moved), D (deleted).`;

const INPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    input: { description: "The entire patch, from '*** Begin Patch' to '*** End Patch'.", type: "string" }
  },
  required: ["input"],
  type: "object"
};

export const applyPatchTool: HarnessToolDescriptor = Object.freeze({
  description: DESCRIPTION,
  effects: "local",
  inputSchema: INPUT_SCHEMA,
  name: APPLY_PATCH_TOOL_NAME,
  needsApproval: false,
  requiresVm: true,
  tool: Object.freeze({ capability: "workspace", description: DESCRIPTION, inputSchema: INPUT_SCHEMA, name: APPLY_PATCH_TOOL_NAME, strict: true })
});

export type WorkspaceTextFile = Readonly<{ kind: "file"; content: string }> | Readonly<{ kind: "missing" }>;

/** The Workspace file operations `apply_patch` needs; they run inside the guest. */
export type ApplyPatchFiles = Readonly<{
  read(path: string, signal?: AbortSignal): Promise<WorkspaceTextFile>;
  write(path: string, content: string, signal?: AbortSignal): Promise<void>;
  remove(path: string, signal?: AbortSignal): Promise<void>;
}>;

/** A Workspace file operation failed; the message is actionable and names the path. */
export class ApplyPatchFileError extends Error {
  override name = "ApplyPatchFileError";
  constructor(readonly code: "apply_patch_file_too_large" | "apply_patch_file_unreadable" | "apply_patch_workspace_failed", message: string) {
    super(message);
  }
}

/** An absolute guest path inside the writable Workspace directories, or the reason it is refused. */
export function resolveApplyPatchPath(raw: string): string {
  if (raw.includes("\0")) throw new ApplyPatchError("apply_patch_invalid", `Path ${JSON.stringify(raw)} contains a NUL character.`);
  const resolved = posix.normalize(raw.startsWith("/") ? raw : posix.join(WORKSPACE_PROJECT_DIRECTORY, raw));
  if (raw.endsWith("/") || resolved.endsWith("/")) {
    throw new ApplyPatchError("apply_patch_invalid", `Path ${JSON.stringify(raw)} names a directory; name a file.`);
  }
  if (WRITABLE_ROOTS.some((root) => resolved.startsWith(`${root}/`))) return resolved;
  const under = (root: string) => resolved === root || resolved.startsWith(`${root}/`);
  if (under(WORKSPACE_INBOX_DIRECTORY)) {
    throw new ApplyPatchError("apply_patch_invalid", `${resolved} is an original attachment and read-only. Copy it into ${WORKSPACE_PROJECT_DIRECTORY} and patch the copy.`);
  }
  if (under(WORKSPACE_SECRETS_PATH) || resolved === WORKSPACE_SECRETS_GUIDE_PATH) {
    throw new ApplyPatchError("apply_patch_invalid", `${resolved} is managed by AIQSA from the user's saved secrets and cannot be patched.`);
  }
  throw new ApplyPatchError("apply_patch_invalid", `Path ${JSON.stringify(raw)} resolves to ${resolved}, outside the directories apply_patch edits (${WRITABLE_ROOTS.join(", ")}). Use a path relative to ${WORKSPACE_PROJECT_DIRECTORY}.`);
}

type Change = Readonly<{ label: string; op: "A" | "D" | "M" }>;

function resolveHunk(hunk: PatchHunk): Readonly<{ hunk: PatchHunk; path: string; movePath?: string }> {
  try {
    const path = resolveApplyPatchPath(hunk.path);
    const movePath = hunk.kind === "update" && hunk.movePath ? resolveApplyPatchPath(hunk.movePath) : undefined;
    return { hunk, path, ...(movePath && movePath !== path ? { movePath } : {}) };
  } catch (error) {
    if (error instanceof ApplyPatchError) throw new ApplyPatchError(error.code, `Patch line ${hunk.line}: ${error.message}`);
    throw error;
  }
}

/**
 * Applies one patch. Every file is read and every hunk matched first; only a
 * patch that applies completely is written. A write failure reports which
 * files changed, so the model never repeats a partly applied patch blindly.
 */
export async function executeApplyPatch(files: ApplyPatchFiles, call: ModelToolCall,
  options: { signal?: AbortSignal } = {}): Promise<ToolExecutionResult> {
  const { signal } = options;
  const input = call.arguments.input;
  if (hasInvalidProviderToolArguments(call.arguments) || typeof input !== "string" || !input.trim()) {
    return harnessToolError(call, "apply_patch_invalid", "Pass the whole patch as the string argument `input`, from '*** Begin Patch' to '*** End Patch'.");
  }
  if (Buffer.byteLength(input, "utf8") > APPLY_PATCH_LIMITS.patchBytes) {
    return harnessToolError(call, "apply_patch_too_large", `The patch exceeds ${APPLY_PATCH_LIMITS.patchBytes} bytes. Split it into several smaller patches.`);
  }
  const originals = new Map<string, string | null>();
  const state = new Map<string, string | null>();
  const changes: Change[] = [];
  try {
    const hunks = parsePatch(input);
    if (hunks.length > APPLY_PATCH_LIMITS.files) {
      return harnessToolError(call, "apply_patch_too_large", `The patch has ${hunks.length} file sections; the limit is ${APPLY_PATCH_LIMITS.files}. Split it into several patches.`);
    }
    const resolved = hunks.map(resolveHunk);
    const current = async (path: string): Promise<string | null> => {
      if (state.has(path)) return state.get(path)!;
      signal?.throwIfAborted();
      const file = await files.read(path, signal);
      const content = file.kind === "file" ? file.content : null;
      originals.set(path, content);
      state.set(path, content);
      return content;
    };
    for (const { hunk, path, movePath } of resolved) {
      const existing = await current(path);
      const at = `Patch line ${hunk.line}`;
      if (hunk.kind === "add") {
        if (existing !== null) {
          throw new ApplyPatchError("apply_patch_mismatch", `${at}: ${path} already exists. Use '*** Update File: ${hunk.path}' to change it, or delete it first in the same patch to replace it.`);
        }
        state.set(path, hunk.contents);
        changes.push({ label: path, op: "A" });
        continue;
      }
      if (existing === null) {
        throw new ApplyPatchError("apply_patch_mismatch", `${at}: ${path} does not exist.${hunk.kind === "update" ? ` Use '*** Add File: ${hunk.path}' to create it.` : ""}`);
      }
      if (hunk.kind === "delete") {
        state.set(path, null);
        changes.push({ label: path, op: "D" });
        continue;
      }
      const next = hunk.chunks.length ? applyChunks(existing, hunk.chunks, path) : existing;
      if (movePath) {
        if (await current(movePath) !== null) {
          throw new ApplyPatchError("apply_patch_mismatch", `${at}: cannot move ${path} to ${movePath} because ${movePath} already exists.`);
        }
        state.set(movePath, next);
        state.set(path, null);
        changes.push({ label: `${path} -> ${movePath}`, op: "M" });
      } else {
        state.set(path, next);
        changes.push({ label: path, op: "M" });
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ApplyPatchError || error instanceof ApplyPatchFileError) {
      return harnessToolError(call, error.code, `${error.message} No file was changed.`);
    }
    throw error;
  }
  // Writes in the order files were first named; removals after the writes of a move.
  const writes = [...state].filter(([path, content]) => content !== null && content !== originals.get(path));
  const removals = [...state].filter(([path, content]) => content === null && originals.get(path) !== null);
  const done: string[] = [];
  for (const [path, content] of [...writes, ...removals]) {
    try {
      signal?.throwIfAborted();
      if (content === null) await files.remove(path, signal);
      else await files.write(path, content, signal);
      done.push(path);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const pending = [...writes, ...removals].map(([name]) => name).filter((name) => name !== path && !done.includes(name));
      const message = error instanceof ApplyPatchFileError ? error.message : `Writing ${path} failed.`;
      return harnessToolError(call, "apply_patch_partially_applied",
        `${message} The patch was applied only partly: changed ${done.length ? done.join(", ") : "no file"}; not changed ${[path, ...pending].join(", ")}. Read the files that were not changed before patching them again.`,
        { changed: done, unchanged: [path, ...pending] });
    }
  }
  return {
    callId: call.id,
    content: [{ text: `Success. Updated the following files:\n${changes.map((change) => `${change.op} ${change.label}`).join("\n")}`, type: "text" }],
    name: call.name,
    status: "complete"
  };
}

/** One Workspace tool call by its original name, as the engine registry dispatches it. */
export type WorkspaceToolCaller = (name: WorkspaceMcpToolName, args: Record<string, unknown>,
  signal?: AbortSignal) => Promise<ToolExecutionResult>;

type Envelope = Readonly<{ data?: unknown; error?: { message?: unknown }; ok?: unknown; truncated?: unknown }>;

function envelope(result: ToolExecutionResult): Envelope | null {
  for (const entry of result.content) {
    const value = entry.type === "text" ? (() => { try { return JSON.parse(entry.text) as unknown; } catch { return null; } })()
      : entry.type === "json" ? entry.value : null;
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "ok" in value) return value as Envelope;
  }
  return null;
}

function failure(result: ToolExecutionResult): string {
  const body = envelope(result);
  if (body && typeof body.error?.message === "string") return body.error.message;
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? text.text.slice(0, 500) : "The Workspace operation failed.";
}

async function data(call: WorkspaceToolCaller, name: WorkspaceMcpToolName, args: Record<string, unknown>, path: string,
  signal?: AbortSignal): Promise<Readonly<{ body: Envelope; result: ToolExecutionResult }>> {
  const result = await call(name, args, signal);
  const body = envelope(result);
  if (result.status !== "complete" || !body || body.ok !== true) {
    throw new ApplyPatchFileError("apply_patch_workspace_failed", `${path}: ${failure(result)}`);
  }
  return { body, result };
}

async function exists(call: WorkspaceToolCaller, path: string, signal?: AbortSignal): Promise<boolean> {
  const { body } = await data(call, "sandbox_fs_exists", { path }, path, signal);
  const value = (body.data as { exists?: unknown } | undefined)?.exists;
  if (typeof value !== "boolean") throw new ApplyPatchFileError("apply_patch_workspace_failed", `${path}: the Workspace did not report whether the file exists.`);
  return value;
}

/** `apply_patch` file operations over the Workspace's own file and command tools. */
export function workspaceApplyPatchFiles(call: WorkspaceToolCaller): ApplyPatchFiles {
  return {
    async read(path, signal) {
      if (!await exists(call, path, signal)) return { kind: "missing" };
      const { body, result } = await data(call, "sandbox_fs_read", { encoding: "utf8", path }, path, signal);
      if (body.truncated !== undefined || result.rawPreview?.truncated === true) {
        throw new ApplyPatchFileError("apply_patch_file_too_large", `${path} is larger than the Workspace returns in one read. Change it with a script instead.`);
      }
      const content = (body.data as { content?: unknown } | undefined)?.content;
      if (typeof content !== "string") throw new ApplyPatchFileError("apply_patch_file_unreadable", `${path} could not be read as text.`);
      if (content.includes("\0") || content.includes("�")) {
        throw new ApplyPatchFileError("apply_patch_file_unreadable", `${path} is not a UTF-8 text file. Change it with a script instead.`);
      }
      return { content, kind: "file" };
    },
    async remove(path, signal) {
      await data(call, "sandbox_fs_remove", { kind: "file", path }, path, signal);
    },
    async write(path, content, signal) {
      const parent = posix.dirname(path);
      if (!await exists(call, parent, signal)) {
        const { body } = await data(call, "sandbox_exec", { args: ["-p", "--", parent], command: "mkdir" }, parent, signal);
        const exitCode = (body.data as { exitCode?: unknown } | undefined)?.exitCode;
        if (exitCode !== 0) throw new ApplyPatchFileError("apply_patch_workspace_failed", `${parent}: the directory could not be created.`);
      }
      await data(call, "sandbox_fs_write", { content, encoding: "utf8", path }, path, signal);
    }
  };
}
