import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import { resolveMemoryCoordinatorPolicy } from "./policy";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import {
  createEmptyMemorySchedulerUsageSource,
  createPrismaMemorySchedulerUsageSource,
  MemoryScheduler
} from "./scheduler";

const BASE_NOW = new Date("2026-08-10T12:00:00.000Z");
const JOB_KIND = "RECALCULATE_WORKING_SET" as const;
const DELETION_OPERATION = "TEMPORARY_DELETE" as const;
const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1_536,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_536
  },
  modelClass: "embedding",
  upstreamModelId: "memory-scheduler-test-embedding"
} as const;

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

  it("lease-fences budget deferral without consuming a provider retry", async () => {
    const suffix = randomUUID();
    const userId = `memory-scheduler-defer-owner-${suffix}`;
    const jobId = `memory-scheduler-defer-job-${suffix}`;
    const repository = createPrismaMemoryCoordinatorRepository(prisma);

    try {
      await prisma.user.create({
        data: {
          displayName: "Memory scheduler deferral owner",
          email: `memory-scheduler-defer-${suffix}@example.test`,
          id: userId,
          status: "active"
        }
      });
      await prisma.memoryJob.create({
        data: {
          createdAt: BASE_NOW,
          id: jobId,
          idempotencyFingerprint: `scheduler-defer-${suffix}`,
          kind: "GLOBAL_DREAM",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "memory-scheduler-test-v1",
          userId
        }
      });
      const claimed = await repository.claimJob({
        claimToken: `scheduler-defer-claim-${suffix}`,
        kinds: ["GLOBAL_DREAM"],
        leaseExpiresAt: at(1_000),
        now: BASE_NOW
      });
      expect(claimed).toMatchObject({ attemptCount: 1, id: jobId });

      await expect(repository.deferJob({
        claim: { ...claimed!, claimToken: `stale-${suffix}` },
        errorCode: "memory_scheduler_budget_deferred",
        nextAttemptAt: at(10_000),
        now: at(100)
      })).resolves.toBe(false);
      await expect(repository.deferJob({
        claim: claimed!,
        errorCode: "memory_scheduler_budget_deferred",
        nextAttemptAt: at(10_000),
        now: at(100)
      })).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: jobId } }))
        .resolves.toMatchObject({
          attemptCount: 0,
          errorCode: "memory_scheduler_budget_deferred",
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: at(10_000),
          state: "RETRYABLE_FAILED"
        });
      await expect(repository.requeueDueJobs({
        kinds: ["GLOBAL_DREAM"],
        now: at(10_000)
      })).resolves.toBe(1);
      await expect(repository.claimJob({
        claimToken: `scheduler-defer-reclaim-${suffix}`,
        kinds: ["GLOBAL_DREAM"],
        leaseExpiresAt: at(12_000),
        now: at(10_000)
      })).resolves.toMatchObject({ attemptCount: 1, id: jobId });
    } finally {
      await prisma.memoryJob.deleteMany({ where: { userId } });
      await prisma.documentProcessingFairnessCursor.deleteMany({
        where: { pipeline: "memory-job" }
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("aggregates only background execution counters inside the UTC window", async () => {
    const suffix = randomUUID();
    const userId = `memory-scheduler-usage-owner-${suffix}`;
    const connectionId = `memory-scheduler-connection-${suffix}`;
    const credentialId = `memory-scheduler-credential-${suffix}`;
    const credentialVersionId = `memory-scheduler-version-${suffix}`;
    const modelId = `memory-scheduler-model-${suffix}`;
    const backgroundJobId = `memory-scheduler-background-${suffix}`;
    const ordinaryJobId = `memory-scheduler-ordinary-${suffix}`;
    const windowStart = new Date("2099-08-12T00:00:00.000Z");
    const windowEnd = new Date("2099-08-13T00:00:00.000Z");
    const inside = new Date("2099-08-12T12:00:00.000Z");
    const outside = new Date("2099-08-11T12:00:00.000Z");

    try {
      await prisma.user.create({
        data: {
          displayName: "Memory scheduler usage owner",
          email: `memory-scheduler-usage-${suffix}@example.test`,
          id: userId,
          status: "active"
        }
      });
      const connectionConfiguration = {
        allowPrivateNetwork: false,
        apiRoot: "https://memory-scheduler.example.test/v1",
        responseTimeoutMs: 30_000
      };
      await prisma.providerConnection.create({
        data: {
          activeConfig: connectionConfiguration,
          activeVersion: 1,
          activatedAt: inside,
          displayName: "Memory scheduler provider",
          draftConfig: connectionConfiguration,
          draftVersion: 1,
          enabled: true,
          family: "openai_compatible",
          id: connectionId,
          unassignedPolicy: "use_default"
        }
      });
      await prisma.providerCredential.create({
        data: {
          activatedAt: inside,
          connectionId,
          draftVersion: 1,
          enabled: true,
          id: credentialId,
          label: "Memory scheduler credential",
          testedAt: inside
        }
      });
      await prisma.providerCredentialVersion.create({
        data: {
          activatedAt: inside,
          credentialId,
          id: credentialVersionId,
          secretEnvelope: "test-only-envelope",
          testedAt: inside,
          testEvidence: { authenticationMode: "bearer" },
          version: 1
        }
      });
      await prisma.providerCredential.update({
        data: { activeVersionId: credentialVersionId },
        where: { id: credentialId }
      });
      await prisma.providerConnection.update({
        data: { defaultCredentialId: credentialId },
        where: { id: connectionId }
      });
      await prisma.providerModel.create({
        data: {
          activeConfig: embeddingConfiguration,
          activeVersion: 1,
          activatedAt: inside,
          capabilities: embeddingConfiguration.capabilities,
          connectionId,
          contextWindow: 32_768,
          defaultParams: {},
          displayName: "Memory scheduler model",
          draftConfig: embeddingConfiguration,
          draftVersion: 1,
          enabled: true,
          id: modelId,
          modelClass: "embedding",
          modelId: embeddingConfiguration.upstreamModelId,
          provider: "openai_compatible"
        }
      });
      await prisma.memoryJob.createMany({
        data: [
          {
            id: backgroundJobId,
            idempotencyFingerprint: `background-${suffix}`,
            kind: "GLOBAL_DREAM",
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "memory-scheduler-test-v1",
            userId
          },
          {
            id: ordinaryJobId,
            idempotencyFingerprint: `ordinary-${suffix}`,
            kind: "INDEX_HISTORY",
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            pipelineVersion: "memory-scheduler-test-v1",
            userId
          }
        ]
      });
      const binding = {
        cachedInputTokens: 0,
        completedAt: inside,
        connectionId,
        credentialId,
        credentialVersionId,
        destinationFingerprint: "memory-scheduler-destination-v1",
        inputTokens: 1,
        logicalRole: "MEMORY_PROFILE",
        outputTokens: 1,
        ownerType: "JOB" as const,
        pipelineVersion: "memory-scheduler-test-v1",
        policyVersion: "memory-scheduler-policy-v1",
        promptVersion: "memory-scheduler-prompt-v1",
        providerId: "openai_compatible",
        providerModelId: modelId,
        reasoningTokens: 0,
        schemaVersion: "memory-scheduler-schema-v1",
        secretFreeExecutionSnapshot: { version: 1 },
        startedAt: inside,
        state: "SUCCEEDED" as const,
        totalTokens: 2,
        usageCompleteness: "COMPLETE" as const,
        userId
      };
      await prisma.memoryExecutionBinding.createMany({
        data: [
          {
            ...binding,
            createdAt: inside,
            estimatedCostMicros: 11,
            id: `memory-scheduler-binding-a-${suffix}`,
            inputHash: `input-a-${suffix}`,
            memoryJobId: backgroundJobId,
            ordinal: 0
          },
          {
            ...binding,
            createdAt: inside,
            estimatedCostMicros: 19,
            id: `memory-scheduler-binding-b-${suffix}`,
            inputHash: `input-b-${suffix}`,
            memoryJobId: backgroundJobId,
            ordinal: 1
          },
          {
            ...binding,
            completedAt: outside,
            createdAt: outside,
            estimatedCostMicros: 100,
            id: `memory-scheduler-binding-outside-${suffix}`,
            inputHash: `input-outside-${suffix}`,
            memoryJobId: backgroundJobId,
            ordinal: 2,
            startedAt: outside
          },
          {
            ...binding,
            createdAt: inside,
            estimatedCostMicros: 200,
            id: `memory-scheduler-binding-ordinary-${suffix}`,
            inputHash: `input-ordinary-${suffix}`,
            memoryJobId: ordinaryJobId,
            ordinal: 0
          }
        ]
      });

      await expect(createPrismaMemorySchedulerUsageSource(prisma)
        .readDailyBackgroundUsage({ windowEnd, windowStart }))
        .resolves.toEqual({
          installation: { calls: 2, costMicros: 30 },
          users: new Map([[userId, { calls: 2, costMicros: 30 }]])
        });
    } finally {
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.memoryJob.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.providerConnection.updateMany({
        data: { defaultCredentialId: null },
        where: { id: connectionId }
      });
      await prisma.providerCredential.updateMany({
        data: { activeVersionId: null },
        where: { id: credentialId }
      });
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  });

  it("bounds tier and tenant turns across a populated multi-owner queue", async () => {
    const suffix = randomUUID();
    const userIds = Array.from(
      { length: 5 },
      (_, index) => `memory-scheduler-fair-${index}-${suffix}`
    );
    const kinds = [
      "RECONCILE_SOURCE",
      "INDEX_HISTORY",
      "GLOBAL_DREAM"
    ] as const;
    const repository = createPrismaMemoryCoordinatorRepository(prisma);
    const scheduler = new MemoryScheduler({
      policy: resolveMemoryCoordinatorPolicy(),
      usageSource: createEmptyMemorySchedulerUsageSource()
    });

    try {
      await prisma.user.createMany({
        data: userIds.map((userId, index) => ({
          displayName: `Memory scheduler fair owner ${index}`,
          email: `memory-scheduler-fair-${index}-${suffix}@example.test`,
          id: userId,
          status: "active" as const
        }))
      });
      await prisma.memoryJob.createMany({
        data: userIds.flatMap((userId, ownerIndex) => kinds.map((kind) => ({
          createdAt: at(ownerIndex),
          id: `memory-scheduler-fair-job-${ownerIndex}-${kind}-${suffix}`,
          idempotencyFingerprint: `fair-${ownerIndex}-${kind}-${suffix}`,
          kind,
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "memory-scheduler-test-v1",
          userId
        })))
      });
      await prisma.documentProcessingFairnessCursor.upsert({
        create: {
          lastGrantedOwnerUserId: userIds[0],
          pipeline: "memory-job"
        },
        update: { lastGrantedOwnerUserId: userIds[0] },
        where: { pipeline: "memory-job" }
      });

      const granted: Array<{ kind: string; userId: string }> = [];
      for (let ordinal = 0; ordinal < 12; ordinal += 1) {
        let claim = null;
        for (const wave of scheduler.claimWaves(kinds)) {
          claim = await repository.claimJob({
            claimToken: `memory-scheduler-fair-claim-${ordinal}-${suffix}`,
            kinds: wave,
            leaseExpiresAt: at(100_000),
            now: at(100)
          });
          if (claim) break;
        }
        expect(claim).not.toBeNull();
        granted.push({ kind: claim!.kind, userId: claim!.userId });
        await expect(repository.terminalJob({
          claim: claim!,
          errorCode: "memory_scheduler_fairness_test_complete",
          now: at(200 + ordinal)
        })).resolves.toBe(true);
      }

      expect(granted.slice(0, 4).map(({ kind }) => kind)).toEqual([
        "RECONCILE_SOURCE",
        "RECONCILE_SOURCE",
        "INDEX_HISTORY",
        "GLOBAL_DREAM"
      ]);
      expect(new Set(granted.slice(0, 5).map(({ userId }) => userId))).toEqual(
        new Set(userIds)
      );
      expect(new Set(granted.map(({ kind }) => kind))).toEqual(new Set(kinds));
    } finally {
      await prisma.memoryJob.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.documentProcessingFairnessCursor.deleteMany({
        where: { pipeline: "memory-job" }
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
});
