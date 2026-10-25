import { Prisma, type PrismaClient } from "@prisma/client";
import {
  SCHEDULED_TASK_WEBHOOK_EVENT_RETENTION_MS,
  SCHEDULED_TASK_WEBHOOK_QUEUE_LIMIT,
  SCHEDULED_TASK_WEBHOOK_RATE_LIMIT,
  SCHEDULED_TASK_WEBHOOK_RATE_WINDOW_MS
} from "../../contracts/scheduledTasks";
import {
  newScheduledWebhookToken,
  scheduledWebhookTokenHash,
  scheduledWebhookTokenMatches,
  type ScheduledWebhookEvent
} from "./webhookEvent";
import type { ScheduledTaskWebhookAcceptance, ScheduledTaskWebhookIntakeStore } from "./webhookIntake";

/*
 * Persistence of automation webhooks: the endpoint's intake, the token, and
 * the event queue's transitions, which the owner store, the runner and run
 * creation apply inside their own transactions. Locks follow the scheduled
 * tasks' order: owner, task row, occurrence, then events.
 */

type Client = PrismaClient | Prisma.TransactionClient;

/** The automation takes webhook events now, over `task` and its owner `account`. */
const OPEN = Prisma.sql`(task."status" = 'ACTIVE'::"ScheduledTaskStatus" AND task."webhookEnabled"
  AND account."status" = 'active'::"UserStatus" AND account."scimDeactivatedAt" IS NULL)`;

export function createPrismaScheduledTaskWebhookIntakeStore(
  prisma: PrismaClient,
  options: Readonly<{ now?: () => Date }> = {}
): ScheduledTaskWebhookIntakeStore {
  const clock = options.now ?? (() => new Date());
  return {
    async find(publicId) {
      const [row] = await prisma.$queryRaw<Array<{ open: boolean; taskId: string; tokenHash: string | null; userId: string }>>(Prisma.sql`
        SELECT hook."taskId", hook."userId", hook."tokenHash", ${OPEN} AS "open"
        FROM "ScheduledTaskWebhook" AS hook
        INNER JOIN "ScheduledTask" AS task ON task."id" = hook."taskId" AND task."userId" = hook."userId"
        INNER JOIN "User" AS account ON account."id" = hook."userId"
        WHERE hook."publicId" = ${publicId}
      `);
      return row ?? null;
    },

    async accept({ event, publicId, taskId, tokenHash, userId }) {
      return prisma.$transaction(async (tx): Promise<ScheduledTaskWebhookAcceptance> => {
        // The task row serializes the event with token rotation, edits and pauses, the
        // runner's claims and settlements, and the task's other events.
        const [task] = await tx.$queryRaw<Array<{ open: boolean }>>(Prisma.sql`
          SELECT ${OPEN} AS "open"
          FROM "ScheduledTask" AS task
          INNER JOIN "User" AS account ON account."id" = task."userId"
          WHERE task."id" = ${taskId} AND task."userId" = ${userId}
          FOR NO KEY UPDATE OF task
        `);
        const [hook] = task ? await tx.$queryRaw<Array<{ tokenHash: string | null }>>(Prisma.sql`
          SELECT "tokenHash" FROM "ScheduledTaskWebhook"
          WHERE "taskId" = ${taskId} AND "userId" = ${userId} AND "publicId" = ${publicId}
        `) : [];
        // A token rotated, a trigger turned off or a pause committed meanwhile wins.
        const matches = scheduledWebhookTokenMatches(hook?.tokenHash ?? null, tokenHash);
        if (!task?.open || !hook || !matches) return { kind: "refused" };
        if (event.dedupeKey !== null &&
          await tx.scheduledTaskWebhookEvent.count({ where: { dedupeKey: event.dedupeKey, taskId } }) > 0) return { kind: "duplicate" };
        if (await tx.scheduledTaskWebhookEvent.count({ where: { state: "QUEUED", taskId } }) >= SCHEDULED_TASK_WEBHOOK_QUEUE_LIMIT) {
          return { kind: "queue_full" };
        }
        const now = clock();
        const windowStart = new Date(now.getTime() - SCHEDULED_TASK_WEBHOOK_RATE_WINDOW_MS);
        const [recent] = await tx.$queryRaw<Array<{ count: number; oldest: Date | null }>>(Prisma.sql`
          SELECT count(*)::int AS "count", min("receivedAt") AS "oldest"
          FROM "ScheduledTaskWebhookEvent"
          WHERE "taskId" = ${taskId} AND "receivedAt" > ${windowStart}
        `);
        if (recent && recent.count >= SCHEDULED_TASK_WEBHOOK_RATE_LIMIT) {
          const leavesAt = (recent.oldest?.getTime() ?? now.getTime()) + SCHEDULED_TASK_WEBHOOK_RATE_WINDOW_MS;
          return { kind: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((leavesAt - now.getTime()) / 1_000)) };
        }
        // Unique per task and in arrival order: the event's occurrence takes it as its instant.
        const [previous] = await tx.$queryRaw<Array<{ latest: Date | null }>>(Prisma.sql`
          SELECT max("receivedAt") AS "latest" FROM "ScheduledTaskWebhookEvent" WHERE "taskId" = ${taskId}
        `);
        const receivedAt = new Date(Math.max(now.getTime(), (previous?.latest?.getTime() ?? Number.NEGATIVE_INFINITY) + 1));
        await tx.scheduledTaskWebhookEvent.create({
          data: {
            bodyText: event.bodyText, contentType: event.contentType, dedupeKey: event.dedupeKey, eventName: event.eventName,
            receivedAt, taskId, userId
          },
          select: { id: true }
        });
        await tx.scheduledTaskWebhook.updateMany({ data: { lastEventAt: receivedAt }, where: { taskId, userId } });
        return { kind: "accepted" };
      });
    }
  };
}

/**
 * Replaces the webhook's token inside the caller's transaction, which holds
 * the task row: a new random token of which only the hash and the time it
 * was issued are kept, so the previous one stops working when this commits.
 * The plaintext exists only in the returned value.
 */
export async function replaceScheduledTaskWebhookToken(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; taskId: string; userId: string }>
): Promise<Readonly<{ issuedAt: Date; publicId: string; token: string }>> {
  const token = newScheduledWebhookToken();
  const [hook] = await tx.$queryRaw<Array<{ publicId: string }>>(Prisma.sql`
    UPDATE "ScheduledTaskWebhook" SET "tokenHash" = ${scheduledWebhookTokenHash(token)}, "tokenIssuedAt" = ${input.now}
    WHERE "taskId" = ${input.taskId} AND "userId" = ${input.userId}
    RETURNING "publicId"
  `);
  if (!hook) throw new Error("scheduled_task_webhook_missing");
  return { issuedAt: input.now, publicId: hook.publicId, token };
}

/**
 * Discards the task's waiting events, which can no longer run (the task was
 * paused or completed, or its webhook trigger turned off): their bodies are
 * cleared and they never run later. An event a still open occurrence carries
 * follows that occurrence instead, as a materialized scheduled instant does.
 */
export async function discardWaitingScheduledTaskWebhookEvents(tx: Prisma.TransactionClient, taskId: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTaskWebhookEvent" AS event
    SET "state" = 'DISCARDED'::"ScheduledTaskWebhookEventState", "bodyText" = NULL
    WHERE event."taskId" = ${taskId} AND event."state" = 'QUEUED'::"ScheduledTaskWebhookEventState"
      AND NOT EXISTS (
        SELECT 1 FROM "ScheduledTaskOccurrence" AS occurrence
        WHERE occurrence."taskId" = event."taskId" AND occurrence."trigger" = 'webhook'
          AND occurrence."scheduledFor" = event."receivedAt"
          AND occurrence."state" IN ('PENDING'::"ScheduledTaskOccurrenceState", 'RUNNING'::"ScheduledTaskOccurrenceState")
      )
  `);
}

/** The event of a webhook occurrence that ended without a run: discarded, it never runs. */
export async function discardScheduledTaskWebhookOccurrenceEvent(
  tx: Prisma.TransactionClient,
  occurrence: Readonly<{ scheduledFor: Date; taskId: string }>
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTaskWebhookEvent"
    SET "state" = 'DISCARDED'::"ScheduledTaskWebhookEventState", "bodyText" = NULL
    WHERE "taskId" = ${occurrence.taskId} AND "receivedAt" = ${occurrence.scheduledFor}
      AND "state" = 'QUEUED'::"ScheduledTaskWebhookEventState"
  `);
}

/**
 * In the transaction that creates the run of a webhook occurrence: its event
 * becomes admitted, linked to the occurrence, and its body is cleared, which
 * from now on lives only in the run's chat. False when the event no longer
 * waits, which must refuse the run.
 */
export async function admitScheduledTaskWebhookEvent(
  tx: Prisma.TransactionClient,
  occurrence: Readonly<{ id: string; scheduledFor: Date; taskId: string; userId: string }>
): Promise<boolean> {
  return await tx.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTaskWebhookEvent"
    SET "state" = 'ADMITTED'::"ScheduledTaskWebhookEventState", "bodyText" = NULL, "occurrenceId" = ${occurrence.id}
    WHERE "taskId" = ${occurrence.taskId} AND "userId" = ${occurrence.userId} AND "receivedAt" = ${occurrence.scheduledFor}
      AND "state" = 'QUEUED'::"ScheduledTaskWebhookEventState"
  `) === 1;
}

/** The waiting event a webhook occurrence carries, by its instant; null when none waits. */
export async function loadScheduledTaskWebhookEvent(
  client: Client,
  occurrence: Readonly<{ scheduledFor: Date; taskId: string; userId: string }>
): Promise<ScheduledWebhookEvent | null> {
  const event = await client.scheduledTaskWebhookEvent.findFirst({
    select: { bodyText: true, contentType: true, eventName: true, receivedAt: true },
    where: { receivedAt: occurrence.scheduledFor, state: "QUEUED", taskId: occurrence.taskId, userId: occurrence.userId }
  });
  return event && event.bodyText !== null
    ? { bodyText: event.bodyText, contentType: event.contentType, eventName: event.eventName, receivedAt: event.receivedAt }
    : null;
}

/**
 * Deletes, oldest first and at most `limit`, the bodyless events kept past
 * `SCHEDULED_TASK_WEBHOOK_EVENT_RETENTION_MS` for deduplication and the rate
 * cap; a waiting event is never deleted.
 */
export async function pruneScheduledTaskWebhookEvents(client: Client, now: Date, limit: number): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    DELETE FROM "ScheduledTaskWebhookEvent"
    WHERE "id" IN (
      SELECT "id" FROM "ScheduledTaskWebhookEvent"
      WHERE "receivedAt" < ${new Date(now.getTime() - SCHEDULED_TASK_WEBHOOK_EVENT_RETENTION_MS)}
        AND "state" <> 'QUEUED'::"ScheduledTaskWebhookEventState"
      ORDER BY "receivedAt" ASC
      LIMIT ${limit}
    )
  `);
}
