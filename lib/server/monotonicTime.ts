/**
 * Wall-clock timestamps and in-process elapsed time have different owners.
 * `performance.now()` is monotonic and therefore cannot turn a duration
 * negative when the host clock is corrected while an operation is running.
 */
export function monotonicNowMilliseconds(): number {
  return performance.now();
}

/** Convert a monotonic interval to the non-negative integer wire contract. */
export function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  const elapsed = endedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(Math.floor(elapsed), Number.MAX_SAFE_INTEGER);
}
