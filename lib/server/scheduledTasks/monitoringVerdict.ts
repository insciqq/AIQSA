import { Prisma } from "@prisma/client";
import type { MonitoringVerdict } from "./runnerPolicy";

type VerdictClient = Readonly<{ $executeRaw: Prisma.TransactionClient["$executeRaw"] }>;

/**
 * Records a monitoring check's reported outcome on the occurrence that
 * admitted the run, while that occurrence is running. The run's link to its
 * occurrence (made in the run's creating transaction) is the only authority:
 * no other run, and no settled occurrence, can take a verdict. Repeating the
 * write is safe and the run's last report wins, so recovery may execute an
 * interrupted report again. False when no running occurrence of this run
 * remains (the task or its history was deleted meanwhile).
 */
export async function recordScheduledMonitoringVerdict(
  client: VerdictClient,
  input: Readonly<{ runId: string; userId: string; verdict: MonitoringVerdict }>
): Promise<boolean> {
  const recorded = await client.$executeRaw(Prisma.sql`
    UPDATE "ScheduledTaskOccurrence" SET "verdict" = ${input.verdict}
    WHERE "runId" = ${input.runId} AND "userId" = ${input.userId}
      AND "state" = 'RUNNING'::"ScheduledTaskOccurrenceState"
  `);
  return recorded > 0;
}
