import { Prisma, type PrismaClient } from "@prisma/client";

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

/**
 * Whether a turn in a chat of this Memory mode may read Memory: any turn of
 * an ordinary chat, and an answer to a scheduled task's prompt also in its
 * excluded chat (exclusion keeps a task chat out of learning, not out of its
 * own task's reads). A temporary chat never reads.
 */
export function memoryReadableChatMode(chatMemoryMode: string, scheduledPrompt: boolean): boolean {
  return chatMemoryMode === "NORMAL" || (scheduledPrompt && chatMemoryMode === "EXCLUDED");
}

/**
 * Whether a run answers a scheduled task's prompt. Such a run reads Memory
 * without ever touching it: a task repeating every hour would otherwise make
 * the facts it reads look used. A run that cannot be read counts as one.
 */
export async function memoryRunAnswersScheduledPrompt(
  client: Pick<PrismaClient, "modelRun">,
  input: Readonly<{ runId: string; userId: string }>
): Promise<boolean> {
  const run = await client.modelRun.findFirst({
    select: { userMessage: { select: { scheduledTaskPrompt: true } } },
    where: { id: input.runId, userId: input.userId }
  });
  return run?.userMessage.scheduledTaskPrompt !== false;
}
