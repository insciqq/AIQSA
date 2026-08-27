import { Prisma } from "@prisma/client";
import {
  enqueueMemoryJob,
  type MemoryJobEnqueueResult
} from "../persistence/jobs";
import type {
  LockedMemorySettings,
  MemoryTransaction
} from "../persistence/transaction";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import {
  MAX_MEMORY_EMBEDDING_BATCH_SIZE,
  MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryEmbeddingBatchJobFingerprint,
  memoryEmbeddingBatchTriggerHash,
  memoryItemEmbeddingJobFingerprint
} from "./contract";
import { loadMemoryEmbeddingBatchSize } from "./config";

type OpenBatchRow = Readonly<{
  id: string;
  nextOrdinal: number;
}>;

export type MemoryEmbeddingBatchEnqueueResult = MemoryJobEnqueueResult & Readonly<{
  childCreated: boolean;
}>;

async function existingBatchResult(
  tx: MemoryTransaction,
  userId: string,
  memoryJobId: string,
  childCreated: boolean
): Promise<MemoryEmbeddingBatchEnqueueResult> {
  const job = await tx.memoryJob.findFirstOrThrow({
    select: {
      id: true,
      memoryGenerationSnapshot: true,
      memoryRevisionSnapshot: true,
      state: true
    },
    where: { id: memoryJobId, userId }
  });
  return { ...job, childCreated, created: false };
}

export async function enqueueMemoryEmbeddingBatchItem(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: Readonly<{
    entryId: string;
    triggerIdentity: string;
  }>,
  options: Readonly<{ batchSize?: number }> = {}
): Promise<MemoryEmbeddingBatchEnqueueResult> {
  const batchSize = options.batchSize ?? loadMemoryEmbeddingBatchSize();
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_MEMORY_EMBEDDING_BATCH_SIZE
  ) {
    throw new Error("memory_embedding_batch_size_invalid");
  }
  const triggerIdentityHash = memoryEmbeddingBatchTriggerHash(
    input.entryId,
    input.triggerIdentity
  );
  const target = await tx.memorySearchEntry.findFirst({
    select: { embeddingState: true, indexGenerationId: true },
    where: { id: input.entryId, userId: settings.userId }
  });
  if (
    !target ||
    (target.embeddingState !== "PENDING" && target.embeddingState !== "FAILED")
  ) {
    throw new Error("memory_embedding_batch_target_invalid");
  }
  const generation = await tx.memoryIndexGeneration.findFirst({
    select: { retrievalPipelineVersion: true },
    where: { id: target.indexGenerationId, userId: settings.userId }
  });
  if (!generation) throw new Error("memory_embedding_batch_target_invalid");
  if (
    generation.retrievalPipelineVersion !==
      MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
  ) {
    const legacy = await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
        input.entryId,
        input.triggerIdentity
      ),
      kind: "EMBED_ITEMS",
      pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
    });
    return { ...legacy, childCreated: false };
  }

  const existing = await tx.memoryEmbeddingBatchItem.findUnique({
    select: { memoryJobId: true },
    where: {
      userId_searchEntryId_triggerIdentityHash: {
        searchEntryId: input.entryId,
        triggerIdentityHash,
        userId: settings.userId
      }
    }
  });
  if (existing) {
    return existingBatchResult(
      tx,
      settings.userId,
      existing.memoryJobId,
      false
    );
  }

  // Every caller already holds the owner settings lock. Locking the selected
  // QUEUED parent as well makes the child ordinal and the claim boundary
  // explicit: a worker can claim the parent or this transaction can append,
  // never both from different snapshots.
  const candidates = await tx.$queryRaw<OpenBatchRow[]>(Prisma.sql`
    SELECT
      job."id",
      COALESCE((
        SELECT MAX(counted."ordinal") + 1
        FROM "MemoryEmbeddingBatchItem" AS counted
        WHERE counted."userId" = job."userId"
          AND counted."memoryJobId" = job."id"
      ), 0)::integer AS "nextOrdinal"
    FROM "MemoryJob" AS job
    WHERE job."userId" = ${settings.userId}
      AND job."kind" = 'EMBED_ITEMS'::"MemoryJobKind"
      AND job."state" = 'QUEUED'::"MemoryJobState"
      AND job."pipelineVersion" = ${MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION}
      AND EXISTS (
        SELECT 1
        FROM "MemoryEmbeddingBatchItem" AS member
        WHERE member."userId" = job."userId"
          AND member."memoryJobId" = job."id"
          AND member."indexGenerationId" = ${target.indexGenerationId}
      )
      AND COALESCE((
        SELECT MAX(bounded."ordinal") + 1
        FROM "MemoryEmbeddingBatchItem" AS bounded
        WHERE bounded."userId" = job."userId"
          AND bounded."memoryJobId" = job."id"
      ), 0) < ${batchSize}
    ORDER BY job."createdAt" DESC, job."id" DESC
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  `);

  const open = candidates[0];
  let memoryJobId: string;
  let ordinal: number;
  let result: MemoryEmbeddingBatchEnqueueResult | null = null;
  if (open) {
    memoryJobId = open.id;
    ordinal = open.nextOrdinal;
  } else {
    const created = await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryEmbeddingBatchJobFingerprint(
        input.entryId,
        input.triggerIdentity
      ),
      kind: "EMBED_ITEMS",
      pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION
    });
    memoryJobId = created.id;
    ordinal = 0;
    result = { ...created, childCreated: true };
  }
  await tx.memoryEmbeddingBatchItem.create({
    data: {
      indexGenerationId: target.indexGenerationId,
      memoryJobId,
      ordinal,
      searchEntryId: input.entryId,
      triggerIdentityHash,
      userId: settings.userId
    }
  });
  return result ?? existingBatchResult(tx, settings.userId, memoryJobId, true);
}
