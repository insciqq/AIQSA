import { Prisma, type PrismaClient, type ScheduledTaskKind as TaskKindColumn } from "@prisma/client";
import type { ScheduledTaskChatMode, ScheduledTaskKind, ScheduledTaskRunTrigger } from "../../contracts/scheduledTasks";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { SMTP_CONTROL_ID } from "../email/repository";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { applyMemorySourceMutations, type LockedMemorySourceChat } from "../memory/sourceState";
import type { ScheduledResultCopy } from "../runs/runRepositoryContract";
import type { ScheduledTaskNotification } from "./notifications";
import {
  SCHEDULED_TASK_LATENESS_MS,
  SCHEDULED_TASK_RETRY_WINDOW_MS,
  SCHEDULED_TASK_RUN_DEADLINE_MS,
  completedRunCheck,
  expiredPendingOutcome,
  linkedRunOutcome,
  planClaimOverlap,
  planOccurrenceSettlement,
  planScheduledTaskClaim,
  type MonitoringCheckSettlement,
  type ScheduledTaskBaseline,
  type ScheduledTaskOpenOccurrence,
  type ScheduledTaskOutcome,
  type ScheduledTaskSettledState,
  type ScheduledTaskStatusColumn
} from "./runnerPolicy";
import { occurrenceCheckSourcesMissing, occurrenceSourcesIncomplete, unavailableSourcesWire } from "./sourceHealth";
import {
  pruneScheduledTaskOccurrences,
  scheduledTaskChatModeFromColumn,
  scheduledTaskKindFromColumn,
  scheduledTaskScheduleFromColumns,
  type ScheduledTaskScheduleColumns
} from "./store";

export type ScheduledTaskSettlement = Readonly<{
  occurrenceId: string;
  reasonCode: string | null;
  runId: string | null;
  /** This settlement starts a streak of incomplete runs: the streak's one health alert. */
  sourceAlert: boolean;
  /**
   * Source health of the settled run: it completed without a relevant source
   * its admission recorded as missing. A monitoring check whose previous shown
   * result relied on that source settled as "could not check" (see
   * `occurrenceCheckSourcesMissing`).
   */
  sourcesIncomplete: boolean;
  state: ScheduledTaskSettledState;
  /** This settlement paused its task. */
  taskPaused: boolean;
}>;

export type ScheduledTaskExecution = Readonly<{
  /**
   * The previous shown result carried into the task's current chat by its
   * monthly rotation, reauthorized: the copy of the current chat epoch and
   * generation (the owner's, by its keys) whose source answer is still there
   * in a chat that is not being deleted; null otherwise.
   */
  carriedResult: ScheduledResultCopy | null;
  /** The task's chat while it can take the next turn: owned, personal, not archived or deleting, not bound to an Assistant. */
  chat: Readonly<{ activeLeafMessageId: string | null; id: string }> | null;
  occurrence: Readonly<{ id: string; scheduledFor: Date; taskId: string; trigger: ScheduledTaskRunTrigger; userId: string }>;
  ownerActive: boolean;
  /**
   * The personal MCP servers the previous shown result of the current
   * generation called, or relied on but already missed; null when there is no
   * such result to judge by (a first run, or its run is gone), so every
   * server counts. Read only while the task has tools on.
   */
  relevantMcpServerIds: readonly string[] | null;
  task: Readonly<{
    /** The newest shown completed result, as stored; admission checks it against the chat path. */
    baseline: ScheduledTaskBaseline | null;
    /** Read with `revision`: the link refuses another (see `ScheduledTask.chatEpoch`). */
    chatEpoch: number;
    chatMode: ScheduledTaskChatMode;
    /** The month the current chat takes; null when none was recorded. */
    chatPeriod: string | null;
    generation: number;
    kind: ScheduledTaskKind;
    memoryEnabled: boolean; modelId: string; prompt: string; provider: string; revision: number; searchEnabled: boolean;
    /** Read with `revision`; empty unless tools are on. */
    pinnedSkillIds: readonly string[];
    /** The prompt's page-reading snapshot, read with `revision`. */
    promptUrlDigests: readonly string[];
    status: ScheduledTaskStatusColumn; timeZone: string; title: string; toolsEnabled: boolean; workspaceEnabled: boolean;
  }>;
}>;

/** An admitted scheduled run past its deadline, by the origin the run carries. */
export type ScheduledTaskOverdueRun = Readonly<{ runId: string; userId: string }>;

export type ScheduledTaskDispatch = Readonly<{
  /** Scheduled runs not yet terminal and admissions in flight, per owner, installation-wide. */
  executing: ReadonlyMap<string, number>;
  /** Unleased pending occurrences, oldest instant first. */
  pending: readonly Readonly<{ id: string; userId: string }>[];
}>;

/** Persistence of the occurrence lifecycle; every settlement also writes the task's bookkeeping. */
export interface ScheduledTaskRunnerStore {
  /**
   * Records the occurrences of due active tasks and advances them; tasks
   * locked elsewhere wait. Its settlements (missed, superseded and
   * previous_running skips) are history only.
   */
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
  /**
   * The previous shown result a monthly rotation carries from `chatId`: the
   * baseline answer's text, bounded, with the personal MCP servers it relied
   * on; null when that answer is gone or has no text.
   */
  loadRotationCopy(input: Readonly<{ baseline: ScheduledTaskBaseline; chatId: string; userId: string }>):
    Promise<ScheduledResultCopy | null>;
  /**
   * Archives the chat a rotation moved the task off, unless the owner pinned
   * it, put it in a folder or shared it, or it is in use; true when archived.
   */
  archiveRotatedChat(input: Readonly<{ chatId: string; taskId: string; userId: string }>): Promise<boolean>;
  readOccurrence(occurrenceId: string): Promise<Readonly<{ runId: string | null; state: string }> | null>;
  /**
   * Releases a still pending occurrence for a later attempt; a busy chat and
   * Workspace files that could not be carried yet are remembered for the window's end.
   */
  retryLater(occurrenceId: string, reasonCode: "chat_busy" | "workspace_carryover_unavailable" | null): Promise<void>;
  /** Settles a pending occurrence that has no run; pauses are decided against `observedRevision`. */
  settlePending(occurrenceId: string, outcome: ScheduledTaskOutcome, now: Date, observedRevision?: number):
    Promise<ScheduledTaskSettlement | null>;
  /** Settles a running occurrence once its run ended; null while the run is active. */
  settleLinked(occurrenceId: string, now: Date): Promise<ScheduledTaskSettlement | null>;
  /** Claims the single result email of a settled occurrence when the owner can receive it. */
  claimNotification(occurrenceId: string, now: Date): Promise<ScheduledTaskNotification | null>;
  /**
   * Active scheduled runs admitted before `now` minus the run deadline, oldest
   * first, found by the scheduled origin on the run itself, so a run outlives
   * its task's deletion here too.
   */
  overdueRuns(now: Date, limit: number): Promise<readonly ScheduledTaskOverdueRun[]>;
}

type LockedTask = {
  baselineGeneration: number | null; carriedGeneration: number | null; chatEpoch: number; consecutiveFailures: number;
  consecutiveIncompleteRuns: number; consecutiveMissingVerdicts: number; generation: number; kind: TaskKindColumn;
  revision: number; status: ScheduledTaskStatusColumn;
};
type LockedOccurrence = {
  chatEpoch: number | null; id: string; leaseExpiresAt: Date | null; reasonCode: string | null; runId: string | null;
  scheduledFor: Date; startedAt: Date | null; state: string; taskGeneration: number | null; taskId: string;
  taskRevision: number | null; trigger: string; unavailableSources: Prisma.JsonValue | null; userId: string;
  userMessageId: string | null; verdict: string | null;
};
type Locked = Readonly<{ occurrence: LockedOccurrence; task: LockedTask }>;
type ClaimRow = ScheduledTaskScheduleColumns & { id: string; nextRunAt: Date; timeZone: string; userId: string };

function trigger(value: string): ScheduledTaskRunTrigger {
  return value === "manual" ? "manual" : "schedule";
}

/** Code points a carried copy keeps of the previous answer, its database bound. */
export const SCHEDULED_CARRYOVER_ANSWER_MAX_LENGTH = 100_000;

/** An answer's text as a carried copy keeps it: its text blocks, trimmed and bounded. */
export function scheduledCopyText(content: Prisma.JsonValue): string {
  const blocks = content !== null && typeof content === "object" && !Array.isArray(content) && Array.isArray(content.blocks)
    ? content.blocks : [];
  const text = textFromContentBlocks({ blocks }).trim();
  const characters = Array.from(text);
  return characters.length > SCHEDULED_CARRYOVER_ANSWER_MAX_LENGTH
    ? `${characters.slice(0, SCHEDULED_CARRYOVER_ANSWER_MAX_LENGTH - 1).join("").trimEnd()}…` : text;
}

/** Task row before occurrence row: the order of the task's cascade delete and of run admission's link. */
async function lockForSettlement(tx: Prisma.TransactionClient, occurrenceId: string): Promise<Locked | null> {
  const [reference] = await tx.$queryRaw<Array<{ taskId: string }>>(Prisma.sql`
    SELECT "taskId" FROM "ScheduledTaskOccurrence" WHERE "id" = ${occurrenceId}
  `);
  if (!reference) return null;
  const [task] = await tx.$queryRaw<LockedTask[]>(Prisma.sql`
    SELECT task."status"::text AS "status", task."kind"::text AS "kind", task."consecutiveFailures",
      task."consecutiveIncompleteRuns", task."consecutiveMissingVerdicts", task."revision", task."generation",
      task."baselineGeneration", task."chatEpoch",
      (SELECT carried."taskGeneration" FROM "ScheduledTaskCarryover" AS carried
        WHERE carried."taskId" = task."id" AND carried."chatEpoch" = task."chatEpoch") AS "carriedGeneration"
    FROM "ScheduledTask" AS task WHERE task."id" = ${reference.taskId}
    FOR NO KEY UPDATE OF task
  `);
  if (!task) return null;
  const [occurrence] = await tx.$queryRaw<LockedOccurrence[]>(Prisma.sql`
    SELECT "id", "taskId", "userId", "trigger", "state"::text AS "state", "runId", "scheduledFor", "startedAt",
      "reasonCode", "leaseExpiresAt", "userMessageId", "taskGeneration", "taskRevision", "chatEpoch", "verdict",
      "unavailableSources"
    FROM "ScheduledTaskOccurrence" WHERE "id" = ${occurrenceId} AND "taskId" = ${reference.taskId}
    FOR UPDATE
  `);
  return occurrence ? { occurrence, task } : null;
}

/**
 * The monitoring settlement of a completed linked run (see `completedRunCheck`),
 * health first: a check whose admission missed a source its previous shown
 * result relied on settles as `could_not_check`, from the same frozen source
 * health that extends the task's incomplete streak in `applySettlement`.
 */
function monitoringSettlementOf({ occurrence, task }: Locked): MonitoringCheckSettlement | null {
  return completedRunCheck({
    healthIncomplete: occurrenceCheckSourcesMissing(occurrence.unavailableSources),
    occurrence,
    task: { ...task, kind: scheduledTaskKindFromColumn(task.kind) }
  });
}

/**
 * Settles one locked occurrence and writes its task's bookkeeping per
 * `planOccurrenceSettlement`: the counters and the incomplete-run streak, an
 * automatic pause, a monitoring goal's completion (decided under the task lock
 * against the revision the run was accepted under), the unread result and the
 * baseline the next same-chat run sees, only under the chat epoch its run was
 * admitted under, which retires a result carried into a rotated chat. A
 * monitoring check's outcome is also kept on its run, where the transcript
 * reads it after the occurrence history is pruned.
 */
async function applySettlement(
  tx: Prisma.TransactionClient,
  { occurrence, task }: Locked,
  outcome: ScheduledTaskOutcome,
  now: Date,
  options: Readonly<{
    assistantMessageId?: string | null; check?: MonitoringCheckSettlement | null; observedRevision?: number;
  }> = {}
): Promise<ScheduledTaskSettlement> {
  const check = options.check ?? null;
  const sourcesIncomplete = outcome.state === "COMPLETED" && occurrenceSourcesIncomplete(occurrence.unavailableSources);
  const plan = planOccurrenceSettlement({
    assistantMessageId: options.assistantMessageId ?? null, check, observedRevision: options.observedRevision,
    occurrence: { ...occurrence, trigger: trigger(occurrence.trigger) }, outcome, sourcesIncomplete, task
  });
  await tx.scheduledTaskOccurrence.update({
    data: {
      finishedAt: now, leaseExpiresAt: null, reasonCode: outcome.reasonCode, state: outcome.state,
      unseenAt: plan.notifies ? now : null
    },
    where: { id: occurrence.id }
  });
  const { baseline } = plan;
  await tx.scheduledTask.update({
    data: {
      consecutiveFailures: plan.consecutiveFailures,
      consecutiveIncompleteRuns: plan.consecutiveIncompleteRuns,
      consecutiveMissingVerdicts: plan.consecutiveMissingVerdicts,
      ...(baseline ? {
        baselineAssistantMessageId: baseline.assistantMessageId, baselineGeneration: baseline.generation,
        baselineRunId: baseline.runId, baselineUserMessageId: baseline.userMessageId
      } : {}),
      // An automatic pause and a reached goal are runner status transitions: they bump the revision.
      ...(plan.pauseReason
        ? { nextRunAt: null, pauseReason: plan.pauseReason, revision: { increment: 1 }, status: "PAUSED" as const }
        : {}),
      ...(plan.goalCompletes
        ? { completionReason: "goal_reached", nextRunAt: null, pauseReason: null, revision: { increment: 1 },
          status: "COMPLETED" as const }
        : {})
    },
    where: { id: occurrence.taskId }
  });
  // The rotated chat has its own shown result now: the carried copy has served.
  if (baseline) await tx.scheduledTaskCarryover.deleteMany({ where: { taskId: occurrence.taskId } });
  if (check && occurrence.runId) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ModelRun" SET "scheduledOutcome" = ${check.outcome}
      WHERE "id" = ${occurrence.runId} AND "userId" = ${occurrence.userId} AND "scheduledOccurrenceId" = ${occurrence.id}
    `);
  }
  return {
    occurrenceId: occurrence.id, reasonCode: outcome.reasonCode, runId: occurrence.runId, sourceAlert: plan.sourceAlert,
    sourcesIncomplete, state: outcome.state, taskPaused: plan.pauseReason !== null
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

/** Quiet skips the claim records for a task it holds locked; nothing else of the task changes. */
async function skipQuietly(
  tx: Prisma.TransactionClient,
  input: Readonly<{ id: string; now: Date; reasonCode: string }>
): Promise<ScheduledTaskSettlement | null> {
  const [skipped] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "ScheduledTaskOccurrence"
    SET "state" = 'SKIPPED'::"ScheduledTaskOccurrenceState", "finishedAt" = ${input.now}, "leaseExpiresAt" = NULL,
      "reasonCode" = ${input.reasonCode}
    WHERE "id" = ${input.id} AND "state" = 'PENDING'::"ScheduledTaskOccurrenceState" AND "runId" IS NULL
    RETURNING "id"
  `);
  return skipped ? {
    occurrenceId: skipped.id, reasonCode: input.reasonCode, runId: null, sourceAlert: false, sourcesIncomplete: false,
    state: "SKIPPED", taskPaused: false
  } : null;
}

export function createPrismaScheduledTaskRunnerStore(prisma: PrismaClient): ScheduledTaskRunnerStore {
  function settleLinked(occurrenceId: string, now: Date) {
    return prisma.$transaction(async (tx) => {
      const locked = await lockForSettlement(tx, occurrenceId);
      if (!locked || locked.occurrence.state !== "RUNNING") return null;
      const run = locked.occurrence.runId
        ? await tx.modelRun.findUnique({
          select: { assistantMessageId: true, errorPayload: true, status: true }, where: { id: locked.occurrence.runId }
        })
        : null;
      const outcome = linkedRunOutcome(run);
      if (!outcome) return null;
      // A completed monitoring check settles with its outcome as the reason.
      const check = outcome.state === "COMPLETED" ? monitoringSettlementOf(locked) : null;
      return applySettlement(tx, locked, check ? { reasonCode: check.outcome, state: "COMPLETED" } : outcome, now,
        { assistantMessageId: run?.assistantMessageId ?? null, check });
    });
  }

  return {
    async claimDue(now, limit) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ClaimRow[]>(Prisma.sql`
          SELECT "id", "userId", "scheduleKind"::text AS "scheduleKind", "timeOfDayMinutes", "daysOfWeekMask",
            "dayOfMonth", "onceLocalDate", "everyHours", "untilMinutes", "timeZone", "nextRunAt"
          FROM "ScheduledTask"
          WHERE "status" = 'ACTIVE'::"ScheduledTaskStatus" AND "nextRunAt" <= ${now}
          ORDER BY "nextRunAt" ASC, "id" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `);
        const settlements: ScheduledTaskSettlement[] = [];
        for (const row of rows) {
          const schedule = scheduledTaskScheduleFromColumns(row);
          const plan = planScheduledTaskClaim({ nextRunAt: row.nextRunAt, schedule, timeZone: row.timeZone }, now);
          const runnable = plan.occurrences.find((occurrence) => !occurrence.missed);
          // The task row is locked first, then its open occurrences, like every settlement.
          const open = runnable ? await tx.$queryRaw<ScheduledTaskOpenOccurrence[]>(Prisma.sql`
            SELECT "id", "state"::text AS "state", "runId", "leaseExpiresAt", "reasonCode"
            FROM "ScheduledTaskOccurrence"
            WHERE "taskId" = ${row.id}
              AND "state" IN ('PENDING'::"ScheduledTaskOccurrenceState", 'RUNNING'::"ScheduledTaskOccurrenceState")
            FOR UPDATE
          `) : [];
          const overlap = planClaimOverlap({ now, open, recurring: schedule.kind !== "once" });
          for (const stale of overlap.superseded) {
            const skipped = await skipQuietly(tx, { id: stale.id, now, reasonCode: stale.reasonCode });
            if (skipped) settlements.push(skipped);
          }
          const inserted = await tx.scheduledTaskOccurrence.createManyAndReturn({
            data: plan.occurrences.map((occurrence) => {
              const reasonCode = occurrence.missed ? "missed" : overlap.previousRunning ? "previous_running" : null;
              return {
                scheduledFor: occurrence.scheduledFor, taskId: row.id, trigger: "schedule", userId: row.userId,
                ...(reasonCode ? { finishedAt: now, reasonCode, state: "SKIPPED" as const } : {})
              };
            }),
            select: { id: true, reasonCode: true, state: true },
            skipDuplicates: true
          });
          await tx.scheduledTask.update({
            data: {
              nextRunAt: plan.nextRunAt,
              ...(plan.status === "ACTIVE"
                ? {}
                : { pauseReason: plan.pauseReason, revision: { increment: 1 }, status: plan.status })
            },
            where: { id: row.id }
          });
          await pruneScheduledTaskOccurrences(tx, row.id);
          settlements.push(...inserted.filter((occurrence) => occurrence.state === "SKIPPED").map((occurrence) => ({
            occurrenceId: occurrence.id, reasonCode: occurrence.reasonCode, runId: null, sourceAlert: false,
            sourcesIncomplete: false, state: "SKIPPED" as const, taskPaused: false
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
      // A scheduled run counts until it is terminal, by the origin it carries
      // (even when its task and occurrence are gone); an admission in flight
      // counts by its lease until it links its run.
      const executing = await prisma.$queryRaw<Array<{ count: number; userId: string }>>(Prisma.sql`
        SELECT "userId", count(*)::int AS "count" FROM (
          SELECT "userId" FROM "ModelRun"
          WHERE "status" IN ('preparing'::"ModelRunStatus", 'queued'::"ModelRunStatus", 'streaming'::"ModelRunStatus",
              'in_progress'::"ModelRunStatus")
            AND "scheduledTaskId" IS NOT NULL
          UNION ALL
          SELECT "userId" FROM "ScheduledTaskOccurrence"
          WHERE "state" = 'PENDING'::"ScheduledTaskOccurrenceState" AND "runId" IS NULL AND "leaseExpiresAt" > ${now}
        ) AS executing
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
              baselineAssistantMessageId: true, baselineGeneration: true, baselineRunId: true, baselineUserMessageId: true,
              chatEpoch: true, chatMode: true, chatPeriod: true, generation: true, kind: true, memoryEnabled: true,
              modelId: true, prompt: true, pinnedSkillIds: true, promptUrlDigests: true, provider: true, revision: true,
              searchEnabled: true, status: true, timeZone: true, title: true, toolsEnabled: true, workspaceEnabled: true,
              user: { select: { status: true } },
              chat: {
                select: {
                  activeLeafMessageId: true, archived: true, assistantId: true, id: true, permanentDeletionAt: true, projectId: true
                }
              },
              carryover: {
                select: {
                  answerText: true, chatEpoch: true, reliedServerIds: true, sourceAssistantMessageId: true, sourceChatId: true,
                  taskGeneration: true, sourceChat: { select: { permanentDeletionAt: true } }
                }
              }
            }
          }
        },
        where: { id: occurrenceId }
      });
      if (!row || row.state !== "PENDING" || row.runId !== null) return null;
      const {
        baselineAssistantMessageId, baselineGeneration, baselineRunId, baselineUserMessageId, carryover, chat, chatMode, kind, user,
        ...task
      } = row.task;
      const usable = chat && !chat.archived && chat.permanentDeletionAt === null && chat.projectId === null &&
        chat.assistantId === null;
      const baseline = baselineRunId && baselineUserMessageId && baselineAssistantMessageId && baselineGeneration
        ? { assistantMessageId: baselineAssistantMessageId, generation: baselineGeneration, runId: baselineRunId,
          userMessageId: baselineUserMessageId }
        : null;
      // Reauthorized at every admission: this chat's copy of this question, its source answer
      // still there (its keys keep it the owner's and delete it with that answer or chat).
      const carriedResult = carryover && carryover.chatEpoch === task.chatEpoch && carryover.taskGeneration === task.generation &&
        carryover.sourceChat.permanentDeletionAt === null
        ? { answer: carryover.answerText, reliedServerIds: [...carryover.reliedServerIds],
          sourceAssistantMessageId: carryover.sourceAssistantMessageId, sourceChatId: carryover.sourceChatId }
        : null;
      return {
        carriedResult,
        chat: usable ? { activeLeafMessageId: chat.activeLeafMessageId, id: chat.id } : null,
        occurrence: {
          id: row.id, scheduledFor: row.scheduledFor, taskId: row.taskId, trigger: trigger(row.trigger), userId: row.userId
        },
        ownerActive: user.status === "active",
        relevantMcpServerIds: !task.toolsEnabled ? null
          : baseline?.generation === task.generation
            ? await previousResultMcpServerIds(prisma, { runId: baseline.runId, userId: row.userId })
            : carriedResult ? carriedResult.reliedServerIds : null,
        task: { ...task, baseline, chatMode: scheduledTaskChatModeFromColumn(chatMode), kind: scheduledTaskKindFromColumn(kind) }
      };
    },

    async loadRotationCopy({ baseline, chatId, userId }) {
      const answer = await prisma.message.findFirst({
        select: { content: true },
        where: { chat: { permanentDeletionAt: null, userId }, chatId, id: baseline.assistantMessageId, role: "assistant" }
      });
      const text = answer ? scheduledCopyText(answer.content) : "";
      if (!text) return null;
      return {
        answer: text, reliedServerIds: (await previousResultMcpServerIds(prisma, { runId: baseline.runId, userId })) ?? [],
        sourceAssistantMessageId: baseline.assistantMessageId, sourceChatId: chatId
      };
    },

    async archiveRotatedChat({ chatId, taskId, userId }) {
      return prisma.$transaction(async (tx) => {
        const [chat] = await tx.$queryRaw<Array<LockedMemorySourceChat & {
          pinned: boolean; permanentDeletionAt: Date | null; projectId: string | null;
        }>>(Prisma.sql`
          SELECT "id", "userId", "activeLeafMessageId", "archived", "folderId", "memoryMode", "memoryBranchGeneration",
            "memorySourceRevision", "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline", "pinned",
            "permanentDeletionAt", "projectId"
          FROM "Chat" WHERE "id" = ${chatId} AND "userId" = ${userId}
          FOR UPDATE
        `);
        // The owner keeps what they pinned, filed or shared in view; a chat in use or already gone is left alone.
        if (!chat || chat.archived || chat.pinned || chat.folderId !== null || chat.projectId !== null ||
          chat.permanentDeletionAt !== null || chat.memoryMode === "TEMPORARY") return false;
        const [busy] = await tx.$queryRaw<Array<{ busy: boolean }>>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1 FROM "SharedChatSnapshot" AS share
            WHERE share."chatId" = ${chatId} AND share."revokedAt" IS NULL AND (share."expiresAt" IS NULL OR share."expiresAt" > now())
          ) OR EXISTS (
            SELECT 1 FROM "ModelRun" AS run WHERE run."chatId" = ${chatId} AND run."status" IN ('preparing'::"ModelRunStatus",
              'queued'::"ModelRunStatus", 'streaming'::"ModelRunStatus", 'in_progress'::"ModelRunStatus")
          ) OR EXISTS (
            SELECT 1 FROM "ScheduledTask" AS task WHERE task."id" = ${taskId} AND task."chatId" = ${chatId}
          ) AS "busy"
        `);
        if (busy?.busy !== false) return false;
        await applyMemorySourceMutations(tx, {
          chat, hooks: defaultMemorySourceMutationHooks, mutations: ["CHAT_ARCHIVE_OR_RESTORE"], patch: { archived: true }
        });
        return true;
      });
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
        return applySettlement(tx, locked, outcome, now, { observedRevision });
      });
    },

    settleLinked,

    async claimNotification(occurrenceId, now) {
      const [row] = await prisma.$queryRaw<Array<{
        chatId: string | null; email: string; reasonCode: string | null; state: ScheduledTaskSettledState;
        taskPauseReason: string | null; title: string; trigger: string; unavailableSources: Prisma.JsonValue | null;
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
          account."email", occurrence."unavailableSources"
      `);
      if (!row) return null;
      const { unavailableSources, ...notification } = row;
      return { ...notification, trigger: trigger(row.trigger), unavailableSources: unavailableSourcesWire(unavailableSources) };
    },

    async overdueRuns(now, limit) {
      return prisma.$queryRaw<ScheduledTaskOverdueRun[]>(Prisma.sql`
        SELECT "id" AS "runId", "userId" FROM "ModelRun"
        WHERE "scheduledTaskId" IS NOT NULL
          AND "status" IN ('preparing'::"ModelRunStatus", 'queued'::"ModelRunStatus", 'streaming'::"ModelRunStatus",
            'in_progress'::"ModelRunStatus")
          AND "createdAt" <= ${new Date(now.getTime() - SCHEDULED_TASK_RUN_DEADLINE_MS)}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${limit}
      `);
    }
  };
}

/**
 * The personal MCP servers the task relies on, judged by its previous shown
 * result: those whose tools that run called (its accepted plan names each
 * loaded tool's server) and those it relied on but already missed, so a
 * server stays relevant while it keeps the task's results incomplete. Null
 * when that run is gone (its chat was deleted): nothing to judge by.
 */
async function previousResultMcpServerIds(
  prisma: PrismaClient,
  input: Readonly<{ runId: string; userId: string }>
): Promise<readonly string[] | null> {
  const [row] = await prisma.$queryRaw<Array<{ found: boolean; serverIds: string[] }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "ModelRun" WHERE "id" = ${input.runId} AND "userId" = ${input.userId}) AS "found",
      ARRAY(
        SELECT DISTINCT tool ->> 'serverId'
        FROM "ModelRun" AS run
        CROSS JOIN LATERAL jsonb_array_elements(CASE
          WHEN jsonb_typeof(run."normalizedRequest" -> 'mcp' -> 'tools') = 'array' THEN run."normalizedRequest" -> 'mcp' -> 'tools'
          ELSE '[]'::jsonb END) AS tool
        WHERE run."id" = ${input.runId} AND run."userId" = ${input.userId} AND tool ->> 'serverId' IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM "ModelRunToolCall" AS call
            WHERE call."modelRunId" = run."id" AND call."toolName" = tool ->> 'namespacedName')
        UNION
        SELECT source ->> 'serverId'
        FROM "ScheduledTaskOccurrence" AS occurrence
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(occurrence."unavailableSources", '[]'::jsonb)) AS source
        WHERE occurrence."runId" = ${input.runId} AND occurrence."userId" = ${input.userId}
          AND source ->> 'serverId' IS NOT NULL AND source -> 'relied' = 'true'::jsonb
      ) AS "serverIds"
  `);
  return row?.found ? row.serverIds : null;
}
