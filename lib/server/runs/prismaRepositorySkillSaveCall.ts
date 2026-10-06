import { Prisma, type ModelRunStatus, type PrismaClient } from "@prisma/client";
import { commitSkillSaveInTransaction } from "../skills/skillSave";
import { SAVE_SKILL_TOOL_NAME, type SkillSaveCommitOutcome } from "../tools/skillSave";
import { activeToolLoopRun, json, lockRunSettlementScope } from "./prismaRepositoryShared";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { runOutputArtifactEvents } from "./runOutputEvents";
import type { RunRepository } from "./runRepositoryContract";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "./toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "./toolLoopPersistence";

type SaveInput = Parameters<NonNullable<RunRepository["saveSkillForCall"]>>[0];
type StoredResult = Parameters<typeof parsePersistedToolExecutionResult>[1];

/**
 * `RunRepository.saveSkillForCall`. One transaction takes the run's
 * settlement locks (Project, owner, chat, then the run), fences the run (active,
 * personal, unscheduled, not an answer to a scheduled task's prompt) and its
 * running call, saves through the shared Skill write core and settles the
 * call with its card. A crash leaves all of it or none of it, so a recovered
 * call is replayed from its settlement or saved now, never twice.
 */
export async function saveSkillForToolCall(prisma: PrismaClient, input: SaveInput): Promise<SkillSaveCommitOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockRunSettlementScope(tx, input.runId);
    const [run] = await tx.$queryRaw<Array<{ errorPayload: Prisma.JsonValue | null; scheduledTaskId: string | null;
      status: ModelRunStatus; userMessageId: string; projectId: string | null }>>(Prisma.sql`
      SELECT r."status", r."errorPayload", r."scheduledTaskId", r."userMessageId", c."projectId"
      FROM "ModelRun" r JOIN "Chat" c ON c."id" = r."chatId"
      WHERE r."id" = ${input.runId} AND r."userId" = ${input.userId}
      FOR UPDATE OF r
    `);
    if (!run || run.scheduledTaskId !== null || run.projectId !== null || !activeToolLoopRun(run) ||
      !await tx.user.findFirst({ where: { id: input.userId, status: "active" }, select: { id: true } })) return { kind: "unavailable" };
    const call = await tx.modelRunToolCall.findFirst({
      select: { providerCallId: true, result: true, state: true, toolName: true },
      where: { id: input.callId, modelRunId: input.runId }
    });
    if (!call || call.toolName !== SAVE_SKILL_TOOL_NAME) return { kind: "unavailable" };
    if (call.state === "complete" || call.state === "error") {
      return { kind: "settled", result: parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName },
        call.result as StoredResult) };
    }
    if (call.state !== "running") return { kind: "unavailable" };
    // An answer to a scheduled task's prompt, which the model may have written, never saves.
    const prompt = await tx.message.findUnique({ select: { scheduledTaskPrompt: true }, where: { id: run.userMessageId } });
    if (prompt?.scheduledTaskPrompt !== false) return { kind: "unavailable" };
    const outcome = await commitSkillSaveInTransaction(tx, { userId: input.userId, runId: input.runId, operationKey: input.callId,
      target: input.target, bundle: input.bundle, changeNote: input.changeNote });
    if (outcome.kind !== "saved") return { kind: "not_saved", outcome };
    const result = input.result(outcome.card, outcome.version);
    const snapshot = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
    if (!snapshot || result.status !== "complete") throw new Error("skill_save_call_result_invalid");
    const settled = await tx.modelRunToolCall.updateMany({
      data: { completedAt: new Date(), result: json(snapshot), state: "complete" },
      where: { id: input.callId, modelRunId: input.runId, state: "running" }
    });
    if (settled.count !== 1) throw new Error("skill_save_call_settle_conflict");
    // The card is part of the answer whatever happens to the run next.
    await appendRunOutputEvents(tx, input.runId, runOutputArtifactEvents(result.artifacts ?? []), { settlement: true });
    return { kind: "saved", result };
  });
}
