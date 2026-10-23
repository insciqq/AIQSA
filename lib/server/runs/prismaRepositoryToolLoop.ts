import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import { loadWorkspaceActivitySnapshot, saveWorkspaceActivitySnapshot, workspaceActivityFingerprint, WORKSPACE_ACTIVITY_RECEIPT } from "./workspaceActivityPersistence";
import { Prisma, type ModelRunStatus, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { runEndedToolCallResult, type ToolLoopJsonValue } from "./toolLoopPersistence";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import { isRunOutputArtifactEvent } from "./runOutputEvents";
import type { RunRepository } from "./runRepositoryContract";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { activeToolLoopRun, isRecord, json, lockRunSettlementScope } from "./prismaRepositoryShared";
export { isRecoveredRunTerminalPayload } from "./prismaRepositoryShared";

/**
 * `settlement`: the events are a tool call's own result, appended in the
 * transaction that settles it; a scheduled task card then records the call's
 * action unless it equals the task's latest card.
 */
export async function appendRunOutputEvents(
  tx: Prisma.TransactionClient,
  runId: string,
  events: readonly RunOutputArtifactEvent[],
  options: Readonly<{ settlement?: boolean }> = {}
): Promise<RunOutputArtifactEvent[]> {
  if (events.length === 0) return [];
  if (events.some((event) => !isRunOutputArtifactEvent(event))) {
    throw new Error("run_output_event_invalid");
  }
  let lastGrounding = events.some((event) => event.type === "grounding_display")
    ? (await tx.modelRunEvent.findFirst({
        orderBy: { sequence: "desc" }, select: { payload: true },
        where: { modelRunId: runId, eventType: "grounding_display" }
      }))?.payload
    : undefined;
  const latest = await tx.modelRunEvent.aggregate({
    _max: { sequence: true },
    where: { modelRunId: runId }
  });
  let sequence = (latest._max.sequence ?? -1) + 1;
  const published: RunOutputArtifactEvent[] = [];
  const pending: Prisma.ModelRunEventCreateManyInput[] = [];
  const updates = new Map<string, RunOutputArtifactEvent>();
  let activity: ThreadWorkspaceActivity | null | undefined;
  // Every caller holds the run row lock. Replayed tool results retain their
  // first committed update, rather than republishing old state as a new event.
  for (const event of events) {
    if (event.type === "artifact" && event.data.artifactType === "workspace_checkpoint") {
      const key = `checkpoint:${event.data.payload.checkpoint.id}`;
      const buffered = updates.get(key);
      const previous = buffered ?? await tx.modelRunEvent.findFirst({ select: { payload: true }, where: {
        modelRunId: runId, eventType: "artifact", AND: [
          { payload: { path: ["artifactType"], equals: "workspace_checkpoint" } },
          { payload: { path: ["payload", "checkpoint", "id"], equals: event.data.payload.checkpoint.id } }
        ]
      } });
      if (previous) {
        const data = "data" in previous ? previous.data : previous.payload;
        if (canonicalJson(data as ToolLoopJsonValue) !== canonicalJson(event.data as unknown as ToolLoopJsonValue)) throw new Error("workspace_checkpoint_replay_invalid");
        published.push(event);
        continue;
      }
      updates.set(key, event);
    }
    // A scheduled task's card is kept once per settled call: the call's
    // settlement appends it, and a live or recovered replay of the settled
    // call publishes it again. Another call on the same task appends its own
    // card, whose action and state the answer then shows.
    if (event.type === "artifact" && event.data.artifactType === "scheduled_task") {
      const key = `scheduled_task:${event.data.payload.taskId}`;
      const buffered = updates.get(key);
      const latest = buffered ?? await tx.modelRunEvent.findFirst({ orderBy: { sequence: "desc" }, select: { payload: true }, where: {
        modelRunId: runId, eventType: "artifact", AND: [
          { payload: { path: ["artifactType"], equals: "scheduled_task" } },
          { payload: { path: ["payload", "taskId"], equals: event.data.payload.taskId } }
        ]
      } });
      const latestData = latest && ("data" in latest ? latest.data : latest.payload);
      if (latest && (!options.settlement ||
        canonicalJson(latestData as ToolLoopJsonValue) === canonicalJson(event.data as unknown as ToolLoopJsonValue))) {
        published.push(event);
        continue;
      }
      updates.set(key, event);
    }
    // A Skill save's card is kept once: its settlement appends it and a
    // replay of the settled call publishes the same save again.
    if (event.type === "artifact" && event.data.artifactType === "skill_save") {
      const key = `skill_save:${event.data.payload.saveId}`;
      if (updates.has(key) || await tx.modelRunEvent.findFirst({ select: { sequence: true }, where: {
        modelRunId: runId, eventType: "artifact", AND: [
          { payload: { path: ["artifactType"], equals: "skill_save" } },
          { payload: { path: ["payload", "saveId"], equals: event.data.payload.saveId } }
        ]
      } })) {
        published.push(event);
        continue;
      }
      updates.set(key, event);
    }
    // A resource change card is kept once: the call's settlement appends it
    // (`lib/server/tools/selfServiceCallStore.ts`) and the native engine then
    // publishes the call's result, card included. Equal cards are one change:
    // a change names the version it left, a proposal its own identity.
    if (event.type === "artifact" && event.data.artifactType === "resource_change") {
      const key = `resource_change:${canonicalJson(event.data.payload as unknown as ToolLoopJsonValue)}`;
      if (updates.has(key) || await tx.modelRunEvent.findFirst({ select: { sequence: true }, where: {
        eventType: "artifact", modelRunId: runId, payload: { equals: json(event.data) }
      } })) {
        published.push(event);
        continue;
      }
      updates.set(key, event);
    }
    if (event.type === "grounding_display") {
      if (lastGrounding && canonicalJson(lastGrounding as ToolLoopJsonValue) ===
        canonicalJson(event.data)) {
        published.push(event);
        continue;
      }
      lastGrounding = json(event.data) as Prisma.JsonValue;
    }
    const updateId = event.type === "artifact" && event.data.artifactType === "workspace_activity"
      ? event.data.payload.updateId ?? `update:${workspaceActivityFingerprint(event.data.payload).slice(0, 24)}` : undefined;
    if (updateId) {
      const buffered = updates.get(updateId);
      if (buffered) {
        published.push(buffered);
        continue;
      }
      const receipt = await tx.modelRunEvent.findFirst({
        select: { payload: true, sequence: true },
        where: { modelRunId: runId, eventType: WORKSPACE_ACTIVITY_RECEIPT,
          payload: { path: ["updateId"], equals: updateId } }
      });
      if (receipt && event.type === "artifact" && event.data.artifactType === "workspace_activity") {
        if (!isRecord(receipt.payload) || receipt.payload.fingerprint !== workspaceActivityFingerprint(event.data.payload)) {
          throw new Error("workspace_activity_replay_invalid");
        }
        const replay: RunOutputArtifactEvent = { type: "artifact", data: {
          artifactType: "workspace_activity", payload: { ...event.data.payload, updateId, sequence: receipt.sequence }
        } };
        published.push(replay);
        updates.set(updateId, replay);
        continue;
      }
      const previous = await tx.modelRunEvent.findFirst({
        orderBy: { sequence: "asc" },
        select: { payload: true },
        where: {
          eventType: "artifact",
          modelRunId: runId,
          payload: { equals: updateId, path: ["payload", "updateId"] }
        }
      });
      if (previous) {
        const replay = { data: previous.payload, type: "artifact" } as ModelRunSseEvent;
        if (!isRunOutputArtifactEvent(replay)) throw new Error("run_output_event_invalid");
        published.push(replay);
        updates.set(updateId, replay);
        continue;
      }
    }
    const ordered: RunOutputArtifactEvent = event.type === "artifact" && event.data.artifactType === "workspace_activity"
      ? { data: { artifactType: "workspace_activity", payload: { ...event.data.payload,
          updateId: event.data.payload.updateId ?? `update:${workspaceActivityFingerprint(event.data.payload).slice(0, 24)}`,
          sequence } }, type: "artifact" }
      : event;
    const workspaceEntry = ordered.type === "artifact" && ordered.data.artifactType === "workspace_activity" ? ordered.data.payload : null;
    const effectiveUpdateId = workspaceEntry?.updateId;
    if (workspaceEntry) {
      if (activity === undefined) activity = await loadWorkspaceActivitySnapshot(tx, runId);
      activity = mergeWorkspaceActivity(activity, { entries: [workspaceEntry] });
    }
    pending.push({
      eventType: workspaceEntry ? WORKSPACE_ACTIVITY_RECEIPT : event.type,
      modelRunId: runId,
      // Receipts preserve replay identity and order without keeping old output
      // snapshots. Only the bounded logical feed retains public text.
      payload: json(workspaceEntry ? { entryId: workspaceEntry.id,
        fingerprint: workspaceActivityFingerprint(workspaceEntry), updateId: effectiveUpdateId } : ordered.data),
      sequence
    });
    published.push(ordered);
    if (effectiveUpdateId) updates.set(effectiveUpdateId, ordered);
    sequence += 1;
  }
  if (pending.length) await tx.modelRunEvent.createMany({ data: pending });
  if (activity) await saveWorkspaceActivitySnapshot(tx, runId, activity);
  return published;
}

function canonicalJson(value: ToolLoopJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const recoveredRunTerminalMarker = "recoveryTerminal";
const knowledgeBudgetCancellationFailure = "operation_cancelled";
const knowledgeBudgetPostDispatchCancellationFailure =
  "operation_cancelled_after_dispatch";

export function recoveredRunErrorPayload(error: { code: string; message: string }) {
  return {
    ...error,
    [recoveredRunTerminalMarker]: true
  };
}

/**
 * Cancels the run's still-pending calls and settles any attached Knowledge
 * capacity in the same transaction. The caller must hold the owning ModelRun
 * row lock before entering this helper.
 */
export async function cancelPendingToolLoopCallsInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  now = new Date()
): Promise<number> {
  const pendingCalls = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT call."id"
    FROM "ModelRunToolCall" AS call
    WHERE call."modelRunId" = ${runId}
      AND call."state" = 'pending'
    ORDER BY call."roundIndex" ASC, call."ordinal" ASC
    FOR UPDATE
  `);
  if (pendingCalls.length === 0) return 0;

  const pendingCallIds = pendingCalls.map((call) => call.id);
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      failureCode: knowledgeBudgetCancellationFailure,
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: now,
      state: "released"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: null,
      state: "reserved"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: now,
      state: "released"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: { not: null },
      state: "reserved"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      ambiguousAt: now,
      failureCode: knowledgeBudgetPostDispatchCancellationFailure,
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: null,
      state: "dispatched"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      ambiguousAt: now,
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: { not: null },
      state: "dispatched"
    }
  });
  const cancelled = await tx.modelRunToolCall.updateMany({
    data: {
      completedAt: now,
      state: "cancelled"
    },
    where: {
      id: { in: pendingCallIds },
      modelRunId: runId,
      state: "pending"
    }
  });
  if (cancelled.count !== pendingCallIds.length) {
    throw new Error("pending_tool_call_cancellation_conflict");
  }
  return cancelled.count;
}

/**
 * Closes the calls still running when their run has just become final, in
 * that terminal transaction. A running call may already have had effects, so
 * it keeps an unknown outcome rather than "cancelled" (never executed). Its
 * own operation may still settle it afterwards (`settleToolLoopCall`), which
 * keeps late evidence such as search usage. Only final runs qualify: a
 * recoverable error run leaves its running calls to recovery. The caller holds
 * the owning ModelRun row lock.
 */
export async function closeRunningToolLoopCallsInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  now = new Date()
): Promise<number> {
  const closed = await tx.modelRunToolCall.updateMany({
    data: { completedAt: now, result: json(runEndedToolCallResult()), state: "error" },
    where: { modelRunId: runId, state: "running" }
  });
  return closed.count;
}

export type PrismaRunToolLoopOperations = Pick<
  RunRepository,
  | "appendAssistantText"
  | "appendRunOutputEvent"
  | "markRunAnswerStarted"
>;

/** The run writes every engine run makes: its answer text, its output events and when its answer began. */
export function createPrismaRunToolLoopOperations(prismaClient: PrismaClient): PrismaRunToolLoopOperations {
  return {
    appendAssistantText: async (assistantMessageId, text, options) => {
      await prismaClient.$transaction(async (tx) => {
        await lockRunSettlementScope(tx, options.runId);
        await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${options.runId} FOR UPDATE`;
        const updated = await tx.message.updateMany({
          data: {
            content: json(textMessageContent(text)),
            ...(options.allowErrored ? {} : { status: "streaming" as const })
          },
          where: {
            id: assistantMessageId,
            status: options.allowErrored
              ? { in: ["streaming", "error"] }
              : "streaming"
          }
        });
        if (updated.count === 0) return;
        await tx.modelRun.updateMany({
          data: { updatedAt: new Date() },
          where: {
            assistantMessageId,
            id: options.runId
          }
        });
      });
    },
    appendRunOutputEvent: async (runId, event) => {
      if (!isRunOutputArtifactEvent(event)) throw new Error("run_output_event_invalid");
      return prismaClient.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<Array<{
          id: string; status: ModelRunStatus; errorPayload: Prisma.JsonValue | null;
        }>>(Prisma.sql`
          SELECT "id", "status", "errorPayload" FROM "ModelRun" WHERE "id" = ${runId} FOR UPDATE
        `);
        if (!run) throw new Error("model_run_not_found");
        // Workspace settlement can finish after the answer. Provider output
        // retains the terminal fence and cannot rewrite a settled answer.
        if (!activeToolLoopRun(run) &&
          !(event.type === "artifact" && event.data.artifactType === "workspace_activity")) return event;
        const [published] = await appendRunOutputEvents(tx, runId, [event]);
        await tx.modelRun.update({
          data: {
            updatedAt: new Date()
          },
          where: {
            id: runId
          }
        });
        return published!;
      });
    },
    markRunAnswerStarted: async (input) => {
      await prismaClient.modelRun.updateMany({
        data: { answerStartedAt: input.at },
        where: { answerStartedAt: null, id: input.runId }
      });
    }
  };
}
