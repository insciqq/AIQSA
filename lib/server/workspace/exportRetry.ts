import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { databaseFailureKind, type DatabaseFailureKind } from "../observability/databaseFailure";
import { WorkspaceRuntimeError } from "./runtime";

/**
 * A database failure that rolled an export step's whole transaction back, or
 * never started it: a bounded lock wait (55P03), an expired or unstartable
 * interactive transaction (P2028), a serialization conflict (40001/P2034) or
 * a deadlock (40P01). Nothing the step wrote survived, so the same step may
 * run again. Anything else is final for the step, an application refusal
 * included, whatever cause it keeps.
 */
export function rollbackSafeExportFailure(error: unknown): DatabaseFailureKind | null {
  if (error instanceof WorkspaceRuntimeError) return null;
  const kind = databaseFailureKind(error);
  return kind === undefined || kind === "statement_timeout" ? null : kind;
}

export const WORKSPACE_EXPORT_RETRY_BASE_DELAY_MS = 100;
export const WORKSPACE_EXPORT_RETRY_MAX_DELAY_MS = 2_000;

/** Full jitter before retry `retry` (1-based): uniform over 1 ms to
 * min(maximum, base * 2^(retry - 1)), so competing exports spread out. */
export function workspaceExportRetryDelayMs(
  retry: number,
  random: (minimum: number, maximumExclusive: number) => number = randomInt
): number {
  const ceiling = Math.min(WORKSPACE_EXPORT_RETRY_MAX_DELAY_MS,
    WORKSPACE_EXPORT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retry - 1));
  return random(1, ceiling + 1);
}

export type WorkspaceExportRetry = Readonly<{
  delayMs: number;
  error: unknown;
  kind: DatabaseFailureKind;
  /** The attempt that just failed, from 1. */
  retry: number;
}>;

/**
 * Runs one export database step, and runs it again after each rollback-safe
 * failure while the export's lease is still valid when the next attempt
 * starts and its signal is not aborted. A lease renewed meanwhile extends
 * the window. Any other failure, or the last one, is thrown unchanged, so its
 * database cause stays with it.
 */
export async function retryWorkspaceExportStep<T>(
  step: () => Promise<T>,
  options: Readonly<{
    /** Until this time (ms since the epoch) the export's lease is valid. */
    leaseValidUntil: () => number;
    onRetry?: (retry: WorkspaceExportRetry) => void;
    signal?: AbortSignal;
    now?: () => number;
    delayMs?: (retry: number) => number;
    wait?: (delayMs: number, signal?: AbortSignal) => Promise<unknown>;
  }>
): Promise<T> {
  const now = options.now ?? Date.now;
  for (let retry = 1; ; retry += 1) {
    try {
      return await step();
    } catch (error) {
      const kind = rollbackSafeExportFailure(error);
      if (kind === null || options.signal?.aborted) throw error;
      const delayMs = (options.delayMs ?? workspaceExportRetryDelayMs)(retry);
      if (now() + delayMs >= options.leaseValidUntil()) throw error;
      options.onRetry?.({ delayMs, error, kind, retry });
      try {
        await (options.wait ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal })))(delayMs, options.signal);
      } catch {
        // Stop or a lost lease ends the pause; the step reports its own failure.
        throw error;
      }
      if (options.signal?.aborted) throw error;
    }
  }
}
