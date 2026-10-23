import { WORKSPACE_MCP_TOOL_ALLOWLIST } from "../../../domain/workspace";
import type { TranscriptItem, TranscriptToolCallItem, TranscriptToolResultItem } from "../transcript";

/**
 * What a compaction keeps word for word, built by code from the transcript
 * so it cannot be hallucinated: the record of the work (files, artifacts,
 * changes, data-changing calls, pending calls, large results by handle,
 * errors), the instructions of Skills loaded before the cut, and the earlier
 * user messages, newest first within their budget. It is recomputed from the
 * whole transcript at every compaction, never carried over from the last one.
 */

/** What a tool call did, for the record. The loop passes its registry's view;
 * the default reads the product's tool names. */
export type CompactionToolKind =
  | "artifact"
  | "assistant"
  | "external_write"
  | "other"
  | "scheduled_task"
  | "secret"
  | "settings"
  | "skill_change"
  | "skill_load"
  | "workspace_command"
  | "workspace_read"
  | "workspace_write";

export type CompactionToolCall = Readonly<{ arguments: string; name: string }>;
export type CompactionToolClassifier = (call: CompactionToolCall) => CompactionToolKind;

/** The handle `read_tool_result` reads a result by, if it has one. The loop
 * passes the engine's handle scheme; the default finds a quoted handle. */
export type CompactionResultHandle = (result: Readonly<{ callId: string; name: string; output: string }>) => string | null;

/** Product tool names (`lib/server/tools/*`), kept here so the module stays a light leaf. */
export const COMPACTION_PRODUCT_TOOLS = Object.freeze({
  artifact: "create_artifact",
  loadSkill: "load_skill",
  manageScheduledTask: "manage_scheduled_task",
  readSkillFile: "read_skill_file",
  readToolResult: "read_tool_result",
  saveSkill: "save_skill",
  scheduledTask: "create_scheduled_task"
});

const OBSERVATION_HANDLE = /\btor1_[a-f0-9]{32}\b/u;

/** The engine's stored-result handle (`tor1_…`) quoted in a result's text. */
export const defaultResultHandle: CompactionResultHandle = (result) => OBSERVATION_HANDLE.exec(result.output)?.[0] ?? null;

const WORKSPACE_TOOL = /^(?:mcp_workspace_)?(sandbox_[a-z_]+?)(?:_[a-z0-9]{10})?$/u;
const WORKSPACE_READS = new Set(["sandbox_fs_read", "sandbox_fs_list", "sandbox_fs_stat", "sandbox_fs_exists"]);
const WORKSPACE_WRITES = new Set(["sandbox_fs_write", "sandbox_fs_mkdir", "sandbox_fs_copy", "sandbox_fs_remove", "sandbox_fs_rename"]);
const WORKSPACE_COMMANDS = new Set(["sandbox_shell", "sandbox_exec", "sandbox_exec_start"]);
const GENERIC_READS = /^(?:read_file|view_file|cat_file|list_files|list_dir|list_directory|glob|grep|stat_file)$/u;
const GENERIC_WRITES = /^(?:write_file|edit_file|create_file|delete_file|remove_file|move_file|rename_file|copy_file|apply_patch|str_replace|replace_in_file|mkdir)$/u;
const GENERIC_COMMANDS = /^(?:run_command|run_shell|shell|bash|exec|execute_command|run_tests|run_python|run_script)$/u;
const WRITE_VERB = /(?:^|_)(?:add|approve|archive|assign|book|cancel|change|close|comment|create|delete|deploy|disable|edit|enable|grant|import|insert|invite|mark|merge|modify|move|patch|pay|post|publish|put|reject|remove|rename|reply|reset|restore|revoke|save|schedule|send|set|share|start|stop|submit|transfer|trigger|update|upload|upsert|write)(?:_|$)/u;
const MCP_TOOL = /^mcp_([a-z0-9_-]+?)_([a-z0-9_-]+)_[a-z0-9]{10}$/u;

function workspaceOperation(name: string): string | null {
  const operation = WORKSPACE_TOOL.exec(name)?.[1];
  return operation && (WORKSPACE_MCP_TOOL_ALLOWLIST as readonly string[]).includes(operation) ? operation : null;
}

function parsedArguments(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export const defaultCompactionToolKind: CompactionToolClassifier = (call) => {
  const name = call.name;
  const operation = workspaceOperation(name);
  if (operation) {
    return WORKSPACE_READS.has(operation) ? "workspace_read" : WORKSPACE_WRITES.has(operation) ? "workspace_write"
      : WORKSPACE_COMMANDS.has(operation) ? "workspace_command" : "other";
  }
  if (GENERIC_READS.test(name)) return "workspace_read";
  if (GENERIC_WRITES.test(name)) return "workspace_write";
  if (GENERIC_COMMANDS.test(name)) return "workspace_command";
  switch (name) {
    case COMPACTION_PRODUCT_TOOLS.artifact:
      return "artifact";
    case COMPACTION_PRODUCT_TOOLS.loadSkill:
    case COMPACTION_PRODUCT_TOOLS.readSkillFile:
      return "skill_load";
    case COMPACTION_PRODUCT_TOOLS.saveSkill:
      return "skill_change";
    case COMPACTION_PRODUCT_TOOLS.scheduledTask:
      return "scheduled_task";
    case COMPACTION_PRODUCT_TOOLS.manageScheduledTask: {
      const action = parsedArguments(call.arguments).action;
      return action === "list" || action === "get" ? "other" : "scheduled_task";
    }
  }
  const mcp = MCP_TOOL.exec(name);
  const tool = mcp ? mcp[2]! : name;
  const changes = WRITE_VERB.test(tool);
  if (/secret/u.test(tool)) return changes ? "secret" : "other";
  if (/assistant/u.test(tool)) return changes ? "assistant" : "other";
  if (/setting|preference/u.test(tool)) return changes ? "settings" : "other";
  return mcp && changes ? "external_write" : "other";
};

// ---------------------------------------------------------------- the record

const LIMITS = Object.freeze({
  argumentsChars: 160,
  commands: 12,
  errors: 10,
  filesChanged: 40,
  filesRead: 40,
  largeResults: 60,
  lineChars: 240,
  listed: 20,
  writes: 30
});
/** Results with a handle are listed once a summary would only see their excerpt. */
const LISTED_RESULT_CHARS = 2_000;
/** Results at least this long are listed even without a handle, as excerpt-only. */
const LARGE_RESULT_CHARS = 8_000;
/** Argument keys a record line never copies: values and bodies, not identity. */
const UNCOPIED_KEYS = /^(?:api_?key|authorization|body|code|content|contents|data|files|password|prompt|secret|text|token|value)$/iu;
const PATH_KEYS = ["path", "file_path", "filepath", "filename", "file", "source", "src", "from", "destination", "dest", "dst", "to", "target"];

function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, Math.max(0, chars - 1))}…`;
}

/** Head and tail of a one-line value: a query's filter or a path's file name is at its end. */
function clipMiddle(text: string, chars: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= chars) return flat;
  const head = Math.floor((chars - 1) * 0.45);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - (chars - 1 - head))}`;
}

/** A short identity of a call's arguments: scalar fields, bodies and secret values left out. */
export function describeArguments(text: string, chars: number = LIMITS.argumentsChars): string {
  const value = parsedArguments(text);
  const parts: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (UNCOPIED_KEYS.test(key)) continue;
    if (typeof field === "string") parts.push(`${key}=${JSON.stringify(clipMiddle(field, 72))}`);
    else if (typeof field === "number" || typeof field === "boolean") parts.push(`${key}=${String(field)}`);
    else if (Array.isArray(field) && field.every((entry) => typeof entry === "string")) {
      parts.push(`${key}=${JSON.stringify(clip(field.join(", "), 72))}`);
    }
  }
  return clip(parts.join(" "), chars);
}

function argumentPaths(text: string): string[] {
  const value = parsedArguments(text);
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0 && field.length <= 1_024) paths.push(field);
  }
  const listed = value.paths;
  if (Array.isArray(listed)) for (const entry of listed) if (typeof entry === "string" && entry.length <= 1_024) paths.push(entry);
  return paths;
}

function firstLine(text: string, chars: number): string {
  const line = text.split(/\r?\n/u).find((entry) => entry.trim().length > 0) ?? "";
  return clip(line, chars);
}

const ERROR_LINE = /(?:error|exception|fail|fatal|traceback|denied|refused|timed? ?out|ошибк|сбой)/iu;

/** The line of a failed result that names the failure, else its first line. */
function errorLine(text: string, chars: number): string {
  const line = text.slice(0, 64_000).split(/\r?\n/u).find((entry) => ERROR_LINE.test(entry));
  return line ? clip(line, chars) : firstLine(text, chars);
}

const RESULT_IDENTIFIER = /"((?:[a-z]+_)?id|[a-z]+Id|url|version)"\s*:\s*"([^"\s]{1,100})"/gu;

/** Up to two identifiers a result names first (ids, URLs, versions). */
function resultIdentifiers(output: string): string {
  const found: string[] = [];
  for (const match of output.slice(0, 2_048).matchAll(RESULT_IDENTIFIER)) {
    found.push(`${match[1]}=${match[2]}`);
    if (found.length === 2) break;
  }
  return found.length > 0 ? ` (${found.join(", ")})` : "";
}

function outcomeText(result: TranscriptToolResultItem, identify = false): string {
  if (result.outcome === "unknown") return "outcome unknown: check its effect before repeating it";
  if (result.outcome === "error") return `error: ${errorLine(result.output, 140)}`;
  const exit = /"?exit_?code"?\s*[:=]\s*(-?\d{1,4})/iu.exec(result.output.slice(0, 4_096))?.[1];
  return exit !== undefined ? `exit ${exit}` : `done${identify ? resultIdentifiers(result.output) : ""}`;
}

const WRITE_OPERATIONS: Readonly<Record<string, string>> = {
  apply_patch: "patched", copy_file: "copied", create_file: "written", delete_file: "removed", edit_file: "edited",
  mkdir: "directory created", move_file: "moved", remove_file: "removed", rename_file: "renamed",
  replace_in_file: "edited", sandbox_fs_copy: "copied", sandbox_fs_mkdir: "directory created", sandbox_fs_remove: "removed",
  sandbox_fs_rename: "renamed", sandbox_fs_write: "written", str_replace: "edited", write_file: "written"
};

type Called = Readonly<{ call: TranscriptToolCallItem; kind: CompactionToolKind; result: TranscriptToolResultItem | undefined }>;

function calls(items: readonly TranscriptItem[], classify: CompactionToolClassifier): Called[] {
  const results = new Map<string, TranscriptToolResultItem>();
  for (const item of items) if (item.kind === "tool_result" && !results.has(item.callId)) results.set(item.callId, item);
  const seen = new Set<string>();
  const out: Called[] = [];
  for (const item of items) {
    if (item.kind !== "tool_call" || seen.has(item.callId)) continue;
    seen.add(item.callId);
    let kind: CompactionToolKind;
    try {
      kind = classify({ arguments: item.arguments, name: item.name });
    } catch {
      kind = "other";
    }
    out.push({ call: item, kind, result: results.get(item.callId) });
  }
  return out;
}

function capped(lines: readonly string[], limit: number, newest: boolean): string[] {
  if (lines.length <= limit) return [...lines];
  const kept = newest ? lines.slice(-limit) : lines.slice(0, limit);
  const note = `- … ${lines.length - limit} more not listed`;
  return newest ? [note, ...kept] : [...kept, note];
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? [title, ...lines.map((line) => clip(line, LIMITS.lineChars))] : [];
}

export type StateBlockOptions = Readonly<{
  classify?: CompactionToolClassifier;
  resultHandle?: CompactionResultHandle;
}>;

/** The record of the work, from every tool call in the transcript. Empty when there is nothing to record. */
export function buildStateBlock(items: readonly TranscriptItem[], options: StateBlockOptions = {}): string {
  const all = calls(items, options.classify ?? defaultCompactionToolKind);
  const handleOf = options.resultHandle ?? defaultResultHandle;

  const changed = new Map<string, { failed: boolean; operations: Map<string, number> }>();
  const read = new Set<string>();
  const touch = (path: string, operation: string, failed: boolean) => {
    const entry = changed.get(path) ?? { failed: false, operations: new Map<string, number>() };
    changed.delete(path);
    entry.operations.set(operation, (entry.operations.get(operation) ?? 0) + 1);
    entry.failed = failed;
    changed.set(path, entry);
  };
  const commands: string[] = [];
  const artifacts: string[] = [];
  const skillsLoaded = new Set<string>();
  const skillChanges: string[] = [];
  const tasks: string[] = [];
  const otherChanges: string[] = [];
  const writes: string[] = [];
  const pending: string[] = [];
  const large: string[] = [];
  const errors: string[] = [];

  for (const { call, kind, result } of all) {
    const identity = `${call.name} ${describeArguments(call.arguments)}`.trim();
    if (!result) {
      pending.push(`- ${identity} (call ${clip(call.callId, 64)}): approval or result pending when this record was made; ` +
        "its outcome follows in the conversation once recorded");
      continue;
    }
    const done = result.outcome === "complete";
    switch (kind) {
      case "workspace_write": {
        const operation = WRITE_OPERATIONS[workspaceOperation(call.name) ?? call.name] ?? "changed";
        const paths = argumentPaths(call.arguments);
        if (paths.length === 2 && (operation === "renamed" || operation === "moved" || operation === "copied")) {
          touch(paths[1]!, `${operation} from ${paths[0]!}`, !done);
          if (operation !== "copied") touch(paths[0]!, `${operation} to ${paths[1]!}`, !done);
        } else {
          for (const path of paths) touch(path, operation, !done);
        }
        break;
      }
      case "workspace_read":
        for (const path of argumentPaths(call.arguments)) read.add(path);
        break;
      case "workspace_command": {
        const parsed = parsedArguments(call.arguments);
        const command = typeof parsed.command === "string" ? [parsed.command, ...(Array.isArray(parsed.args)
          ? parsed.args.filter((entry): entry is string => typeof entry === "string") : [])].join(" ") : describeArguments(call.arguments);
        commands.push(`- \`${clip(command, 160)}\` → ${outcomeText(result)}`);
        break;
      }
      case "artifact":
        artifacts.push(`- ${identity} → ${outcomeText(result, true)}`);
        break;
      case "skill_load": {
        const skill = parsedArguments(call.arguments).skill;
        if (typeof skill === "string" && done) skillsLoaded.add(clip(skill, 80));
        break;
      }
      case "skill_change":
        skillChanges.push(`- ${identity} → ${outcomeText(result, true)}`);
        break;
      case "scheduled_task":
        tasks.push(`- ${identity} → ${outcomeText(result, true)}`);
        break;
      case "secret":
      case "assistant":
      case "settings":
        otherChanges.push(`- ${identity} → ${outcomeText(result, true)}`);
        break;
      case "external_write":
        writes.push(`- ${identity} → ${outcomeText(result, true)}`);
        break;
      case "other":
        break;
    }
    const handle = handleOf(result);
    if (handle && result.output.length > LISTED_RESULT_CHARS && call.name !== COMPACTION_PRODUCT_TOOLS.readToolResult) {
      large.push(`- ${handle}: ${identity} (${result.output.length.toLocaleString("en-US")} characters)`);
    } else if (!handle && result.output.length >= LARGE_RESULT_CHARS && kind !== "skill_load") {
      large.push(`- (no handle) ${identity} (${result.output.length.toLocaleString("en-US")} characters; only an excerpt survives compaction)`);
    }
    if (result.outcome === "error") errors.push(`- ${identity} → ${errorLine(result.output, 160)}`);
  }

  const changedLines = [...changed.entries()].map(([path, entry]) =>
    `- ${path}: ${[...entry.operations.entries()].map(([operation, count]) => count > 1 ? `${operation} ×${count}` : operation).join(", ")}` +
    (entry.failed ? " (last attempt failed)" : ""));
  const readLines = [...read].filter((path) => !changed.has(path)).map((path) => `- ${path}`);
  const lines = [
    ...section("Files changed (latest last):", capped(changedLines, LIMITS.filesChanged, true)),
    ...section("Files read:", capped(readLines, LIMITS.filesRead, true)),
    ...section(`Workspace commands (latest ${Math.min(commands.length, LIMITS.commands)} of ${commands.length}):`,
      commands.slice(-LIMITS.commands)),
    ...section("Artifacts:", capped(artifacts, LIMITS.listed, true)),
    ...section("Skills loaded:", skillsLoaded.size > 0 ? [`- ${[...skillsLoaded].join(", ")}`] : []),
    ...section("Skills changed:", capped(skillChanges, LIMITS.listed, true)),
    ...section("Scheduled tasks:", capped(tasks, LIMITS.listed, true)),
    ...section("Secrets, Assistants and settings changed:", capped(otherChanges, LIMITS.listed, true)),
    ...section("Data-changing calls and their outcomes:", capped(writes, LIMITS.writes, true)),
    ...section("Waiting when this record was made:", pending),
    ...section("Large tool results (read them with read_tool_result):", capped(large, LIMITS.largeResults, true)),
    ...section("Recent tool errors:", errors.slice(-LIMITS.errors))
  ];
  return lines.length > 0
    ? ["## Recorded state (generated by the system from the tool log; exact)", ...lines].join("\n")
    : "";
}

// ------------------------------------------------- verbatim user messages

export type RetainedBudgets = Readonly<{ skillTokens: number; userMessageTokens: number }>;

/** Head and tail of a text within about `tokens`, marked where it was cut. */
function fitText(text: string, tokens: number, estimate: (value: unknown) => number): string {
  const total = estimate(text);
  if (total <= tokens) return text;
  const chars = Math.max(0, Math.floor(text.length * tokens / Math.max(1, total)) - 80);
  const half = Math.floor(chars / 2);
  return `${text.slice(0, half)}\n…[${(text.length - half * 2).toLocaleString("en-US")} characters omitted]…\n${text.slice(text.length - half)}`;
}

function cutIndex(items: readonly TranscriptItem[], keepFromId: string): number {
  const index = items.findIndex((item) => item.id === keepFromId);
  return index < 0 ? items.length : index;
}

/** The newest user messages before the cut within the budget, rendered oldest first. */
export function earlierUserMessages(items: readonly TranscriptItem[], keepFromId: string, tokens: number,
  estimate: (value: unknown) => number): string {
  const users = items.slice(0, cutIndex(items, keepFromId)).flatMap((item) => item.kind === "user" && item.text.trim() ? [item] : []);
  if (users.length === 0 || tokens <= 0) return "";
  const kept: string[] = [];
  let remaining = tokens;
  let index = users.length - 1;
  for (; index >= 0; index -= 1) {
    const user = users[index]!;
    const label = `[${index + 1}${user.followup ? ", follow-up during the work" : ""}]`;
    const cost = estimate(user.text) + 8;
    if (cost <= remaining) {
      kept.unshift(`${label} ${user.text}`);
      remaining -= cost;
      continue;
    }
    if (remaining >= 400) kept.unshift(`${label} ${fitText(user.text, remaining - 8, estimate)}`);
    break;
  }
  const omitted = kept.length < users.length ? users.length - kept.length : 0;
  return [
    "## Earlier user messages (verbatim, oldest first; later ones follow in the conversation)",
    ...(omitted > 0 ? [`(${omitted} older user message${omitted === 1 ? " is" : "s are"} covered by the summary only.)`] : []),
    ...kept
  ].join("\n");
}

/** The latest instructions of each Skill loaded before the cut, newest first within the budget. */
export function skillsInUse(items: readonly TranscriptItem[], keepFromId: string, tokens: number,
  estimate: (value: unknown) => number): string {
  const before = items.slice(0, cutIndex(items, keepFromId));
  const latest = new Map<string, string>();
  for (const { call, result } of calls(before, defaultCompactionToolKind)) {
    if (call.name !== COMPACTION_PRODUCT_TOOLS.loadSkill || result?.outcome !== "complete") continue;
    const skill = parsedArguments(call.arguments).skill;
    if (typeof skill !== "string" || !skill) continue;
    latest.delete(skill);
    latest.set(skill, result.output);
  }
  if (latest.size === 0) return "";
  const kept: string[] = [];
  const named: string[] = [];
  let remaining = tokens;
  for (const [skill, output] of [...latest.entries()].reverse()) {
    const cost = estimate(output) + 12;
    if (cost <= remaining) {
      kept.unshift(`### ${clip(skill, 80)}\n${output}`);
      remaining -= cost;
    } else {
      named.unshift(clip(skill, 80));
    }
  }
  return [
    "## Skills loaded earlier (their instructions as loaded, verbatim)",
    ...kept,
    ...(named.length > 0 ? [`Also loaded earlier, not repeated here: ${named.join(", ")} (call load_skill again for the instructions).`] : [])
  ].join("\n");
}

export type RetainedContextOptions = StateBlockOptions & RetainedBudgets & Readonly<{
  estimate: (value: unknown) => number;
  items: readonly TranscriptItem[];
  keepFromId: string;
}>;

export const RETAINED_PREAMBLE = "Kept from the earlier, compacted part of this conversation:";

/** The retained text of a compaction: the record, the Skills in use and the earlier user messages. */
export function buildRetainedContext(options: RetainedContextOptions): string {
  const parts = [
    buildStateBlock(options.items, options),
    skillsInUse(options.items, options.keepFromId, options.skillTokens, options.estimate),
    earlierUserMessages(options.items, options.keepFromId, options.userMessageTokens, options.estimate)
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? [RETAINED_PREAMBLE, ...parts].join("\n\n") : "";
}

/** An upper bound of the retained text's tokens for a cut, without building it. */
export function estimateRetainedTokens(items: readonly TranscriptItem[], keepFromId: string,
  estimate: (value: unknown) => number, budgets: RetainedBudgets & Readonly<{ stateTokens: number }>): number {
  const before = items.slice(0, cutIndex(items, keepFromId));
  let users = 0;
  let skills = 0;
  const loaded = new Set<string>();
  for (const item of before) {
    if (item.kind === "user") users += estimate(item.text) + 8;
    if (item.kind === "tool_call" && item.name === COMPACTION_PRODUCT_TOOLS.loadSkill) loaded.add(item.callId);
    if (item.kind === "tool_result" && loaded.has(item.callId)) skills += estimate(item.output) + 12;
  }
  return Math.min(users, budgets.userMessageTokens) + Math.min(skills, budgets.skillTokens) + budgets.stateTokens;
}
