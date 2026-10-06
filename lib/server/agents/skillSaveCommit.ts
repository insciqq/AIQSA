import type { Prisma, PrismaClient } from "@prisma/client";
import { parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import { snapshotToolLoopJson, toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { commitSkillSaveInTransaction } from "../skills/skillSave";
import { SAVE_SKILL_TOOL_NAME, type SkillSaveCommitter } from "../tools/skillSave";
import type { ToolExecutionResult } from "../tools/types";

type AgentStore = Readonly<{
  assertActiveInTransaction(tx: Prisma.TransactionClient): Promise<void>;
  settleBuiltinToolInTransaction(tx: Prisma.TransactionClient, id: string, result: ToolExecutionResult): Promise<void>;
}>;

/**
 * A personal Agent run's `save_skill` builtin: the same server path as a chat
 * save. One transaction holds the run's settlement locks and live Agent
 * grant, fences the delivery's claim, saves through the shared Skill write
 * core and settles the claim with its card, so a repeated or recovered
 * delivery never saves twice.
 */
export function agentSkillSaveCommitter(db: PrismaClient, store: AgentStore,
  owner: Readonly<{ claimId: string; runId: string; userId: string }>): SkillSaveCommitter {
  return (save) => db.$transaction(async (tx) => {
    await store.assertActiveInTransaction(tx);
    const run = await tx.modelRun.findFirst({ where: { id: owner.runId, userId: owner.userId },
      select: { scheduledTaskId: true, chat: { select: { projectId: true } }, userMessage: { select: { scheduledTaskPrompt: true } } } });
    if (!run || run.scheduledTaskId !== null || run.chat.projectId !== null || run.userMessage.scheduledTaskPrompt !== false) {
      return { kind: "unavailable" as const };
    }
    const call = await tx.modelRunToolCall.findFirst({ where: { id: owner.claimId, modelRunId: owner.runId },
      select: { providerCallId: true, toolName: true, state: true, result: true } });
    if (!call || call.toolName !== SAVE_SKILL_TOOL_NAME) return { kind: "unavailable" as const };
    if (call.state === "complete" || call.state === "error") {
      return { kind: "settled" as const, result: parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName },
        snapshotToolLoopJson(call.result, toolLoopPersistenceLimits.resultBytes)) };
    }
    const outcome = await commitSkillSaveInTransaction(tx, { userId: owner.userId, runId: owner.runId, operationKey: owner.claimId,
      target: save.target, bundle: save.bundle, changeNote: save.changeNote });
    if (outcome.kind !== "saved") return { kind: "not_saved" as const, outcome };
    const result = save.result(outcome.card, outcome.version);
    await store.settleBuiltinToolInTransaction(tx, owner.claimId, result);
    return { kind: "saved" as const, result };
  });
}
