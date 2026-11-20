/** A wake-up hint only. PostgreSQL remains the receipt and ordering authority. */
const globals = globalThis as typeof globalThis & {
  __aiqsaRunFollowupSubscribers?: Map<string, Set<(revision: number) => void>>;
};
const subscribers = globals.__aiqsaRunFollowupSubscribers ??= new Map<string, Set<(revision: number) => void>>();

/** The user's own follow-up was accepted into `runId`'s answer (`runFollowupHandler.ts`). */
export function notifyRunFollowup(runId: string, revision: number): void {
  for (const listener of [...subscribers.get(runId) ?? []]) listener(revision);
}

/**
 * Hears the user's follow-ups to one run in this process until the returned function is called. A hint: a listener
 * that misses one (another process, a restart) must still end the way it would have without it.
 */
export function subscribeRunFollowups(runId: string, listener: (revision: number) => void): () => void {
  const set = subscribers.get(runId) ?? new Set<(revision: number) => void>();
  set.add(listener);
  subscribers.set(runId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && subscribers.get(runId) === set) subscribers.delete(runId);
  };
}
