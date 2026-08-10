import type { Prisma } from "@prisma/client";
import { memoryShadowRebuildJobPrefixes } from "./contract";

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
