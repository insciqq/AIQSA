import { Prisma } from "@prisma/client";
import {
  ScheduledOccurrenceConflictError,
  type ScheduledOccurrenceAdmission,
  type ScheduledUnavailableSource
} from "../runs/runRepositoryContract";

type LinkedTask = {
  baselineAssistantMessageId: string | null; baselineGeneration: number | null; chatId: string | null; chatPeriod: string | null;
};

/**
 * Called by run creation inside its transaction: the PENDING occurrence
 * without a run becomes RUNNING with the new run, chat, user message, the
 * task generation, revision and chat epoch and the run's source health (the
 * relevant sources its plan lacked, if any), and the task points at the run's
 * chat (bookkeeping, no revision change). The task must still be at the
 * revision, generation and chat epoch the runner read before preparation, so
 * a pause, an edit or another run that moved the task's chat meanwhile fences
 * this admission.
 *
 * A run that moves the task to another chat advances the epoch, so a late
 * settlement of a run of the old chat can change neither the chat nor the
 * baseline. A monthly rotation also replaces the baseline (its ids name the
 * old chat) with a frozen copy of the previous shown result for the new chat
 * and transfers the Workspace seed captured from the old one. When the old
 * chat never showed a result of its own (a month of monitoring checks without
 * news, or of failed runs), the copy still carried into it moves on to the
 * new epoch instead, so the comparison basis survives. A run that sees a
 * carried copy rechecks it here: still the task's copy for this epoch and
 * generation, its source answer still there and its chat not being deleted.
 * A missing, already linked or fenced occurrence, or any of these checks
 * failing, throws, rolling the whole admission (its new chat included) back,
 * so an occurrence without a run proves that no run was created for it; the
 * runner admits it again under the current task.
 */
export async function linkScheduledTaskOccurrence(
  tx: Prisma.TransactionClient,
  input: Pick<ScheduledOccurrenceAdmission, "chatPeriod" | "occurrenceId" | "previousResultCopy" | "rotation" | "taskChatEpoch" |
    "taskGeneration" | "taskId" | "taskRevision"> & Readonly<{
    chatId: string;
    now: Date;
    runId: string;
    unavailableSources: readonly ScheduledUnavailableSource[];
    userId: string;
    userMessageId: string;
  }>
): Promise<void> {
  const unavailableSources = input.unavailableSources.length > 0
    ? JSON.stringify(input.unavailableSources.map(({ name, reason, relied, serverId }) => ({ name, reason, relied, serverId })))
    : null;
  const readEpoch = input.taskChatEpoch ?? 0;
  // Task before occurrence, the order of the task's cascade delete and of the runner.
  const tasks = await tx.$queryRaw<LinkedTask[]>(Prisma.sql`
    SELECT "chatId", "chatPeriod", "baselineAssistantMessageId", "baselineGeneration" FROM "ScheduledTask"
    WHERE "id" = ${input.taskId} AND "userId" = ${input.userId}
      AND "revision" = ${input.taskRevision} AND "generation" = ${input.taskGeneration} AND "chatEpoch" = ${readEpoch}
    FOR NO KEY UPDATE
  `);
  const task = tasks[0];
  if (tasks.length !== 1 || !task) throw new ScheduledOccurrenceConflictError();
  const moved = task.chatId !== input.chatId;
  const epoch = moved ? readEpoch + 1 : readEpoch;
  // A rotation starts from the chat the runner read; no run of it can be open (`previous_running`).
  if (input.rotation && (!moved || task.chatId !== input.rotation.fromChatId)) throw new ScheduledOccurrenceConflictError();
  const copy = input.previousResultCopy;
  const copySource = copy ? await assertCopyCurrent(tx, input, task, copy, readEpoch) : null;
  const linked = await tx.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTaskOccurrence"
    SET "state" = 'RUNNING'::"ScheduledTaskOccurrenceState", "runId" = ${input.runId}, "chatId" = ${input.chatId},
      "userMessageId" = ${input.userMessageId}, "startedAt" = COALESCE("startedAt", ${input.now}),
      "leaseExpiresAt" = NULL, "reasonCode" = NULL, "taskGeneration" = ${input.taskGeneration},
      "taskRevision" = ${input.taskRevision}, "chatEpoch" = ${epoch}, "unavailableSources" = ${unavailableSources}::jsonb
    WHERE "id" = ${input.occurrenceId} AND "taskId" = ${input.taskId} AND "userId" = ${input.userId}
      AND "state" = 'PENDING'::"ScheduledTaskOccurrenceState" AND "runId" IS NULL
  `);
  if (linked !== 1) throw new ScheduledOccurrenceConflictError();
  const period = input.chatPeriod ?? null;
  if (input.rotation) {
    // The old chat's ids never reach the new one: its carried copy takes their place.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ScheduledTask" SET "chatId" = ${input.chatId}, "chatEpoch" = ${epoch}, "chatPeriod" = ${period},
        "baselineRunId" = NULL, "baselineUserMessageId" = NULL, "baselineAssistantMessageId" = NULL, "baselineGeneration" = NULL
      WHERE "id" = ${input.taskId} AND "userId" = ${input.userId}
    `);
  } else if (moved) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ScheduledTask" SET "chatId" = ${input.chatId}, "chatEpoch" = ${epoch}, "chatPeriod" = ${period}
      WHERE "id" = ${input.taskId} AND "userId" = ${input.userId}
    `);
  } else if (task.chatPeriod === null && period !== null) {
    // A chat older than months takes the month of its first run since.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ScheduledTask" SET "chatPeriod" = ${period} WHERE "id" = ${input.taskId} AND "userId" = ${input.userId}
    `);
  }
  const carriedOn = input.rotation !== undefined && copy !== undefined && copySource === "carried";
  if (moved && !carriedOn) {
    // A copy belongs to the chat it was carried into; a new chat starts without one unless this rotation carries it.
    await tx.scheduledTaskCarryover.deleteMany({ where: { taskId: input.taskId, userId: input.userId } });
  }
  if (!input.rotation) return;
  if (copy && carriedOn) {
    // The stored copy itself moves on (its text and servers as frozen), never one the runner rewrote.
    const advanced = await tx.scheduledTaskCarryover.updateMany({
      data: { chatEpoch: epoch },
      where: { chatEpoch: readEpoch, sourceAssistantMessageId: copy.sourceAssistantMessageId, sourceChatId: copy.sourceChatId,
        taskGeneration: input.taskGeneration, taskId: input.taskId, userId: input.userId }
    });
    if (advanced.count !== 1) throw new ScheduledOccurrenceConflictError();
  } else if (copy) {
    await tx.scheduledTaskCarryover.create({ data: {
      answerText: copy.answer, chatEpoch: epoch, reliedServerIds: [...copy.reliedServerIds], sourceAssistantMessageId: copy.sourceAssistantMessageId,
      sourceChatId: copy.sourceChatId, taskGeneration: input.taskGeneration, taskId: input.taskId, userId: input.userId
    } });
  }
  if (input.rotation.seedId) {
    const transferred = await tx.chatContinuationWorkspaceSeed.updateMany({
      data: { leaseExpiresAt: null, leaseToken: null, newChatId: input.chatId, status: "TRANSFERRED" },
      where: { id: input.rotation.seedId, newChatId: null, scheduledTaskId: input.taskId, sourceChatId: input.rotation.fromChatId,
        status: "READY" }
    });
    if (transferred.count !== 1) throw new ScheduledOccurrenceConflictError();
  }
}

/**
 * A carried copy the run sees is still current, and what it copies: at a
 * rotation from a chat with a shown result of this question, that result
 * (`baseline`: the answer in the chat it rotates from); otherwise the task's
 * carried copy for the epoch and generation read (`carried`), which a
 * rotation moves on. Either way its source answer is still there, owned by
 * the task's owner, in a chat that is not being deleted.
 */
async function assertCopyCurrent(
  tx: Prisma.TransactionClient,
  input: Pick<ScheduledOccurrenceAdmission, "rotation" | "taskGeneration" | "taskId"> & Readonly<{ userId: string }>,
  task: LinkedTask,
  copy: NonNullable<ScheduledOccurrenceAdmission["previousResultCopy"]>,
  readEpoch: number
): Promise<"baseline" | "carried"> {
  const shown = task.baselineAssistantMessageId !== null && task.baselineGeneration === input.taskGeneration;
  let source: "baseline" | "carried";
  if (input.rotation && shown) {
    if (copy.sourceChatId !== input.rotation.fromChatId || task.baselineAssistantMessageId !== copy.sourceAssistantMessageId) {
      throw new ScheduledOccurrenceConflictError();
    }
    source = "baseline";
  } else {
    const carried = await tx.scheduledTaskCarryover.count({ where: {
      chatEpoch: readEpoch, sourceAssistantMessageId: copy.sourceAssistantMessageId, sourceChatId: copy.sourceChatId,
      taskGeneration: input.taskGeneration, taskId: input.taskId, userId: input.userId
    } });
    if (carried !== 1) throw new ScheduledOccurrenceConflictError();
    source = "carried";
  }
  const sources = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT message."id" FROM "Message" AS message
    JOIN "Chat" AS chat ON chat."id" = message."chatId"
    WHERE message."id" = ${copy.sourceAssistantMessageId} AND message."chatId" = ${copy.sourceChatId}
      AND message."role" = 'assistant' AND chat."userId" = ${input.userId} AND chat."permanentDeletionAt" IS NULL
  `);
  if (sources.length !== 1) throw new ScheduledOccurrenceConflictError();
  return source;
}
