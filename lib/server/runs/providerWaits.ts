import type { RunProviderWait } from "../../contracts/runs";

/**
 * What a running model request is waiting on its provider for, by run. The live
 * stream carries the same fact; this is for a reader that lost that stream, such
 * as a phone that returned to the app (operator decision 2026-10-31). It is a
 * status line, so it stays in memory: a restart only returns the line to the
 * waiting phrase, and a provider outage never waits on a database write. One
 * object per process (`globalThis`), shared by the engine's bundle and the routes'.
 */
const WAITS = Symbol.for("aiqsa.runProviderWaits");
const shared = globalThis as typeof globalThis & { [WAITS]?: Map<string, RunProviderWait> };
const waits = shared[WAITS] ??= new Map<string, RunProviderWait>();

export function setRunProviderWait(runId: string, wait: RunProviderWait | null): void {
  if (wait) waits.set(runId, wait);
  else waits.delete(runId);
}

export function runProviderWait(runId: string): RunProviderWait | null {
  return waits.get(runId) ?? null;
}
