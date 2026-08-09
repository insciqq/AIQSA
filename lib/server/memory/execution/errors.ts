export const MEMORY_EXECUTION_ERROR_CODES = [
  "memory_execution_binding_conflict",
  "memory_execution_binding_not_found",
  "memory_execution_capability_unavailable",
  "memory_execution_egress_consent_required",
  "memory_execution_input_invalid",
  "memory_execution_output_invalid",
  "memory_execution_policy_drift",
  "memory_execution_policy_unavailable",
  "memory_execution_qualification_required",
  "memory_execution_recovery_expired",
  "memory_execution_snapshot_invalid",
  "memory_execution_state_conflict",
  "memory_execution_target_unavailable",
  "memory_execution_usage_invalid"
] as const;

export type MemoryExecutionErrorCode = (typeof MEMORY_EXECUTION_ERROR_CODES)[number];

/** Stable, content-free failures only. Provider bodies, private input, and
 * credential material must never be attached to this error. */
export class MemoryExecutionError extends Error {
  readonly code: MemoryExecutionErrorCode;

  constructor(code: MemoryExecutionErrorCode) {
    super(code);
    this.name = "MemoryExecutionError";
    this.code = code;
  }
}

export function memoryExecutionFailure(code: MemoryExecutionErrorCode): never {
  throw new MemoryExecutionError(code);
}
