import { createHash } from "node:crypto";
import { Prisma, type ModelRunEngine, type ModelRunStatus, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { sumEstimatedCostMicros, sumTokenUsage } from "../../domain/usage";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import type { MemorySourceMutationHooks } from "../memory/sourceState";
import { signalRunTerminal } from "../push/runTerminalSignal";
import { settleTerminalMemorySource } from "../runs/prismaRepositoryPreparation";
import { runFollowupsAllowCompletion } from "../runs/prismaRepositoryFollowups";
import {
  activeMessageStatuses,
  dispatchableModelRunStatuses,
  json,
  lockRunSettlementScope
} from "../runs/prismaRepositoryShared";
import type { ContextCompactionStatus } from "../../contracts/contextCompaction";
import { appendRunOutputEvents, closeRunningToolLoopCallsInTransaction } from "../runs/prismaRepositoryToolLoop";
import { runAttributionUsageRows } from "../runs/prismaRepositoryUsage";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";

/**
 * Terminal writes of a native run, answer first: the answer text is
 * published (message complete, `answerCompletedAt`) before anything else,
 * the run completes after its Workspace handed off, and usage is written
 * last, one row per physical model call with the provider's figures, in
 * writes that can be repeated without counting twice. None of the later
 * writes can take the published answer back.
 */
export type NativeRunScope = Readonly<{ assistantMessageId: string; chatId: string; runId: string; userId: string }>;

type LockedRun = Readonly<{
  answerCompletedAt: Date | null;
  assistantMessageId: string | null;
  engine: ModelRunEngine;
  followupMode: string | null;
  status: ModelRunStatus;
}>;

async function lockNativeRun(tx: Prisma.TransactionClient, scope: NativeRunScope): Promise<LockedRun | null> {
  await lockRunSettlementScope(tx, scope.runId);
  const [run] = await tx.$queryRaw<LockedRun[]>(Prisma.sql`
    SELECT "answerCompletedAt", "assistantMessageId", "engine", "followupMode", "status"
    FROM "ModelRun" WHERE "id" = ${scope.runId} AND "userId" = ${scope.userId} AND "chatId" = ${scope.chatId}
    FOR UPDATE
  `);
  return run && run.engine === "native" && run.assistantMessageId === scope.assistantMessageId ? run : null;
}

/** A stable row id for one physical call's usage, so a repeated write adds nothing. */
export function nativeUsageRowId(runId: string, key: string): string {
  const hex = createHash("sha256").update(`native-usage:${runId}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createNativeRunStore(client: Pick<PrismaClient, "$transaction" | "message" | "usageEvent">,
  memorySourceHooks: MemorySourceMutationHooks = defaultMemorySourceMutationHooks) {
  return {
    /**
     * Publishes the answer: the message completes with this text and the run
     * records that its answer exists. Only an active native run of the scope
     * whose follow-ups are closed at `followupRevision` publishes; false otherwise.
     */
    async publishAnswer(scope: NativeRunScope, input: Readonly<{ followupRevision: number; text: string }>): Promise<boolean> {
      return client.$transaction(async (tx) => {
        const run = await lockNativeRun(tx, scope);
        if (!run || run.answerCompletedAt || !dispatchableModelRunStatuses.includes(run.status)) return false;
        if (run.followupMode && !(await runFollowupsAllowCompletion(tx, scope.runId, input.followupRevision))) return false;
        const message = await tx.message.updateMany({
          data: { content: json(textMessageContent(input.text)), errorMessage: null, status: "complete" },
          where: { chatId: scope.chatId, id: scope.assistantMessageId, role: "assistant", status: { in: activeMessageStatuses } }
        });
        if (message.count !== 1) return false;
        await tx.modelRun.update({ data: { answerCompletedAt: new Date() }, where: { id: scope.runId } });
        return true;
      });
    },

    /**
     * The text a stopped run's answer keeps: Stop settles the run and its
     * answer first, so the text streamed since the last save is written here,
     * only to the cancelled answer of this cancelled native run.
     */
    async saveStoppedText(scope: NativeRunScope, text: string): Promise<boolean> {
      const saved = await client.message.updateMany({
        data: { content: json(textMessageContent(text)) },
        where: { assistantModelRuns: { some: { chatId: scope.chatId, engine: "native", id: scope.runId, status: "cancelled",
          userId: scope.userId } }, chatId: scope.chatId, id: scope.assistantMessageId, role: "assistant", status: "cancelled" }
      });
      return saved.count === 1;
    },

    /**
     * Records a compaction's status on a native run whose answer may be
     * settled already: a background compaction can finish after its run, and
     * its quiet marker belongs to that answer. It adds a marker and never
     * changes the answer.
     */
    async appendCompactionStatus(scope: NativeRunScope, status: ContextCompactionStatus): Promise<boolean> {
      return client.$transaction(async (tx) => {
        if (!await lockNativeRun(tx, scope)) return false;
        await appendRunOutputEvents(tx, scope.runId, [{ data: { artifactType: "context_compaction", payload: status }, type: "artifact" }]);
        return true;
      });
    },

    /** Completes a run whose answer is published; its open calls keep an unknown outcome. */
    async complete(scope: NativeRunScope): Promise<boolean> {
      const completed = await client.$transaction(async (tx) => {
        const run = await lockNativeRun(tx, scope);
        if (!run || !run.answerCompletedAt || !dispatchableModelRunStatuses.includes(run.status)) return false;
        await tx.modelRun.update({ data: { errorPayload: Prisma.JsonNull, status: "complete" }, where: { id: scope.runId } });
        await closeRunningToolLoopCallsInTransaction(tx, scope.runId);
        await settleTerminalMemorySource(tx, { assistantMessageId: scope.assistantMessageId, chatId: scope.chatId,
          runId: scope.runId, status: "complete", userId: scope.userId }, memorySourceHooks);
        return true;
      });
      if (completed) signalRunTerminal(scope.runId);
      return completed;
    },

    /** Writes usage rows not yet written; a row written before is kept as it is. */
    async writeUsageRows(scope: NativeRunScope, rows: readonly Readonly<{ attribution: RunUsageAttribution; key: string }>[]): Promise<void> {
      if (rows.length === 0) return;
      const data = runAttributionUsageRows({ chatId: scope.chatId, runId: scope.runId, userId: scope.userId },
        rows.map((row) => row.attribution)).map((row, index) => ({ ...row, id: nativeUsageRowId(scope.runId, rows[index]!.key) }));
      await client.usageEvent.createMany({ data, skipDuplicates: true });
    },

    /**
     * The run's and its answer's token totals from the provider-reported rows
     * written for it; the chat's totals grow by them once.
     */
    async applyUsageTotals(scope: NativeRunScope, attributions: readonly RunUsageAttribution[]): Promise<void> {
      const usage = sumTokenUsage(attributions.map((attribution) => attribution.usage));
      const cost = sumEstimatedCostMicros(attributions.map((attribution) => attribution.estimatedCostMicros ?? null));
      await client.$transaction(async (tx) => {
        const first = await tx.modelRun.updateMany({
          data: {
            cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
            estimatedCostMicros: cost !== null && cost <= 2_147_483_647 ? cost : null, inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
            usageCompleteness: usage.completeness === "complete" ? "COMPLETE" : usage.completeness === "partial" ? "PARTIAL" : "UNAVAILABLE"
          },
          where: { engine: "native", id: scope.runId, inputTokens: null, outputTokens: null, totalTokens: null, userId: scope.userId }
        });
        if (first.count !== 1) return;
        await tx.chat.update({ data: {
          totalInputTokens: { increment: usage.inputTokens ?? 0 },
          totalOutputTokens: { increment: usage.outputTokens ?? 0 },
          totalReasoningTokens: { increment: usage.reasoningTokens ?? 0 }
        }, where: { id: scope.chatId } });
        await tx.message.updateMany({ data: { outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens },
          where: { chatId: scope.chatId, id: scope.assistantMessageId } });
      });
    }
  };
}

export type NativeRunStore = ReturnType<typeof createNativeRunStore>;
