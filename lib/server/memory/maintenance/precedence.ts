/** Exact current testimony of a memory: the supporting message and when the
 * user wrote it. */
export type MemoryMaintenanceTestimony = Readonly<{ messageId: string; observedAt: Date }>;
export type MemoryMaintenancePrecedence = "TARGET" | "SOURCE" | "NONE";

/** `candidate` holds testimony from a message outside `other`, later than all
 * of `other`'s testimony. */
function newer(candidate: readonly MemoryMaintenanceTestimony[], other: readonly MemoryMaintenanceTestimony[]): boolean {
  if (other.length === 0) return false;
  const latest = Math.max(...other.map(({ observedAt }) => observedAt.getTime()));
  const messages = new Set(other.map(({ messageId }) => messageId));
  return candidate.some(({ messageId, observedAt }) => !messages.has(messageId) && observedAt.getTime() > latest);
}

/** Which of two contradicting memories outranks the other; the source is
 * always an automatic, unprotected fact. A protected target (explicit,
 * owner-edited, pinned or remember-requested) always outranks it. Between
 * automatic facts, one outranks the other only with testimony from another
 * message later than all of the other's; facts resting on the same single
 * message, or whose latest testimony is shared or simultaneous, have no
 * clear order. A newer automatic target outranks only once maintenance
 * confirmed it `lasting`: a short-lived newer fact never purges a lasting
 * one. */
export function memoryMaintenanceContradictionPrecedence(input: Readonly<{
  source: readonly MemoryMaintenanceTestimony[];
  target: Readonly<{ protected: boolean; lasting: boolean; testimony: readonly MemoryMaintenanceTestimony[] }>;
}>): MemoryMaintenancePrecedence {
  if (input.target.protected) return "TARGET";
  if (newer(input.target.testimony, input.source)) return input.target.lasting ? "TARGET" : "NONE";
  return newer(input.source, input.target.testimony) ? "SOURCE" : "NONE";
}

export type MemoryMaintenanceContradictionCandidate = Readonly<{
  sourceRef: string;
  sourceFactId: string;
  targetFactId: string;
  /** Null once the related memory is no longer current, authorized and unchanged. */
  precedence: MemoryMaintenancePrecedence | null;
}>;
/** REMOVE: the outranking related memory survives. KEEP: no conflict remains,
 * because the related memory changed or this settlement removes it. CONFLICT:
 * both memories stay current without a removal. */
export type MemoryMaintenanceContradictionOutcome = "REMOVE" | "KEEP" | "CONFLICT";

/** How settlement ends each verified contradiction. A source goes only when
 * its related memory outranks it and survives this settlement; removals whose
 * related memory goes too are all kept, round by round, until none remains,
 * so the result never depends on decision order. `removedFactIds` holds the
 * facts this settlement removes for other reasons. */
export function settleMemoryMaintenanceContradictions(candidates: readonly MemoryMaintenanceContradictionCandidate[],
  removedFactIds: ReadonlySet<string>): ReadonlyMap<string, MemoryMaintenanceContradictionOutcome> {
  const removing = new Set(candidates.filter(({ precedence }) => precedence === "TARGET").map(({ sourceRef }) => sourceRef));
  const removed = () => new Set([...removedFactIds,
    ...candidates.filter(({ sourceRef }) => removing.has(sourceRef)).map(({ sourceFactId }) => sourceFactId)]);
  for (let gone = removed(); ; gone = removed()) {
    const kept = candidates.filter(({ sourceRef, targetFactId }) => removing.has(sourceRef) && gone.has(targetFactId));
    if (kept.length === 0) break;
    for (const { sourceRef } of kept) removing.delete(sourceRef);
  }
  const gone = removed();
  return new Map(candidates.map((candidate) => [candidate.sourceRef, removing.has(candidate.sourceRef) ? "REMOVE"
    : candidate.precedence === null || gone.has(candidate.targetFactId) ? "KEEP" : "CONFLICT"]));
}
