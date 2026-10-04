import { Prisma } from "@prisma/client";

/**
 * Ordinary-chat pushes skip runs a scheduled task started: the scheduled
 * settlement sends its own notice. Today the occurrence link identifies them;
 * once runs record a scheduled origin, only this predicate changes.
 *
 * The enclosing query names the `ModelRun` row `run`.
 */
export function notScheduledRunSql(): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "ScheduledTaskOccurrence" AS scheduled_occurrence
    WHERE scheduled_occurrence."runId" = run."id"
  )`;
}
