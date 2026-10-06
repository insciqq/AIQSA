import { Prisma, type ModelRunStatus, type PrismaClient } from "@prisma/client";
import {
  SCHEDULED_TASK_MANAGED_PER_ANSWER,
  SCHEDULED_TASK_MAX_TOTAL,
  decodeScheduledTaskCard,
  type ScheduledTask,
  type ScheduledTaskDraft
} from "../../contracts/scheduledTasks";
import { sameScheduledTaskSchedule } from "../../domain/scheduledTaskSchedule";
import { admitScheduledTaskModel, type ScheduledTaskDraftAdmissionDeps } from "../scheduledTasks/draftAdmission";
import { planScheduledTaskUpdate } from "../scheduledTasks/mutations";
import { loadScheduledTaskPinnedSkillMap } from "../scheduledTasks/pinnedSkills";
import { scheduledPromptUrlDigests } from "../scheduledTasks/promptUrls";
import { decodeScheduledTaskUpdateRequest } from "../scheduledTasks/requests";
import { kickScheduledTaskRunner } from "../scheduledTasks/runnerKick";
import {
  ScheduledTaskError,
  scheduledTaskRowSelect,
  toScheduledTask,
  updateScheduledTask,
  type ScheduledTaskRow,
  type ScheduledTaskUpdateWrite
} from "../scheduledTasks/store";
import { MANAGE_SCHEDULED_TASK_TOOL_NAME } from "../tools/scheduledTaskManagement";
import type { ToolExecutionResult } from "../tools/types";
import { activeToolLoopRun, json } from "./prismaRepositoryShared";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { runOutputArtifactEvents } from "./runOutputEvents";
import type {
  RunRepository,
  ScheduledTaskCallManagement,
  ScheduledTaskCallManagementRefusal
} from "./runRepositoryContract";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "./toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "./toolLoopPersistence";

type ManagementInput = Parameters<NonNullable<RunRepository["manageScheduledTaskForCall"]>>[0];
type ManagementDeps = ScheduledTaskDraftAdmissionDeps & Readonly<{ kick?: () => void; now?: () => Date }>;
type StoredResult = Parameters<typeof parsePersistedToolExecutionResult>[1];

/** A change planned against the task as read before the transaction. */
type PlannedChange = Readonly<{
  current: ScheduledTask;
  /** The change sets another prompt, which only a task this answer read may take. */
  newPrompt: boolean;
  /** The task already is as asked: the call settles without a write or a card. */
  unchanged: boolean;
  write: ScheduledTaskUpdateWrite;
}>;

/**
 * Plans a change runs this many times when the task changed between its read
 * and the transaction (an editor save, a runner transition) before the call
 * is refused as stale.
 */
const CHANGE_ATTEMPTS = 3;
const REPLAN = Symbol("replan");

function refused(code: ScheduledTaskCallManagementRefusal, detail?: string): ScheduledTaskCallManagement {
  return { code, kind: "refused", ...(detail ? { detail } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A task's own fields, never its run history: all a result and a card show. */
function projected(row: ScheduledTaskRow): ScheduledTask {
  return toScheduledTask(row, { lastRun: null, running: false, unseen: false });
}

/** Tasks as the model reads them: their own fields with the pinned Skills the owner may see now. */
async function projectedWithSkills(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: readonly ScheduledTaskRow[]
): Promise<ScheduledTask[]> {
  const skills = await loadScheduledTaskPinnedSkillMap(tx, userId, rows.flatMap((row) => row.pinnedSkillIds));
  return rows.map((row) => toScheduledTask(row, { lastRun: null, running: false, unseen: false }, skills));
}

/** Every editable field of the plan equals the task's. */
function sameDraft(draft: ScheduledTaskDraft, task: ScheduledTask): boolean {
  return Object.entries(draft).every(([key, value]) => key === "schedule"
    ? sameScheduledTaskSchedule(draft.schedule, task.schedule)
    : key === "pinnedSkillIds"
      ? draft.pinnedSkillIds.length === task.pinnedSkillIds.length &&
        draft.pinnedSkillIds.every((skillId, index) => skillId === task.pinnedSkillIds[index])
      : value === task[key as keyof ScheduledTask]);
}

/**
 * A change through the owner API's own decoder, edit rules and model
 * admission, against the task's current revision as the server reads it. The
 * model is admitted only when something would change.
 */
async function planChange(
  prisma: PrismaClient,
  deps: ManagementDeps,
  input: ManagementInput,
  taskId: string
): Promise<PlannedChange | ScheduledTaskCallManagement> {
  const row = await prisma.scheduledTask.findFirst({
    select: scheduledTaskRowSelect, where: { id: taskId, user: { status: "active" }, userId: input.userId }
  });
  if (!row) return refused("scheduled_task_not_found");
  const current = projected(row);
  const body = input.change?.(current);
  if (body === undefined) return refused("scheduled_task_call_unavailable");
  if (typeof body === "string") return refused("scheduled_task_arguments_invalid", body);
  const decoded = decodeScheduledTaskUpdateRequest({ ...body, expectedRevision: current.revision });
  if (!decoded.ok) return refused(decoded.code);
  const plan = planScheduledTaskUpdate(current, decoded.value, (deps.now ?? (() => new Date()))());
  if (!plan.ok) return refused(plan.code);
  const unchanged = plan.status === current.status && sameDraft(plan.draft, current) &&
    (plan.nextRunAt === undefined || (plan.nextRunAt?.toISOString() ?? null) === current.nextRunAt);
  if (!unchanged && plan.checkModel) {
    try {
      await admitScheduledTaskModel(deps, input.userId, plan.draft);
    } catch (error) {
      if (error instanceof ScheduledTaskError) return refused(error.code);
      throw error;
    }
  }
  const newPrompt = plan.draft.prompt !== current.prompt;
  return {
    current, newPrompt, unchanged,
    write: {
      draft: plan.draft, expectedRevision: current.revision, nextRunAt: plan.nextRunAt, status: plan.status,
      // A model-written prompt never takes the owner's authorship: it keeps the
      // links this run's user text authorized and those the task's snapshot,
      // read with this revision, already held; a page's or Search's never.
      promptUrls: newPrompt ? scheduledPromptUrlDigests(plan.draft.prompt, {
        kind: "tool", userUrlDigests: [...input.userUrlDigests, ...row.promptUrlDigests]
      }) : "keep"
    }
  };
}

/**
 * What the answer's other settled management calls did: the tasks they
 * changed or proposed deleting (each settled with its card), and the tasks
 * they read in full with `get`.
 */
async function answerCalls(tx: Prisma.TransactionClient, input: ManagementInput) {
  const calls = await tx.modelRunToolCall.findMany({
    select: { arguments: true, providerCallId: true, result: true, toolName: true },
    where: { id: { not: input.callId }, modelRunId: input.runId, state: "complete", toolName: MANAGE_SCHEDULED_TASK_TOOL_NAME }
  });
  const affected = new Set<string>();
  const read = new Set<string>();
  for (const call of calls) {
    if (isRecord(call.arguments) && call.arguments.action === "get" && typeof call.arguments.taskId === "string") {
      read.add(call.arguments.taskId);
    }
    const settled = parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName }, call.result as StoredResult);
    for (const event of settled?.artifacts ?? []) {
      const card = event.type === "artifact" && event.data.artifactType === "scheduled_task"
        ? decodeScheduledTaskCard(event.data.payload) : null;
      if (card) affected.add(card.taskId);
    }
  }
  return { affected, read };
}

/**
 * One attempt: a change is planned first (reads only), then one transaction
 * takes the owner lock (the order owner, then run, of every settlement
 * writer), fences the run and its call as a creation does, reads the task,
 * applies the change under the revision the plan read and settles the call
 * with its result and card. `REPLAN` when the task changed since the plan.
 */
async function manageOnce(
  prisma: PrismaClient,
  deps: ManagementDeps,
  input: ManagementInput
): Promise<ScheduledTaskCallManagement | typeof REPLAN> {
  const taskId = input.taskId;
  if ((taskId === null) !== (input.action === "list")) return refused("scheduled_task_call_unavailable");
  const mutation = input.action === "update" || input.action === "pause" || input.action === "resume" ? input.action : null;
  let planned: PlannedChange | null = null;
  if (mutation && taskId !== null) {
    const plan = await planChange(prisma, deps, input, taskId);
    if ("kind" in plan) return plan;
    planned = plan;
  }
  let changed = false;
  let outcome: ScheduledTaskCallManagement | typeof REPLAN;
  try {
    outcome = await prisma.$transaction(async (tx): Promise<ScheduledTaskCallManagement | typeof REPLAN> => {
      const owners = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "User" WHERE "id" = ${input.userId} AND "status" = 'active' FOR NO KEY UPDATE
      `);
      if (owners.length !== 1) return refused("scheduled_tasks_unavailable");
      const [run] = await tx.$queryRaw<Array<{ errorPayload: Prisma.JsonValue | null; scheduledTaskId: string | null;
        status: ModelRunStatus; userMessageId: string }>>(Prisma.sql`
        SELECT "status", "errorPayload", "scheduledTaskId", "userMessageId" FROM "ModelRun"
        WHERE "id" = ${input.runId} AND "userId" = ${input.userId}
        FOR UPDATE
      `);
      // A scheduled run never manages tasks, whatever its accepted request says.
      if (!run || run.scheduledTaskId !== null || !activeToolLoopRun(run)) return refused("scheduled_task_call_unavailable");
      const call = await tx.modelRunToolCall.findFirst({
        select: { providerCallId: true, result: true, state: true, toolName: true },
        where: { id: input.callId, modelRunId: input.runId }
      });
      if (!call || call.toolName !== MANAGE_SCHEDULED_TASK_TOOL_NAME) return refused("scheduled_task_call_unavailable");
      if (call.state === "complete" || call.state === "error") {
        return { kind: "settled", result: parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName },
          call.result as StoredResult) };
      }
      if (call.state !== "running") return refused("scheduled_task_call_unavailable");
      // Nor does any other answer to a scheduled task's prompt, by the mark on its message.
      const prompt = await tx.message.findUnique({ select: { scheduledTaskPrompt: true }, where: { id: run.userMessageId } });
      if (prompt?.scheduledTaskPrompt !== false) return refused("scheduled_task_call_unavailable");

      const settle = async (result: ToolExecutionResult): Promise<ScheduledTaskCallManagement> => {
        const snapshot = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
        if (!snapshot || result.status !== "complete") throw new Error("scheduled_task_call_result_invalid");
        const settled = await tx.modelRunToolCall.updateMany({
          data: { completedAt: new Date(), result: json(snapshot), state: "complete" },
          where: { id: input.callId, modelRunId: input.runId, state: "running" }
        });
        if (settled.count !== 1) throw new Error("scheduled_task_call_settle_conflict");
        // A card is part of the answer whatever happens to the run next, and records this call's action.
        await appendRunOutputEvents(tx, input.runId, runOutputArtifactEvents(result.artifacts ?? []), { settlement: true });
        return { kind: "managed", result };
      };

      if (taskId === null) {
        const rows = await tx.scheduledTask.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: scheduledTaskRowSelect, take: SCHEDULED_TASK_MAX_TOTAL,
          where: { userId: input.userId }
        });
        return settle(input.result({ action: "list", tasks: await projectedWithSkills(tx, input.userId, rows) }));
      }
      const row = await tx.scheduledTask.findFirst({ select: scheduledTaskRowSelect, where: { id: taskId, userId: input.userId } });
      if (!row) return refused("scheduled_task_not_found");
      const [task] = await projectedWithSkills(tx, input.userId, [row]);
      if (input.action === "get") return settle(input.result({ action: "get", task: task! }));
      if (planned && row.revision !== planned.current.revision) return REPLAN;
      if (mutation && planned?.unchanged) return settle(input.result({ action: mutation, changed: false, task: task! }));
      // A change or a deletion proposal affects its task; one answer affects at most five.
      const answer = await answerCalls(tx, input);
      if (!answer.affected.has(taskId) && answer.affected.size >= SCHEDULED_TASK_MANAGED_PER_ANSWER) {
        return refused("scheduled_task_answer_limit");
      }
      if (!mutation || !planned) {
        return input.action === "propose_delete"
          ? settle(input.result({ action: "propose_delete", task: task! }))
          : refused("scheduled_task_call_unavailable");
      }
      // A new prompt replaces the whole instruction: only one written from the saved prompt keeps its content.
      if (planned.newPrompt && !answer.read.has(taskId)) return refused("scheduled_task_read_required");
      const updated = await updateScheduledTask(tx, input.userId, taskId, planned.write);
      changed = true;
      return settle(input.result({ action: mutation, changed: true, task: updated }));

    });
  } catch (error) {
    if (error instanceof ScheduledTaskError) return error.code === "scheduled_task_stale" ? REPLAN : refused(error.code);
    throw error;
  }
  if (changed) (deps.kick ?? kickScheduledTaskRunner)();
  return outcome;
}

/**
 * `RunRepository.manageScheduledTaskForCall`. A read or a deletion proposal
 * settles the call with what it read; a change applies the owner's edit rules
 * to the task's current revision, read by the server and never supplied by
 * the model, re-planning when the task changes meanwhile. A crash leaves the
 * change, the settlement and the card all or none, so a recovered call is
 * replayed from its settlement or applied now, never twice.
 */
export async function manageScheduledTaskForToolCall(
  prisma: PrismaClient,
  deps: ManagementDeps,
  input: ManagementInput
): Promise<ScheduledTaskCallManagement> {
  for (let attempt = 1; attempt <= CHANGE_ATTEMPTS; attempt += 1) {
    const outcome = await manageOnce(prisma, deps, input);
    if (outcome !== REPLAN) return outcome;
  }
  return refused("scheduled_task_stale");
}

/**
 * `RunRepository.loadScheduledTaskManagement`: null without a saved task;
 * otherwise the task whose own chat this is, as the chat list marks it (the
 * task that posts into the chat now, else the one whose newest run did).
 */
export async function loadScheduledTaskManagementAdmission(
  prisma: PrismaClient,
  input: Readonly<{ chatId: string; userId: string }>
): Promise<Readonly<{ chatTask: Readonly<{ taskId: string; title: string }> | null }> | null> {
  const owned = await prisma.scheduledTask.findFirst({ select: { id: true }, where: { user: { status: "active" }, userId: input.userId } });
  if (!owned) return null;
  const current = await prisma.scheduledTask.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, title: true },
    where: { chatId: input.chatId, userId: input.userId }
  });
  const posted = current ? null : await prisma.scheduledTaskOccurrence.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { task: { select: { id: true, title: true } } },
    where: { chatId: input.chatId, userId: input.userId }
  });
  const task = current ?? posted?.task ?? null;
  return { chatTask: task ? { taskId: task.id, title: task.title } : null };
}
