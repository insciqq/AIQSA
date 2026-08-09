import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";

const BASE_NOW = new Date("2026-08-10T12:00:00.000Z");
const JOB_KIND = "RECALCULATE_WORKING_SET" as const;
const DELETION_OPERATION = "TEMPORARY_DELETE" as const;

function at(milliseconds: number): Date {
  return new Date(BASE_NOW.getTime() + milliseconds);
}

describe("Prisma Memory coordinator repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rotates owners, fences expired leases, resumes consent, and never abandons deletion", async () => {
    const suffix = randomUUID();
    const ownerA = `memory-coordinator-a-${suffix}`;
    const ownerB = `memory-coordinator-b-${suffix}`;
    const jobA1 = `memory-coordinator-job-a1-${suffix}`;
    const jobA2 = `memory-coordinator-job-a2-${suffix}`;
    const jobB = `memory-coordinator-job-b-${suffix}`;
    const deletionA = `memory-coordinator-deletion-a-${suffix}`;
    const deletionB = `memory-coordinator-deletion-b-${suffix}`;
    const repository = createPrismaMemoryCoordinatorRepository(prisma);

    try {
      await prisma.user.createMany({
        data: [
          {
            displayName: "Memory coordinator A",
            email: `memory-coordinator-a-${suffix}@example.test`,
            id: ownerA,
            status: "active"
          },
          {
            displayName: "Memory coordinator B",
            email: `memory-coordinator-b-${suffix}@example.test`,
            id: ownerB,
            status: "active"
          }
        ]
      });
      await prisma.memoryJob.createMany({
        data: [
          {
            createdAt: at(0),
            id: jobA1,
            idempotencyFingerprint: `a1-${suffix}`,
            kind: JOB_KIND,
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "memory-coordinator-test-v1",
            userId: ownerA
          },
          {
            createdAt: at(1),
            id: jobA2,
            idempotencyFingerprint: `a2-${suffix}`,
            kind: JOB_KIND,
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "memory-coordinator-test-v1",
            userId: ownerA
          },
          {
            createdAt: at(0),
            id: jobB,
            idempotencyFingerprint: `b-${suffix}`,
            kind: JOB_KIND,
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "memory-coordinator-test-v1",
            userId: ownerB
          }
        ]
      });
      await prisma.documentProcessingFairnessCursor.upsert({
        create: { lastGrantedOwnerUserId: ownerA, pipeline: "memory-job" },
        update: { lastGrantedOwnerUserId: ownerA },
        where: { pipeline: "memory-job" }
      });

      const raced = await Promise.all([
        repository.claimJob({
          claimToken: `job-claim-1-${suffix}`,
          kinds: [JOB_KIND],
          leaseExpiresAt: at(1_000),
          now: BASE_NOW
        }),
        repository.claimJob({
          claimToken: `job-claim-2-${suffix}`,
          kinds: [JOB_KIND],
          leaseExpiresAt: at(1_000),
          now: BASE_NOW
        })
      ]);
      expect(raced.every(Boolean)).toBe(true);
      const claims = raced.filter((claim) => claim !== null);
      expect(new Set(claims.map(({ userId }) => userId))).toEqual(new Set([ownerA, ownerB]));
      expect(new Set(claims.map(({ id }) => id)).size).toBe(2);
      const claimA = claims.find(({ userId }) => userId === ownerA)!;
      const claimB = claims.find(({ userId }) => userId === ownerB)!;

      await expect(repository.settleJobGate({
        claim: claimA,
        decision: {
          errorCode: "memory_egress_consent_required",
          status: "WAITING_FOR_EGRESS_CONSENT"
        },
        now: BASE_NOW
      })).resolves.toBe(true);
      await expect(repository.terminalJob({
        claim: claimB,
        errorCode: "memory_job_terminal_test",
        now: BASE_NOW
      })).resolves.toBe(true);
      const waiting = await repository.listWaitingJobs({ kinds: [JOB_KIND], limit: 10 });
      expect(waiting.map(({ id }) => id)).toContain(claimA.id);
      await expect(repository.resolveWaitingJob({
        decision: { status: "READY" },
        job: waiting.find(({ id }) => id === claimA.id)!,
        now: at(10)
      })).resolves.toBe(true);

      const originalLease = await repository.claimJob({
        claimToken: `job-original-${suffix}`,
        kinds: [JOB_KIND],
        leaseExpiresAt: at(1_000),
        now: at(10)
      });
      expect(originalLease).toMatchObject({ id: claimA.id, recoveredLease: false });
      const recoveredLease = await repository.claimJob({
        claimToken: `job-recovered-${suffix}`,
        kinds: [JOB_KIND],
        leaseExpiresAt: at(4_000),
        now: at(2_000)
      });
      expect(recoveredLease).toMatchObject({ id: claimA.id, recoveredLease: true });
      const staleApply = vi.fn(async () => undefined);
      await expect(repository.commitJobSuccess({
        acceptedResultHash: "1".repeat(64),
        apply: staleApply,
        claim: originalLease!,
        now: at(2_000),
        stage: "APPLIED"
      })).resolves.toBe(false);
      expect(staleApply).not.toHaveBeenCalled();
      await expect(repository.commitJobSuccess({
        acceptedResultHash: "2".repeat(64),
        apply: async (tx) => {
          await tx.userMemorySettings.update({
            data: { preferredProfileLanguage: "en" },
            where: { userId: ownerA }
          });
        },
        claim: recoveredLease!,
        now: at(2_100),
        stage: "APPLIED"
      })).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: claimA.id } }))
        .resolves.toMatchObject({
          acceptedResultHash: "2".repeat(64),
          stage: "APPLIED",
          state: "SUCCEEDED"
        });

      await prisma.user.update({
        data: { status: "disabled" },
        where: { id: ownerA }
      });
      await expect(repository.cancelUnavailableJobOwners({
        kinds: [JOB_KIND],
        now: at(2_200)
      })).resolves.toBe(1);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: jobA2 } }))
        .resolves.toMatchObject({
          completedAt: at(2_200),
          errorCode: "memory_owner_unavailable",
          state: "CANCELLED"
        });
      await expect(repository.claimJob({
        claimToken: `job-disabled-owner-${suffix}`,
        kinds: [JOB_KIND],
        leaseExpiresAt: at(3_000),
        now: at(2_200)
      })).resolves.toBeNull();

      await prisma.memoryDeletionOutbox.createMany({
        data: [
          {
            createdAt: at(0),
            id: deletionA,
            memoryGeneration: 0,
            operation: DELETION_OPERATION,
            targetId: `chat-a-${suffix}`,
            targetType: "CHAT",
            userId: ownerA
          },
          {
            createdAt: at(0),
            id: deletionB,
            memoryGeneration: 0,
            operation: DELETION_OPERATION,
            targetId: `chat-b-${suffix}`,
            targetType: "CHAT",
            userId: ownerB
          }
        ]
      });
      await prisma.documentProcessingFairnessCursor.upsert({
        create: { lastGrantedOwnerUserId: ownerA, pipeline: "memory-delete" },
        update: { lastGrantedOwnerUserId: ownerA },
        where: { pipeline: "memory-delete" }
      });
      const deletionClaims = (await Promise.all([
        repository.claimDeletion({
          claimToken: `deletion-claim-1-${suffix}`,
          leaseExpiresAt: at(3_000),
          now: at(2_000),
          operations: [DELETION_OPERATION]
        }),
        repository.claimDeletion({
          claimToken: `deletion-claim-2-${suffix}`,
          leaseExpiresAt: at(3_000),
          now: at(2_000),
          operations: [DELETION_OPERATION]
        })
      ])).filter((claim) => claim !== null);
      expect(new Set(deletionClaims.map(({ userId }) => userId)))
        .toEqual(new Set([ownerA, ownerB]));
      const completedDeletion = deletionClaims.find(({ userId }) => userId === ownerA)!;
      const crashedDeletion = deletionClaims.find(({ userId }) => userId === ownerB)!;
      await expect(repository.commitDeletionSuccess({
        claim: completedDeletion,
        now: at(2_100)
      })).resolves.toBe(true);

      const recoveredDeletion = await repository.claimDeletion({
        claimToken: `deletion-recovered-${suffix}`,
        leaseExpiresAt: at(5_000),
        now: at(4_000),
        operations: [DELETION_OPERATION]
      });
      expect(recoveredDeletion).toMatchObject({
        id: crashedDeletion.id,
        recoveredLease: true,
        resumedFromBlocked: false
      });
      await expect(repository.commitDeletionSuccess({
        claim: crashedDeletion,
        now: at(4_000)
      })).resolves.toBe(false);
      await expect(repository.retryDeletion({
        blocked: false,
        claim: recoveredDeletion!,
        errorCode: "memory_purge_retry_test",
        nextAttemptAt: at(4_100),
        now: at(4_000)
      })).resolves.toBe(true);
      const thirdDeletionAttempt = await repository.claimDeletion({
        claimToken: `deletion-third-${suffix}`,
        leaseExpiresAt: at(6_000),
        now: at(4_100),
        operations: [DELETION_OPERATION]
      });
      expect(thirdDeletionAttempt).toMatchObject({ attemptCount: 3, resumedFromBlocked: false });
      await expect(repository.retryDeletion({
        blocked: true,
        claim: thirdDeletionAttempt!,
        errorCode: "memory_purge_blocked_test",
        nextAttemptAt: at(4_200),
        now: at(4_100)
      })).resolves.toBe(true);
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: crashedDeletion.id }
      })).resolves.toMatchObject({
        errorCode: "memory_purge_blocked_test",
        lastAuditAt: at(4_100),
        state: "BLOCKED_REQUIRES_ADMIN"
      });
      const blockedReconciliation = await repository.claimDeletion({
        claimToken: `deletion-blocked-reconcile-${suffix}`,
        leaseExpiresAt: at(7_000),
        now: at(4_200),
        operations: [DELETION_OPERATION]
      });
      expect(blockedReconciliation).toMatchObject({
        attemptCount: 4,
        id: crashedDeletion.id,
        resumedFromBlocked: true
      });
      await expect(repository.commitDeletionSuccess({
        claim: blockedReconciliation!,
        now: at(4_300)
      })).resolves.toBe(true);
      const deletionRows = await prisma.memoryDeletionOutbox.findMany({
        where: { id: { in: [deletionA, deletionB] } }
      });
      expect(deletionRows).toHaveLength(2);
      expect(deletionRows.every(({ state }) => state === "SUCCEEDED")).toBe(true);
    } finally {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: [ownerA, ownerB] } } });
      await prisma.memoryJob.deleteMany({ where: { userId: { in: [ownerA, ownerB] } } });
      await prisma.documentProcessingFairnessCursor.deleteMany({
        where: { pipeline: { in: ["memory-job", "memory-delete"] } }
      });
      await prisma.user.deleteMany({ where: { id: { in: [ownerA, ownerB] } } });
    }
  });
});
