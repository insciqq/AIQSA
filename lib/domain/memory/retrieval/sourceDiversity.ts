const MEMORY_SOURCE_DIVERSITY_DENOMINATOR = 4;

export function orderMemoryCandidatesByDistinctSourceFirst<T>(
  candidates: readonly T[],
  sourceChatId: (candidate: T) => string | null
): readonly T[] {
  const firstBySource: T[] = [];
  const remaining: T[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const source = sourceChatId(candidate);
    if (source === null) continue;
    if (seen.has(source)) remaining.push(candidate);
    else {
      seen.add(source);
      firstBySource.push(candidate);
    }
  }
  const ordered = [...firstBySource, ...remaining];
  let sourceIndex = 0;
  return candidates.map((candidate) => sourceChatId(candidate) === null
    ? candidate
    : ordered[sourceIndex++]!);
}

/**
 * Preserves the earliest relevance-ranked candidate whenever the current
 * prefix can still keep one source at or below a 25% share. Candidates are
 * deferred, never removed. When fewer than four sources exist, the earliest
 * remaining candidate is used because the target share is mathematically
 * impossible.
 */
export function orderMemoryCandidatesWithSoftSourceDiversity<T>(
  candidates: readonly T[],
  sourceChatId: (candidate: T) => string | null
): readonly T[] {
  const sourceCandidates = candidates.filter((candidate) => sourceChatId(candidate) !== null);
  if (sourceCandidates.length < 2) return candidates;

  const pending = [...sourceCandidates];
  const ordered: T[] = [];
  const selectedBySource = new Map<string, number>();
  while (pending.length > 0) {
    const proposedPosition = ordered.length + 1;
    const maximumPerSource = Math.max(
      1,
      Math.floor(proposedPosition / MEMORY_SOURCE_DIVERSITY_DENOMINATOR)
    );
    const eligibleIndex = pending.findIndex((candidate) => {
      const source = sourceChatId(candidate)!;
      return (selectedBySource.get(source) ?? 0) < maximumPerSource;
    });
    const selectedIndex = eligibleIndex >= 0 ? eligibleIndex : 0;
    const [selected] = pending.splice(selectedIndex, 1);
    const source = sourceChatId(selected!)!;
    selectedBySource.set(source, (selectedBySource.get(source) ?? 0) + 1);
    ordered.push(selected!);
  }

  let sourceIndex = 0;
  return candidates.map((candidate) => sourceChatId(candidate) === null
    ? candidate
    : ordered[sourceIndex++]!);
}
