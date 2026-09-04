import type { RunEventView } from "@/lib/contracts/runs";
import {
  decodeThreadWorkspaceActivityEntry,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityEntry,
  type ThreadWorkspaceOutputStatus
} from "@/lib/contracts/workspace";
import { formatWorkDurationV2 } from "./runPresentation";

/**
 * Client-owned copy and folding for the Workspace activity timeline. The
 * server sends only kind + phase + bounded facts; every human phrase lives
 * here so persisted events never freeze English text.
 */

const COLLAPSED_COMMAND_CHARS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeEntry(
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
 * Merges the reloadable projection with the live stream. Persisted entries
 * are authoritative for their ids; live events only add steps the server
 * has not projected yet, so a late `chat_update` can never regress a phase.
 */
export function presentWorkspaceActivityV2(
  events: readonly RunEventView[],
  persisted: ThreadWorkspaceActivity | null = null
): ThreadWorkspaceActivity | null {
  const byId = new Map<string, ThreadWorkspaceActivityEntry>();
  for (const entry of persisted?.entries ?? []) byId.set(entry.id, entry);
  const persistedIds = new Set(byId.keys());
  for (const entry of liveEntries(events)) {
    if (persistedIds.has(entry.id)) continue;
    byId.set(entry.id, mergeEntry(byId.get(entry.id), entry));
  }
  const entries = [...byId.values()];
  if (entries.length === 0 && !persisted?.outputStatus) return null;
  return { entries, ...(persisted?.outputStatus ? { outputStatus: persisted.outputStatus } : {}) };
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
  switch (entry.phase) {
    case "requested":
    case "running":
      return `Running ${command}…`;
    case "failed":
      return `${command} failed`;
    case "cancelled":
      return `Stopped ${command}`;
    default:
      return `Ran ${command}`;
  }
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
      if (failed) return `Could not find ${path}`;
      return entry.count && entry.count > 1 ? `Checked ${plural(entry.count, "file")}` : `Checked ${path}`;
  }
}

/** The one human phrase for a row; server kinds never reach the reader. */
export function workspaceActivityLabelV2(entry: ThreadWorkspaceActivityEntry): string {
  const running = entry.phase === "requested" || entry.phase === "running";
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
    default:
      return fileLabel(entry);
  }
}

export const WORKSPACE_RECREATED_NOTICE_V2 =
  "Previous runtime state and installed dependencies may no longer be available. Original attachments were restored.";

export function workspaceDurationV2(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

export function workspaceActivityHasFailureV2(activity: ThreadWorkspaceActivity | null): boolean {
  return (activity?.entries ?? []).some((entry) => entry.phase === "failed" || entry.phase === "cancelled");
}

/** Live status line while the run works: the latest running step, else the generic phrase. */
export function workspaceLiveLabelV2(activity: ThreadWorkspaceActivity | null): string | null {
  if (!activity || activity.entries.length === 0) return null;
  for (let index = activity.entries.length - 1; index >= 0; index -= 1) {
    const entry = activity.entries[index]!;
    if (entry.phase === "running" || entry.phase === "requested") {
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
      return "The answer completed, but some generated files could not be prepared for download.";
    default:
      return null;
  }
}
