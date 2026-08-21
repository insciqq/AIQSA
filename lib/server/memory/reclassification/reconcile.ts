import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { memoryPersonalFactEvidencePredicate } from "../persistence/eligibility";
import { memorySha256 } from "../persistence/lexical";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { MEMORY_RECLASSIFICATION_PIPELINE_VERSION } from "./classifier";

type PendingOwner = Readonly<{
  userId: string;
  memoryGeneration: number;
  memoryRevision: number;
  pendingCount: number;
  oldestVersionId: string;
}>;

export const MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS =
  5 * 60 * 1_000;

/** Discover one idempotent global job per pending owner.  The count/oldest
 * token changes after each committed batch, so a successfully completed job
 * cannot hide the next batch. */
export async function reconcileMemoryFactReclassificationJobs(
  client: PrismaClient = prisma,
  now = new Date()
): Promise<number> {
  if (!Number.isFinite(now.getTime())) return 0;
  const owners = await client.$queryRaw<PendingOwner[]>(Prisma.sql`
    SELECT
      version."userId",
      settings."memoryGeneration",
      settings."memoryRevision",
      COUNT(*)::integer AS "pendingCount",
      MIN(version."id") AS "oldestVersionId"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    INNER JOIN "User" AS owner_user
      ON owner_user."id" = version."userId"
    WHERE settings."useMemoryFacts" = TRUE
      AND owner_user."status" = 'active'::"UserStatus"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."safetyClassificationState" =
        'PENDING'::"MemorySafetyClassificationState"
      AND version."displayText" IS NOT NULL
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND ${memoryPersonalFactEvidencePredicate(Prisma.sql`version."userId"`)}
    GROUP BY version."userId", settings."memoryGeneration", settings."memoryRevision"
  `);
  if (owners.length === 0) return 0;
  const rows = owners.map((owner) => ({
    idempotencyFingerprint: memorySha256({
      domain: "aiqsa.memory.reclassification-job",
      memoryGeneration: owner.memoryGeneration,
      memoryRevision: owner.memoryRevision,
      oldestVersionId: owner.oldestVersionId,
      pendingCount: owner.pendingCount,
      pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
      userId: owner.userId
    }),
    kind: "RECLASSIFY_FACTS" as const,
    memoryGenerationSnapshot: owner.memoryGeneration,
    memoryRevisionSnapshot: owner.memoryRevision,
    pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
    userId: owner.userId
  }));
  const revived = await client.memoryJob.updateMany({
    data: {
      acceptedResultHash: null,
      attemptCount: 0,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      stage: null,
      state: "QUEUED"
    },
    where: {
      AND: [{
        OR: rows.map((row) => ({
          idempotencyFingerprint: row.idempotencyFingerprint,
          userId: row.userId
        }))
      }, {
        OR: [
          { state: { in: ["CANCELLED", "STALE"] } },
          {
            errorCode: "memory_reclassification_provider_unavailable",
            state: "TERMINAL_FAILED",
            updatedAt: {
              lte: new Date(
                now.getTime() - MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS
              )
            }
          }
        ]
      }],
      kind: "RECLASSIFY_FACTS",
    }
  });
  const result = await client.memoryJob.createMany({
    data: rows,
    skipDuplicates: true
  });
  return revived.count + result.count;
}
