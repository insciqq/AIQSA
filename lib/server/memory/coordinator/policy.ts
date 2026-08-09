export type MemoryCoordinatorPolicy = Readonly<{
  blockedDeletionRetryMs: number;
  deletionFastRetryDelaysMs: readonly number[];
  heartbeatMs: number;
  intervalMs: number;
  jobRetryDelaysMs: readonly number[];
  leaseMs: number;
  maxDeletionFastAttempts: number;
  maxDeletionParallel: number;
  maxJobAttempts: number;
  maxJobParallel: number;
  reconciliationBatchSize: number;
}>;

export const DEFAULT_MEMORY_COORDINATOR_POLICY: MemoryCoordinatorPolicy = Object.freeze({
  blockedDeletionRetryMs: 15 * 60_000,
  deletionFastRetryDelaysMs: Object.freeze([1_000, 5_000, 30_000]),
  heartbeatMs: 10_000,
  intervalMs: 1_000,
  jobRetryDelaysMs: Object.freeze([1_000, 5_000]),
  leaseMs: 30_000,
  maxDeletionFastAttempts: 3,
  maxDeletionParallel: 1,
  maxJobAttempts: 3,
  maxJobParallel: 2,
  reconciliationBatchSize: 100
});

function boundedInteger(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validDelays(values: readonly number[]): boolean {
  return Array.isArray(values) && values.length >= 1 && values.length <= 10 &&
    values.every((value) => boundedInteger(value, 1, 24 * 60 * 60_000));
}

export function resolveMemoryCoordinatorPolicy(
  input: Partial<MemoryCoordinatorPolicy> = {}
): MemoryCoordinatorPolicy {
  const policy: MemoryCoordinatorPolicy = {
    ...DEFAULT_MEMORY_COORDINATOR_POLICY,
    ...input,
    deletionFastRetryDelaysMs: Object.freeze([
      ...(input.deletionFastRetryDelaysMs ??
        DEFAULT_MEMORY_COORDINATOR_POLICY.deletionFastRetryDelaysMs)
    ]),
    jobRetryDelaysMs: Object.freeze([
      ...(input.jobRetryDelaysMs ?? DEFAULT_MEMORY_COORDINATOR_POLICY.jobRetryDelaysMs)
    ])
  };
  if (
    !boundedInteger(policy.intervalMs, 10, 60_000) ||
    !boundedInteger(policy.leaseMs, 100, 15 * 60_000) ||
    !boundedInteger(policy.heartbeatMs, 10, policy.leaseMs - 1) ||
    !boundedInteger(policy.maxJobAttempts, 1, 20) ||
    !boundedInteger(policy.maxDeletionFastAttempts, 1, 20) ||
    !boundedInteger(policy.maxJobParallel, 1, 16) ||
    !boundedInteger(policy.maxDeletionParallel, 1, 8) ||
    !boundedInteger(policy.reconciliationBatchSize, 1, 1_000) ||
    !boundedInteger(policy.blockedDeletionRetryMs, 1_000, 7 * 24 * 60 * 60_000) ||
    !validDelays(policy.jobRetryDelaysMs) ||
    !validDelays(policy.deletionFastRetryDelaysMs)
  ) {
    throw new Error("memory_coordinator_policy_invalid");
  }
  return Object.freeze(policy);
}

export function memoryRetryDelay(
  delays: readonly number[],
  attemptCount: number
): number {
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)]!;
}
