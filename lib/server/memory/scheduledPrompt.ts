import { Prisma } from "@prisma/client";

/**
 * Whether a user message is a scheduled task's prompt. The message carries
 * the mark itself: run creation sets it on the prompt a scheduled run posts,
 * and a branch copies it with the message. The prompt may have been written
 * by the model, so the prompt and every answer to it (the scheduled run, a
 * later regeneration, an answer in a branch at any depth) are never Personal
 * Memory history or direct user evidence, whatever the chat's mode.
 *
 * `messageId` is an expression of the enclosing query, evaluated outside the
 * subquery so its column references cannot resolve to the subquery's own
 * message row; null reads as false. The subquery is uncorrelated and bounded
 * by the message chat index, so PostgreSQL evaluates it once per query: a
 * whole message path costs one scan of the chat's messages.
 */
export function memoryScheduledPromptSql(chatId: string, messageId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(${messageId} IN (
    SELECT scheduled_prompt."id"
    FROM "Message" AS scheduled_prompt
    WHERE scheduled_prompt."chatId" = ${chatId}
      AND scheduled_prompt."scheduledTaskPrompt"
  ), false)`;
}
