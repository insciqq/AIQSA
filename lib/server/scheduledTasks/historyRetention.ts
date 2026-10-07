import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memoryClient";
import {
  PermanentChatDeletionError,
  type PermanentChatDeletionCapability,
  type PermanentChatDeletionService
} from "../chats/permanentDeletion/service";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";

/**
 * A scheduled task's history retention: the chats its runs created are
 * permanently deleted once their last run settled more than the task's
 * `historyRetentionDays` ago, through the same deletion service and
 * obligations as the owner's own permanent deletion. Kept are the task's
 * current chat, chats of a task without retention (null: forever), and every
 * chat the owner touched: one with an owner-written message, pinned, in a
 * folder, with an active share, renamed or restored from the archive
 * (`Chat.ownerKeptAt`). So is a chat a rotation still carries from (its
 * copied result or its Workspace seed not yet restored) and one with a run in
 * progress. Deleting the task makes its chats ordinary, never deleted.
 */

/** Old task chats one sweep hands to permanent deletion at most. */
export const SCHEDULED_TASK_HISTORY_SWEEP_LIMIT = 20;
/** How often the runner sweeps; retention is counted in days, so a quarter hour is timely. */
export const SCHEDULED_TASK_HISTORY_SWEEP_INTERVAL_MS = 15 * 60_000;

type Client = PrismaClient | Prisma.TransactionClient;

/** The task chat `chat` of task `task` is under retention and nothing keeps it (the time aside). */
function eligibleSql(now: Date): Prisma.Sql {
  return Prisma.sql`
    task."historyRetentionDays" IS NOT NULL
    AND chat."projectId" IS NULL AND chat."permanentDeletionAt" IS NULL
    AND chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
    AND chat."id" IS DISTINCT FROM task."chatId"
    AND NOT chat."pinned" AND chat."folderId" IS NULL AND chat."ownerKeptAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Message" AS message
      WHERE message."chatId" = chat."id" AND message."role" = 'user' AND NOT message."scheduledTaskPrompt")
    AND NOT EXISTS (
      SELECT 1 FROM "SharedChatSnapshot" AS share
      WHERE share."chatId" = chat."id" AND share."revokedAt" IS NULL
        AND (share."expiresAt" IS NULL OR share."expiresAt" > ${now}))
    AND NOT EXISTS (SELECT 1 FROM "ScheduledTaskCarryover" AS carried WHERE carried."sourceChatId" = chat."id")
    AND NOT EXISTS (
      SELECT 1 FROM "ChatContinuationWorkspaceSeed" AS seed
      WHERE seed."sourceChatId" = chat."id" AND seed."scheduledTaskId" IS NOT NULL
        AND seed."status" IN ('CAPTURING'::"ChatContinuationWorkspaceSeedStatus", 'READY'::"ChatContinuationWorkspaceSeedStatus",
          'TRANSFERRED'::"ChatContinuationWorkspaceSeedStatus", 'RESTORING'::"ChatContinuationWorkspaceSeedStatus"))
    AND NOT EXISTS (
      SELECT 1 FROM "ModelRun" AS active
      WHERE active."chatId" = chat."id" AND active."status" IN ('preparing'::"ModelRunStatus", 'queued'::"ModelRunStatus",
        'streaming'::"ModelRunStatus", 'in_progress'::"ModelRunStatus"))
  `;
}

/** Task chats with the time their last run settled; a chat without any run is never selected. */
function taskChatsSql(): Prisma.Sql {
  return Prisma.sql`
    FROM "Chat" AS chat
    JOIN "ScheduledTask" AS task ON task."id" = chat."scheduledTaskId" AND task."userId" = chat."userId"
    CROSS JOIN LATERAL (SELECT max(run."updatedAt") AS "settledAt" FROM "ModelRun" AS run WHERE run."chatId" = chat."id")
      AS last_run
  `;
}

function dueAtSql(): Prisma.Sql {
  return Prisma.sql`last_run."settledAt" + make_interval(days => task."historyRetentionDays")`;
}

/**
 * Per task of the owner: when its retention deletes the next chat as things
 * stand, or nothing when no chat is due to go.
 */
export async function loadScheduledTaskHistoryNextDeletions(
  client: Client,
  userId: string,
  taskIds: readonly string[],
  now: Date
): Promise<Map<string, Date>> {
  if (taskIds.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ dueAt: Date; taskId: string }>>(Prisma.sql`
    SELECT task."id" AS "taskId", min(${dueAtSql()}) AS "dueAt"
    ${taskChatsSql()}
    WHERE chat."userId" = ${userId} AND chat."scheduledTaskId" = ANY(${[...taskIds]}::text[])
      AND last_run."settledAt" IS NOT NULL AND ${eligibleSql(now)}
    GROUP BY task."id"
  `);
  return new Map(rows.map((row) => [row.taskId, row.dueAt]));
}

type Candidate = Readonly<{ chatId: string; taskId: string; userId: string }>;

/** Whether one candidate is still due, read under the deletion admission's chat lock. */
async function stillDue(tx: Prisma.TransactionClient, candidate: Candidate, now: Date): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ due: boolean }>>(Prisma.sql`
    SELECT true AS "due"
    ${taskChatsSql()}
    WHERE chat."id" = ${candidate.chatId} AND chat."userId" = ${candidate.userId} AND task."id" = ${candidate.taskId}
      AND last_run."settledAt" IS NOT NULL AND ${dueAtSql()} <= ${now} AND ${eligibleSql(now)}
  `);
  return rows.length === 1;
}

export type ScheduledTaskHistoryRetention = (now: Date, limit?: number) => Promise<number>;

/**
 * One bounded sweep, oldest due chat first: each goes through the owner's
 * permanent deletion service, whose admission rechecks the rule under the
 * chat lock, so an owner action committed meanwhile wins. Content-free:
 * only the count of deleted chats is kept on the task.
 */
export function createPrismaScheduledTaskHistoryRetention(deps: Readonly<{
  deletion: Readonly<{ capability: PermanentChatDeletionCapability; service: Pick<PermanentChatDeletionService, "confirm"> }>;
  prisma: PrismaClient;
}>): ScheduledTaskHistoryRetention {
  return async (now, limit = SCHEDULED_TASK_HISTORY_SWEEP_LIMIT) => {
    // Until permanent deletion opens, nothing is deleted; chats wait.
    if (!deps.deletion.capability.enabled) return 0;
    const candidates = await deps.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT chat."id" AS "chatId", task."id" AS "taskId", chat."userId"
      ${taskChatsSql()}
      WHERE chat."scheduledTaskId" IS NOT NULL AND last_run."settledAt" IS NOT NULL AND ${dueAtSql()} <= ${now}
        AND ${eligibleSql(now)}
      ORDER BY last_run."settledAt" ASC, chat."id" ASC
      LIMIT ${Math.max(1, Math.min(limit, 200))}
    `);
    let deleted = 0;
    for (const candidate of candidates) {
      try {
        await deps.deletion.service.confirm(candidate.userId, candidate.chatId, {
          alsoForgetOriginMemories: false, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID()
        }, { condition: (tx) => stillDue(tx, candidate, now) });
      } catch (error) {
        // A chat that changed, became busy or went meanwhile waits for the next sweep.
        logEvent("job_attempt", {
          subsystem: "scheduled_tasks", stage: "cleanup", outcome: "skipped", action: "skip",
          code: error instanceof PermanentChatDeletionError ? "scheduled_task_history_chat_kept"
            : "scheduled_task_history_retention_failed",
          prisma_code: databaseFailureCode(error)
        });
        continue;
      }
      deleted += 1;
      // Content-free and outside the admission, so the task row is never locked after a chat row.
      await deps.prisma.scheduledTask.updateMany({
        data: { historyDeletedChats: { increment: 1 } }, where: { id: candidate.taskId, userId: candidate.userId }
      }).catch(() => undefined);
    }
    if (deleted > 0) logEvent("job_attempt", { subsystem: "scheduled_tasks", stage: "cleanup", outcome: "completed", count: deleted });
    return deleted;
  };
}
