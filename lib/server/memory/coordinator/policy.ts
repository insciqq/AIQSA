export type MemoryCoordinatorPolicy = Readonly<{
  blockedDeletionRetryMs: number;
  deletionFastRetryDelaysMs: readonly number[];
  heartbeatMs: number;
  intervalMs: number;
  jobRetryDelaysMs: readonly number[];
  leaseMs: number;
  maxDeletionClaimsPerWorkerPass: number;
  maxDeletionFastAttempts: number;
  maxDeletionParallel: number;
  maxJobAttempts: number;
  maxJobClaimsPerWorkerPass: number;
  maxJobParallel: number;
  maxJobParallelPerUser: number;
  reconciliationBatchSize: number;
}>;

export const DEFAULT_MEMORY_COORDINATOR_POLICY: MemoryCoordinatorPolicy = Object.freeze({
  blockedDeletionRetryMs: 15 * 60_000,
  deletionFastRetryDelaysMs: Object.freeze([1_000, 5_000, 30_000]),
  heartbeatMs: 10_000,
  intervalMs: 1_000,
  jobRetryDelaysMs: Object.freeze([1_000, 5_000]),
  leaseMs: 30_000,
  maxDeletionClaimsPerWorkerPass: 64,
  maxDeletionFastAttempts: 3,
  maxDeletionParallel: 1,
  maxJobAttempts: 3,
  maxJobClaimsPerWorkerPass: 16,
  maxJobParallel: 2,
  maxJobParallelPerUser: 1,
  reconciliationBatchSize: 100
});

const ENVIRONMENT_POLICY_FIELDS = Object.freeze({
  AIQSA_MEMORY_COORDINATOR_INTERVAL_MS: Object.freeze({
    field: "intervalMs" as const,
    max: 60_000,
    min: 1_000
  }),
  AIQSA_MEMORY_COORDINATOR_LEASE_MS: Object.freeze({
    field: "leaseMs" as const,
    max: 15 * 60_000,
    min: 100
  }),
  AIQSA_MEMORY_DELETION_CLAIMS_PER_PASS: Object.freeze({
    field: "maxDeletionClaimsPerWorkerPass" as const,
    max: 1_000,
    min: 1
  }),
  AIQSA_MEMORY_DELETION_PARALLELISM: Object.freeze({
    field: "maxDeletionParallel" as const,
    max: 8,
    min: 1
  }),
  AIQSA_MEMORY_JOB_CLAIMS_PER_PASS: Object.freeze({
    field: "maxJobClaimsPerWorkerPass" as const,
    max: 1_000,
    min: 1
  }),
  AIQSA_MEMORY_JOB_PARALLELISM: Object.freeze({
    field: "maxJobParallel" as const,
    max: 16,
    min: 1
  }),
  AIQSA_MEMORY_JOB_PER_USER_PARALLELISM: Object.freeze({
    field: "maxJobParallelPerUser" as const,
    max: 16,
    min: 1
  })
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
    !boundedInteger(policy.maxJobParallelPerUser, 1, policy.maxJobParallel) ||
    !boundedInteger(policy.maxDeletionParallel, 1, 8) ||
    !boundedInteger(policy.maxJobClaimsPerWorkerPass, 1, 1_000) ||
    !boundedInteger(policy.maxDeletionClaimsPerWorkerPass, 1, 1_000) ||
    !boundedInteger(policy.reconciliationBatchSize, 1, 1_000) ||
    !boundedInteger(policy.blockedDeletionRetryMs, 1_000, 7 * 24 * 60 * 60_000) ||
    !validDelays(policy.jobRetryDelaysMs) ||
    !validDelays(policy.deletionFastRetryDelaysMs)
  ) {
    throw new Error("memory_coordinator_policy_invalid");
  }
  return Object.freeze(policy);
}

export function loadMemoryCoordinatorPolicy(
  env: Record<string, string | undefined> = process.env
): MemoryCoordinatorPolicy {
  const input: Partial<MemoryCoordinatorPolicy> = {};
  for (const [name, config] of Object.entries(ENVIRONMENT_POLICY_FIELDS)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
      throw new Error("memory_coordinator_policy_environment_invalid");
    }
    const value = Number(raw);
    if (!boundedInteger(value, config.min, config.max)) {
      throw new Error("memory_coordinator_policy_environment_invalid");
    }
    Object.assign(input, { [config.field]: value });
  }
  try {
    return resolveMemoryCoordinatorPolicy(input);
  } catch {
    throw new Error("memory_coordinator_policy_environment_invalid");
  }
}

export function memoryRetryDelay(
  delays: readonly number[],
  attemptCount: number
): number {
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)]!;
}
