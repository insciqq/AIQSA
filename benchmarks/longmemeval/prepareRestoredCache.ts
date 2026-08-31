import { Prisma, PrismaClient, type MemoryJobKind } from "@prisma/client";
import { parseMemoryRebuildJobFingerprint } from
  "../../lib/server/memory/rebuild/contract";
import { createPrismaMemoryRebuildRepository } from
  "../../lib/server/memory/rebuild/repository";
import { LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX } from "./preparedCaseCache";

const confirmation = "RESTORED_PREPARED_CACHE";
const activeJobStates = [
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
] as const;
const supportedRestoredJobKinds = new Set<MemoryJobKind>([
  "EMBED_ITEMS",
  "INDEX_HISTORY",
  "REBUILD_INDEX"
]);
const preparedDisplayName =
  /^LongMemEval prepared [A-Za-z0-9_-]{1,128} [a-f0-9]{64}$/u;

function assertRestoredBenchmarkDatabase(): string {
  if (process.argv[2] !== "--confirm" || process.argv[3] !== confirmation) {
    throw new Error("longmemeval_restored_cache_confirmation_required");
  }
  if (process.env.AIQSA_MEMORY_BENCHMARK_TARGET !== "longmemeval") {
    throw new Error("longmemeval_restored_cache_target_invalid");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("longmemeval_restored_cache_database_missing");
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" || parsed.hostname !== "postgres" ||
    parsed.port !== "5432" || parsed.username !== "aiqsa_benchmark" ||
    parsed.pathname !== "/aiqsa_memory_benchmark") {
    throw new Error("longmemeval_restored_cache_database_invalid");
  }
  return databaseUrl;
}

export async function prepareLongMemEvalRestoredCache(
  prisma: PrismaClient
): Promise<Readonly<{
  compatibleGenerationPromotions: number;
  currentGenerations: number;
  preparedUsers: number;
  quarantinedBatchItems: number;
  quarantinedExecutionBindings: number;
  quarantinedJobs: number;
  removedShadowEntries: number;
  removedShadowGenerations: number;
}>> {
  const quarantine = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1852594534, 1919247215)`;
    const users = await tx.user.findMany({
      select: { displayName: true, email: true, id: true },
      where: { email: { endsWith: LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX } }
    });
    if (users.some((user) => !user.email ||
      !preparedDisplayName.test(user.displayName))) {
      throw new Error("longmemeval_restored_cache_owner_invalid");
    }
    const userIds = users.map(({ id }) => id);
    if (userIds.length === 0) {
      return Object.freeze({
        preparedUsers: 0,
        quarantinedBatchItems: 0,
        quarantinedExecutionBindings: 0,
        quarantinedJobs: 0,
        removedShadowEntries: 0,
        removedShadowGenerations: 0
      });
    }
    const [
      activeRuns,
      activeRetrievals,
      jobs,
      shadowGenerations,
      rebuildJobs,
      settingsRows
    ] = await Promise.all([
      tx.modelRun.count({
        where: {
          status: { notIn: ["cancelled", "complete", "error"] },
          userId: { in: userIds }
        }
      }),
      tx.memoryRetrievalAttempt.count({
        where: {
          state: { in: ["EXECUTING", "PENDING", "READY"] },
          userId: { in: userIds }
        }
      }),
      tx.memoryJob.findMany({
        select: {
          id: true,
          idempotencyFingerprint: true,
          kind: true,
          userId: true
        },
        where: {
          state: { in: [...activeJobStates] },
          userId: { in: userIds }
        }
      }),
      tx.memoryIndexGeneration.findMany({
        select: { id: true, sourceIndexGenerationId: true, state: true, userId: true },
        where: {
          state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
          userId: { in: userIds }
        }
      }),
      tx.memoryJob.findMany({
        select: {
          id: true,
          idempotencyFingerprint: true,
          state: true,
          userId: true
        },
        where: {
          kind: "REBUILD_INDEX",
          userId: { in: userIds }
        }
      }),
      tx.userMemorySettings.findMany({
        select: { activeIndexGenerationId: true, userId: true },
        where: { userId: { in: userIds } }
      })
    ]);
    if (activeRuns > 0 || activeRetrievals > 0) {
      throw new Error("longmemeval_restored_cache_query_active");
    }
    if (jobs.some(({ kind }) => !supportedRestoredJobKinds.has(kind))) {
      throw new Error("longmemeval_restored_cache_job_kind_unsupported");
    }
    const rebuildIdentities = rebuildJobs.map((job) => ({
      identity: parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint),
      job
    }));
    if (rebuildIdentities.some(({ identity }) => identity === null)) {
      throw new Error("longmemeval_restored_cache_rebuild_identity_invalid");
    }
    const shadowKeys = new Set(shadowGenerations.map((generation) =>
      `${generation.userId}:${generation.id}`));
    const rebuildTargets = new Set(rebuildIdentities.map(({ identity, job }) =>
      `${job.userId}:${identity!.generationId}`));
    const activeGenerationIds = new Set(settingsRows.flatMap((settings) =>
      settings.activeIndexGenerationId ? [settings.activeIndexGenerationId] : []));
    const sourceIds = shadowGenerations.flatMap(({ sourceIndexGenerationId }) =>
      sourceIndexGenerationId ? [sourceIndexGenerationId] : []);
    const sourceGenerations = sourceIds.length === 0
      ? []
      : await tx.memoryIndexGeneration.findMany({
          select: { id: true, state: true, userId: true },
          where: { id: { in: sourceIds }, userId: { in: userIds } }
        });
    const sourceAuthorities = new Set(sourceGenerations.flatMap((generation) =>
      ["ACTIVE", "SUPERSEDED"].includes(generation.state)
        ? [`${generation.userId}:${generation.id}`]
        : []));
    if (shadowGenerations.some((generation) =>
      !generation.sourceIndexGenerationId ||
      activeGenerationIds.has(generation.id) ||
      !rebuildTargets.has(`${generation.userId}:${generation.id}`) ||
      !sourceAuthorities.has(
        `${generation.userId}:${generation.sourceIndexGenerationId}`
      ))) {
      throw new Error("longmemeval_restored_cache_generation_invalid");
    }
    const activeRebuildIdentities = jobs
      .filter(({ kind }) => kind === "REBUILD_INDEX")
      .map((job) => ({
        identity: parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint),
        userId: job.userId
      }));
    if (activeRebuildIdentities.some(({ identity, userId }) =>
      !identity || !shadowKeys.has(`${userId}:${identity.generationId}`))) {
      throw new Error("longmemeval_restored_cache_active_rebuild_invalid");
    }
    const activeEmbeddingJobIds = jobs
      .filter(({ kind }) => kind === "EMBED_ITEMS")
      .map(({ id }) => id);
    const embeddingGenerations = activeEmbeddingJobIds.length === 0
      ? []
      : await tx.memoryEmbeddingBatchItem.findMany({
          distinct: ["userId", "indexGenerationId"],
          select: { indexGenerationId: true, userId: true },
          where: {
            memoryJobId: { in: activeEmbeddingJobIds },
            userId: { in: userIds }
          }
        });
    if (embeddingGenerations.some((generation) =>
      !shadowKeys.has(`${generation.userId}:${generation.indexGenerationId}`))) {
      throw new Error("longmemeval_restored_cache_embedding_generation_invalid");
    }
    const removableGenerationIds = shadowGenerations.map(({ id }) => id);
    const activeBindings = await tx.memoryExecutionBinding.findMany({
      select: { id: true },
      where: {
        ownerType: "JOB",
        state: { in: ["PENDING", "RUNNING"] },
        userId: { in: userIds }
      }
    });
    const shadowRebuildJobIds = rebuildIdentities.flatMap(({ identity, job }) =>
      shadowKeys.has(`${job.userId}:${identity!.generationId}`) ? [job.id] : []);
    const jobIds = [...new Set([
      ...jobs.map(({ id }) => id),
      ...shadowRebuildJobIds
    ])];
    const bindingIds = activeBindings.map(({ id }) => id);
    const now = new Date();
    const [quarantinedBatchItems, quarantinedExecutionBindings] =
      jobIds.length === 0 && bindingIds.length === 0
      ? [{ count: 0 }, { count: 0 }]
      : await Promise.all([
          tx.memoryEmbeddingBatchItem.updateMany({
            data: {
              completedAt: now,
              errorCode: "longmemeval_restore_quarantined",
              resultDimension: null,
              resultVector: Prisma.DbNull,
              state: "STALE"
            },
            where: {
              OR: [
                { memoryJobId: { in: jobIds } },
                { executionBindingId: { in: bindingIds } }
              ],
              state: { in: ["PENDING", "RESULT_READY"] },
              userId: { in: userIds }
            }
          }),
          tx.memoryExecutionBinding.updateMany({
            data: {
              completedAt: now,
              errorCode: "longmemeval_restore_quarantined",
              state: "CANCELLED"
            },
            where: {
              id: { in: bindingIds },
              ownerType: "JOB",
              state: { in: ["PENDING", "RUNNING"] },
              userId: { in: userIds }
            }
          })
        ]);
    const quarantinedJobs = jobIds.length === 0
      ? { count: 0 }
      : await tx.memoryJob.updateMany({
          data: {
            acceptedResultHash: null,
            completedAt: now,
            errorCode: "longmemeval_restore_quarantined",
            errorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            stage: null,
            state: "CANCELLED",
            updatedAt: now
          },
          where: {
            id: { in: jobIds },
            userId: { in: userIds }
          }
        });
    const removedShadowEntries = removableGenerationIds.length === 0
      ? { count: 0 }
      : await tx.memorySearchEntry.deleteMany({
          where: {
            indexGenerationId: { in: removableGenerationIds },
            userId: { in: userIds }
          }
        });
    const removedShadowGenerations = removableGenerationIds.length === 0
      ? { count: 0 }
      : await tx.memoryIndexGeneration.deleteMany({
          where: {
            id: { in: removableGenerationIds },
            sourceIndexGenerationId: { not: null },
            state: { in: ["BUILDING", "CATCHING_UP", "READY", "CANCELLED", "FAILED"] },
            userId: { in: userIds }
          }
        });
    const [remainingJobs, remainingBindings, remainingShadows] = await Promise.all([
      tx.memoryJob.count({
        where: {
          state: { in: [...activeJobStates] },
          userId: { in: userIds }
        }
      }),
      tx.memoryExecutionBinding.count({
        where: {
          ownerType: "JOB",
          state: { in: ["PENDING", "RUNNING"] },
          userId: { in: userIds }
        }
      }),
      tx.memoryIndexGeneration.count({
        where: {
          state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
          userId: { in: userIds }
        }
      })
    ]);
    if (remainingJobs !== 0 || remainingBindings !== 0 || remainingShadows !== 0 ||
      quarantinedJobs.count !== jobIds.length ||
      removedShadowGenerations.count !== removableGenerationIds.length) {
      throw new Error("longmemeval_restored_cache_quarantine_incomplete");
    }
    return Object.freeze({
      preparedUsers: userIds.length,
      quarantinedBatchItems: quarantinedBatchItems.count,
      quarantinedExecutionBindings: quarantinedExecutionBindings.count,
      quarantinedJobs: quarantinedJobs.count,
      removedShadowEntries: removedShadowEntries.count,
      removedShadowGenerations: removedShadowGenerations.count
    });
  }, { timeout: 120_000 });
  const users = await prisma.user.findMany({
    orderBy: { id: "asc" },
    select: { id: true },
    where: { email: { endsWith: LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX } }
  });
  const rebuild = createPrismaMemoryRebuildRepository(prisma);
  let compatibleGenerationPromotions = 0;
  let currentGenerations = 0;
  for (const user of users) {
    const promotion = await rebuild.promoteCompatibleActiveGeneration(user.id);
    if (promotion.kind === "promoted") {
      compatibleGenerationPromotions += 1;
    } else if (promotion.kind === "already_current") {
      currentGenerations += 1;
    } else {
      throw new Error("longmemeval_restored_cache_generation_incompatible");
    }
    const inventory = await rebuild.inventory(user.id);
    if (!inventory.ready ||
      inventory.activeGenerationId !== promotion.generationId) {
      throw new Error("longmemeval_restored_cache_generation_not_ready");
    }
  }
  return Object.freeze({
    compatibleGenerationPromotions,
    currentGenerations,
    ...quarantine
  });
}

async function main(): Promise<void> {
  const databaseUrl = assertRestoredBenchmarkDatabase();
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const result = await prepareLongMemEvalRestoredCache(prisma);
    process.stdout.write(`${JSON.stringify({
      event: "longmemeval_restored_cache_prepared",
      ...result
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error
    ? error.message
    : "longmemeval_restored_cache_failed"}\n`);
  process.exitCode = 1;
});
