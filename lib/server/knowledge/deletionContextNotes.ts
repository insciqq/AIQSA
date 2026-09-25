/**
 * Model-derived context notes are hidden evidence digests, not generated
 * answer text. Knowledge deletion removes them from the runs that used the
 * deleted evidence and from every later run that carried or re-summarized
 * them; only content-free receipts (attempt states, digests, usage) remain.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));
}

/** The accepted policy without its carried notes. A hybrid policy without
 * `reuse` decodes as a policy that carries nothing. */
export function withoutCarriedContextNotes(normalizedRequest: unknown): unknown {
  if (!isRecord(normalizedRequest) || !isRecord(normalizedRequest.contextCompactionPolicy) ||
    !Object.hasOwn(normalizedRequest.contextCompactionPolicy, "reuse")) return normalizedRequest;
  return {
    ...normalizedRequest,
    contextCompactionPolicy: without(normalizedRequest.contextCompactionPolicy, "reuse")
  };
}

/** The tool-loop checkpoint without its committed notes. Summary attempts are
 * content-free receipts and stay; an absent `summary` decodes as no summary,
 * so the checkpoint can never supply notes to a later turn. */
export function withoutCheckpointContextNotes(toolLoopState: unknown): unknown {
  if (!isRecord(toolLoopState) || !isRecord(toolLoopState.contextCompaction) ||
    !Object.hasOwn(toolLoopState.contextCompaction, "summary")) return toolLoopState;
  return {
    ...toolLoopState,
    contextCompaction: without(toolLoopState.contextCompaction, "summary")
  };
}

/** The notes a run holds: those its accepted policy carried and those its
 * checkpoint committed. */
export type ContextNotesRun = Readonly<{
  id: string;
  reuseRunId: string | null;
  reuseSummaryId: string | null;
  summaryId: string | null;
}>;

/**
 * Runs, beyond the affected ones, whose notes descend from an affected run:
 * a run that carried notes from an included run, or that holds notes derived
 * in an included run (its checkpoint summary differs from what it carried),
 * is included in turn. Passing through unchanged notes adds no new identity,
 * so notes an affected run merely carried from an unrelated earlier run do not
 * reach that earlier run. The fixed point is bounded by the given rows.
 */
export function contextNotesDescendantRunIds(input: Readonly<{
  affectedRunIds: readonly string[];
  runs: readonly ContextNotesRun[];
}>): string[] {
  const affected = new Set(input.affectedRunIds);
  const included = new Set(input.affectedRunIds);
  const derived = new Set<string>();
  const derive = (run: ContextNotesRun) => {
    if (run.summaryId && run.summaryId !== run.reuseSummaryId) derived.add(run.summaryId);
  };
  for (const run of input.runs) if (included.has(run.id)) derive(run);
  for (let changed = true; changed;) {
    changed = false;
    for (const run of input.runs) {
      if (included.has(run.id)) continue;
      if (run.reuseRunId !== null && included.has(run.reuseRunId) ||
        run.reuseSummaryId !== null && derived.has(run.reuseSummaryId) ||
        run.summaryId !== null && derived.has(run.summaryId)) {
        included.add(run.id);
        derive(run);
        changed = true;
      }
    }
  }
  return [...included].filter((id) => !affected.has(id)).sort();
}
