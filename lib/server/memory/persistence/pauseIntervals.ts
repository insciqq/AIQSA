import { Prisma, type MemoryPauseScope } from "@prisma/client";

export type MemoryPauseIntervalSnapshot = Readonly<{
  id: string;
  memoryGeneration: number;
  pausedAt: Date;
  resumedAt: Date | null;
  scope: MemoryPauseScope;
}>;

export type MemoryDestructiveSourceBarrierSnapshot = Readonly<{
  explicitOverrideAllowed: boolean;
  sourceCreatedAtCutoff: Date;
}>;

export function memorySourceIsInsidePause(
  sourceCreatedAt: Date,
  intervals: readonly MemoryPauseIntervalSnapshot[]
): boolean {
  return intervals.some((interval) =>
    sourceCreatedAt >= interval.pausedAt &&
    (interval.resumedAt === null || sourceCreatedAt <= interval.resumedAt));
}

export function memoryDestructiveSourceCutoff(
  barriers: readonly MemoryDestructiveSourceBarrierSnapshot[]
): Date | null {
  return barriers.reduce<Date | null>((latest, barrier) => {
    if (barrier.explicitOverrideAllowed) return latest;
    return latest === null || barrier.sourceCreatedAtCutoff > latest
      ? barrier.sourceCreatedAtCutoff
      : latest;
  }, null);
}

/** Callers expose the source Message as `evidence_message`. */
export function memoryAutomaticEvidencePausePredicate(
  userId: string | Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryPauseInterval" AS learning_pause
    WHERE learning_pause."userId" = ${userId}
      AND learning_pause."scope" IN (
        'MASTER'::"MemoryPauseScope",
        'AUTOMATIC_LEARNING'::"MemoryPauseScope"
      )
      AND evidence_message."createdAt" >= learning_pause."pausedAt"
      AND (
        learning_pause."resumedAt" IS NULL
        OR evidence_message."createdAt" <= learning_pause."resumedAt"
      )
  )`;
}

/**
 * An ACTIVE history chunk may intentionally trail the chat only while the
 * current settled leaf belongs to a master/Search pause. All ordinary source
 * changes still require an exact checkpoint/source identity.
 *
 * Callers expose the candidate history row as `chunk`.
 */
export function memoryHistoryChunkSourceAuthorityPredicate(): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "Chat" AS retained_source_chat
      INNER JOIN "ChatMemoryCheckpoint" AS retained_checkpoint
        ON retained_checkpoint."userId" = retained_source_chat."userId"
        AND retained_checkpoint."chatId" = retained_source_chat."id"
      WHERE retained_source_chat."userId" = chunk."userId"
        AND retained_source_chat."id" = chunk."chatId"
        AND retained_source_chat."projectId" IS NULL
        AND retained_source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND retained_source_chat."memoryBranchGeneration" = chunk."branchGeneration"
        AND retained_checkpoint."branchGeneration" = chunk."branchGeneration"
        AND retained_checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
        AND retained_checkpoint."lastIndexedMessageId" =
          retained_checkpoint."activeLeafMessageId"
        AND retained_checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
        AND (
          (
            retained_source_chat."memorySourceRevision" =
              chunk."sourceRevisionAtCreation"
            AND retained_checkpoint."activeLeafMessageId" =
              retained_source_chat."activeLeafMessageId"
          )
          OR EXISTS (
            SELECT 1
            FROM "Message" AS paused_leaf
            INNER JOIN "MemoryPauseInterval" AS pause_interval
              ON pause_interval."userId" = retained_source_chat."userId"
              AND pause_interval."scope" IN (
                'MASTER'::"MemoryPauseScope",
                'SEARCH_HISTORY'::"MemoryPauseScope"
              )
              AND paused_leaf."createdAt" >= pause_interval."pausedAt"
              AND (
                pause_interval."resumedAt" IS NULL
                OR paused_leaf."createdAt" <= pause_interval."resumedAt"
              )
            WHERE paused_leaf."chatId" = retained_source_chat."id"
              AND paused_leaf."id" = retained_source_chat."activeLeafMessageId"
          )
        )
    )
  `;
}
