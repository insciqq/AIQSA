import { Prisma } from "@prisma/client";
import { ScheduledOccurrenceConflictError, type ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";

/**
 * Called by run creation inside its transaction: the PENDING occurrence
 * without a run becomes RUNNING with the new run, chat, user message and the
 * task generation and revision, and the task points at the run's chat
 * (bookkeeping, no revision change). The task must still be at the revision
 * and generation the runner read before preparation, so a pause or edit made
 * meanwhile fences this admission. A missing, already linked or fenced
 * occurrence throws, rolling the whole admission back, so an occurrence
 * without a run proves that no run was created for it.
 */
export async function linkScheduledTaskOccurrence(
  tx: Prisma.TransactionClient,
  input: Pick<ScheduledOccurrenceAdmission, "occurrenceId" | "taskGeneration" | "taskId" | "taskRevision"> & Readonly<{
    chatId: string;
    now: Date;
    runId: string;
    userId: string;
    userMessageId: string;
  }>
): Promise<void> {
  // Task before occurrence, the order of the task's cascade delete and of the runner.
  const tasks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "ScheduledTask"
    WHERE "id" = ${input.taskId} AND "userId" = ${input.userId}
      AND "revision" = ${input.taskRevision} AND "generation" = ${input.taskGeneration}
    FOR NO KEY UPDATE
  `);
  if (tasks.length !== 1) throw new ScheduledOccurrenceConflictError();
  const linked = await tx.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTaskOccurrence"
    SET "state" = 'RUNNING'::"ScheduledTaskOccurrenceState", "runId" = ${input.runId}, "chatId" = ${input.chatId},
      "userMessageId" = ${input.userMessageId}, "startedAt" = COALESCE("startedAt", ${input.now}),
      "leaseExpiresAt" = NULL, "reasonCode" = NULL, "taskGeneration" = ${input.taskGeneration},
      "taskRevision" = ${input.taskRevision}
    WHERE "id" = ${input.occurrenceId} AND "taskId" = ${input.taskId} AND "userId" = ${input.userId}
      AND "state" = 'PENDING'::"ScheduledTaskOccurrenceState" AND "runId" IS NULL
  `);
  if (linked !== 1) throw new ScheduledOccurrenceConflictError();
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTask" SET "chatId" = ${input.chatId}
    WHERE "id" = ${input.taskId} AND "userId" = ${input.userId} AND "chatId" IS DISTINCT FROM ${input.chatId}
  `);
}
