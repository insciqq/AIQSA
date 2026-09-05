import {
  WORKSPACE_ACTIVITY_MAX_ENTRIES,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityCommand,
  type ThreadWorkspaceActivityEntry
} from "../contracts/workspace";

function outputSnapshot(entry: ThreadWorkspaceActivityEntry) {
  const command = entry.command;
  return command && (command.stdoutPreview !== undefined || command.stderrPreview !== undefined ||
    command.truncated !== undefined || command.originalByteCount !== undefined)
    ? { command, sequence: command.outputSequence ?? entry.sequence } : undefined;
}

/** Merge observations of the same logical row by durable event order, not delivery order. */
export function mergeWorkspaceActivityEntry(
  previous: ThreadWorkspaceActivityEntry | undefined,
  next: ThreadWorkspaceActivityEntry
): ThreadWorkspaceActivityEntry {
  previous ??= next;
  const nextIsOlder = (next.sequence ?? -1) < (previous.sequence ?? -1) ||
    next.sequence === previous.sequence && previous.runOutcome !== undefined && next.runOutcome === undefined;
  const [older, newer] = nextIsOlder ? [next, previous] : [previous, next];
  const firstSequence = Math.min(older.firstSequence ?? older.sequence ?? Infinity, newer.firstSequence ?? newer.sequence ?? Infinity);
  const base = { ...newer, ...(Number.isFinite(firstSequence) ? { firstSequence } : {}) };
  const command = newer.command;
  if (!command) return base;
  // Select output by its source event, including inherited snapshots. Never
  // combine two independent output budgets: that could exceed 8 KiB.
  const olderOutput = outputSnapshot(older);
  const newerOutput = outputSnapshot(newer);
  const source = (olderOutput?.sequence ?? -1) > (newerOutput?.sequence ?? -1)
    ? olderOutput : newerOutput ?? olderOutput;
  const output = source?.command;
  const cwd = command.cwd ?? older.command?.cwd;
  const exitCode = command.exitCode === undefined ? older.command?.exitCode : command.exitCode;
  const mergedCommand: ThreadWorkspaceActivityCommand = {
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(output?.originalByteCount !== undefined ? { originalByteCount: output.originalByteCount } : {}),
    ...(source?.sequence !== undefined ? { outputSequence: source.sequence } : {}),
    preview: command.preview === "…" ? older.command?.preview ?? command.preview : command.preview,
    ...(output?.stderrPreview !== undefined ? { stderrPreview: output.stderrPreview } : {}),
    ...(output?.stdoutPreview !== undefined ? { stdoutPreview: output.stdoutPreview } : {}),
    ...(output?.truncated !== undefined ? { truncated: output.truncated } : {})
  };
  return {
    ...base,
    command: mergedCommand,
    ...(newer.startedAt ?? older.startedAt ? { startedAt: newer.startedAt ?? older.startedAt } : {})
  };
}

export function mergeWorkspaceActivity(
  previous: ThreadWorkspaceActivity | null | undefined,
  next: ThreadWorkspaceActivity | null | undefined
): ThreadWorkspaceActivity | null {
  const byId = new Map<string, ThreadWorkspaceActivityEntry>();
  for (const entry of [...previous?.entries ?? [], ...next?.entries ?? []]) {
    byId.set(entry.id, mergeWorkspaceActivityEntry(byId.get(entry.id), entry));
  }
  const outputStatus = next?.outputStatus ?? previous?.outputStatus;
  if (!byId.size && !outputStatus) return null;
  return {
    entries: [...byId.values()].sort((left, right) =>
      left.firstSequence !== undefined && right.firstSequence !== undefined
        ? left.firstSequence - right.firstSequence : 0
    ).slice(0, WORKSPACE_ACTIVITY_MAX_ENTRIES),
    ...(outputStatus ? { outputStatus } : {})
  };
}
