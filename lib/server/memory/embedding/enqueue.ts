import { randomUUID } from "node:crypto";
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

export type MemoryEmbeddingBatchBulkEnqueueResult = Readonly<{
  childrenCreated: number;
  childrenReused: number;
  failed: boolean;
  jobsCreated: number;
}>;

type BulkEnqueueInput = Readonly<{
  entryId: string;
  triggerIdentity: string;
}>;

const reusableBatchJobStates = new Set([
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
]);

function validatedBatchSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MEMORY_EMBEDDING_BATCH_SIZE
  ) {
    throw new Error("memory_embedding_batch_size_invalid");
  }
  return value;
}

/**
 * Enqueues a closed set of vector-pipeline entries without the per-item query
 * amplification of the incremental open-batch path. The caller already owns
 * the user settings lock, so one parent and its complete ordered child set are
 * inserted atomically and cannot race an ordinary incremental enqueue.
 */
export async function enqueueMemoryEmbeddingBatchItems(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  inputs: readonly BulkEnqueueInput[],
  options: Readonly<{ batchSize?: number }> = {}
): Promise<MemoryEmbeddingBatchBulkEnqueueResult> {
  const batchSize = validatedBatchSize(
    options.batchSize ?? loadMemoryEmbeddingBatchSize()
  );
  if (inputs.length === 0) {
    return {
      childrenCreated: 0,
      childrenReused: 0,
      failed: false,
      jobsCreated: 0
    };
  }

  const triggerByEntryId = new Map<string, Readonly<{
    triggerIdentity: string;
    triggerIdentityHash: string;
  }>>();
  for (const input of inputs) {
    if (triggerByEntryId.has(input.entryId)) {
      throw new Error("memory_embedding_batch_bulk_input_invalid");
    }
    // Fingerprint parsing owns the UUID-shape validation for every seed. Do
    // it for every member as well so no non-seed child can bypass that bound.
    memoryEmbeddingBatchJobFingerprint(input.entryId, input.triggerIdentity);
    triggerByEntryId.set(input.entryId, {
      triggerIdentity: input.triggerIdentity,
      triggerIdentityHash: memoryEmbeddingBatchTriggerHash(
        input.entryId,
        input.triggerIdentity
      )
    });
  }

  const targets = await tx.memorySearchEntry.findMany({
    orderBy: { id: "asc" },
    select: { embeddingState: true, id: true, indexGenerationId: true },
    where: {
      id: { in: [...triggerByEntryId.keys()] },
      userId: settings.userId
    }
  });
  if (
    targets.length !== triggerByEntryId.size ||
    targets.some(({ embeddingState }) =>
      embeddingState !== "PENDING" && embeddingState !== "FAILED")
  ) {
    throw new Error("memory_embedding_batch_target_invalid");
  }
  const generationIds = new Set(targets.map(({ indexGenerationId }) =>
    indexGenerationId));
  if (generationIds.size !== 1) {
    throw new Error("memory_embedding_batch_target_invalid");
  }
  const generationId = targets[0]!.indexGenerationId;
  const generation = await tx.memoryIndexGeneration.findFirst({
    select: { retrievalPipelineVersion: true },
    where: { id: generationId, userId: settings.userId }
  });
  if (
    generation?.retrievalPipelineVersion !==
      MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
  ) {
    throw new Error("memory_embedding_batch_target_invalid");
  }

  const existingChildren = await tx.memoryEmbeddingBatchItem.findMany({
    select: {
      memoryJobId: true,
      searchEntryId: true,
      triggerIdentityHash: true
    },
    where: {
      searchEntryId: { in: targets.map(({ id }) => id) },
      userId: settings.userId
    }
  });
  const exactChildren = existingChildren.filter((child) =>
    triggerByEntryId.get(child.searchEntryId)?.triggerIdentityHash ===
      child.triggerIdentityHash);
  const existingJobIds = [...new Set(exactChildren.map(({ memoryJobId }) =>
    memoryJobId))];
  const existingJobs = existingJobIds.length === 0
    ? []
    : await tx.memoryJob.findMany({
        select: { id: true, state: true },
        where: { id: { in: existingJobIds }, userId: settings.userId }
      });
  if (existingJobs.length !== existingJobIds.length) {
    throw new Error("memory_embedding_batch_parent_invalid");
  }
  const stateByJobId = new Map(existingJobs.map((job) => [job.id, job.state]));
  const failed = exactChildren.some(({ memoryJobId }) =>
    !reusableBatchJobStates.has(stateByJobId.get(memoryJobId)!));
  const reusedEntryIds = new Set(exactChildren.map(({ searchEntryId }) =>
    searchEntryId));
  const missingTargets = targets.filter(({ id }) => !reusedEntryIds.has(id));
  if (missingTargets.length === 0) {
    return {
      childrenCreated: 0,
      childrenReused: exactChildren.length,
      failed,
      jobsCreated: 0
    };
  }

  // Preserve incremental packing across rebuild catch-up passes when an
  // earlier parent is still QUEUED. The row locks share the same claim
  // boundary as the one-item path: a worker either owns the parent or this
  // transaction appends a closed child set, never both.
  const openParents = await tx.$queryRaw<OpenBatchRow[]>(Prisma.sql`
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
          AND member."indexGenerationId" = ${generationId}
      )
      AND COALESCE((
        SELECT MAX(bounded."ordinal") + 1
        FROM "MemoryEmbeddingBatchItem" AS bounded
        WHERE bounded."userId" = job."userId"
          AND bounded."memoryJobId" = job."id"
      ), 0) < ${batchSize}
    ORDER BY job."createdAt" DESC, job."id" DESC
    FOR UPDATE OF job SKIP LOCKED
    LIMIT ${missingTargets.length}
  `);
  const occupiedByJobId = new Map<string, Set<string>>();
  for (const child of existingChildren) {
    const occupied = occupiedByJobId.get(child.memoryJobId) ?? new Set<string>();
    occupied.add(child.searchEntryId);
    occupiedByJobId.set(child.memoryJobId, occupied);
  }
  const remainingTargets = [...missingTargets];
  const appendedChildren: Array<Readonly<{
    id: string;
    indexGenerationId: string;
    memoryJobId: string;
    ordinal: number;
    searchEntryId: string;
    triggerIdentityHash: string;
    userId: string;
  }>> = [];
  for (const open of openParents) {
    const occupied = occupiedByJobId.get(open.id) ?? new Set<string>();
    for (let ordinal = open.nextOrdinal; ordinal < batchSize; ordinal += 1) {
      const targetIndex = remainingTargets.findIndex((target) =>
        !occupied.has(target.id));
      if (targetIndex < 0) break;
      const [target] = remainingTargets.splice(targetIndex, 1);
      appendedChildren.push({
        id: randomUUID(),
        indexGenerationId: generationId,
        memoryJobId: open.id,
        ordinal,
        searchEntryId: target!.id,
        triggerIdentityHash:
          triggerByEntryId.get(target!.id)!.triggerIdentityHash,
        userId: settings.userId
      });
      occupied.add(target!.id);
    }
    if (remainingTargets.length === 0) break;
  }

  const groups: Array<typeof remainingTargets> = [];
  for (let start = 0; start < remainingTargets.length; start += batchSize) {
    groups.push(remainingTargets.slice(start, start + batchSize));
  }
  const parents = groups.map((group) => {
    const seed = group[0]!;
    const trigger = triggerByEntryId.get(seed.id)!;
    return {
      group,
      id: randomUUID(),
      idempotencyFingerprint: memoryEmbeddingBatchJobFingerprint(
        seed.id,
        trigger.triggerIdentity
      )
    };
  });
  const conflictingParents = parents.length === 0
    ? 0
    : await tx.memoryJob.count({
        where: {
          idempotencyFingerprint: {
            in: parents.map(({ idempotencyFingerprint }) => idempotencyFingerprint)
          },
          userId: settings.userId
        }
      });
  if (conflictingParents !== 0) {
    throw new Error("memory_embedding_batch_parent_invalid");
  }
  const createdParents = parents.length === 0
    ? { count: 0 }
    : await tx.memoryJob.createMany({
        data: parents.map((parent) => ({
          id: parent.id,
          idempotencyFingerprint: parent.idempotencyFingerprint,
          kind: "EMBED_ITEMS" as const,
          memoryGenerationSnapshot: settings.memoryGeneration,
          memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION,
          userId: settings.userId
        }))
      });
  if (createdParents.count !== parents.length) {
    throw new Error("memory_embedding_batch_parent_invalid");
  }
  const children = [
    ...appendedChildren,
    ...parents.flatMap((parent) => parent.group.map((target, ordinal) => ({
      id: randomUUID(),
      indexGenerationId: generationId,
      memoryJobId: parent.id,
      ordinal,
      searchEntryId: target.id,
      triggerIdentityHash: triggerByEntryId.get(target.id)!.triggerIdentityHash,
      userId: settings.userId
    })))
  ];
  const createdChildren = await tx.memoryEmbeddingBatchItem.createMany({
    data: children
  });
  if (createdChildren.count !== children.length) {
    throw new Error("memory_embedding_batch_child_invalid");
  }
  return {
    childrenCreated: createdChildren.count,
    childrenReused: exactChildren.length,
    failed,
    jobsCreated: createdParents.count
  };
}

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
  const batchSize = validatedBatchSize(
    options.batchSize ?? loadMemoryEmbeddingBatchSize()
  );
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
