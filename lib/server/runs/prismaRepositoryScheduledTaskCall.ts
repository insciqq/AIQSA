import { Prisma, type ModelRunStatus, type PrismaClient } from "@prisma/client";
import { decodeScheduledTaskCard } from "../../contracts/scheduledTasks";
import { admitScheduledTaskCreate, type ScheduledTaskDraftAdmissionDeps } from "../scheduledTasks/draftAdmission";
import { kickScheduledTaskRunner } from "../scheduledTasks/runnerKick";
import { insertScheduledTask, ScheduledTaskError } from "../scheduledTasks/store";
import { CREATE_SCHEDULED_TASK_TOOL_NAME } from "../tools/scheduledTaskCreation";
import { activeToolLoopRun, json } from "./prismaRepositoryShared";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { runOutputArtifactEvents } from "./runOutputEvents";
import type { RunRepository, ScheduledTaskCallCreation, ScheduledTaskCallRefusal } from "./runRepositoryContract";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "./toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "./toolLoopPersistence";

type CreationInput = Parameters<NonNullable<RunRepository["createScheduledTaskForCall"]>>[0];
type StoredResult = Parameters<typeof parsePersistedToolExecutionResult>[1];

function refused(code: ScheduledTaskCallRefusal): ScheduledTaskCallCreation {
  return { code, kind: "refused" };
}

/**
 * Whether another answer to the same message (a regeneration or retry)
 * created a task the owner still has: the message's request is then served,
 * while a task the owner deleted may be created again.
 */
async function earlierAnswerTaskKept(
  tx: Prisma.TransactionClient,
  input: CreationInput,
  userMessageId: string
): Promise<boolean> {
  const calls = await tx.modelRunToolCall.findMany({
    select: { providerCallId: true, result: true, toolName: true },
    where: { modelRun: { userId: input.userId, userMessageId }, modelRunId: { not: input.runId }, state: "complete",
      toolName: CREATE_SCHEDULED_TASK_TOOL_NAME }
  });
  const taskIds = calls.flatMap((call) =>
    parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName }, call.result as StoredResult)?.artifacts ?? [])
    .flatMap((event) => {
      const card = event.type === "artifact" && event.data.artifactType === "scheduled_task"
        ? decodeScheduledTaskCard(event.data.payload) : null;
      return card ? [card.taskId] : [];
    });
  return taskIds.length > 0 && await tx.scheduledTask.count({ where: { id: { in: taskIds }, userId: input.userId } }) > 0;
}

/**
 * `RunRepository.createScheduledTaskForCall`. The owner API's rules run first
 * (reads only); then one transaction takes the owner lock (the order owner,
 * then run, of every settlement writer), fences the run and its call, keeps
 * one task per answer and per message, creates the task under the owner's
 * limits, settles the call with its result and appends the answer's card. A
 * crash leaves either all of it or none of it, so a recovered call is replayed
 * from its settlement or created now, never twice.
 */
export async function createScheduledTaskForToolCall(
  prisma: PrismaClient,
  deps: ScheduledTaskDraftAdmissionDeps & Readonly<{ kick?: () => void; now?: () => Date }>,
  input: CreationInput
): Promise<ScheduledTaskCallCreation> {
  const admitted = await admitScheduledTaskCreate(deps, input.userId, input.body, (deps.now ?? (() => new Date()))());
  if (!admitted.ok) return refused(admitted.code);
  let outcome: ScheduledTaskCallCreation;
  try {
    outcome = await prisma.$transaction(async (tx) => {
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
      // A scheduled run never creates tasks, whatever its accepted request says.
      if (!run || run.scheduledTaskId !== null || !activeToolLoopRun(run)) return refused("scheduled_task_call_unavailable");
      const call = await tx.modelRunToolCall.findFirst({
        select: { providerCallId: true, result: true, state: true, toolName: true },
        where: { id: input.callId, modelRunId: input.runId }
      });
      if (!call || call.toolName !== CREATE_SCHEDULED_TASK_TOOL_NAME) return refused("scheduled_task_call_unavailable");
      if (call.state === "complete" || call.state === "error") {
        return { kind: "settled", result: parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName },
          call.result as StoredResult) };
      }
      if (call.state !== "running") return refused("scheduled_task_call_unavailable");
      // Nor does another answer to a scheduled task's own turn (its saved prompt).
      if (await tx.modelRun.count({ where: { scheduledTaskId: { not: null }, userId: input.userId,
        userMessageId: run.userMessageId } }) > 0) return refused("scheduled_task_call_unavailable");
      // Only a creation settles complete: another one means this answer has its task.
      const created = await tx.modelRunToolCall.count({ where: {
        id: { not: input.callId }, modelRunId: input.runId, state: "complete", toolName: CREATE_SCHEDULED_TASK_TOOL_NAME
      } });
      if (created > 0) return refused("scheduled_task_answer_limit");
      if (await earlierAnswerTaskKept(tx, input, run.userMessageId)) return refused("scheduled_task_already_created");
      const task = await insertScheduledTask(tx, input.userId, admitted.draft, admitted.nextRunAt);
      const result = input.result(task);
      const snapshot = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
      if (!snapshot || result.status !== "complete") throw new Error("scheduled_task_call_result_invalid");
      const settled = await tx.modelRunToolCall.updateMany({
        data: { completedAt: new Date(), result: json(snapshot), state: "complete" },
        where: { id: input.callId, modelRunId: input.runId, state: "running" }
      });
      if (settled.count !== 1) throw new Error("scheduled_task_call_settle_conflict");
      // The card is part of the answer whatever happens to the run next.
      await appendRunOutputEvents(tx, input.runId, runOutputArtifactEvents(result.artifacts ?? []));
      return { kind: "created", result, task };
    });
  } catch (error) {
    if (error instanceof ScheduledTaskError) return refused(error.code);
    throw error;
  }
  if (outcome.kind === "created") (deps.kick ?? kickScheduledTaskRunner)();
  return outcome;
}
