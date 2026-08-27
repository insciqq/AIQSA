import type { MemoryJobKind, Prisma } from "@prisma/client";
import { memoryShadowRebuildJobPrefixes } from "./contract";

export const MEMORY_SHADOW_CUTOVER_BLOCKING_JOB_KINDS = Object.freeze([
  "EMBED_ITEMS",
  "EXTRACT_FACTS",
  "INDEX_HISTORY",
  "RECLASSIFY_FACTS",
  "RESOLVE_FACT_RELATIONS",
  "SYNTHESIZE_MEMORIES"
] as const satisfies readonly MemoryJobKind[]);

const cutoverBlockingJobKinds = new Set<MemoryJobKind>(
  MEMORY_SHADOW_CUTOVER_BLOCKING_JOB_KINDS
);

export function memoryJobBlocksShadowCutover(kind: MemoryJobKind): boolean {
  return cutoverBlockingJobKinds.has(kind);
}

export async function wakeMemoryShadowRebuildInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  generationId: string
): Promise<number> {
  const prefixes = memoryShadowRebuildJobPrefixes(generationId);
  const updated = await tx.memoryJob.updateMany({
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
      state: "QUEUED",
      updatedAt: new Date()
    },
    where: {
      OR: prefixes.map((prefix) => ({
        idempotencyFingerprint: { startsWith: prefix }
      })),
      kind: "REBUILD_INDEX",
      state: "SUCCEEDED",
      userId
    }
  });
  return updated.count;
}

export async function wakeCurrentMemoryShadowRebuildInTransaction(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<number> {
  const shadow = await tx.memoryIndexGeneration.findFirst({
    orderBy: { generation: "desc" },
    select: { id: true },
    where: {
      state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
      userId
    }
  });
  return shadow
    ? wakeMemoryShadowRebuildInTransaction(tx, userId, shadow.id)
    : 0;
}
