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
