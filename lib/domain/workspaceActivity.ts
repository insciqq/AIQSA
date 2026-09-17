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
  const base = {
    ...newer,
    ...(Number.isFinite(firstSequence) ? { firstSequence } : {}),
    ...(newer.kind !== "plan" && isWorkspaceActivityActive(newer) && !isWorkspaceActivityActive(older)
      ? { phase: older.phase, ...(older.runOutcome ? { runOutcome: older.runOutcome } : {}) } : {})
  };
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
    ...(command.preview === "…" ? older.command?.previewTruncated !== undefined
      ? { previewTruncated: older.command.previewTruncated } : {}
      : command.previewTruncated !== undefined ? { previewTruncated: command.previewTruncated } : {}),
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

export function isWorkspaceActivityActive(entry: ThreadWorkspaceActivityEntry): boolean {
  return entry.kind !== "elided" && (entry.phase === "requested" || entry.phase === "running");
}

const lifecycleKinds = new Set(["workspace_start", "workspace_recreated", "workspace_stopped", "attachments_prepare", "outputs_export"]);

function elision(entries: readonly ThreadWorkspaceActivityEntry[]): ThreadWorkspaceActivityEntry | undefined {
  return entries.filter((entry) => entry.kind === "elided").sort((left, right) =>
    (right.throughSequence ?? 0) - (left.throughSequence ?? 0) || (right.count ?? 0) - (left.count ?? 0)
  )[0];
}

function order(entries: readonly ThreadWorkspaceActivityEntry[]): ThreadWorkspaceActivityEntry[] {
  return [...entries].sort((left, right) => {
    const leftSequence = left.firstSequence ?? left.sequence;
    const rightSequence = right.firstSequence ?? right.sequence;
    return leftSequence !== undefined && rightSequence !== undefined ? leftSequence - rightSequence : 0;
  });
}

/** One retention policy for persistence, history and live snapshots. Inputs are logical rows. */
export function compactWorkspaceActivityEntries(
  entries: readonly ThreadWorkspaceActivityEntry[]
): ThreadWorkspaceActivityEntry[] {
  const previous = elision(entries);
  const rows = order(entries.filter((entry) => entry.kind !== "elided"));
  const capacity = WORKSPACE_ACTIVITY_MAX_ENTRIES - (previous || rows.length > WORKSPACE_ACTIVITY_MAX_ENTRIES ? 1 : 0);
  if (rows.length <= capacity) return [...previous ? [previous] : [], ...rows];

  // Keep active actions, then the most recently observed completed actions.
  // A long command that just completed should not disappear because it started early.
  const position = new Map(rows.map((entry, index) => [entry.id, index]));
  const prioritized = [...rows].sort((left, right) =>
    Number(isWorkspaceActivityActive(right)) - Number(isWorkspaceActivityActive(left)) ||
    (right.sequence ?? position.get(right.id)!) - (left.sequence ?? position.get(left.id)!)
  );
  const retained = new Set(prioritized.slice(0, capacity).map((entry) => entry.id));
  const removed = rows.filter((entry) => !retained.has(entry.id));
  const throughSequence = removed.reduce((maximum, entry) => Math.max(maximum, entry.sequence ?? 0), previous?.throughSequence ?? 0);
  const marker: ThreadWorkspaceActivityEntry = {
    count: (previous?.count ?? 0) + removed.length,
    failedCount: (previous?.failedCount ?? 0) + removed.filter((entry) => entry.phase === "failed").length,
    firstSequence: 0,
    hasLifecycle: previous?.hasLifecycle === true || removed.some((entry) => lifecycleKinds.has(entry.kind)),
    id: "elided",
    kind: "elided",
    // Neutral metadata: even the degenerate active-row overflow claims no completion.
    phase: "requested",
    sequence: throughSequence,
    throughSequence
  };
  return [marker, ...rows.filter((entry) => retained.has(entry.id))];
}

function logicalRows(activity: ThreadWorkspaceActivity | null | undefined): ThreadWorkspaceActivityEntry[] {
  const byId = new Map<string, ThreadWorkspaceActivityEntry>();
  for (const entry of activity?.entries ?? []) byId.set(entry.id, mergeWorkspaceActivityEntry(byId.get(entry.id), entry));
  return compactWorkspaceActivityEntries([...byId.values()]);
}

export function mergeWorkspaceActivity(
  previous: ThreadWorkspaceActivity | null | undefined,
  next: ThreadWorkspaceActivity | null | undefined
): ThreadWorkspaceActivity | null {
  const prior = logicalRows(previous);
  const incoming = logicalRows(next);
  const priorElision = elision(prior);
  const incomingElision = elision(incoming);
  // The snapshot with the furthest boundary owns the retained holes below it
  // (usually long-running commands). An older snapshot cannot resurrect its rows.
  const incomingOwnsBoundary = !!incomingElision && (!priorElision ||
    (incomingElision.throughSequence ?? 0) > (priorElision.throughSequence ?? 0) ||
    incomingElision.throughSequence === priorElision.throughSequence && (incomingElision.count ?? 0) > (priorElision.count ?? 0));
  const marker = incomingOwnsBoundary ? incomingElision : priorElision;
  const retained = new Set((incomingOwnsBoundary ? incoming : prior).map((entry) => entry.id));
  const byId = new Map<string, ThreadWorkspaceActivityEntry>();
  for (const entry of [...prior, ...incoming]) {
    if (entry.kind === "elided") continue;
    if (marker && entry.sequence !== undefined && entry.sequence <= marker.throughSequence! && !retained.has(entry.id)) continue;
    byId.set(entry.id, mergeWorkspaceActivityEntry(byId.get(entry.id), entry));
  }
  const outputStatus = next?.outputStatus ?? previous?.outputStatus;
  if (!byId.size && !outputStatus && !marker) return null;
  const entries = compactWorkspaceActivityEntries([...marker ? [marker] : [], ...byId.values()]);
  const truncated = previous?.truncated === true || next?.truncated === true || entries.some((entry) => entry.kind === "elided");
  return {
    entries,
    ...(outputStatus ? { outputStatus } : {}),
    ...(truncated ? { truncated: true } : {})
  };
}
