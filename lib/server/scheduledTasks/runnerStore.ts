import { Prisma, type PrismaClient } from "@prisma/client";
import type { ScheduledTaskRunTrigger } from "../../contracts/scheduledTasks";
import { SMTP_CONTROL_ID } from "../email/repository";
import type { ScheduledTaskNotification } from "./notifications";
import {
  SCHEDULED_TASK_LATENESS_MS,
  SCHEDULED_TASK_RETRY_WINDOW_MS,
  expiredPendingOutcome,
  linkedRunOutcome,
  planScheduledTaskClaim,
  planTaskSettlement,
  type ScheduledTaskOutcome,
  type ScheduledTaskSettledState,
  type ScheduledTaskStatusColumn
} from "./runnerPolicy";
import { pruneScheduledTaskOccurrences, scheduledTaskScheduleFromColumns, type ScheduledTaskScheduleColumns } from "./store";

export type ScheduledTaskSettlement = Readonly<{
  occurrenceId: string;
  reasonCode: string | null;
  runId: string | null;
  state: ScheduledTaskSettledState;
  /** This settlement paused its task. */
  taskPaused: boolean;
}>;

export type ScheduledTaskExecution = Readonly<{
  /** The task's chat while it can take the next turn: owned, personal, not archived or deleting, not bound to an Assistant. */
  chat: Readonly<{ activeLeafMessageId: string | null; id: string }> | null;
  occurrence: Readonly<{ id: string; scheduledFor: Date; taskId: string; trigger: ScheduledTaskRunTrigger; userId: string }>;
  ownerActive: boolean;
  task: Readonly<{
    modelId: string; prompt: string; provider: string; revision: number; searchEnabled: boolean;
    status: ScheduledTaskStatusColumn; timeZone: string; title: string;
  }>;
}>;

export type ScheduledTaskDispatch = Readonly<{
  /** Running or leased occurrences per owner, installation-wide. */
  executing: ReadonlyMap<string, number>;
  /** Unleased pending occurrences, oldest instant first. */
  pending: readonly Readonly<{ id: string; userId: string }>[];
}>;

/** Persistence of the occurrence lifecycle; every settlement also writes the task's bookkeeping. */
export interface ScheduledTaskRunnerStore {
  /** Records the occurrences of due active tasks and advances them; tasks locked elsewhere wait. */
  claimDue(now: Date, limit: number): Promise<Readonly<{ claimed: number; settlements: readonly ScheduledTaskSettlement[] }>>;
  /** Settles running occurrences whose run ended or vanished. */
  settleFinishedRuns(now: Date, limit: number): Promise<readonly ScheduledTaskSettlement[]>;
  /** Settles unleased pending occurrences past their lateness or retry window. */
  expirePending(now: Date, limit: number): Promise<readonly ScheduledTaskSettlement[]>;
  loadDispatch(now: Date, limit: number): Promise<ScheduledTaskDispatch>;
  /** Leases an unlinked pending occurrence for one admission attempt. */
  acquireLease(occurrenceId: string, now: Date, until: Date): Promise<boolean>;
  /** A pending, unlinked occurrence with its current task, owner and chat. */
  loadExecution(occurrenceId: string): Promise<ScheduledTaskExecution | null>;
  readOccurrence(occurrenceId: string): Promise<Readonly<{ runId: string | null; state: string }> | null>;
  /** Releases a still pending occurrence for a later attempt; a busy chat is remembered for the window's end. */
  retryLater(occurrenceId: string, reasonCode: "chat_busy" | null): Promise<void>;
  /** Settles a pending occurrence that has no run; pauses are decided against `observedRevision`. */
  settlePending(occurrenceId: string, outcome: ScheduledTaskOutcome, now: Date, observedRevision?: number):
    Promise<ScheduledTaskSettlement | null>;
  /** Settles a running occurrence once its run ended; null while the run is active. */
  settleLinked(occurrenceId: string, now: Date): Promise<ScheduledTaskSettlement | null>;
  /** Claims the single result email of a settled occurrence when the owner can receive it. */
  claimNotification(occurrenceId: string, now: Date): Promise<ScheduledTaskNotification | null>;
}

type LockedTask = { consecutiveFailures: number; revision: number; status: ScheduledTaskStatusColumn };
type LockedOccurrence = {
  id: string; leaseExpiresAt: Date | null; reasonCode: string | null; runId: string | null; scheduledFor: Date;
  startedAt: Date | null; state: string; taskId: string; trigger: string; userId: string;
};
type Locked = Readonly<{ occurrence: LockedOccurrence; task: LockedTask }>;
type ClaimRow = ScheduledTaskScheduleColumns & { id: string; nextRunAt: Date; timeZone: string; userId: string };

function trigger(value: string): ScheduledTaskRunTrigger {
  return value === "manual" ? "manual" : "schedule";
}

/** Task row before occurrence row: the order of the task's cascade delete and of run admission's link. */
async function lockForSettlement(tx: Prisma.TransactionClient, occurrenceId: string): Promise<Locked | null> {
  const [reference] = await tx.$queryRaw<Array<{ taskId: string }>>(Prisma.sql`
    SELECT "taskId" FROM "ScheduledTaskOccurrence" WHERE "id" = ${occurrenceId}
  `);
  if (!reference) return null;
  const [task] = await tx.$queryRaw<LockedTask[]>(Prisma.sql`
    SELECT "status"::text AS "status", "consecutiveFailures", "revision"
    FROM "ScheduledTask" WHERE "id" = ${reference.taskId}
    FOR NO KEY UPDATE
  `);
  if (!task) return null;
  const [occurrence] = await tx.$queryRaw<LockedOccurrence[]>(Prisma.sql`
    SELECT "id", "taskId", "userId", "trigger", "state"::text AS "state", "runId", "scheduledFor", "startedAt",
      "reasonCode", "leaseExpiresAt"
    FROM "ScheduledTaskOccurrence" WHERE "id" = ${occurrenceId} AND "taskId" = ${reference.taskId}
    FOR UPDATE
  `);
  return occurrence ? { occurrence, task } : null;
}

async function applySettlement(
  tx: Prisma.TransactionClient,
  { occurrence, task }: Locked,
  outcome: ScheduledTaskOutcome,
  now: Date,
  observedRevision?: number
): Promise<ScheduledTaskSettlement> {
  await tx.scheduledTaskOccurrence.update({
    data: { finishedAt: now, leaseExpiresAt: null, reasonCode: outcome.reasonCode, state: outcome.state },
    where: { id: occurrence.id }
  });
  const plan = planTaskSettlement({ observedRevision, outcome, task, trigger: trigger(occurrence.trigger) });
  await tx.scheduledTask.update({
    data: {
      consecutiveFailures: plan.consecutiveFailures, unseenResultAt: now,
      // An automatic pause is a runner status transition: it bumps the revision.
      ...(plan.pauseReason
        ? { nextRunAt: null, pauseReason: plan.pauseReason, revision: { increment: 1 }, status: "PAUSED" as const }
        : {})
    },
    where: { id: occurrence.taskId }
  });
  return {
    occurrenceId: occurrence.id, reasonCode: outcome.reasonCode, runId: occurrence.runId, state: outcome.state,
    taskPaused: plan.pauseReason !== null
  };
}

async function settleEach(
  rows: readonly { id: string }[],
  settle: (id: string) => Promise<ScheduledTaskSettlement | null>
): Promise<ScheduledTaskSettlement[]> {
  const settled: ScheduledTaskSettlement[] = [];
  for (const { id } of rows) {
    const settlement = await settle(id);
    if (settlement) settled.push(settlement);
  }
  return settled;
}

export function createPrismaScheduledTaskRunnerStore(prisma: PrismaClient): ScheduledTaskRunnerStore {
  function settleLinked(occurrenceId: string, now: Date) {
    return prisma.$transaction(async (tx) => {
      const locked = await lockForSettlement(tx, occurrenceId);
      if (!locked || locked.occurrence.state !== "RUNNING") return null;
      const run = locked.occurrence.runId
        ? await tx.modelRun.findUnique({ select: { errorPayload: true, status: true }, where: { id: locked.occurrence.runId } })
        : null;
      const outcome = linkedRunOutcome(run);
      return outcome ? applySettlement(tx, locked, outcome, now) : null;
    });
  }

  return {
    async claimDue(now, limit) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ClaimRow[]>(Prisma.sql`
          SELECT "id", "userId", "scheduleKind"::text AS "scheduleKind", "timeOfDayMinutes", "daysOfWeekMask",
            "dayOfMonth", "onceLocalDate", "timeZone", "nextRunAt"
          FROM "ScheduledTask"
          WHERE "status" = 'ACTIVE'::"ScheduledTaskStatus" AND "nextRunAt" <= ${now}
          ORDER BY "nextRunAt" ASC, "id" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `);
        const settlements: ScheduledTaskSettlement[] = [];
        for (const row of rows) {
          const plan = planScheduledTaskClaim({
            nextRunAt: row.nextRunAt, schedule: scheduledTaskScheduleFromColumns(row), timeZone: row.timeZone
          }, now);
          const inserted = await tx.scheduledTaskOccurrence.createManyAndReturn({
            data: plan.occurrences.map((occurrence) => ({
              scheduledFor: occurrence.scheduledFor, taskId: row.id, trigger: "schedule", userId: row.userId,
              ...(occurrence.missed ? { finishedAt: now, reasonCode: "missed", state: "SKIPPED" as const } : {})
            })),
            select: { id: true, state: true },
            skipDuplicates: true
          });
          const missed = inserted.filter((occurrence) => occurrence.state === "SKIPPED");
          await tx.scheduledTask.update({
            data: {
              nextRunAt: plan.nextRunAt,
              ...(plan.status === "ACTIVE"
                ? {}
                : { pauseReason: plan.pauseReason, revision: { increment: 1 }, status: plan.status }),
              ...(missed.length > 0 ? { unseenResultAt: now } : {})
            },
            where: { id: row.id }
          });
          await pruneScheduledTaskOccurrences(tx, row.id);
          settlements.push(...missed.map((occurrence) => ({
            occurrenceId: occurrence.id, reasonCode: "missed", runId: null, state: "SKIPPED" as const, taskPaused: false
          })));
        }
        return { claimed: rows.length, settlements };
      }, { maxWait: 10_000, timeout: 60_000 });
    },

    async settleFinishedRuns(now, limit) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT occurrence."id"
        FROM "ScheduledTaskOccurrence" AS occurrence
        LEFT JOIN "ModelRun" AS run ON run."id" = occurrence."runId"
        WHERE occurrence."state" = 'RUNNING'::"ScheduledTaskOccurrenceState"
          AND (occurrence."runId" IS NULL OR run."status" IN (
            'complete'::"ModelRunStatus", 'cancelled'::"ModelRunStatus", 'error'::"ModelRunStatus"))
        ORDER BY occurrence."startedAt" ASC NULLS FIRST, occurrence."id" ASC
        LIMIT ${limit}
      `);
      return settleEach(rows, (id) => settleLinked(id, now));
    },

    async expirePending(now, limit) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "ScheduledTaskOccurrence"
        WHERE "state" = 'PENDING'::"ScheduledTaskOccurrenceState"
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
          AND ("scheduledFor" < ${new Date(now.getTime() - SCHEDULED_TASK_LATENESS_MS)}
            OR "startedAt" < ${new Date(now.getTime() - SCHEDULED_TASK_RETRY_WINDOW_MS)})
        ORDER BY "scheduledFor" ASC, "id" ASC
        LIMIT ${limit}
      `);
      return settleEach(rows, (id) => prisma.$transaction(async (tx) => {
        const locked = await lockForSettlement(tx, id);
        const occurrence = locked?.occurrence;
        if (!locked || !occurrence || occurrence.state !== "PENDING" || occurrence.runId !== null ||
          (occurrence.leaseExpiresAt && occurrence.leaseExpiresAt > now)) return null;
        const outcome = expiredPendingOutcome(occurrence, now);
        return outcome ? applySettlement(tx, locked, outcome, now) : null;
      }));
    },

    async loadDispatch(now, limit) {
      const pending = await prisma.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
        SELECT "id", "userId" FROM "ScheduledTaskOccurrence"
        WHERE "state" = 'PENDING'::"ScheduledTaskOccurrenceState"
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "scheduledFor" ASC, "createdAt" ASC, "id" ASC
        LIMIT ${limit}
      `);
      const executing = await prisma.$queryRaw<Array<{ count: number; userId: string }>>(Prisma.sql`
        SELECT "userId", count(*)::int AS "count" FROM "ScheduledTaskOccurrence"
        WHERE "state" = 'RUNNING'::"ScheduledTaskOccurrenceState"
          OR ("state" = 'PENDING'::"ScheduledTaskOccurrenceState" AND "leaseExpiresAt" > ${now})
        GROUP BY "userId"
      `);
      return { executing: new Map(executing.map((row) => [row.userId, row.count])), pending };
    },

    async acquireLease(occurrenceId, now, until) {
      return await prisma.$executeRaw(Prisma.sql`
        UPDATE "ScheduledTaskOccurrence"
        SET "leaseExpiresAt" = ${until}, "startedAt" = COALESCE("startedAt", ${now})
        WHERE "id" = ${occurrenceId} AND "state" = 'PENDING'::"ScheduledTaskOccurrenceState" AND "runId" IS NULL
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
      `) === 1;
    },

    async loadExecution(occurrenceId) {
      const row = await prisma.scheduledTaskOccurrence.findUnique({
        select: {
          id: true, runId: true, scheduledFor: true, state: true, taskId: true, trigger: true, userId: true,
          task: {
            select: {
              modelId: true, prompt: true, provider: true, revision: true, searchEnabled: true, status: true, timeZone: true,
              title: true, user: { select: { status: true } },
              chat: {
                select: {
                  activeLeafMessageId: true, archived: true, assistantId: true, id: true, permanentDeletionAt: true, projectId: true
                }
              }
            }
          }
        },
        where: { id: occurrenceId }
      });
      if (!row || row.state !== "PENDING" || row.runId !== null) return null;
      const { chat, user, ...task } = row.task;
      const usable = chat && !chat.archived && chat.permanentDeletionAt === null && chat.projectId === null &&
        chat.assistantId === null;
      return {
        chat: usable ? { activeLeafMessageId: chat.activeLeafMessageId, id: chat.id } : null,
        occurrence: {
          id: row.id, scheduledFor: row.scheduledFor, taskId: row.taskId, trigger: trigger(row.trigger), userId: row.userId
        },
        ownerActive: user.status === "active",
        task
      };
    },

    async readOccurrence(occurrenceId) {
      return prisma.scheduledTaskOccurrence.findUnique({ select: { runId: true, state: true }, where: { id: occurrenceId } });
    },

    async retryLater(occurrenceId, reasonCode) {
      await prisma.scheduledTaskOccurrence.updateMany({
        data: { leaseExpiresAt: null, ...(reasonCode ? { reasonCode } : {}) },
        where: { id: occurrenceId, runId: null, state: "PENDING" }
      });
    },

    async settlePending(occurrenceId, outcome, now, observedRevision) {
      return prisma.$transaction(async (tx) => {
        const locked = await lockForSettlement(tx, occurrenceId);
        if (!locked || locked.occurrence.state !== "PENDING" || locked.occurrence.runId !== null) return null;
        return applySettlement(tx, locked, outcome, now, observedRevision);
      });
    },

    settleLinked,

    async claimNotification(occurrenceId, now) {
      const [row] = await prisma.$queryRaw<Array<{
        chatId: string | null; email: string; reasonCode: string | null; state: ScheduledTaskSettledState;
        taskPauseReason: string | null; title: string; trigger: string;
      }>>(Prisma.sql`
        UPDATE "ScheduledTaskOccurrence" AS occurrence SET "notifiedAt" = ${now}
        FROM "ScheduledTask" AS task, "User" AS account
        WHERE occurrence."id" = ${occurrenceId} AND occurrence."notifiedAt" IS NULL
          AND occurrence."state" IN ('COMPLETED'::"ScheduledTaskOccurrenceState",
            'FAILED'::"ScheduledTaskOccurrenceState", 'SKIPPED'::"ScheduledTaskOccurrenceState")
          AND task."id" = occurrence."taskId" AND task."emailNotify"
          AND account."id" = occurrence."userId" AND account."status" = 'active'::"UserStatus" AND account."email" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM "AuthIdentity" AS verified
            WHERE verified."userId" = account."id" AND verified."emailVerifiedAt" IS NOT NULL
              AND verified."normalizedEmail" = lower(btrim(account."email")))
          AND EXISTS (
            SELECT 1 FROM "SmtpControl" AS smtp
            WHERE smtp."id" = ${SMTP_CONTROL_ID} AND smtp."enabled" AND smtp."activeConfig" IS NOT NULL)
        RETURNING occurrence."state"::text AS "state", occurrence."reasonCode", occurrence."trigger",
          COALESCE(occurrence."chatId", task."chatId") AS "chatId", task."title", task."pauseReason" AS "taskPauseReason",
          account."email"
      `);
      return row ? { ...row, trigger: trigger(row.trigger) } : null;
    }
  };
}
