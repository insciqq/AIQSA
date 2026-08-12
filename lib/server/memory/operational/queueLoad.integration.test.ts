import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { MemoryJobKind } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { resolveMemoryCoordinatorPolicy } from "../coordinator/policy";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import {
  createEmptyMemorySchedulerUsageSource,
  createPrismaMemorySchedulerUsageSource,
  MemoryScheduler
} from "../coordinator/scheduler";
import {
  MEMORY_OPERATIONAL_QUEUE_EVIDENCE_VERSION,
  memoryOperationalQueueEvidenceSchema
} from "./evidence";

const describeOperational =
  process.env.AIQSA_MEMORY_OPERATIONAL_INTEGRATION_TEST === "1"
    ? describe
    : describe.skip;

const OWNER_COUNT = 24;
const MAXIMUM_CGROUP_MEMORY_BYTES = 2 * 1_024 * 1_024 * 1_024;
const MAXIMUM_RSS_GROWTH_BYTES = 256 * 1_024 * 1_024;
const MAXIMUM_QUEUE_LAG_MS = 15 * 60_000;
const MAXIMUM_CLAIM_LATENCY_P95_MS = 1_000;
const JOB_KINDS = Object.freeze([
  "RECONCILE_SOURCE",
  "INDEX_HISTORY",
  "GLOBAL_DREAM",
  "RECALCULATE_WORKING_SET"
] satisfies readonly MemoryJobKind[]);

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function maximumConsecutive(values: readonly string[]): number {
  let maximum = 0;
  let previous: string | null = null;
  let run = 0;
  for (const value of values) {
    run = value === previous ? run + 1 : 1;
    previous = value;
    maximum = Math.max(maximum, run);
  }
  return maximum;
}

function readCgroupValue(paths: readonly string[]): string {
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next cgroup layout.
    }
  }
  throw new Error("memory_operational_cgroup_limit_unavailable");
}

function readCgroupMemoryLimitBytes(): number {
  const raw = readCgroupValue([
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes"
  ]);
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error("memory_operational_cgroup_memory_unbounded");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("memory_operational_cgroup_memory_invalid");
  }
  return value;
}

function readCgroupCpuLimit(): number {
  try {
    const [quotaText, periodText] = readCgroupValue([
      "/sys/fs/cgroup/cpu.max"
    ]).split(/\s+/u);
    if (quotaText === "max") {
      throw new Error("memory_operational_cgroup_cpu_unbounded");
    }
    const quota = Number(quotaText);
    const period = Number(periodText);
    const limit = quota / period;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("memory_operational_cgroup_cpu_invalid");
    }
    return limit;
  } catch (error) {
    if (error instanceof Error &&
      error.message === "memory_operational_cgroup_cpu_unbounded") {
      throw error;
    }
    const quota = Number(readCgroupValue([
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"
    ]));
    const period = Number(readCgroupValue([
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us"
    ]));
    const limit = quota / period;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error("memory_operational_cgroup_cpu_invalid");
    }
    return limit;
  }
}

describeOperational("Memory operational queue load", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("bounds multi-owner load and recovers an expired claim without private evidence", async () => {
    const suffix = randomUUID();
    const now = new Date();
    const ownerIds = Array.from(
      { length: OWNER_COUNT },
      (_, index) => `memory-operational-owner-${index}-${suffix}`
    );
    const jobs = ownerIds.flatMap((userId, ownerIndex) =>
      JOB_KINDS.map((kind, kindIndex) => ({
        createdAt: new Date(now.getTime() - 5 * 60_000 + ownerIndex * 10 + kindIndex),
        id: `memory-operational-job-${ownerIndex}-${kindIndex}-${suffix}`,
        idempotencyFingerprint: `operational-${ownerIndex}-${kindIndex}-${suffix}`,
        kind,
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        pipelineVersion: "memory-operational-load-v1",
        userId
      }))
    );
    const recoveryJobId = jobs[0]!.id;
    const cursorBefore = await prisma.documentProcessingFairnessCursor.findUnique({
      where: { pipeline: "memory-job" }
    });
    const policy = resolveMemoryCoordinatorPolicy();
    const repository = createPrismaMemoryCoordinatorRepository(prisma);
    const scheduler = new MemoryScheduler({
      policy,
      usageSource: createEmptyMemorySchedulerUsageSource()
    });
    const rssStart = process.memoryUsage().rss;
    let peakRssBytes = rssStart;

    try {
      await prisma.user.createMany({
        data: ownerIds.map((id, index) => ({
          displayName: `Memory operational owner ${index}`,
          email: `memory-operational-${index}-${suffix}@example.test`,
          id,
          status: "active" as const
        }))
      });
      await prisma.memoryJob.createMany({ data: jobs });
      await prisma.memoryJob.update({
        data: {
          attemptCount: 1,
          leaseExpiresAt: new Date(now.getTime() - 1_000),
          leaseToken: `memory-operational-expired-${suffix}`,
          state: "CLAIMED"
        },
        where: { id: recoveryJobId }
      });
      await prisma.documentProcessingFairnessCursor.upsert({
        create: {
          lastGrantedOwnerUserId: ownerIds[0],
          pipeline: "memory-job"
        },
        update: { lastGrantedOwnerUserId: ownerIds[0] },
        where: { pipeline: "memory-job" }
      });

      const eligibleRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS "count"
        FROM "MemoryJob" AS job
        INNER JOIN "User" AS owner_user ON owner_user."id" = job."userId"
        WHERE owner_user."status" = 'active'::"UserStatus"
          AND job."kind" IN (
            'RECONCILE_SOURCE'::"MemoryJobKind",
            'INDEX_HISTORY'::"MemoryJobKind",
            'GLOBAL_DREAM'::"MemoryJobKind",
            'RECALCULATE_WORKING_SET'::"MemoryJobKind"
          )
          AND (
            (job."state" = 'QUEUED'::"MemoryJobState"
              AND (job."nextAttemptAt" IS NULL OR job."nextAttemptAt" <= ${now}))
            OR (job."state" = 'CLAIMED'::"MemoryJobState"
              AND job."leaseExpiresAt" <= ${now})
          )
      `;
      if (Number(eligibleRows[0]?.count ?? -1n) !== jobs.length) {
        throw new Error("memory_operational_queue_requires_isolated_database");
      }

      const claimLatencies: number[] = [];
      const claims: Array<{
        id: string;
        recoveredLease: boolean;
        userId: string;
      }> = [];
      for (let offset = 0; offset < jobs.length; offset += policy.maxJobParallel) {
        const ordinals = Array.from(
          { length: Math.min(policy.maxJobParallel, jobs.length - offset) },
          (_, index) => offset + index
        );
        const waveSets = ordinals.map(() => scheduler.claimWaves(JOB_KINDS));
        const batch = await Promise.all(ordinals.map(async (ordinal, index) => {
          const started = performance.now();
          for (const wave of waveSets[index]!) {
            const claim = await repository.claimJob({
              claimToken: `memory-operational-claim-${ordinal}-${suffix}`,
              kinds: wave,
              leaseExpiresAt: new Date(now.getTime() + 10 * 60_000),
              now
            });
            if (claim) {
              claimLatencies.push(performance.now() - started);
              return claim;
            }
          }
          throw new Error("memory_operational_claim_unavailable");
        }));
        claims.push(...batch);
        await Promise.all(batch.map((claim, index) => repository.terminalJob({
          claim,
          errorCode: "memory_operational_load_complete",
          now: new Date(now.getTime() + offset + index + 1)
        })));
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }

      const usageAt = new Date();
      const usageJobs = jobs.filter(({ kind }) => kind === "GLOBAL_DREAM").slice(0, 4);
      await prisma.memoryExecutionBinding.createMany({
        data: usageJobs.map((job, index) => ({
          acceptedOutputHash: `memory-operational-output-${index}`,
          cachedInputTokens: 0,
          completedAt: usageAt,
          createdAt: usageAt,
          destinationFingerprint: "memory-operational-destination-v1",
          estimatedCostMicros: 10 + index,
          id: `memory-operational-binding-${index}-${suffix}`,
          inputHash: `memory-operational-input-${index}-${suffix}`,
          inputTokens: 10,
          logicalRole: "MEMORY_PROFILE",
          memoryJobId: job.id,
          ordinal: 0,
          outputTokens: 5,
          ownerType: "JOB" as const,
          pipelineVersion: "memory-operational-load-v1",
          policyVersion: "memory-operational-load-v1",
          promptVersion: "memory-operational-load-v1",
          providerId: "memory-operational-fixture",
          reasoningTokens: 0,
          recoverableUntil: usageAt,
          relationsDetachedAt: usageAt,
          schemaVersion: "memory-operational-load-v1",
          secretFreeExecutionSnapshot: {},
          startedAt: usageAt,
          state: "SUCCEEDED" as const,
          totalTokens: 15,
          usageCompleteness: "COMPLETE" as const,
          userId: job.userId
        }))
      });
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

      const windowStart = new Date(Date.UTC(
        usageAt.getUTCFullYear(),
        usageAt.getUTCMonth(),
        usageAt.getUTCDate()
      ));
      const dailyUsage = await createPrismaMemorySchedulerUsageSource(prisma)
        .readDailyBackgroundUsage({
          windowEnd: new Date(windowStart.getTime() + 24 * 60 * 60_000),
          windowStart
        });
      const fixtureUsageCalls = ownerIds.reduce(
        (total, ownerId) => total + (dailyUsage.users.get(ownerId)?.calls ?? 0),
        0
      );
      expect(fixtureUsageCalls).toBe(usageJobs.length);

      const usageBindingCount = await prisma.memoryExecutionBinding.count({
        where: { userId: { in: ownerIds } }
      });
      const usageCompleteCount = await prisma.memoryExecutionBinding.count({
        where: {
          usageCompleteness: "COMPLETE",
          userId: { in: ownerIds }
        }
      });
      const finalQueuedJobCount = await prisma.memoryJob.count({
        where: {
          id: { in: jobs.map(({ id }) => id) },
          state: { in: ["QUEUED", "CLAIMED", "RETRYABLE_FAILED"] }
        }
      });
      const evidence = memoryOperationalQueueEvidenceSchema.parse({
        cgroupCpuLimit: readCgroupCpuLimit(),
        cgroupMemoryLimitBytes: readCgroupMemoryLimitBytes(),
        claimLatencyP95Ms: Number(percentile95(claimLatencies).toFixed(2)),
        claimedJobCount: claims.length,
        defaultJobParallelism: policy.maxJobParallel,
        defaultOwnerParallelism: policy.maxJobParallelPerUser,
        evidenceVersion: MEMORY_OPERATIONAL_QUEUE_EVIDENCE_VERSION,
        finalQueuedJobCount,
        initialQueuedJobCount: jobs.length,
        maxClaimsPerWorkerPass: policy.maxJobClaimsPerWorkerPass,
        maxConsecutiveOwnerClaims: maximumConsecutive(
          claims.map(({ userId }) => userId)
        ),
        maximumCgroupCpuLimit: 2,
        maximumCgroupMemoryLimitBytes: MAXIMUM_CGROUP_MEMORY_BYTES,
        maximumClaimLatencyP95Ms: MAXIMUM_CLAIM_LATENCY_P95_MS,
        maximumConcurrentClaimRequests: policy.maxJobParallel,
        maximumQueueLagMs: MAXIMUM_QUEUE_LAG_MS,
        maximumRssGrowthBytes: MAXIMUM_RSS_GROWTH_BYTES,
        oldestQueueLagMs: Math.max(...jobs.map(({ createdAt }) =>
          now.getTime() - createdAt.getTime())),
        ownerCount: ownerIds.length,
        peakRssBytes,
        recoveredLeaseCount: claims.filter(({ recoveredLease }) => recoveredLease).length,
        rssGrowthBytes: Math.max(0, peakRssBytes - rssStart),
        sanitizedAggregatesOnly: true,
        tenantCoverageFirstTurnCount: new Set(
          claims.slice(0, OWNER_COUNT).map(({ userId }) => userId)
        ).size,
        usageBindingCount,
        usageCompleteCount,
        usageIncompleteCount: usageBindingCount - usageCompleteCount
      });

      expect(evidence).toMatchObject({
        claimedJobCount: jobs.length,
        defaultJobParallelism: 2,
        defaultOwnerParallelism: 1,
        finalQueuedJobCount: 0,
        maxClaimsPerWorkerPass: 16,
        recoveredLeaseCount: 1,
        sanitizedAggregatesOnly: true,
        tenantCoverageFirstTurnCount: OWNER_COUNT,
        usageBindingCount: usageJobs.length,
        usageCompleteCount: usageJobs.length,
        usageIncompleteCount: 0
      });
      expect(evidence.maxConsecutiveOwnerClaims).toBe(1);
      expect(JSON.stringify(evidence)).not.toContain(suffix);
      expect(JSON.stringify(evidence)).not.toContain(ownerIds[0]);
      console.info("memory_phase8_operational_queue", evidence);
    } finally {
      await prisma.memoryExecutionBinding.deleteMany({
        where: { userId: { in: ownerIds } }
      });
      await prisma.memoryJob.deleteMany({ where: { userId: { in: ownerIds } } });
      if (cursorBefore) {
        await prisma.documentProcessingFairnessCursor.upsert({
          create: {
            lastGrantedOwnerUserId: cursorBefore.lastGrantedOwnerUserId,
            pipeline: "memory-job"
          },
          update: { lastGrantedOwnerUserId: cursorBefore.lastGrantedOwnerUserId },
          where: { pipeline: "memory-job" }
        });
      } else {
        await prisma.documentProcessingFairnessCursor.deleteMany({
          where: { pipeline: "memory-job" }
        });
      }
      await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    }
  }, 120_000);
});
