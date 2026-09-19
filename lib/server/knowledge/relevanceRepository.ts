import { Prisma, type PrismaClient } from "@prisma/client";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { DecisionReceipt } from "../providers/decisions";

export type KnowledgeRelevanceOwner = Readonly<{
  runId: string; userId: string; reservationId: string; leaseToken: string;
}>;
export type KnowledgeRelevanceAttemptInput = KnowledgeRelevanceOwner & Readonly<{
  ordinal: number; inputHash: string; executionSnapshot: ProviderExecutionSnapshot;
}>;
export type KnowledgeRelevanceSettlement = Readonly<{
  receipt: DecisionReceipt | null; usefulness: number | null; failureCode: string | null; dispatched: boolean;
}>;
export type KnowledgeRelevanceRepository = Readonly<{
  start(input: KnowledgeRelevanceAttemptInput): Promise<string | null>;
  settle(owner: KnowledgeRelevanceOwner, id: string, result: KnowledgeRelevanceSettlement): Promise<void>;
}>;

export function createKnowledgeRelevanceRepository(db: PrismaClient): KnowledgeRelevanceRepository {
  return {
    async start(input) {
      return db.$transaction(async tx => {
        // Serialize against lease settlement/recovery. A stale tool cannot
        // create another outbound obligation or borrow another run's claim.
        const reservations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT r."id" FROM "KnowledgeBudgetReservation" r
          JOIN "ModelRun" m ON m."id" = r."modelRunId"
          WHERE r."id" = ${input.reservationId} AND r."modelRunId" = ${input.runId}
            AND m."userId" = ${input.userId} AND m."status" IN ('in_progress', 'streaming')
            AND r."state" = 'dispatched' AND r."leaseToken" = ${input.leaseToken}
            AND r."leaseExpiresAt" > NOW() AND r."purgedAt" IS NULL
          FOR UPDATE OF r`);
        if (reservations.length !== 1) return null;
        const existing = await tx.knowledgeRelevanceAttempt.findUnique({
          where: { reservationId_ordinal: { reservationId: input.reservationId, ordinal: input.ordinal } }, select: { id: true }
        });
        if (existing) return null; // Settled and ambiguous work are equally non-replayable.
        const attempt = await tx.knowledgeRelevanceAttempt.create({ data: {
          reservationId: input.reservationId, ordinal: input.ordinal, inputHash: input.inputHash,
          executionSnapshot: JSON.parse(JSON.stringify(input.executionSnapshot)) as Prisma.InputJsonObject
        }, select: { id: true } });
        return attempt.id;
      });
    },
    async settle(owner, id, result) {
      await db.$transaction(async tx => {
        const attempt = await tx.knowledgeRelevanceAttempt.findFirst({ where: {
          id, reservationId: owner.reservationId,
          reservation: { modelRunId: owner.runId, modelRun: { userId: owner.userId } }
        }, include: { reservation: { include: { modelRun: { select: { chatId: true, chat: { select: { projectId: true } } } } } } } });
        if (!attempt) throw new Error("knowledge_relevance_attempt_missing");
        const snapshot = attempt.executionSnapshot as unknown as ProviderExecutionSnapshot;
        const changed = await tx.knowledgeRelevanceAttempt.updateMany({ where: { id,
          state: { in: result.receipt ? ["dispatched", "ambiguous"] : ["dispatched"] } },
        data: { state: result.receipt || !result.dispatched ? "settled" : "ambiguous", usefulness: result.usefulness,
          failureCode: result.failureCode, settledAt: new Date() } });
        if (changed.count !== 1) return;
        if (!result.dispatched) return;
        const receipt = result.receipt;
        const usage = { inputTokens: receipt?.usage.inputTokens ?? null, outputTokens: receipt?.usage.outputTokens ?? null,
          totalTokens: receipt ? receipt.usage.inputTokens + receipt.usage.outputTokens : null,
          estimatedCostMicros: receipt?.usage.costUsd == null ? null : Math.round(receipt.usage.costUsd * 1_000_000),
          usageCompleteness: receipt ? "COMPLETE" as const : "UNAVAILABLE" as const };
        await tx.usageEvent.upsert({ where: { knowledgeRelevanceAttemptId: id }, update: usage,
          create: { ...usage, knowledgeRelevance: true, knowledgeRelevanceAttemptId: id, userId: owner.userId, modelRunId: owner.runId,
            chatId: attempt.reservation.modelRun.chatId, projectId: attempt.reservation.modelRun.chat.projectId,
            provider: snapshot.providerFamily, providerModelId: snapshot.providerModelId, modelId: snapshot.model.upstreamModelId,
            operationCount: 1 } });
      });
    }
  };
}
