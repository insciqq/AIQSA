import type { MemoryJobFenceDecision } from "./types";

const safeCode = /^[a-z][a-z0-9_]{0,63}$/u;

export function isMemoryCoordinatorErrorCode(value: unknown): value is string {
  return typeof value === "string" && safeCode.test(value);
}

/** Content-free coordinator failure. Private source/provider text must never
 * be attached to queue state, logs, or this error. */
export class MemoryCoordinatorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true
  ) {
    super(isMemoryCoordinatorErrorCode(code) ? code : "memory_coordinator_failed");
    this.name = "MemoryCoordinatorError";
    this.code = this.message;
  }
}

/** Running work that lost its source, generation, settings or lifecycle
 * authority, which a committed read proved. The coordinator settles the
 * re-run gate's STALE/CANCELLED decision, or this one when the gate cannot
 * decide. Only a gate that still accepts the claim keeps `code` terminal. */
export class MemoryJobFencedError extends MemoryCoordinatorError {
  readonly decision: MemoryJobFenceDecision;

  constructor(code: string, decision: MemoryJobFenceDecision) {
    super(code, false);
    this.name = "MemoryJobFencedError";
    this.decision = Object.freeze({
      errorCode: isMemoryCoordinatorErrorCode(decision.errorCode)
        ? decision.errorCode
        : "memory_source_stale",
      status: decision.status === "CANCELLED" ? "CANCELLED" : "STALE"
    });
  }
}
