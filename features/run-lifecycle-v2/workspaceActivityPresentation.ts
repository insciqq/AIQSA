import type { RunEventView } from "@/lib/contracts/runs";
import {
  decodeThreadWorkspaceActivityEntry,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityCodeMcp,
  type ThreadWorkspaceActivityEntry,
  type ThreadWorkspaceOutputStatus,
  type WorkspaceOutputSkips
} from "@/lib/contracts/workspace";
import { formatWorkDurationV2 } from "./runPresentation";
import { closeWorkspaceActivityEntries, isWorkspaceActivityActive, mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import { isExploredWorkspaceCommand } from "./workspaceCommandClassification";

/**
 * Client-owned copy and folding for the Workspace activity timeline. The
 * server sends only kind + phase + bounded facts; every human phrase lives
 * here so persisted events never freeze English text.
 */

const COLLAPSED_COMMAND_CHARS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liveEntries(events: readonly RunEventView[]): ThreadWorkspaceActivityEntry[] {
  const entries: ThreadWorkspaceActivityEntry[] = [];
  for (const event of events) {
    if (event.type !== "artifact" || !isRecord(event.data) ||
      event.data.artifactType !== "workspace_activity") continue;
    const entry = decodeThreadWorkspaceActivityEntry(event.data.payload);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Both sources carry the sequence assigned at persistence, including replay.
 * A delayed detail response and reordered SSE obey the same merge rule.
 */
export function presentWorkspaceActivityV2(
  events: readonly RunEventView[],
  persisted: ThreadWorkspaceActivity | null = null,
  terminal = false
): ThreadWorkspaceActivity | null {
  const activity = mergeWorkspaceActivity(persisted, { entries: liveEntries(events) });
  return activity ? { ...activity, entries: closeWorkspaceActivityEntries(activity.entries, terminal) } : null;
}

/** Keep lifecycle proof in the source activity, but do not present a successful
 * empty handoff as work performed by the answer. A plan is the answer's own
 * (`workspacePlanV2`), not Workspace work. */
export function visibleWorkspaceActivityV2(
  activity: ThreadWorkspaceActivity | null,
  generatedFileCount = 0
): ThreadWorkspaceActivity | null {
  const entries = (activity?.entries ?? []).filter(entry =>
    entry.kind !== "plan" &&
    !(entry.kind === "execution_status" && entry.phase === "closed") &&
    !(entry.kind === "outputs_export" && entry.phase === "succeeded" && entry.count === 0 && !entry.skipped) &&
    !(entry.kind === "attachments_prepare" && entry.phase === "succeeded" && entry.count === 0)
  );
  const substantiveEntry = entries.some(entry =>
    !(entry.kind === "workspace_start" && entry.phase === "succeeded")
  );
  const unresolvedExport = activity?.outputStatus && activity.outputStatus.state !== "complete";
  if (!substantiveEntry && generatedFileCount === 0 && !unresolvedExport) return null;
  return activity ? { ...activity, entries } : { entries };
}

/** The answer's latest plan (`update_plan`, or a Codex Agent's plan) with steps to show; null without one. */
export function workspacePlanV2(activity: ThreadWorkspaceActivity | null): ThreadWorkspaceActivityEntry | null {
  const plans = (activity?.entries ?? []).filter((entry) => entry.kind === "plan" && (entry.items?.length ?? 0) > 0);
  return plans.at(-1) ?? null;
}

/** "Plan · 2 of 5 complete": the plan's own count, never inferred from time. */
export function workspacePlanSummaryV2(plan: ThreadWorkspaceActivityEntry): string {
  return `Plan · ${plan.items?.filter((item) => item.completed).length ?? 0} of ${plan.items?.length ?? 0} complete`;
}

/** Consecutive successful existence/stat checks collapse into one "Checked N files" row. */
export function aggregateWorkspaceActivityV2(
  entries: readonly ThreadWorkspaceActivityEntry[]
): ThreadWorkspaceActivityEntry[] {
  const rows: ThreadWorkspaceActivityEntry[] = [];
  for (const entry of entries) {
    const previous = rows.at(-1);
    if (
      entry.kind === "file_check" && entry.phase === "succeeded" &&
      previous?.kind === "file_check" && previous.phase === "succeeded"
    ) {
      rows[rows.length - 1] = {
        ...previous,
        count: (previous.count ?? 1) + 1,
        ...(previous.durationMs !== undefined || entry.durationMs !== undefined
          ? { durationMs: (previous.durationMs ?? 0) + (entry.durationMs ?? 0) }
          : {})
      };
      continue;
    }
    rows.push(entry);
  }
  return rows;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function collapsedCommandV2(preview: string): string {
  const characters = [...preview];
  return characters.length > COLLAPSED_COMMAND_CHARS
    ? `${characters.slice(0, COLLAPSED_COMMAND_CHARS - 1).join("")}…`
    : preview;
}

/** An interpreter given its program inline, after any `cd … &&`: the row names the language, not escaped source. */
const INLINE_SCRIPT = /^(?:cd\s+\S+\s*&&\s*)*(?:\S*\/)?(python[0-9.]*|node)\s+(?:-c\b|-e\b|-p\b|--eval\b|-\s*<<|<<)/u;

/** One line for a command: inline code by its language, a multi-line command by its first line. */
function commandSummary(preview: string): string {
  const interpreter = INLINE_SCRIPT.exec(preview)?.[1];
  if (interpreter) return interpreter === "node" ? "JavaScript code" : "Python code";
  const [first = "", ...rest] = preview.split("\n");
  return collapsedCommandV2(rest.length > 0 ? `${first.trimEnd()} …` : first);
}

/**
 * One step line of the Workspace browser helper, exactly as it prints it
 * (`ops/workspace-guest/python/aiqsa/browser/_format.py`):
 * `[browser #3] click: button "Add to cart" @ shop.example/cart`. A
 * presentation hint read from the command's own output, never authority.
 */
const BROWSER_STEP = /^\[browser #(\d{1,5})\] ([a-z_]{1,20})(?:: (.+?))?(?: @ (\S+))?$/u;
/** Only a command that runs the helper reports steps; any other output that imitates one stays output. */
const BROWSER_COMMAND = /aiqsa-browser|aiqsa import browser|aiqsa\.browser/u;

export type WorkspaceBrowserStepV2 = Readonly<{ number: number; action: string; target?: string; where?: string }>;

/** The browser steps a finished command reported, in order. */
export function workspaceBrowserStepsV2(entry: ThreadWorkspaceActivityEntry): WorkspaceBrowserStepV2[] {
  const output = entry.kind === "command" ? entry.command?.stdoutPreview : undefined;
  if (!output || !output.includes("[browser #") || !BROWSER_COMMAND.test(entry.command?.preview ?? "")) return [];
  const steps: WorkspaceBrowserStepV2[] = [];
  for (const line of output.split("\n")) {
    const match = BROWSER_STEP.exec(line.trimEnd());
    if (!match) continue;
    steps.push({ number: Number(match[1]), action: match[2]!, ...(match[3] ? { target: match[3] } : {}),
      ...(match[4] ? { where: match[4] } : {}) });
  }
  return steps;
}

/** What the agent did in the browser, in the reader's words. */
export function workspaceBrowserStepPhraseV2(step: WorkspaceBrowserStepV2): string {
  const target = step.target;
  switch (step.action) {
    case "open": return `Opened ${step.where ?? "a page"}`;
    case "click": return `Clicked ${target ?? "an element"}`;
    case "type": return `Typed into ${target ?? "a field"}`;
    case "select": return `Selected ${target ?? "an option"}`;
    case "upload": return `Uploaded ${target ?? "a file"}`;
    case "press": return `Pressed ${target ?? "a key"}`;
    case "scroll": return `Scrolled ${target ?? "the page"}`;
    case "back": return "Went back";
    case "forward": return "Went forward";
    case "reload": return "Reloaded the page";
    case "wait": return `Waited for ${target ?? "the page"}`;
    case "tab": return target ? `Switched to tab ${target}` : "Switched tabs";
    case "new_tab": return "Opened a new tab";
    case "close_tab": return "Closed a tab";
    case "screenshot": return `Took a screenshot${target && target !== "page" ? ` of ${target}` : ""}`;
    case "save_session": return `Saved the sign-in for ${target ?? "this site"}`;
    case "download": return `Downloaded ${target ?? "a file"}`;
    default: return `Browser step: ${step.action}`;
  }
}

/** A finished command that drove the browser reads as its steps, not as its command line. */
function browserCommandLabel(entry: ThreadWorkspaceActivityEntry): string | null {
  if (entry.phase !== "succeeded") return null;
  const steps = workspaceBrowserStepsV2(entry);
  const last = steps.at(-1);
  if (!last) return null;
  return steps.length === 1
    ? `Browser: ${workspaceBrowserStepPhraseV2(last)}`
    : `Browser: ${steps.length} steps, last: ${workspaceBrowserStepPhraseV2(last)}`;
}

function commandLabel(entry: ThreadWorkspaceActivityEntry): string {
  const browser = browserCommandLabel(entry);
  if (browser) return browser;
  const command = commandSummary(entry.command?.preview ?? "command");
  if (entry.phase === "failed") return `${command} failed`;
  if (entry.phase === "closed") return `${command} · exit not observed`;
  if (entry.phase === "unknown") return `${command} · outcome unconfirmed`;
  return `${workspaceCommandVerbV2(entry)} ${command}${isWorkspaceActivityActive(entry) ? "…" : ""}`;
}

export function workspaceCommandVerbV2(entry: ThreadWorkspaceActivityEntry): string {
  if (entry.phase === "cancelled") return "Stopped";
  if (entry.phase === "failed") return "";
  const explored = isExploredWorkspaceCommand(entry.command?.preview ?? "", entry.command?.previewTruncated);
  return isWorkspaceActivityActive(entry) ? explored ? "Exploring" : "Running" : explored ? "Explored" : "Ran";
}

function fileLabel(entry: ThreadWorkspaceActivityEntry): string {
  const path = entry.file?.displayPath ?? "file";
  const target = entry.file?.targetPath ?? "";
  const running = entry.phase === "requested" || entry.phase === "running";
  const failed = entry.phase === "failed" || entry.phase === "cancelled";
  switch (entry.kind) {
    case "file_read":
      return running ? `Reading ${path}…` : failed ? `Could not read ${path}` : `Read ${path}`;
    case "file_write":
      return running ? `Writing ${path}…` : failed ? `Could not write ${path}` : `Wrote ${path}`;
    case "file_list":
      return running ? `Listing ${path}…` : failed ? `Could not list ${path}` : `Listed ${path}`;
    case "file_copy":
      return running ? `Copying ${path} → ${target}…` : failed ? `Could not copy ${path}` : `Copied ${path} → ${target}`;
    case "file_move":
      return running ? `Moving ${path} → ${target}…` : failed ? `Could not move ${path}` : `Moved ${path} → ${target}`;
    case "file_remove":
      return running ? `Removing ${path}…` : failed ? `Could not remove ${path}` : `Removed ${path}`;
    case "folder_create":
      return running ? `Creating folder ${path}…` : failed ? `Could not create folder ${path}` : `Created folder ${path}`;
    default:
      if (running) return `Checking ${path}…`;
      if (failed) return `Could not check ${path}`;
      return entry.count && entry.count > 1 ? `Checked ${plural(entry.count, "file")}` : `Checked ${path}`;
  }
}

/** The one human phrase for a row; server kinds never reach the reader. */
export function workspaceActivityLabelV2(entry: ThreadWorkspaceActivityEntry): string {
  const running = entry.phase === "requested" || entry.phase === "running";
  if (entry.kind === "execution_status") return entry.phase === "closed"
    ? "Workspace execution ended" : "Workspace cleanup unconfirmed";
  if (entry.kind !== "command" && entry.kind !== "plan" && (entry.phase === "closed" || entry.phase === "unknown")) {
    const target = entry.file?.displayPath ?? entry.mcp?.toolName;
    return `${target ?? "Workspace step"} · outcome unconfirmed`;
  }
  switch (entry.kind) {
    case "workspace_start":
      if (running) return "Starting workspace…";
      if (entry.phase === "failed") return "Workspace could not start";
      if (entry.phase === "cancelled") return "Workspace start stopped";
      return "Workspace ready";
    case "workspace_recreated":
      return "Workspace was recreated";
    case "workspace_stopped":
      return "Workspace work stopped";
    case "attachments_prepare": {
      const count = plural(entry.count ?? 0, "attachment");
      return running ? `Preparing ${count}…` : entry.phase === "failed" ? `Could not prepare ${count}` : `Prepared ${count}`;
    }
    case "outputs_export": {
      const count = plural(entry.count ?? 0, "file");
      return running ? `Exporting ${count}…` : entry.phase === "failed" ? "Export failed"
        : entry.count ? `Exported ${count}` : "No files exported";
    }
    case "command":
      return commandLabel(entry);
    case "file_change": {
      const count = entry.count ?? entry.changes?.length ?? 0;
      const single = count === 1 ? entry.changes?.[0] : undefined;
      if (entry.phase === "failed" || entry.phase === "cancelled") {
        const target = single ? single.displayPath : plural(count, "file");
        return entry.phase === "failed" ? `Could not finish changing ${target}` : `Changing ${target} stopped`;
      }
      if (single) return `${running ? "Changing" : single.action === "add" ? "Created" : single.action === "delete" ? "Deleted" : "Edited"} ${single.displayPath}`;
      return `${running ? "Editing" : "Edited"} ${plural(count, "file")}`;
    }
    case "mcp_call":
      if (entry.phase === "failed") return entry.text ?? (entry.mcp?.discovery ? "Tool discovery failed" : "MCP tool call failed");
      if (entry.mcp?.discovery) return running ? "Finding tools…" : "Found tools";
      return `${running ? "Calling" : "Called"} ${entry.mcp?.serverName ? `${entry.mcp.serverName}: ` : ""}${entry.mcp?.toolName ?? "MCP tool"}`;
    case "search":
      return `${running ? "Searching" : "Searched"}${entry.search?.query ? ` ${entry.search.query}` : " the web"}`;
    case "agent_note":
      return entry.text ?? "Agent note";
    case "plan":
      return workspacePlanSummaryV2(entry);
    case "elided":
      return `${entry.count ?? 0} earlier steps omitted${entry.failedCount ? ` · ${entry.failedCount} failed` : ""}`;
    default:
      return fileLabel(entry);
  }
}

/** What an export left out of the output folder, in plain words; null when nothing. */
export function workspaceOutputSkipsCopyV2(skipped: WorkspaceOutputSkips | undefined): string | null {
  const parts = [
    ...(skipped?.link ? [plural(skipped.link, "link")] : []),
    ...(skipped?.special ? [plural(skipped.special, "special file")] : [])
  ];
  return parts.length > 0 ? `${parts.join(" and ")} not exported` : null;
}

export function workspaceActivityOutcomeV2(activity: ThreadWorkspaceActivity | null): string | null {
  if (activity?.entries.some(entry => entry.kind === "execution_status" && entry.phase === "unknown")) return "Cleanup unconfirmed";
  if (activity?.outputStatus?.state === "failed") return "File export failed";
  if (activity?.entries.some(entry => entry.phase === "unknown")) return "Some outcomes unconfirmed";
  return null;
}

export const WORKSPACE_RECREATED_NOTICE_V2 =
  "Previous runtime state and installed dependencies may no longer be available. Original attachments were restored.";

/** One line for the MCP calls a command's code made: tools and counts, never arguments or results. */
export function workspaceCodeMcpCopyV2(codeMcp: ThreadWorkspaceActivityCodeMcp): string {
  const listed = codeMcp.tools.map((tool) =>
    `${tool.serverName ? `${tool.serverName} · ` : ""}${tool.toolName} ×${tool.calls}${tool.failed ? ` (${tool.failed} failed)` : ""}`);
  const unlisted = codeMcp.calls - codeMcp.tools.reduce((sum, tool) => sum + tool.calls, 0);
  if (unlisted > 0) listed.push(`${unlisted} more`);
  const parts = [`MCP calls from code: ${codeMcp.calls}`];
  if (listed.length) parts.push(listed.join(", "));
  if (codeMcp.failed) parts.push(`${codeMcp.failed} failed`);
  if (codeMcp.refused) parts.push(`${codeMcp.refused} refused, call budget used up`);
  return parts.join(" · ");
}

export function workspaceDurationV2(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

/** Live status line while the run works: the latest running step, else the generic phrase. */
export function workspaceLiveLabelV2(activity: ThreadWorkspaceActivity | null): string | null {
  const visible = visibleWorkspaceActivityV2(activity);
  if (!visible || visible.entries.length === 0) return null;
  return workspaceActiveLabelV2(activity) ?? "Working in Workspace…";
}

/** The label of the Workspace step running now, without the generic fallback. */
export function workspaceActiveLabelV2(activity: ThreadWorkspaceActivity | null): string | null {
  const visible = visibleWorkspaceActivityV2(activity);
  if (!visible) return null;
  for (let index = visible.entries.length - 1; index >= 0; index -= 1) {
    const entry = visible.entries[index]!;
    if (isWorkspaceActivityActive(entry) && entry.kind !== "plan") {
      return workspaceActivityLabelV2(entry);
    }
  }
  return null;
}

export function workspaceProcessLabelV2(input: Readonly<{
  live: boolean;
  workDurationMs: number | null;
}>): string {
  if (input.live) return "Working in Workspace…";
  return input.workDurationMs === null
    ? "Worked in Workspace"
    : `Worked in Workspace for ${formatWorkDurationV2(input.workDurationMs)}`;
}

export function workspaceOutputStatusCopyV2(
  status: ThreadWorkspaceOutputStatus | undefined,
  fileCount = 0
): string | null {
  switch (status?.state) {
    case "exporting":
      return fileCount > 0 ? `Exporting ${plural(fileCount, "file")}…` : "Preparing generated files…";
    case "retrying":
      return "The answer completed, but some generated files are still being prepared.";
    case "failed":
      return "Some generated files could not be prepared for download.";
    default:
      return null;
  }
}
