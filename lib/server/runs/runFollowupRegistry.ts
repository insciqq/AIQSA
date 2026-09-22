/** A wake-up hint only. PostgreSQL remains the receipt and ordering authority. */
const globals = globalThis as typeof globalThis & {
  __aiqsaRunFollowupListeners?: Map<string, (revision: number) => void>;
};
const listeners = globals.__aiqsaRunFollowupListeners ??= new Map<string, (revision: number) => void>();

export function notifyRunFollowup(runId: string, revision: number): void {
  listeners.get(runId)?.(revision);
}

export function subscribeRunFollowup(runId: string, listener: (revision: number) => void): () => void {
  if (listeners.has(runId)) throw new Error("run_followup_executor_conflict");
  listeners.set(runId, listener);
  return () => { if (listeners.get(runId) === listener) listeners.delete(runId); };
}
