import { Prisma } from "@prisma/client";

/**
 * Ordinary-chat pushes skip runs a scheduled task started: the scheduled
 * settlement sends its own notice. The run's scheduled origin identifies them
 * and survives the deletion of the task and its occurrences.
 *
 * The enclosing query names the `ModelRun` row `run`.
 */
export function notScheduledRunSql(): Prisma.Sql {
  return Prisma.sql`run."scheduledTaskId" IS NULL`;
}

/**
 * Ordinary-chat pushes also skip the runs of an automatic answer review: the
 * answer under review and every step. The session's end sends one notice.
 *
 * The enclosing query names the `ModelRun` row `run`.
 */
export function notAutoReviewRunSql(): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "Message" AS review_answer
    INNER JOIN "AnswerReviewSession" AS review_session
      ON review_session."chatId" = review_answer."chatId"
     AND (review_session."id" = review_answer."answerReviewSessionId"
       OR review_session."sourceAssistantMessageId" = review_answer."id")
    WHERE review_answer."id" = run."assistantMessageId"
      AND review_session."mode" = 'auto'::"AnswerReviewMode"
  )`;
}
