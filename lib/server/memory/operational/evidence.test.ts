import { describe, expect, it } from "vitest";
import {
  MEMORY_OPERATIONAL_QUEUE_EVIDENCE_VERSION,
  memoryOperationalQueueEvidenceSchema
} from "./evidence";

function validEvidence() {
  return {
    cgroupCpuLimit: 2,
    cgroupMemoryLimitBytes: 2_147_483_648,
    claimLatencyP95Ms: 20,
    claimedJobCount: 96,
    defaultJobParallelism: 2,
    defaultOwnerParallelism: 1,
    evidenceVersion: MEMORY_OPERATIONAL_QUEUE_EVIDENCE_VERSION,
    finalQueuedJobCount: 0,
    initialQueuedJobCount: 96,
    maxClaimsPerWorkerPass: 16,
    maxConsecutiveOwnerClaims: 1,
    maximumCgroupCpuLimit: 2,
    maximumCgroupMemoryLimitBytes: 2_147_483_648,
    maximumClaimLatencyP95Ms: 1_000,
    maximumConcurrentClaimRequests: 2,
    maximumQueueLagMs: 15 * 60_000,
    maximumRssGrowthBytes: 268_435_456,
    oldestQueueLagMs: 300_000,
    ownerCount: 24,
    peakRssBytes: 256_000_000,
    recoveredLeaseCount: 1,
    rssGrowthBytes: 32_000_000,
    sanitizedAggregatesOnly: true,
    tenantCoverageFirstTurnCount: 24,
    usageBindingCount: 4,
    usageCompleteCount: 4,
    usageIncompleteCount: 0
  } as const;
}

describe("Memory operational queue evidence", () => {
  it("accepts bounded aggregate-only evidence", () => {
    expect(memoryOperationalQueueEvidenceSchema.parse(validEvidence()))
      .toEqual(validEvidence());
  });

  it.each(["userId", "query", "sourceText", "providerBody"])(
    "rejects private or identifying field %s",
    (field) => {
      expect(memoryOperationalQueueEvidenceSchema.safeParse({
        ...validEvidence(),
        [field]: "private"
      }).success).toBe(false);
    }
  );

  it("rejects unreconciled or out-of-bound measurements", () => {
    expect(memoryOperationalQueueEvidenceSchema.safeParse({
      ...validEvidence(),
      claimLatencyP95Ms: 1_001
    }).success).toBe(false);
    expect(memoryOperationalQueueEvidenceSchema.safeParse({
      ...validEvidence(),
      usageIncompleteCount: 1
    }).success).toBe(false);
    expect(memoryOperationalQueueEvidenceSchema.safeParse({
      ...validEvidence(),
      peakRssBytes: 3_000_000_000
    }).success).toBe(false);
  });
});
