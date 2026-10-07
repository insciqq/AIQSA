import { Prisma, type PrismaClient } from "@prisma/client";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { DecisionReceipt } from "../providers/decisions";
import { loadProviderModelCostBasis, providerModelUsageCostMicros } from "../usage";

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
        const reservations = await tx.$queryRaw<Array<{ id: string; chatId: string; projectId: string | null }>>(Prisma.sql`
          SELECT r."id", m."chatId", c."projectId" FROM "KnowledgeBudgetReservation" r
          JOIN "ModelRun" m ON m."id" = r."modelRunId"
          JOIN "Chat" c ON c."id" = m."chatId"
          WHERE r."id" = ${input.reservationId} AND r."modelRunId" = ${input.runId}
            AND m."userId" = ${input.userId} AND m."status" IN ('in_progress', 'streaming')
            AND r."state" = 'dispatched' AND r."leaseToken" = ${input.leaseToken}
            AND r."leaseExpiresAt" > NOW() AND r."purgedAt" IS NULL
          FOR UPDATE OF r`);
        const reservation = reservations[0];
        if (reservations.length !== 1 || !reservation) return null;
        const existing = await tx.knowledgeRelevanceAttempt.findUnique({
          where: { reservationId_ordinal: { reservationId: input.reservationId, ordinal: input.ordinal } }, select: { id: true }
        });
        if (existing) return null; // Settled and ambiguous work are equally non-replayable.
        const attempt = await tx.knowledgeRelevanceAttempt.create({ data: {
          reservationId: input.reservationId, ordinal: input.ordinal, inputHash: input.inputHash,
          executionSnapshot: JSON.parse(JSON.stringify(input.executionSnapshot)) as Prisma.InputJsonObject
        }, select: { id: true } });
        // Claimed with the attempt, before dispatch: a crash after this commit
        // leaves unknown usage instead of none. Settlement fills it once.
        const snapshot = input.executionSnapshot;
        await tx.usageEvent.create({ data: {
          knowledgeRelevance: true, knowledgeRelevanceAttemptId: attempt.id, purpose: "knowledge_retrieval",
          userId: input.userId, modelRunId: input.runId, chatId: reservation.chatId, projectId: reservation.projectId,
          provider: snapshot.providerFamily, providerModelId: snapshot.providerModelId, modelId: snapshot.model.upstreamModelId,
          usageCompleteness: "UNAVAILABLE", operationCount: 1
        } });
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
        if (!result.dispatched) {
          // Nothing left the process: the claimed unknown row is withdrawn.
          await tx.usageEvent.deleteMany({ where: { knowledgeRelevanceAttemptId: id, usageCompleteness: "UNAVAILABLE" } });
          return;
        }
        const receipt = result.receipt;
        const usage = { inputTokens: receipt?.usage.inputTokens ?? null, outputTokens: receipt?.usage.outputTokens ?? null,
          totalTokens: receipt ? receipt.usage.inputTokens + receipt.usage.outputTokens : null,
          estimatedCostMicros: receipt ? providerModelUsageCostMicros({
            basis: await loadProviderModelCostBasis(tx, snapshot.providerModelId),
            reportedCostUsd: receipt.usage.costUsd ?? null,
            usage: { inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens }
          }) : null,
          usageCompleteness: receipt ? "COMPLETE" as const : "UNAVAILABLE" as const };
        await tx.usageEvent.upsert({ where: { knowledgeRelevanceAttemptId: id }, update: usage,
          create: { ...usage, knowledgeRelevance: true, knowledgeRelevanceAttemptId: id, purpose: "knowledge_retrieval",
            userId: owner.userId, modelRunId: owner.runId,
            chatId: attempt.reservation.modelRun.chatId, projectId: attempt.reservation.modelRun.chat.projectId,
            provider: snapshot.providerFamily, providerModelId: snapshot.providerModelId, modelId: snapshot.model.upstreamModelId,
            operationCount: 1 } });
      });
    }
  };
}
