import {
  Prisma,
  type PrismaClient,
  type ScheduledTaskOccurrenceState,
  type ScheduledTaskScheduleKind as ScheduleKindColumn,
  type ScheduledTaskStatus as StatusColumn
} from "@prisma/client";
import {
  SCHEDULED_TASK_MAX_ACTIVE,
  SCHEDULED_TASK_MAX_TOTAL,
  SCHEDULED_TASK_RECENT_RUNS_LIMIT,
  type ScheduledTask,
  type ScheduledTaskDetailResponse,
  type ScheduledTaskDraft,
  type ScheduledTaskErrorCode,
  type ScheduledTaskLastRun,
  type ScheduledTaskListResponse,
  type ScheduledTaskRun,
  type ScheduledTaskRunState,
  type ScheduledTaskSchedule,
  type ScheduledTaskSettledRunState,
  type ScheduledTaskStatus
} from "../../contracts/scheduledTasks";
import {
  scheduledTaskMinutesToTime,
  scheduledTaskTimeToMinutes,
  scheduledTaskWeekdayMask,
  scheduledTaskWeekdaysFromMask
} from "../../domain/scheduledTaskSchedule";
import { SMTP_CONTROL_ID } from "../email/repository";
import { SCHEDULED_TASK_OCCURRENCE_RETENTION } from "./runnerPolicy";

export class ScheduledTaskError extends Error {
  constructor(readonly code: ScheduledTaskErrorCode) {
    super(code);
    this.name = "ScheduledTaskError";
  }
}

type ScheduledTaskClient = PrismaClient | Prisma.TransactionClient;

export type ScheduledTaskScheduleColumns = {
  scheduleKind: ScheduleKindColumn;
  timeOfDayMinutes: number;
  daysOfWeekMask: number;
  dayOfMonth: number | null;
  onceLocalDate: string | null;
};
export type ScheduledTaskActivity = { lastRun: ScheduledTaskLastRun | null; running: boolean };
export type ScheduledTaskUpdateWrite = Readonly<{
  expectedRevision: number;
  draft: ScheduledTaskDraft;
  status: ScheduledTaskStatus;
  /** Undefined keeps the stored due time (an active task whose schedule did not change). */
  nextRunAt: Date | null | undefined;
}>;

/** Owner-scoped persistence; every method treats another owner's task as missing. */
export interface ScheduledTaskStore {
  list(userId: string): Promise<ScheduledTaskListResponse>;
  get(userId: string, taskId: string): Promise<ScheduledTask | null>;
  detail(userId: string, taskId: string): Promise<ScheduledTaskDetailResponse | null>;
  /** Creates an active task; throws `scheduled_task_limit` at either limit. */
  create(userId: string, draft: ScheduledTaskDraft, nextRunAt: Date): Promise<ScheduledTask>;
  /**
   * Writes every editable field and the status under `expectedRevision`, clears
   * the pause reason and failure count and increments the revision. Activation
   * counts against the active limit.
   */
  update(userId: string, taskId: string, write: ScheduledTaskUpdateWrite): Promise<ScheduledTask>;
  /** The chat and any accepted run stay; occurrences go with the task. */
  delete(userId: string, taskId: string): Promise<boolean>;
  markSeen(userId: string, taskId: string): Promise<boolean>;
  /**
   * Queues a manual occurrence for `now` in any status; throws
   * `scheduled_task_running` while one is pending or running.
   */
  requestRun(userId: string, taskId: string, now: Date): Promise<ScheduledTask>;
}

const STATUS_WIRE = { ACTIVE: "active", PAUSED: "paused", COMPLETED: "completed" } as const satisfies Record<StatusColumn, ScheduledTaskStatus>;
const STATUS_COLUMN = { active: "ACTIVE", paused: "PAUSED", completed: "COMPLETED" } as const satisfies Record<ScheduledTaskStatus, StatusColumn>;
const RUN_STATE_WIRE = {
  PENDING: "pending", RUNNING: "running", COMPLETED: "completed", FAILED: "failed", SKIPPED: "skipped"
} as const satisfies Record<ScheduledTaskOccurrenceState, ScheduledTaskRunState>;
const KIND_COLUMN = { once: "ONCE", daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY" } as const satisfies Record<ScheduledTaskSchedule["kind"], ScheduleKindColumn>;

export const scheduledTaskRowSelect = {
  id: true, title: true, prompt: true, scheduleKind: true, timeOfDayMinutes: true, daysOfWeekMask: true, dayOfMonth: true,
  onceLocalDate: true, timeZone: true, modelId: true, provider: true, searchEnabled: true, emailNotify: true, status: true,
  pauseReason: true, nextRunAt: true, chatId: true, unseenResultAt: true, revision: true, createdAt: true, updatedAt: true,
  chat: { select: { permanentDeletionAt: true } }
} satisfies Prisma.ScheduledTaskSelect;
export type ScheduledTaskRow = Prisma.ScheduledTaskGetPayload<{ select: typeof scheduledTaskRowSelect }>;

const runSelect = {
  scheduledFor: true, trigger: true, state: true, reasonCode: true, startedAt: true, finishedAt: true, chatId: true,
  chat: { select: { permanentDeletionAt: true } }
} satisfies Prisma.ScheduledTaskOccurrenceSelect;
type RunRow = Prisma.ScheduledTaskOccurrenceGetPayload<{ select: typeof runSelect }>;

export function scheduledTaskScheduleColumns(schedule: ScheduledTaskSchedule): ScheduledTaskScheduleColumns {
  return {
    scheduleKind: KIND_COLUMN[schedule.kind],
    timeOfDayMinutes: scheduledTaskTimeToMinutes(schedule.time),
    daysOfWeekMask: schedule.kind === "weekly" ? scheduledTaskWeekdayMask(schedule.days) : 0,
    dayOfMonth: schedule.kind === "monthly" ? schedule.dayOfMonth : null,
    onceLocalDate: schedule.kind === "once" ? schedule.date : null
  };
}

/** Database checks guarantee the columns of each kind. */
export function scheduledTaskScheduleFromColumns(columns: ScheduledTaskScheduleColumns): ScheduledTaskSchedule {
  const time = scheduledTaskMinutesToTime(columns.timeOfDayMinutes);
  switch (columns.scheduleKind) {
    case "ONCE": return { kind: "once", date: columns.onceLocalDate!, time };
    case "DAILY": return { kind: "daily", time };
    case "WEEKLY": return { kind: "weekly", time, days: scheduledTaskWeekdaysFromMask(columns.daysOfWeekMask) };
    case "MONTHLY": return { kind: "monthly", time, dayOfMonth: columns.dayOfMonth! };
  }
}

/** A chat that permanent deletion has fenced is no longer offered. */
function usableChatId(chatId: string | null, chat: { permanentDeletionAt: Date | null } | null): string | null {
  return chatId !== null && chat?.permanentDeletionAt === null ? chatId : null;
}

export function toScheduledTask(row: ScheduledTaskRow, activity: ScheduledTaskActivity): ScheduledTask {
  return {
    id: row.id, title: row.title, prompt: row.prompt, schedule: scheduledTaskScheduleFromColumns(row), timeZone: row.timeZone,
    modelId: row.modelId, provider: row.provider, searchEnabled: row.searchEnabled, emailNotify: row.emailNotify,
    status: STATUS_WIRE[row.status], pauseReason: row.pauseReason, nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRun: activity.lastRun, running: activity.running, chatId: usableChatId(row.chatId, row.chat),
    unseenResult: row.unseenResultAt !== null, revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

function toScheduledTaskRun(row: RunRow): ScheduledTaskRun {
  return {
    scheduledFor: row.scheduledFor.toISOString(), trigger: row.trigger === "manual" ? "manual" : "schedule",
    state: RUN_STATE_WIRE[row.state], reasonCode: row.reasonCode, startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null, chatId: usableChatId(row.chatId, row.chat)
  };
}

type SettledRow = { taskId: string; scheduledFor: Date; state: "COMPLETED" | "FAILED" | "SKIPPED"; reasonCode: string | null; finishedAt: Date };

/** Per task of the owner: the newest settled occurrence and whether one is pending or running. */
export async function loadScheduledTaskActivity(
  client: ScheduledTaskClient,
  userId: string,
  taskIds: readonly string[]
): Promise<Map<string, ScheduledTaskActivity>> {
  const activity = new Map<string, ScheduledTaskActivity>(taskIds.map((taskId) => [taskId, { lastRun: null, running: false }]));
  if (taskIds.length === 0) return activity;
  const settled = await client.$queryRaw<SettledRow[]>`
    SELECT task_row."id" AS "taskId", latest."scheduledFor", latest."state"::text AS "state", latest."reasonCode", latest."finishedAt"
    FROM unnest(${[...taskIds]}::text[]) AS task_row("id")
    CROSS JOIN LATERAL (
      SELECT occurrence."scheduledFor", occurrence."state", occurrence."reasonCode", occurrence."finishedAt"
      FROM "ScheduledTaskOccurrence" AS occurrence
      WHERE occurrence."taskId" = task_row."id" AND occurrence."userId" = ${userId}
        AND occurrence."state" IN ('COMPLETED', 'FAILED', 'SKIPPED')
      ORDER BY occurrence."scheduledFor" DESC, occurrence."createdAt" DESC, occurrence."id" DESC
      LIMIT 1
    ) AS latest
  `;
  const open = await client.scheduledTaskOccurrence.findMany({
    select: { taskId: true },
    where: { state: { in: ["PENDING", "RUNNING"] }, taskId: { in: [...taskIds] }, userId }
  });
  for (const row of settled) {
    const state: ScheduledTaskSettledRunState = RUN_STATE_WIRE[row.state];
    activity.set(row.taskId, {
      running: false,
      lastRun: { scheduledFor: row.scheduledFor.toISOString(), state, reasonCode: row.reasonCode, finishedAt: row.finishedAt.toISOString() }
    });
  }
  for (const row of open) activity.set(row.taskId, { ...activity.get(row.taskId)!, running: true });
  return activity;
}

/** Notification email can be offered: installation SMTP is active and the account has an address. */
export async function readScheduledTaskEmailAvailability(client: ScheduledTaskClient, userId: string): Promise<boolean> {
  const smtp = await client.smtpControl.findUnique({ select: { activeConfig: true, enabled: true }, where: { id: SMTP_CONTROL_ID } });
  if (!smtp?.enabled || smtp.activeConfig === null) return false;
  const user = await client.user.findUnique({ select: { email: true }, where: { id: userId } });
  return Boolean(user?.email);
}

function draftColumns(draft: ScheduledTaskDraft) {
  return {
    title: draft.title, prompt: draft.prompt, ...scheduledTaskScheduleColumns(draft.schedule), timeZone: draft.timeZone,
    modelId: draft.modelId, provider: draft.provider, searchEnabled: draft.searchEnabled, emailNotify: draft.emailNotify
  };
}

async function lockOwner(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Serializes the owner's limit and revision checks; NO KEY keeps inserts
  // that reference the account (chats, runs, usage) unblocked.
  const owners = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} AND "status" = 'active' FOR NO KEY UPDATE
  `;
  if (owners.length !== 1) throw new ScheduledTaskError("scheduled_tasks_unavailable");
}

/** Keeps the newest occurrences of a task; open ones are never removed. */
export async function pruneScheduledTaskOccurrences(tx: Prisma.TransactionClient, taskId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "ScheduledTaskOccurrence"
    WHERE "id" IN (
      SELECT "id" FROM "ScheduledTaskOccurrence" WHERE "taskId" = ${taskId}
      ORDER BY "scheduledFor" DESC, "createdAt" DESC, "id" DESC
      OFFSET ${SCHEDULED_TASK_OCCURRENCE_RETENTION}
    ) AND "state" IN ('COMPLETED'::"ScheduledTaskOccurrenceState", 'FAILED'::"ScheduledTaskOccurrenceState",
      'SKIPPED'::"ScheduledTaskOccurrenceState")
  `;
}

function visibleTask(userId: string, taskId: string) {
  return { id: taskId, user: { status: "active" as const }, userId };
}

export function createPrismaScheduledTaskStore(prisma: PrismaClient): ScheduledTaskStore {
  async function project(client: ScheduledTaskClient, userId: string, row: ScheduledTaskRow): Promise<ScheduledTask> {
    const activity = await loadScheduledTaskActivity(client, userId, [row.id]);
    return toScheduledTask(row, activity.get(row.id)!);
  }
  return {
    async list(userId) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.scheduledTask.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: scheduledTaskRowSelect,
          where: { user: { status: "active" }, userId }
        });
        const activity = await loadScheduledTaskActivity(tx, userId, rows.map((row) => row.id));
        return {
          tasks: rows.map((row) => toScheduledTask(row, activity.get(row.id)!)),
          limits: { maxActive: SCHEDULED_TASK_MAX_ACTIVE, maxTotal: SCHEDULED_TASK_MAX_TOTAL },
          emailAvailable: await readScheduledTaskEmailAvailability(tx, userId)
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    async get(userId, taskId) {
      const row = await prisma.scheduledTask.findFirst({ select: scheduledTaskRowSelect, where: visibleTask(userId, taskId) });
      return row ? project(prisma, userId, row) : null;
    },
    async detail(userId, taskId) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.scheduledTask.findFirst({ select: scheduledTaskRowSelect, where: visibleTask(userId, taskId) });
        if (!row) return null;
        const task = await project(tx, userId, row);
        const runs = await tx.scheduledTaskOccurrence.findMany({
          orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          select: runSelect,
          take: SCHEDULED_TASK_RECENT_RUNS_LIMIT,
          where: { taskId: row.id, userId }
        });
        return { task, recentRuns: runs.map(toScheduledTaskRun) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    async create(userId, draft, nextRunAt) {
      return prisma.$transaction(async (tx) => {
        await lockOwner(tx, userId);
        const total = await tx.scheduledTask.count({ where: { userId } });
        const active = await tx.scheduledTask.count({ where: { status: "ACTIVE", userId } });
        if (total >= SCHEDULED_TASK_MAX_TOTAL || active >= SCHEDULED_TASK_MAX_ACTIVE) throw new ScheduledTaskError("scheduled_task_limit");
        const row = await tx.scheduledTask.create({
          data: { ...draftColumns(draft), nextRunAt, status: "ACTIVE", userId },
          select: scheduledTaskRowSelect
        });
        return toScheduledTask(row, { lastRun: null, running: false });
      });
    },
    async update(userId, taskId, write) {
      return prisma.$transaction(async (tx) => {
        await lockOwner(tx, userId);
        const current = await tx.scheduledTask.findUnique({ select: { revision: true, status: true }, where: { userId_id: { id: taskId, userId } } });
        if (!current) throw new ScheduledTaskError("scheduled_task_not_found");
        if (current.revision !== write.expectedRevision) throw new ScheduledTaskError("scheduled_task_stale");
        if (write.status === "active" && current.status !== "ACTIVE" &&
          await tx.scheduledTask.count({ where: { status: "ACTIVE", userId } }) >= SCHEDULED_TASK_MAX_ACTIVE) {
          throw new ScheduledTaskError("scheduled_task_limit");
        }
        // The revision guard also fences a runner status transition committed after the read.
        const updated = await tx.scheduledTask.updateMany({
          data: {
            ...draftColumns(write.draft), consecutiveFailures: 0, pauseReason: null, revision: { increment: 1 },
            status: STATUS_COLUMN[write.status], ...(write.nextRunAt === undefined ? {} : { nextRunAt: write.nextRunAt })
          },
          where: { id: taskId, revision: write.expectedRevision, userId }
        });
        if (updated.count !== 1) throw new ScheduledTaskError("scheduled_task_stale");
        const row = await tx.scheduledTask.findUniqueOrThrow({ select: scheduledTaskRowSelect, where: { userId_id: { id: taskId, userId } } });
        return project(tx, userId, row);
      });
    },
    async delete(userId, taskId) {
      return (await prisma.scheduledTask.deleteMany({ where: { id: taskId, userId } })).count === 1;
    },
    async markSeen(userId, taskId) {
      return (await prisma.scheduledTask.updateMany({ data: { unseenResultAt: null }, where: { id: taskId, userId } })).count === 1;
    },
    async requestRun(userId, taskId, now) {
      return prisma.$transaction(async (tx) => {
        // The task row serializes this check with concurrent requests and the runner's claim.
        const tasks = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT task."id" FROM "ScheduledTask" AS task
          JOIN "User" AS account ON account."id" = task."userId" AND account."status" = 'active'::"UserStatus"
          WHERE task."id" = ${taskId} AND task."userId" = ${userId}
          FOR NO KEY UPDATE OF task
        `;
        if (tasks.length !== 1) throw new ScheduledTaskError("scheduled_task_not_found");
        if (await tx.scheduledTaskOccurrence.count({ where: { state: { in: ["PENDING", "RUNNING"] }, taskId, userId } }) > 0) {
          throw new ScheduledTaskError("scheduled_task_running");
        }
        await tx.scheduledTaskOccurrence.create({ data: { scheduledFor: now, taskId, trigger: "manual", userId } });
        await pruneScheduledTaskOccurrences(tx, taskId);
        const row = await tx.scheduledTask.findUniqueOrThrow({ select: scheduledTaskRowSelect, where: { userId_id: { id: taskId, userId } } });
        return project(tx, userId, row);
      });
    }
  };
}
