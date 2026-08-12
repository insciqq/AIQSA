import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../persistence/transaction";

function count(rows: readonly Readonly<{ count: number }>[]): number {
  const value = rows[0]?.count;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("memory_feedback_purge_count_invalid");
  }
  return value;
}

async function scrub(
  tx: MemoryTransaction,
  userId: string,
  predicate: Prisma.Sql,
  reason: string
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    WITH RECURSIVE selected AS (
      SELECT feedback."id", feedback."retractsFeedbackId"
      FROM "MemoryFeedback" AS feedback
      WHERE feedback."userId" = ${userId}
        AND feedback."contentPurgedAt" IS NULL
        AND (${predicate})
      UNION
      SELECT related."id", related."retractsFeedbackId"
      FROM "MemoryFeedback" AS related
      INNER JOIN selected
        ON related."retractsFeedbackId" = selected."id"
        OR selected."retractsFeedbackId" = related."id"
      WHERE related."userId" = ${userId}
        AND related."contentPurgedAt" IS NULL
    )
    UPDATE "MemoryFeedback" AS feedback
    SET
      "memoryFactId" = NULL,
      "memoryFactVersionId" = NULL,
      "episodeId" = NULL,
      "recallChunkId" = NULL,
      "modelRunId" = NULL,
      "modelRunMemoryItemId" = NULL,
      "modelRunToolCallId" = NULL,
      "sourceChatIdSnapshot" = NULL,
      "sourceBranchGenerationSnapshot" = NULL,
      "comment" = NULL,
      "retractsFeedbackId" = NULL,
      "memoryEventId" = NULL,
      "contentPurgedAt" = CURRENT_TIMESTAMP,
      "purgeReason" = ${reason}
    WHERE feedback."userId" = ${userId}
      AND feedback."contentPurgedAt" IS NULL
      AND feedback."id" IN (SELECT selected."id" FROM selected)
  `);
}

async function inspect(
  tx: MemoryTransaction,
  userId: string,
  predicate: Prisma.Sql
): Promise<number> {
  return count(await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    WITH RECURSIVE selected AS (
      SELECT feedback."id", feedback."retractsFeedbackId"
      FROM "MemoryFeedback" AS feedback
      WHERE feedback."userId" = ${userId}
        AND feedback."contentPurgedAt" IS NULL
        AND (${predicate})
      UNION
      SELECT related."id", related."retractsFeedbackId"
      FROM "MemoryFeedback" AS related
      INNER JOIN selected
        ON related."retractsFeedbackId" = selected."id"
        OR selected."retractsFeedbackId" = related."id"
      WHERE related."userId" = ${userId}
        AND related."contentPurgedAt" IS NULL
    )
    SELECT COUNT(*)::integer AS "count" FROM selected
  `));
}

export async function purgeMemoryFeedbackAccount(
  tx: MemoryTransaction,
  userId: string
): Promise<void> {
  await scrub(tx, userId, Prisma.sql`TRUE`, "account_deleted");
  await tx.memoryFeedback.deleteMany({ where: { userId } });
}

export async function purgeMemoryFeedbackHistoryClear(
  tx: MemoryTransaction,
  userId: string,
  targetIds: Readonly<{
    chunkIds: readonly string[];
    episodeIds: readonly string[];
  }>,
  reason: "all_reusable_delete" | "history_clear" | "suppressed_source" = "history_clear"
): Promise<void> {
  const predicate = historyTargetPredicate(targetIds);
  if (!predicate) return;
  await scrub(
    tx,
    userId,
    predicate,
    reason
  );
}

export async function inspectMemoryFeedbackHistoryClear(
  tx: MemoryTransaction,
  userId: string,
  targetIds: Readonly<{
    chunkIds: readonly string[];
    episodeIds: readonly string[];
  }>
): Promise<number> {
  const predicate = historyTargetPredicate(targetIds);
  if (!predicate) return 0;
  return inspect(tx, userId, predicate);
}

function historyTargetPredicate(targetIds: Readonly<{
  chunkIds: readonly string[];
  episodeIds: readonly string[];
}>): Prisma.Sql | null {
  const predicates: Prisma.Sql[] = [];
  if (targetIds.episodeIds.length > 0) {
    predicates.push(Prisma.sql`
      feedback."targetKind" = 'EPISODE'::"MemoryFeedbackTargetKind"
      AND feedback."episodeId" IN (${Prisma.join(targetIds.episodeIds)})
    `);
  }
  if (targetIds.chunkIds.length > 0) {
    predicates.push(Prisma.sql`
      feedback."targetKind" = 'RECALL_CHUNK'::"MemoryFeedbackTargetKind"
      AND feedback."recallChunkId" IN (${Prisma.join(targetIds.chunkIds)})
    `);
  }
  return predicates.length > 0 ? Prisma.join(predicates, " OR ") : null;
}

const invalidSourcePredicate = (chatId: string) => Prisma.sql`
  feedback."sourceChatIdSnapshot" = ${chatId}
  AND (
    feedback."sourceBranchGenerationSnapshot" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "Chat" AS source
      WHERE source."userId" = feedback."userId"
        AND source."id" = feedback."sourceChatIdSnapshot"
        AND source."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND source."memoryBranchGeneration" =
          feedback."sourceBranchGenerationSnapshot"
    )
  )
`;

export async function purgeMemoryFeedbackInvalidSource(
  tx: MemoryTransaction,
  userId: string,
  chatId: string,
  targetIds: Readonly<{
    chunkIds: readonly string[];
    episodeIds: readonly string[];
  }>
): Promise<void> {
  const targetPredicate = historyTargetPredicate(targetIds);
  await scrub(
    tx,
    userId,
    targetPredicate
      ? Prisma.sql`(${invalidSourcePredicate(chatId)}) OR (${targetPredicate})`
      : invalidSourcePredicate(chatId),
    "source_invalidated"
  );
}

export async function inspectMemoryFeedbackInvalidSource(
  tx: MemoryTransaction,
  userId: string,
  chatId: string,
  targetIds: Readonly<{
    chunkIds: readonly string[];
    episodeIds: readonly string[];
  }>
): Promise<number> {
  const targetPredicate = historyTargetPredicate(targetIds);
  const predicate = targetPredicate
    ? Prisma.sql`(${invalidSourcePredicate(chatId)}) OR (${targetPredicate})`
    : invalidSourcePredicate(chatId);
  return inspect(tx, userId, predicate);
}

function permanentChatPredicate(input: Readonly<{
  chatId: string;
  chunkIds: readonly string[];
  episodeIds: readonly string[];
  runIds: readonly string[];
}>): Prisma.Sql {
  const predicates: Prisma.Sql[] = [
    Prisma.sql`feedback."sourceChatIdSnapshot" = ${input.chatId}`
  ];
  if (input.runIds.length > 0) {
    predicates.push(Prisma.sql`feedback."modelRunId" IN (${Prisma.join(input.runIds)})`);
  }
  const history = historyTargetPredicate(input);
  if (history) predicates.push(history);
  return Prisma.join(predicates.map((predicate) => Prisma.sql`(${predicate})`), " OR ");
}

export async function purgeMemoryFeedbackPermanentChat(
  tx: MemoryTransaction,
  userId: string,
  input: Readonly<{
    chatId: string;
    chunkIds: readonly string[];
    episodeIds: readonly string[];
    runIds: readonly string[];
  }>
): Promise<void> {
  await scrub(
    tx,
    userId,
    permanentChatPredicate(input),
    "source_chat_deleted"
  );
}

export async function inspectMemoryFeedbackPermanentChat(
  tx: MemoryTransaction,
  userId: string,
  input: Readonly<{
    chatId: string;
    chunkIds: readonly string[];
    episodeIds: readonly string[];
    runIds: readonly string[];
  }>
): Promise<number> {
  return inspect(tx, userId, permanentChatPredicate(input));
}
