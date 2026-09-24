import type { RunEventView } from "@/lib/contracts/runs";
import {
  decodeThreadWorkspaceActivityEntry,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityEntry,
  type ThreadWorkspaceOutputStatus
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

function commandLabel(entry: ThreadWorkspaceActivityEntry): string {
  const command = collapsedCommandV2(entry.command?.preview ?? "command");
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
      return running ? `Exporting ${count}…` : entry.phase === "failed" ? "Export failed" : `Exported ${count}`;
    }
    case "command":
      return commandLabel(entry);
    case "file_change": {
      const count = entry.count ?? entry.changes?.length ?? 0;
      const single = count === 1 ? entry.changes?.[0] : undefined;
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
      return `Plan · ${entry.items?.filter((item) => item.completed).length ?? 0} of ${entry.items?.length ?? 0} complete`;
    case "elided":
      return `${entry.count ?? 0} earlier steps omitted${entry.failedCount ? ` · ${entry.failedCount} failed` : ""}`;
    default:
      return fileLabel(entry);
  }
}

export function workspaceActivityOutcomeV2(activity: ThreadWorkspaceActivity | null): string | null {
  if (activity?.entries.some(entry => entry.kind === "execution_status" && entry.phase === "unknown")) return "Cleanup unconfirmed";
  if (activity?.outputStatus?.state === "failed") return "File export failed";
  if (activity?.entries.some(entry => entry.phase === "unknown")) return "Some outcomes unconfirmed";
  return null;
}

export const WORKSPACE_RECREATED_NOTICE_V2 =
  "Previous runtime state and installed dependencies may no longer be available. Original attachments were restored.";

export function workspaceDurationV2(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

/** Live status line while the run works: the latest running step, else the generic phrase. */
export function workspaceLiveLabelV2(activity: ThreadWorkspaceActivity | null): string | null {
  if (!activity || activity.entries.length === 0) return null;
  for (let index = activity.entries.length - 1; index >= 0; index -= 1) {
    const entry = activity.entries[index]!;
    if (isWorkspaceActivityActive(entry) && entry.kind !== "plan") {
      return workspaceActivityLabelV2(entry);
    }
  }
  return "Working in Workspace…";
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
