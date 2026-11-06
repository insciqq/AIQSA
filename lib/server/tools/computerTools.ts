import type { z } from "zod";
import {
  COMPUTER_TOOL_NAMES,
  COMPUTER_TOOL_OPS,
  computerActivitySummary,
  isComputerExitCode,
  isComputerToolName,
  type ComputerFailureCode,
  type ComputerToolName
} from "@/lib/contracts/computer";
import {
  CONNECT_DEFAULT_READ_LINES,
  CONNECT_DEFAULT_SHELL_TIMEOUT_SECONDS,
  CONNECT_MAX_COMMAND_BYTES,
  CONNECT_MAX_GREP_CONTEXT,
  CONNECT_MAX_JOB_WAIT_SECONDS,
  CONNECT_MAX_OP_DEADLINE_MS,
  CONNECT_MAX_PATTERN_LENGTH,
  CONNECT_MAX_READ_LINES,
  CONNECT_MAX_SHELL_TIMEOUT_SECONDS,
  CONNECT_MAX_WRITE_BYTES,
  CONNECT_OUTPUT_HEAD_BYTES,
  CONNECT_OUTPUT_TAIL_BYTES,
  CONNECT_MAX_CWD_LENGTH,
  connectOpArgsSchemas,
  parseConnectOpResult,
  type ConnectOp,
  type ConnectOpArgs,
  type ConnectOpResult,
  type ConnectOs
} from "@/lib/contracts/connect";
import type { EngineTool } from "../engine/toolRegistry";
import { getComputerOps, type ComputerOps, type ComputerOpOutcome } from "../connect/computerPort";
import { computerOsLabel, type FrozenComputerBinding } from "./computerBinding";
import type { HarnessToolEffects } from "./harnessTool";
import { hasInvalidProviderToolArguments, type ModelToolCall, type RunTool, type ToolExecutionResult } from "./types";

/**
 * The agent's tools on the user's computer (AIQSA Connect, §6–§7 of the
 * computer PRD): eight native tools of capability `computer`, offered only to a
 * run admitted with a computer binding (`computerBinding.ts`), its sub-agents
 * with every tool included (D-07). Each call goes through the port
 * (`getComputerOps`) with the run's id, the frozen device and folder, a
 * timeout bounded by the turn's tool time and the call's signal.
 *
 * Effects (D-05): reading tools are `none`, so a call the device may have
 * started and that failed on the way is tried again by the batch; the others
 * are `external`, so such a call keeps an unknown outcome and an equivalent
 * one waits for the user (`lib/server/engine/unknownEffects.ts`). A failure
 * nothing was sent for, or one the device answered with a definite code, is
 * an ordinary error result.
 */

export const COMPUTER_TOOL_LIMITS = Object.freeze({
  /** Every tool but `computer_shell` (§7). */
  callMs: 60_000,
  /** Room beyond a command's own `timeoutSeconds` for its reply to arrive. */
  shellReplyMs: 15_000,
  /** The engine's own backstop beyond the port's timeout, should a reply never come. */
  graceMs: 5_000,
  /** The least time a call that may still start is given. */
  minCallMs: 1_000,
  /** Room `computer_job_output` leaves after its wait for the reply. */
  jobReplyMs: 5_000
});

/** What each tool may do (D-05). */
export const COMPUTER_TOOL_EFFECTS: Readonly<Record<ComputerToolName, Exclude<HarnessToolEffects, "local">>> = Object.freeze({
  computer_edit: "external",
  computer_glob: "none",
  computer_grep: "none",
  computer_job_output: "none",
  computer_job_stop: "external",
  computer_read: "none",
  computer_shell: "external",
  computer_write: "external"
});

/** The longest one call of the tool may take (`toolCallBounds`): a command's longest timeout and its reply, else a minute. */
export function computerToolCallMs(name: string): number {
  return name === "computer_shell"
    ? CONNECT_MAX_SHELL_TIMEOUT_SECONDS * 1_000 + COMPUTER_TOOL_LIMITS.shellReplyMs
    : COMPUTER_TOOL_LIMITS.callMs;
}

// Definitions. Descriptions depend only on the frozen binding's OS, never on whether the computer is online (D-08).

const PATH_TEXT = "absolute, starting with ~, or relative to the chat's working folder";
const string = (description: string, maxLength: number) => ({ description, maxLength, type: "string" });
const nullable = (type: "boolean" | "integer" | "string", description: string, bounds: Record<string, number> = {}) =>
  ({ description, ...bounds, type: [type, "null"] });

function schema(properties: Record<string, unknown>): Record<string, unknown> {
  return { additionalProperties: false, properties, required: Object.keys(properties), type: "object" };
}

function shellDescription(os: ConnectOs): string {
  const shell = os === "windows"
    ? "Runs a command in PowerShell on the user's Windows computer, with the user's own permissions: PowerShell 7 (pwsh) " +
      "when it is installed, otherwise Windows PowerShell 5.1. Write PowerShell, not cmd or bash (Get-ChildItem, Get-Content, " +
      "Select-String, Copy-Item, $env:NAME); quote paths with spaces; \\ and / both work in paths."
    : `Runs a command in the user's login shell on their ${computerOsLabel(os)} computer, with the user's own permissions ` +
      "($SHELL -l -c, so PATH is as in their terminal).";
  return `${shell}
Every command starts in the chat's working folder (named in the turn context); cd does not carry over to the next call, so chain commands in one call or use absolute paths. stdin is closed and nothing can answer a prompt: pass non-interactive flags (for example -y) and never open an editor or a pager (PAGER=cat, GIT_PAGER=cat, NO_COLOR=1 and TERM=dumb are set).
timeoutSeconds: how long the command may run, 1-${CONNECT_MAX_SHELL_TIMEOUT_SECONDS} (null: ${CONNECT_DEFAULT_SHELL_TIMEOUT_SECONDS}); then it is stopped with its child processes. background: true starts it as a background job and returns its jobId at once; use it for servers, watchers and work longer than ${CONNECT_MAX_SHELL_TIMEOUT_SECONDS / 60} minutes, read the job with computer_job_output and stop it with computer_job_stop. Every job is stopped when this answer ends.
The result has the exit code, stdout and stderr; a long stream keeps its first ${CONNECT_OUTPUT_HEAD_BYTES / 1_024} KiB and last ${CONNECT_OUTPUT_TAIL_BYTES / 1_024} KiB.
For files prefer computer_read, computer_glob, computer_grep, computer_write and computer_edit. Nothing asks the user before a command runs, so never delete, overwrite, move or send away the user's files, or change their system, unless the user asked for exactly that.`;
}

const READ_DESCRIPTION = `Reads a text file on the user's computer. path: ${PATH_TEXT}. Returns numbered lines like cat -n, from offset (the first line, from 1; null: 1) for up to limit lines (1-${CONNECT_MAX_READ_LINES}; null: ${CONNECT_DEFAULT_READ_LINES}), with the file's encoding and line endings; a line longer than 2000 characters is cut. UTF-8, UTF-16 and the system's legacy code page are decoded. A binary file is refused: use a command for it. Read a file before you edit it, and a long one in parts.`;

const WRITE_DESCRIPTION = `Writes a text file on the user's computer, creating it or replacing all of its content. path: ${PATH_TEXT}. content: the whole new text, at most ${CONNECT_MAX_WRITE_BYTES / 1_048_576} MiB. A new file is UTF-8 without BOM; replacing a file with CRLF line endings keeps CRLF. To change part of an existing file use computer_edit, and read a file before you replace it. Never overwrite a file the user did not ask you to change.`;

const EDIT_DESCRIPTION = `Replaces exact text in a file on the user's computer. Read the file with computer_read in this conversation first. path: ${PATH_TEXT}. oldString: the exact text to replace as the file has it, indentation included and without the line numbers computer_read adds; it must occur exactly once unless replaceAll is true. newString: the replacement (it may be empty). replaceAll: replace every occurrence (null: false). The file keeps its encoding, BOM and line endings. Fails with computer_edit_no_match when oldString is not in the file and computer_edit_ambiguous when it occurs more than once.`;

const GLOB_DESCRIPTION = `Finds files on the user's computer by a glob pattern such as **/*.docx or src/**/*.ts. path: the folder to search, ${PATH_TEXT} (null: the working folder). Returns up to 1000 paths, most recently modified first. .git and node_modules are skipped unless path points inside them.`;

const GREP_DESCRIPTION = `Searches the contents of files on the user's computer with an RE2 regular expression. path: a folder or file to search, ${PATH_TEXT} (null: the working folder). glob: only files whose names match it, for example *.md (null: every file). ignoreCase (null: false). mode: files lists the matching files (null: files), content shows matching lines with their line numbers, count gives the number of matching lines per file. context: lines around each match in content mode, 0-${CONNECT_MAX_GREP_CONTEXT} (null: 0). Returns up to 1000 matches; .git and node_modules are skipped unless path points inside them.`;

const JOB_OUTPUT_DESCRIPTION = `Reads what a background job started by computer_shell with background: true printed since the last read, and whether it is still running, with its exit code once it ended. waitSeconds: wait up to this long for new output or its end, 0-${CONNECT_MAX_JOB_WAIT_SECONDS} (null: 0). A job keeps only its last 1 MiB of output.`;

const JOB_STOP_DESCRIPTION = "Stops a background job started by computer_shell with background: true, with its child processes.";

/** The eight tools, in `COMPUTER_TOOL_NAMES` order, for a computer of this OS. */
export function computerToolDefinitions(os: ConnectOs): readonly RunTool[] {
  const path = string(`The path, ${PATH_TEXT}.`, CONNECT_MAX_CWD_LENGTH);
  const optionalPath = nullable("string", `A path, ${PATH_TEXT}; null for the working folder.`, { maxLength: CONNECT_MAX_CWD_LENGTH });
  const tools: Readonly<Record<ComputerToolName, Readonly<{ description: string; inputSchema: Record<string, unknown> }>>> = {
    computer_shell: { description: shellDescription(os), inputSchema: schema({
      command: string("The command to run.", CONNECT_MAX_COMMAND_BYTES),
      timeoutSeconds: nullable("integer", "Seconds the command may run; null for the default.",
        { maximum: CONNECT_MAX_SHELL_TIMEOUT_SECONDS, minimum: 1 }),
      background: nullable("boolean", "Run it as a background job; null for false.")
    }) },
    computer_job_output: { description: JOB_OUTPUT_DESCRIPTION, inputSchema: schema({
      jobId: string("The job's id from computer_shell.", 32),
      waitSeconds: nullable("integer", "Seconds to wait for new output or the job's end; null for 0.",
        { maximum: CONNECT_MAX_JOB_WAIT_SECONDS, minimum: 0 })
    }) },
    computer_job_stop: { description: JOB_STOP_DESCRIPTION, inputSchema: schema({
      jobId: string("The job's id from computer_shell.", 32)
    }) },
    computer_read: { description: READ_DESCRIPTION, inputSchema: schema({
      path,
      offset: nullable("integer", "The first line to return, from 1; null for 1.", { minimum: 1 }),
      limit: nullable("integer", "How many lines to return; null for the default.", { maximum: CONNECT_MAX_READ_LINES, minimum: 1 })
    }) },
    computer_write: { description: WRITE_DESCRIPTION, inputSchema: schema({
      path,
      content: string("The file's whole new content.", CONNECT_MAX_WRITE_BYTES)
    }) },
    computer_edit: { description: EDIT_DESCRIPTION, inputSchema: schema({
      path,
      oldString: string("The exact text to replace.", CONNECT_MAX_WRITE_BYTES),
      newString: string("The replacement text.", CONNECT_MAX_WRITE_BYTES),
      replaceAll: nullable("boolean", "Replace every occurrence; null for false.")
    }) },
    computer_glob: { description: GLOB_DESCRIPTION, inputSchema: schema({
      pattern: string("The glob pattern.", CONNECT_MAX_PATTERN_LENGTH),
      path: optionalPath
    }) },
    computer_grep: { description: GREP_DESCRIPTION, inputSchema: schema({
      pattern: string("The RE2 regular expression.", CONNECT_MAX_PATTERN_LENGTH),
      path: optionalPath,
      glob: nullable("string", "A file name glob; null for every file.", { maxLength: CONNECT_MAX_PATTERN_LENGTH }),
      ignoreCase: nullable("boolean", "Ignore case; null for false."),
      mode: { anyOf: [{ enum: ["files", "content", "count"], type: "string" }, { type: "null" }],
        description: "files, content or count; null for files." },
      context: nullable("integer", "Lines around each match in content mode; null for 0.", { maximum: CONNECT_MAX_GREP_CONTEXT, minimum: 0 })
    }) }
  };
  return COMPUTER_TOOL_NAMES.map((name): RunTool => ({ capability: "computer", description: tools[name].description,
    inputSchema: tools[name].inputSchema, name, strict: true }));
}

// Arguments: the model's, with the defaults and the frozen folder, checked against the device protocol before anything is sent.

type PreparedCall = Readonly<{ op: ConnectOp; args: ConnectOpArgs; timeoutMs: number }>;

const absent = (value: unknown) => value === undefined || value === null;
const text = (value: unknown) => typeof value === "string";
const integer = (value: unknown) => Number.isSafeInteger(value);
const boolean = (value: unknown) => typeof value === "boolean";
const grepMode = (value: unknown) => value === "files" || value === "content" || value === "count";
/** A fallback that leaves an absent or null argument out of the op. */
const OMIT = Symbol("omit");

/** Each tool's arguments: the key, its check and what null or absent stands for (none: required). */
type ArgumentSpec = readonly [key: string, check: (value: unknown) => boolean, fallback?: unknown];
const ARGUMENTS: Readonly<Record<ComputerToolName, readonly ArgumentSpec[]>> = {
  computer_edit: [["path", text], ["oldString", text], ["newString", text], ["replaceAll", boolean, false]],
  computer_glob: [["pattern", text], ["path", text, OMIT]],
  computer_grep: [["pattern", text], ["path", text, OMIT], ["glob", text, OMIT], ["ignoreCase", boolean, false],
    ["mode", grepMode, "files"], ["context", integer, 0]],
  computer_job_output: [["jobId", text], ["waitSeconds", integer, 0]],
  computer_job_stop: [["jobId", text]],
  computer_read: [["path", text], ["offset", integer, 1], ["limit", integer, CONNECT_DEFAULT_READ_LINES]],
  computer_shell: [["command", text], ["timeoutSeconds", integer, CONNECT_DEFAULT_SHELL_TIMEOUT_SECONDS], ["background", boolean, false]],
  computer_write: [["path", text], ["content", text]]
};

/** The model's arguments with their defaults and, for the ops that resolve paths, the folder; a string names a bad one. */
function modelArgs(name: ComputerToolName, args: Record<string, unknown>, cwd: string): Record<string, unknown> | string {
  const values: Record<string, unknown> = {};
  for (const [key, check, fallback] of ARGUMENTS[name]) {
    const value = args[key];
    if (absent(value)) {
      if (fallback === undefined) return key;
      if (fallback !== OMIT) values[key] = fallback;
    } else if (check(value)) values[key] = value;
    else return key;
  }
  return name === "computer_job_output" || name === "computer_job_stop" ? values : { ...values, cwd };
}

/**
 * The call as the device protocol takes it, with its timeout: a command's own and its reply's, otherwise a minute, never
 * past the turn's tool time; a command and a wait shorten to fit. A string names the argument that is missing or invalid.
 */
export function prepareComputerCall(name: ComputerToolName, args: Record<string, unknown>, cwd: string,
  timeLeftMs?: number): PreparedCall | string {
  const values = modelArgs(name, args, cwd);
  if (typeof values === "string") return values;
  const op = COMPUTER_TOOL_OPS[name];
  const own = name === "computer_shell"
    ? Number(values.timeoutSeconds) * 1_000 + COMPUTER_TOOL_LIMITS.shellReplyMs
    : COMPUTER_TOOL_LIMITS.callMs;
  const left = timeLeftMs !== undefined && Number.isFinite(timeLeftMs) ? timeLeftMs : Infinity;
  const timeoutMs = Math.max(COMPUTER_TOOL_LIMITS.minCallMs, Math.min(own, left, CONNECT_MAX_OP_DEADLINE_MS));
  if (name === "computer_shell" && timeoutMs < own) {
    values.timeoutSeconds = Math.max(1, Math.floor((timeoutMs - COMPUTER_TOOL_LIMITS.shellReplyMs) / 1_000));
  }
  if (name === "computer_job_output") {
    values.waitSeconds = Math.min(Number(values.waitSeconds),
      Math.max(0, Math.floor((timeoutMs - COMPUTER_TOOL_LIMITS.jobReplyMs) / 1_000)));
  }
  const checked = (connectOpArgsSchemas[op] as z.ZodType).safeParse(values);
  if (!checked.success) {
    const key = checked.error.issues[0]?.path[0];
    return typeof key === "string" ? key : "arguments";
  }
  return { args: checked.data as ConnectOpArgs, op, timeoutMs };
}

// Results.

/** What each failure code means for the model; the code itself is in the result. */
const FAILURE_TEXT: Readonly<Record<ComputerFailureCode, string>> = {
  computer_cancelled: "The operation was cancelled.",
  computer_edit_ambiguous: "oldString occurs more than once in the file. Include more of the surrounding lines so it is unique, or set replaceAll.",
  computer_edit_no_match: "oldString is not in the file. Read the file again and copy the exact text.",
  computer_file_binary: "The file is binary, so it cannot be read as text; use a command for it.",
  computer_file_too_large: "The file or the text is too large for this tool; read the file in parts with offset and limit, or use a command.",
  computer_is_a_directory: "The path is a folder, not a file.",
  computer_job_not_found: "No such background job: the id is wrong, or the job ended with an earlier answer.",
  computer_limit: "Too many operations or background jobs are running on the computer; wait, or stop a background job first.",
  computer_not_a_directory: "A part of the path is not a folder.",
  computer_path_not_found: "The path does not exist.",
  computer_pattern_invalid: "The pattern is not a valid RE2 regular expression or glob.",
  computer_permission_denied: "The user's account on the computer has no permission for this path.",
  computer_timeout: "The operation reached its time limit and was stopped.",
  connect_device_disconnected: "The computer disconnected before it answered.",
  connect_device_error: "The computer could not complete the operation.",
  connect_device_offline: "The user's computer is offline. Tell the user it is offline and that AIQSA Connect must be running on it; " +
    "do not use the Workspace instead, which cannot see the user's files.",
  connect_device_unavailable: "This computer is no longer connected to the user's account (it was removed or revoked). Ask the user " +
    "to choose another computer for this chat.",
  connect_disabled: "An administrator turned AIQSA Connect off, so the user's computer cannot be used now.",
  connect_unsupported: "The computer's AIQSA Connect is too old for this operation; ask the user to update it."
};

/** What a failure nothing was sent for tells the model: its code's words, and that nothing ran. */
function notSentText(code: ComputerFailureCode): string {
  return `${FAILURE_TEXT[code]} Nothing was sent to the computer.`;
}

/** What an `external` call that may have run and then failed tells the model (`toolBatch.ts`). */
export function computerUnknownOutcomeText(code: ComputerFailureCode): string {
  return `${FAILURE_TEXT[code]} It may have run, in part or whole, so its effect is unknown and it was not repeated. ` +
    "Check the current state first (read the files or list what it would have changed), then tell the user what you found.";
}

/**
 * Codes the device answers only after deciding the operation's outcome itself: whatever was sent, nothing more happens,
 * so they are ordinary errors, never unknown outcomes or retries.
 */
const DEFINITE_CODES: ReadonlySet<ComputerFailureCode> = new Set<ComputerFailureCode>([
  "computer_edit_ambiguous", "computer_edit_no_match", "computer_file_binary", "computer_file_too_large", "computer_is_a_directory",
  "computer_job_not_found", "computer_limit", "computer_not_a_directory", "computer_path_not_found", "computer_pattern_invalid",
  "computer_permission_denied", "connect_unsupported"
]);

/** Codes after which a reading call that may have reached the device is tried again: the operation never ended on its own terms. */
const TRANSIENT_READ_CODES: ReadonlySet<ComputerFailureCode> = new Set<ComputerFailureCode>([
  "computer_cancelled", "connect_device_disconnected", "connect_device_error"
]);

/**
 * A call that failed after it may have reached the device (`sent: true`), thrown for the batch: an `external` call keeps an
 * unknown outcome (`timedOut`: it reached its time limit), and a reading call is tried again when `transient`.
 */
export class ComputerOpError extends Error {
  readonly code: ComputerFailureCode;
  readonly timedOut: boolean;
  readonly transient: boolean;

  constructor(code: ComputerFailureCode, options: Readonly<{ timedOut?: boolean; transient?: boolean }> = {}) {
    super(code);
    this.name = "ComputerOpError";
    this.code = code;
    this.timedOut = options.timedOut === true;
    this.transient = options.transient === true;
  }
}

function errorResult(call: Pick<ModelToolCall, "id" | "name">, code: string, message: string): ToolExecutionResult {
  return { callId: call.id, content: [{ type: "json", value: { error: code, message } }], name: call.name, status: "error" };
}

function complete(call: Pick<ModelToolCall, "id" | "name">, textValue: string, exitCode?: number): ToolExecutionResult {
  return { callId: call.id, content: [{ text: textValue, type: "text" }], name: call.name,
    // The step's exit code, read back from the call's row (`computerActivityFacts`).
    ...(exitCode !== undefined ? { rawPreview: { computer: { exitCode } } } : {}), status: "complete" };
}

const kib = (bytes: number) => bytes < 1_024 ? `${bytes} bytes` : `${Math.round(bytes / 1_024)} KiB`;
const lines = (value: string) => value.replace(/\r?\n$/u, "");

function streams(stdout: string, stderr: string): string {
  const parts = [...(stdout ? [`stdout:\n${lines(stdout)}`] : []), ...(stderr ? [`stderr:\n${lines(stderr)}`] : [])];
  return parts.length > 0 ? parts.join("\n") : "(no output)";
}

function readText(path: string, result: ConnectOpResult<"read">): string {
  const body = result.content === "" ? [] : lines(result.content).split(/\r\n|\n|\r/u);
  if (body.length === 0) {
    return result.totalLines === 0 ? `${path}: empty file (${result.encoding})`
      : `${path}: no lines from line ${result.startLine}; the file has ${result.totalLines}.`;
  }
  const end = result.startLine + body.length - 1;
  const numbered = body.map((line, index) => `${String(result.startLine + index).padStart(6)}\t${line}`).join("\n");
  const more = end < result.totalLines ? `\nLines ${end + 1}-${result.totalLines} are not shown: read on with offset ${end + 1}.`
    : result.truncated ? "\nSome long lines were cut." : "";
  return `${path}: lines ${result.startLine}-${end} of ${result.totalLines} (${result.encoding}, ${result.lineEnding} line endings)\n` +
    `${numbered}${more}`;
}

function grepText(result: ConnectOpResult<"grep">): string {
  if (result.matches.length === 0) return "No matches.";
  const more = result.truncated ? "\nMore matches exist; narrow the pattern, path or glob." : "";
  switch (result.mode) {
    case "files":
      return `${result.matches.map((match) => match.path).join("\n")}${more}`;
    case "count":
      return `${result.matches.map((match) => `${match.path}: ${match.count}`).join("\n")}${more}`;
    case "content":
      return `${result.matches.map((match) => `${match.path}${match.context ? "-" : ":"}${match.line}${match.context ? "-" : ":"} ${match.text}`)
        .join("\n")}${more}`;
  }
}

/** A successful operation as the model reads it: compact text, numbered lines for a file. */
function successResult(call: ModelToolCall, name: ComputerToolName, args: ConnectOpArgs, result: ConnectOpResult): ToolExecutionResult {
  const path = "path" in args && typeof args.path === "string" ? args.path : "";
  switch (name) {
    case "computer_shell": {
      const shell = result as ConnectOpResult<"shell">;
      if ("jobId" in shell) {
        return complete(call, `Started background job ${shell.jobId}. Read its output with computer_job_output and stop it with ` +
          "computer_job_stop; it is stopped when this answer ends.");
      }
      const cut = shell.truncated ? `\nOutput was cut: each stream keeps its first ${kib(CONNECT_OUTPUT_HEAD_BYTES)} and last ` +
        `${kib(CONNECT_OUTPUT_TAIL_BYTES)} (stdout ${kib(shell.stdoutBytes)}, stderr ${kib(shell.stderrBytes)} in full).` : "";
      return complete(call, `Exit code: ${shell.exitCode} (${(shell.durationMs / 1_000).toFixed(1)} s)\n` +
        `${streams(shell.stdout, shell.stderr)}${cut}`, shell.exitCode);
    }
    case "computer_job_output": {
      const job = result as ConnectOpResult<"job_output">;
      const state = job.running ? "The job is still running." : `The job ended with exit code ${job.exitCode}.`;
      const cut = job.truncated ? "\nEarlier output was dropped: a job keeps only its last 1 MiB." : "";
      return complete(call, `${state}\n${job.stdout || job.stderr ? streams(job.stdout, job.stderr) : "(no new output)"}${cut}`,
        job.running ? undefined : job.exitCode);
    }
    case "computer_job_stop":
      return complete(call, (result as ConnectOpResult<"job_stop">).stopped ? "Stopped the job and its child processes."
        : "The job had already ended.");
    case "computer_read":
      return complete(call, readText(path, result as ConnectOpResult<"read">));
    case "computer_write": {
      const written = result as ConnectOpResult<"write">;
      return complete(call, `${written.created ? "Created" : "Replaced"} ${path} (${written.bytes} bytes).`);
    }
    case "computer_edit": {
      const count = (result as ConnectOpResult<"edit">).replacements;
      return complete(call, `Edited ${path}: ${count} ${count === 1 ? "replacement" : "replacements"}.`);
    }
    case "computer_glob": {
      const found = result as ConnectOpResult<"glob">;
      if (found.paths.length === 0) return complete(call, "No files match.");
      return complete(call, `${found.paths.join("\n")}${found.truncated ? "\nMore files match; narrow the pattern or path." : ""}`);
    }
    case "computer_grep":
      return complete(call, grepText(result as ConnectOpResult<"grep">));
  }
}

export type ComputerToolContext = Readonly<{
  binding: FrozenComputerBinding;
  /** The port; absent, the process's (`getComputerOps`), read at each call since the relay installs it. */
  ops?: ComputerOps;
  runId: string;
  /** How long a call may still run before the turn's tool time ends; absent, only its own bound. */
  timeLeftMs?: () => number;
  userId: string;
}>;

/**
 * One call on the user's computer. Returns a result for a success, for anything refused before sending and for a
 * definite failure; throws `ComputerOpError` for a failure after the device may have started it, and the run's abort
 * when Stop or the deadline ended the call.
 */
export async function executeComputerTool(context: ComputerToolContext, call: ModelToolCall, signal: AbortSignal):
  Promise<ToolExecutionResult> {
  if (!isComputerToolName(call.name)) return errorResult(call, "tool_unavailable", "This tool is not available.");
  const name = call.name;
  if (hasInvalidProviderToolArguments(call.arguments)) {
    return errorResult(call, "tool_arguments_invalid", "The arguments were not one JSON object, so nothing was sent.");
  }
  const prepared = prepareComputerCall(name, call.arguments, context.binding.cwd, context.timeLeftMs?.());
  if (typeof prepared === "string") {
    return errorResult(call, "tool_arguments_invalid", `The argument ${JSON.stringify(prepared)} is missing or invalid, so nothing ` +
      "was sent. Check it against the tool's description and call again.");
  }
  signal.throwIfAborted();
  // The port answers by itself at `timeoutMs`; this is the engine's backstop, after which the call counts as timed out.
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), prepared.timeoutMs + COMPUTER_TOOL_LIMITS.graceMs);
  (handle as { unref?: () => void }).unref?.();
  let outcome: ComputerOpOutcome;
  try {
    outcome = await (context.ops ?? getComputerOps()).call({ args: prepared.args, deviceId: context.binding.deviceId, op: prepared.op,
      runId: context.runId, signal: AbortSignal.any([signal, timer.signal]), timeoutMs: prepared.timeoutMs, userId: context.userId });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(handle);
  }
  // Stop or the turn's deadline: the batch's cancellation path settles the call.
  signal.throwIfAborted();
  if (outcome.ok) {
    const result = parseConnectOpResult(prepared.op, outcome.result);
    if (result) return successResult(call, name, prepared.args, result);
    outcome = { code: "connect_device_error", ok: false, sent: true };
  }
  const code: ComputerFailureCode = timer.signal.aborted ? "computer_timeout" : outcome.code;
  if (!outcome.sent) return errorResult(call, code, notSentText(code));
  if (DEFINITE_CODES.has(code)) return errorResult(call, code, FAILURE_TEXT[code]);
  if (COMPUTER_TOOL_EFFECTS[name] === "external") throw new ComputerOpError(code, { timedOut: code === "computer_timeout" });
  if (TRANSIENT_READ_CODES.has(code)) throw new ComputerOpError(code, { transient: true });
  return errorResult(call, code, FAILURE_TEXT[code]);
}

// Steps in the answer (§7): `ThreadToolActivityCall` with origin `computer`.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The argument a step names: the command, the path, the pattern or the job. */
const SUMMARY_ARGUMENT: Readonly<Record<ComputerToolName, string>> = {
  computer_edit: "path",
  computer_glob: "pattern",
  computer_grep: "pattern",
  computer_job_output: "jobId",
  computer_job_stop: "jobId",
  computer_read: "path",
  computer_shell: "command",
  computer_write: "path"
};

/**
 * A computer step's facts, from its arguments and, once it settled, its result: one bounded line (the command's first
 * line, a path or a pattern) and a command's exit code. Owner-only, as the chat is.
 */
export function computerActivityFacts(toolName: string, argumentsValue: unknown, result?: unknown): { exitCode?: number; summary?: string } {
  if (!isComputerToolName(toolName)) return {};
  const value = isRecord(argumentsValue) ? argumentsValue[SUMMARY_ARGUMENT[toolName]] : undefined;
  const summary = typeof value === "string" ? computerActivitySummary(value) : null;
  const preview = isRecord(result) && isRecord(result.rawPreview) && isRecord(result.rawPreview.computer) ? result.rawPreview.computer : null;
  const exitCode = preview && isComputerExitCode(preview.exitCode) ? preview.exitCode : undefined;
  return { ...(summary ? { summary } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** The run's computer tools for its registry, each a step of origin `computer` named after the computer. */
export function computerEngineTools(input: ComputerToolContext & Readonly<{ serverName?: string }>): EngineTool[] {
  return computerToolDefinitions(input.binding.os).map((definition): EngineTool => {
    const name = definition.name as ComputerToolName;
    return {
      activity: (call) => ({ origin: "computer", ...(input.serverName ? { serverName: input.serverName } : {}), toolName: call.name,
        ...computerActivityFacts(call.name, call.arguments) }),
      definition,
      effects: COMPUTER_TOOL_EFFECTS[name],
      observationSource: "workspace",
      execute: (execution) => executeComputerTool(input, execution.call, execution.signal)
    };
  });
}
