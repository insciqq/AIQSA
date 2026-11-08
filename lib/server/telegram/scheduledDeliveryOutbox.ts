import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Records a settled occurrence's Telegram delivery once (`ON CONFLICT DO
 * NOTHING`) when its task sends results to Telegram. The runner calls it
 * inside the transaction that settles a notifying occurrence, so a crash
 * after that commit still leaves the row for the sender's sweep
 * (`scheduledDelivery.ts`), which rechecks the task and Telegram access
 * before every attempt. True when this call wrote the row.
 */
export async function recordTelegramScheduledDelivery(
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
  occurrenceId: string,
  now: Date
): Promise<boolean> {
  const inserted = await client.$executeRaw(Prisma.sql`
    INSERT INTO "TelegramScheduledDelivery" ("id", "occurrenceId", "userId", "state", "attempts", "nextAttemptAt", "createdAt")
    SELECT ${randomUUID()}, occurrence."id", occurrence."userId", 'pending'::"TelegramScheduledDeliveryState", 0, ${now}, ${now}
    FROM "ScheduledTaskOccurrence" AS occurrence
    INNER JOIN "ScheduledTask" AS task ON task."id" = occurrence."taskId" AND task."userId" = occurrence."userId"
    WHERE occurrence."id" = ${occurrenceId}
      AND task."telegramNotify"
      AND occurrence."state" IN ('COMPLETED'::"ScheduledTaskOccurrenceState",
        'FAILED'::"ScheduledTaskOccurrenceState", 'SKIPPED'::"ScheduledTaskOccurrenceState")
    ON CONFLICT ("occurrenceId") DO NOTHING
  `);
  return inserted === 1;
}
