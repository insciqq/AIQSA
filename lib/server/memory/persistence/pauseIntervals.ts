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

type JoinedHistorySourceAliases = Readonly<{
  chat: "chat" | "dependency_source_chat" | "source_chat";
  checkpoint: "checkpoint" | "dependency_checkpoint";
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
 * Stable history projections carry creation counters only for audit/frozen receipts. Their
 * reusable authority is the READY current checkpoint plus an exact source map
 * whose immutable message identities still lie on the retained active DAG.
 * A checkpoint may trail only while the current leaf is inside a pause.
 *
 * Callers expose the candidate history row as `chunk`.
 */
function memoryHistorySourceAuthorityPredicate(
  kind: "CHUNK" | "ROUND",
  aliases?: JoinedHistorySourceAliases
): Prisma.Sql {
  const chat = Prisma.raw(`"${aliases?.chat ?? "retained_source_chat"}"`);
  const checkpoint = Prisma.raw(
    `"${aliases?.checkpoint ?? "retained_checkpoint"}"`
  );
  const source = Prisma.raw(kind === "CHUNK" ? `"chunk"` : `"round"`);
  const sourceMap = Prisma.raw(kind === "CHUNK"
    ? `"MemoryRecallChunkMessage"`
    : `"MemoryRecallRoundMessage"`);
  const sourceMapId = Prisma.raw(kind === "CHUNK" ? `"chunkId"` : `"roundId"`);
  const authority = Prisma.sql`
    ${chat}."userId" = ${source}."userId"
    AND ${chat}."id" = ${source}."chatId"
    AND ${chat}."projectId" IS NULL
    AND ${chat}."memoryMode" = 'NORMAL'::"MemoryChatMode"
    AND ${checkpoint}."userId" = ${chat}."userId"
    AND ${checkpoint}."chatId" = ${chat}."id"
    AND ${checkpoint}."branchGeneration" = ${chat}."memoryBranchGeneration"
    AND ${checkpoint}."lastIndexedMessageId" = ${checkpoint}."activeLeafMessageId"
    AND ${checkpoint}."status" = 'READY'::"MemoryHistoryCheckpointStatus"
    AND EXISTS (
      SELECT 1 FROM ${sourceMap} AS authority_source_map
      WHERE authority_source_map."userId" = ${source}."userId"
        AND authority_source_map."chatId" = ${source}."chatId"
        AND authority_source_map.${sourceMapId} = ${source}."id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${sourceMap} AS authority_source_map
      LEFT JOIN "Message" AS authority_source_message
        ON authority_source_message."chatId" = authority_source_map."chatId"
        AND authority_source_message."id" = authority_source_map."messageId"
      LEFT JOIN "ChatMemoryCheckpointMessage" AS authority_checkpoint_message
        ON authority_checkpoint_message."userId" = authority_source_map."userId"
        AND authority_checkpoint_message."chatId" = authority_source_map."chatId"
        AND authority_checkpoint_message."messageId" = authority_source_map."messageId"
      WHERE authority_source_map."userId" = ${source}."userId"
        AND authority_source_map."chatId" = ${source}."chatId"
        AND authority_source_map.${sourceMapId} = ${source}."id"
        AND (
          authority_source_message."id" IS NULL
          OR authority_source_message."updatedAt" <>
            authority_source_map."sourceMessageUpdatedAt"
          OR authority_checkpoint_message."messageId" IS NULL
          OR authority_checkpoint_message."sourceMessageUpdatedAt" <>
            authority_source_map."sourceMessageUpdatedAt"
        )
    )
    AND (
      (
        ${checkpoint}."sourceRevision" = ${chat}."memorySourceRevision"
        AND ${checkpoint}."activeLeafMessageId" = ${chat}."activeLeafMessageId"
      )
      OR EXISTS (
        SELECT 1
        FROM "Message" AS paused_leaf
        INNER JOIN "MemoryPauseInterval" AS pause_interval
          ON pause_interval."userId" = ${chat}."userId"
          AND pause_interval."scope" IN (
            'MASTER'::"MemoryPauseScope",
            'SEARCH_HISTORY'::"MemoryPauseScope"
          )
          AND paused_leaf."createdAt" >= pause_interval."pausedAt"
          AND (
            pause_interval."resumedAt" IS NULL
            OR paused_leaf."createdAt" <= pause_interval."resumedAt"
          )
        WHERE paused_leaf."chatId" = ${chat}."id"
          AND paused_leaf."id" = ${chat}."activeLeafMessageId"
      )
    )
  `;
  if (aliases) return authority;
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "Chat" AS retained_source_chat
      INNER JOIN "ChatMemoryCheckpoint" AS retained_checkpoint
        ON retained_checkpoint."userId" = retained_source_chat."userId"
        AND retained_checkpoint."chatId" = retained_source_chat."id"
      WHERE ${authority}
    )
  `;
}

export function memoryHistoryChunkSourceAuthorityPredicate(
  aliases?: JoinedHistorySourceAliases
): Prisma.Sql {
  return memoryHistorySourceAuthorityPredicate("CHUNK", aliases);
}

/** Round equivalent of the exact current-source authority fence. */
export function memoryHistoryRoundSourceAuthorityPredicate(
  aliases?: JoinedHistorySourceAliases
): Prisma.Sql {
  return memoryHistorySourceAuthorityPredicate("ROUND", aliases);
}
