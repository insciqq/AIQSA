import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../../prisma";
import {
  loadPersonalMemoryEvidenceSnapshots,
  memoryPersonalFactEvidencePredicate
} from "../../persistence/eligibility";
import { memorySha256 } from "../../persistence/lexical";
import { MEMORY_FACT_RELATION_PIPELINE_VERSION } from "./policy";

type PendingRelationTarget = Readonly<{
  memoryGeneration: number;
  memoryRevision: number;
  targetFactVersionId: string;
  userId: string;
}>;

type PendingRelationJobRow = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  memoryGeneration: number;
  memoryRevision: number;
  sourceMessageId: string;
  sourceRevision: number;
  targetFactVersionId: string;
  userId: string;
}>;

export function memoryFactRelationJobFingerprint(input: Readonly<{
  memoryGeneration: number;
  sourceMessageId: string;
  targetFactVersionId: string;
  userId: string;
}>): string {
  return memorySha256({
    domain: "aiqsa.memory.fact-relations",
    memoryGeneration: input.memoryGeneration,
    pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
    sourceMessageId: input.sourceMessageId,
    targetFactVersionId: input.targetFactVersionId,
    userId: input.userId,
    version: 2
  });
}

/** Recover every safety-admitted durable observation that still needs a
 * semantic relation. This is also the crash-recovery owner for a commit that
 * landed before its relation job could be enqueued. */
export async function reconcileMemoryFactRelationJobs(
  client: PrismaClient = prisma
): Promise<number> {
  const targets = await client.$queryRaw<PendingRelationTarget[]>(Prisma.sql`
    SELECT
      version."userId",
      version."id" AS "targetFactVersionId",
      settings."memoryGeneration",
      settings."memoryRevision"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    INNER JOIN "User" AS owner_user ON owner_user."id" = version."userId"
    WHERE version."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND settings."useMemoryFacts" = TRUE
      AND owner_user."status" = 'active'::"UserStatus"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND ${memoryPersonalFactEvidencePredicate(Prisma.sql`version."userId"`)}
    ORDER BY version."userId", version."createdAt", version."id"
  `);
  if (targets.length === 0) return 0;
  const evidence = (await Promise.all([...new Set(targets.map(({ userId }) => userId))]
    .map((userId) => loadPersonalMemoryEvidenceSnapshots(
      client,
      userId,
      targets.filter((target) => target.userId === userId)
        .map(({ targetFactVersionId }) => targetFactVersionId)
    )))).flat();
  const selected = targets.flatMap((target) => {
    const item = evidence.find(({ factVersionId }) =>
      factVersionId === target.targetFactVersionId);
    return item ? [{ item, target }] : [];
  });
  if (selected.length === 0) return 0;
  const chats = await client.chat.findMany({
    select: {
      activeLeafMessageId: true,
      id: true,
      memoryBranchGeneration: true,
      memorySourceRevision: true,
      userId: true
    },
    where: {
      OR: selected.map(({ item, target }) => ({
        activeLeafMessageId: { not: null },
        id: item.chatId,
        userId: target.userId
      }))
    }
  });
  const rows: PendingRelationJobRow[] = selected.flatMap(({ item, target }) => {
    const chat = chats.find((candidate) => candidate.id === item.chatId &&
      candidate.userId === target.userId);
    return chat?.activeLeafMessageId ? [{
      activeLeafMessageId: chat.activeLeafMessageId,
      branchGeneration: chat.memoryBranchGeneration,
      chatId: chat.id,
      memoryGeneration: target.memoryGeneration,
      memoryRevision: target.memoryRevision,
      sourceMessageId: item.messageId,
      sourceRevision: chat.memorySourceRevision,
      targetFactVersionId: target.targetFactVersionId,
      userId: target.userId
    }] : [];
  });
  if (rows.length === 0) return 0;
  const jobs = rows.map((row) => ({
    activeLeafMessageId: row.activeLeafMessageId,
    branchGeneration: row.branchGeneration,
    chatId: row.chatId,
    idempotencyFingerprint: memoryFactRelationJobFingerprint(row),
    kind: "RESOLVE_FACT_RELATIONS" as const,
    memoryGenerationSnapshot: row.memoryGeneration,
    memoryRevisionSnapshot: row.memoryRevision,
    pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
    sourceHash: memorySha256({
      domain: "aiqsa.memory.fact-relation-source-snapshot",
      sourceMessageId: row.sourceMessageId,
      sourceRevision: row.sourceRevision,
      targetFactVersionId: row.targetFactVersionId,
      version: 1
    }),
    sourceMessageId: row.sourceMessageId,
    sourceRevision: row.sourceRevision,
    targetFactVersionId: row.targetFactVersionId,
    userId: row.userId
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
      OR: jobs.map((job) => ({
        idempotencyFingerprint: job.idempotencyFingerprint,
        sourceMessageId: job.sourceMessageId,
        state: { in: ["CANCELLED", "STALE"] },
        targetFactVersionId: job.targetFactVersionId,
        userId: job.userId
      })),
      kind: "RESOLVE_FACT_RELATIONS"
    }
  });
  const created = await client.memoryJob.createMany({
    data: jobs,
    skipDuplicates: true
  });
  return revived.count + created.count;
}
