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

export function memoryCoordinatorError(
  code: string,
  retryable = true
): MemoryCoordinatorError {
  return new MemoryCoordinatorError(code, retryable);
}
