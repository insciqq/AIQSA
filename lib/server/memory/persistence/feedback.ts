import { Prisma } from "@prisma/client";

function memoryConversationFeedbackPredicate(
  userId: string,
  chatId: string,
  target: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "MemoryFeedback" AS negative_feedback
    INNER JOIN "ModelRun" AS negative_run
      ON negative_run."userId" = negative_feedback."userId"
      AND negative_run."id" = negative_feedback."modelRunId"
    WHERE negative_feedback."userId" = ${userId}
      AND negative_feedback."feedbackType" = 'NOT_USEFUL'::"MemoryFeedbackType"
      AND ${target}
      AND negative_feedback."contentPurgedAt" IS NULL
      AND negative_run."chatId" = ${chatId}
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryFeedback" AS feedback_retraction
        WHERE feedback_retraction."userId" = negative_feedback."userId"
          AND feedback_retraction."feedbackType" = 'RETRACT'::"MemoryFeedbackType"
          AND feedback_retraction."retractsFeedbackId" = negative_feedback."id"
          AND feedback_retraction."contentPurgedAt" IS NULL
      )
  )`;
}

export function memoryFactConversationFeedbackPredicate(
  userId: string,
  chatId: string,
  factVersionId: Prisma.Sql = Prisma.sql`version."id"`
): Prisma.Sql {
  return memoryConversationFeedbackPredicate(
    userId,
    chatId,
    Prisma.sql`negative_feedback."memoryFactVersionId" = ${factVersionId}`
  );
}

export function memoryChunkConversationFeedbackPredicate(
  userId: string,
  chatId: string,
  chunkId: Prisma.Sql = Prisma.sql`chunk."id"`
): Prisma.Sql {
  return memoryConversationFeedbackPredicate(
    userId,
    chatId,
    Prisma.sql`negative_feedback."recallChunkId" = ${chunkId}`
  );
}

export function memoryRoundConversationFeedbackPredicate(
  userId: string,
  chatId: string,
  roundId: Prisma.Sql = Prisma.sql`round."id"`
): Prisma.Sql {
  return memoryConversationFeedbackPredicate(
    userId,
    chatId,
    Prisma.sql`negative_feedback."recallRoundId" = ${roundId}`
  );
}
