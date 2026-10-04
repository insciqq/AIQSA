import { Prisma } from "@prisma/client";

/**
 * Whether a user message is a scheduled task's prompt: some run of it, the
 * scheduled run or any later regeneration, carries a scheduled origin. The
 * origin is a plain value on the run that outlives its task, and the prompt
 * may have been written by the model, so the prompt and every answer to it
 * are never Personal Memory history or direct user evidence, whatever the
 * chat's mode. The test follows the message, not the run that settled it: a
 * regeneration carries no origin of its own.
 *
 * `messageId` is an expression of the enclosing query. The subquery is
 * uncorrelated and bounded by the run chat index, so PostgreSQL evaluates it
 * once per query: a whole message path costs one scan of the chat's runs.
 */
export function memoryScheduledPromptSql(chatId: string, messageId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(${messageId} IN (
    SELECT scheduled_run."userMessageId"
    FROM "ModelRun" AS scheduled_run
    WHERE scheduled_run."chatId" = ${chatId}
      AND scheduled_run."scheduledTaskId" IS NOT NULL
  ), false)`;
}
