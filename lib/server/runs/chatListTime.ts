import { Prisma } from "@prisma/client";

/**
 * A chat's place in the chat list is `Chat.updatedAt` (`lib/server/chats/navigation.ts`), which every Prisma write of
 * the row moves. A monitoring check moves its chat only when its result is shown, anything but a healthy `no_update`
 * (operator report 2026-11-08: an hourly monitor stayed at the top of Today with nothing to show). So the writes a
 * check's run makes (its admission, its terminal settlement, its usage totals) keep the time the chat had, and the
 * settlement of its occurrence moves the chat when the outcome is shown (`lib/server/scheduledTasks/runnerStore.ts`).
 * A check is known by the marker its accepted request froze (`NormalizedRunRequest.monitoringVerdictTool`); every other
 * run, the owner's own messages included, moves its chat as before.
 */

type ChatTimeClient = Pick<Prisma.TransactionClient, "$queryRaw" | "chat" | "modelRun">;

/**
 * The time a monitoring check's chat keeps through the check's own writes, read under the chat row lock this takes. Every
 * writer that locks both takes the chat before the run (owner → chat → run: the settlement scope and usage totals), so
 * call this before locking the run; null for any other run.
 */
export async function monitoringCheckChatTime(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: Readonly<{ chatId: string; runId: string }>
): Promise<Date | null> {
  const [row] = await tx.$queryRaw<Array<{ updatedAt: Date }>>(Prisma.sql`
    SELECT chat."updatedAt"
    FROM "ModelRun" AS run
    JOIN "Chat" AS chat ON chat."id" = run."chatId"
    WHERE run."id" = ${input.runId} AND chat."id" = ${input.chatId}
      AND run."normalizedRequest" -> 'monitoringVerdictTool' = 'true'::jsonb
    FOR UPDATE OF chat
  `);
  return row?.updatedAt instanceof Date ? row.updatedAt : null;
}

/**
 * The time a monitoring check's admission leaves its chat, read once the admission holds the chat locked and before
 * its other writes to it: the chat's own, or for a chat a monthly rotation opens, the time of the chat the task moves
 * off, so the task's chat keeps its place until a result is shown. The chat moved off is only read, never locked.
 */
export async function monitoringAdmissionChatTime(
  tx: Pick<ChatTimeClient, "chat">,
  input: Readonly<{ chatId: string; rotatedFromChatId?: string | null; userId: string }>
): Promise<Date | null> {
  const rotated = input.rotatedFromChatId
    ? await tx.chat.findFirst({ select: { updatedAt: true },
      where: { id: input.rotatedFromChatId, permanentDeletionAt: null, userId: input.userId } })
    : null;
  if (rotated) return rotated.updatedAt;
  return (await tx.chat.findFirst({ select: { updatedAt: true }, where: { id: input.chatId, userId: input.userId } }))?.updatedAt ??
    null;
}

/** Puts the chat back at `updatedAt` after this transaction's writes for a monitoring check moved it. */
export async function keepChatListTime(tx: Pick<ChatTimeClient, "chat">, chatId: string, updatedAt: Date): Promise<void> {
  await tx.chat.updateMany({ data: { updatedAt }, where: { id: chatId } });
}

/**
 * The settlement of a monitoring check whose result is shown moves its chat to the settlement time, never back and not
 * while the chat is being deleted. Only a check of this occurrence counts: any other run's own writes moved its chat.
 */
export async function moveShownMonitoringCheck(
  tx: Pick<ChatTimeClient, "chat" | "modelRun">,
  input: Readonly<{ now: Date; occurrenceId: string; runId: string; userId: string }>
): Promise<void> {
  const run = await tx.modelRun.findFirst({
    select: { chatId: true },
    where: {
      id: input.runId, normalizedRequest: { equals: true, path: ["monitoringVerdictTool"] },
      scheduledOccurrenceId: input.occurrenceId, userId: input.userId
    }
  });
  if (!run) return;
  await tx.chat.updateMany({
    data: { updatedAt: input.now },
    where: { id: run.chatId, permanentDeletionAt: null, updatedAt: { lt: input.now }, userId: input.userId }
  });
}
