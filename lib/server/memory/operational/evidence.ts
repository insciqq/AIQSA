import { z } from "zod";

export const MEMORY_OPERATIONAL_QUEUE_EVIDENCE_VERSION =
  "memory-phase8-operational-queue-v1";

const boundedCount = z.number().int().nonnegative().max(1_000_000);
const boundedMilliseconds = z.number().finite().nonnegative().max(24 * 60 * 60_000);
const boundedBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const memoryOperationalQueueEvidenceSchema = z.object({
  cgroupCpuLimit: z.number().finite().positive().max(64),
  cgroupMemoryLimitBytes: boundedBytes,
  claimLatencyP95Ms: boundedMilliseconds,
  claimedJobCount: boundedCount,
  defaultJobParallelism: z.number().int().min(1).max(16),
  defaultOwnerParallelism: z.number().int().min(1).max(16),
  evidenceVersion: z.literal(MEMORY_OPERATIONAL_QUEUE_EVIDENCE_VERSION),
  finalQueuedJobCount: boundedCount,
  initialQueuedJobCount: boundedCount,
  maxClaimsPerWorkerPass: z.number().int().min(1).max(1_000),
  maxConsecutiveOwnerClaims: boundedCount,
  maximumCgroupCpuLimit: z.number().finite().positive().max(64),
  maximumCgroupMemoryLimitBytes: boundedBytes,
  maximumClaimLatencyP95Ms: boundedMilliseconds,
  maximumConcurrentClaimRequests: z.number().int().min(1).max(16),
  maximumQueueLagMs: boundedMilliseconds,
  maximumRssGrowthBytes: boundedBytes,
  oldestQueueLagMs: boundedMilliseconds,
  ownerCount: z.number().int().min(2).max(1_000),
  peakRssBytes: boundedBytes,
  recoveredLeaseCount: boundedCount,
  rssGrowthBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sanitizedAggregatesOnly: z.literal(true),
  tenantCoverageFirstTurnCount: boundedCount,
  usageBindingCount: boundedCount,
  usageCompleteCount: boundedCount,
  usageIncompleteCount: boundedCount
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.claimedJobCount > value.initialQueuedJobCount) {
    issue("claimed jobs exceed the initial queue");
  }
  if (value.finalQueuedJobCount !== value.initialQueuedJobCount - value.claimedJobCount) {
    issue("final queue count does not reconcile");
  }
  if (value.recoveredLeaseCount > value.claimedJobCount) {
    issue("recovered leases exceed claims");
  }
  if (value.defaultOwnerParallelism > value.defaultJobParallelism) {
    issue("owner parallelism exceeds worker parallelism");
  }
  if (value.maximumConcurrentClaimRequests > value.defaultJobParallelism) {
    issue("claim concurrency exceeds worker parallelism");
  }
  if (value.tenantCoverageFirstTurnCount > value.ownerCount) {
    issue("tenant coverage exceeds owners");
  }
  if (value.claimLatencyP95Ms > value.maximumClaimLatencyP95Ms) {
    issue("claim latency exceeds the declared bound");
  }
  if (value.cgroupCpuLimit > value.maximumCgroupCpuLimit) {
    issue("cgroup CPU limit exceeds the declared bound");
  }
  if (value.cgroupMemoryLimitBytes > value.maximumCgroupMemoryLimitBytes) {
    issue("cgroup memory limit exceeds the declared bound");
  }
  if (value.oldestQueueLagMs > value.maximumQueueLagMs) {
    issue("queue lag exceeds the declared bound");
  }
  if (value.peakRssBytes > value.cgroupMemoryLimitBytes) {
    issue("peak RSS exceeds the cgroup limit");
  }
  if (value.rssGrowthBytes > value.maximumRssGrowthBytes) {
    issue("RSS growth exceeds the declared bound");
  }
  if (value.usageCompleteCount + value.usageIncompleteCount !==
    value.usageBindingCount) {
    issue("usage completeness counts do not reconcile");
  }
});

export type MemoryOperationalQueueEvidence = z.infer<
  typeof memoryOperationalQueueEvidenceSchema
>;
