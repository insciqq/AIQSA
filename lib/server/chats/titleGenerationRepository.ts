import { Prisma, type PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { estimateCostMicros, normalizeTokenUsage } from "../../domain/usage";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ChatTitleWork } from "./titleGeneration";

const clearedInput = { answerText: "", credentialVersionId: null, expectedTitle: "", questionText: "", reasoningEffort: null, providerSnapshot: Prisma.DbNull };

export function createChatTitleRepository(client: PrismaClient) {
  return {
    async enqueue(work: ChatTitleWork, expiresAt: Date): Promise<void> {
      await client.chatTitleGeneration.createMany({
        data: { ...work, expiresAt, credentialVersionId: work.providerSnapshot.credentialVersionId,
          providerSnapshot: JSON.parse(JSON.stringify(work.providerSnapshot)) as Prisma.InputJsonValue },
        skipDuplicates: true
      });
    },

    async recover(now: Date): Promise<void> {
      await client.chatTitleGeneration.updateMany({
        where: { status: "pending", OR: [
          { expiresAt: { lte: now } }, { modelRun: { status: { in: ["cancelled", "error"] } } }
        ] },
        data: { ...clearedInput, finishedAt: now, status: "skipped" }
      });
      // A dispatched call is never replayed. Its unknown-usage receipt remains
      // chargeable evidence even after a crash or loss of the response.
      await client.chatTitleGeneration.updateMany({
        where: { status: "dispatched", dispatchedAt: { lte: new Date(now.getTime() - 60_000) } },
        data: { ...clearedInput, finishedAt: now, status: "ambiguous" }
      });
    },

    async take(now: Date): Promise<ChatTitleWork | "skipped" | null> {
      return client.$transaction(async (tx) => {
        const [candidate] = await tx.$queryRaw<Array<{ runId: string }>>(Prisma.sql`
          SELECT title."runId" FROM "ChatTitleGeneration" AS title
          JOIN "ModelRun" AS run ON run."id" = title."runId"
          WHERE title."status" = 'pending' AND title."expiresAt" > ${now}
            AND run."status" = 'complete'
          ORDER BY title."createdAt" ASC
          LIMIT 1 FOR UPDATE OF title SKIP LOCKED
        `);
        if (!candidate) return null;
        const job = await tx.chatTitleGeneration.findUniqueOrThrow({
          where: { runId: candidate.runId },
          include: { chat: { select: {
            archived: true, permanentDeletionAt: true, projectId: true, title: true,
            titleRevision: true, userId: true, user: { select: { status: true } }
          } } }
        });
        if (job.chat.archived || job.chat.permanentDeletionAt || job.chat.projectId ||
          job.chat.userId !== job.userId || job.chat.user?.status !== "active" ||
          job.chat.title !== job.expectedTitle || job.chat.titleRevision !== job.titleRevision ||
          !job.providerSnapshot || !job.credentialVersionId) {
          await tx.chatTitleGeneration.update({ where: { runId: job.runId },
            data: { ...clearedInput, finishedAt: now, status: "skipped" } });
          return "skipped";
        }
        const snapshot = normalizeProviderExecutionSnapshot(job.providerSnapshot);
        await tx.chatTitleGeneration.update({ where: { runId: job.runId },
          data: { dispatchedAt: now, status: "dispatched" } });
        await tx.usageEvent.create({ data: {
          chatId: job.chatId, chatTitleGeneration: true, chatTitleGenerationId: job.runId,
          modelId: snapshot.model.upstreamModelId, modelRunId: job.runId,
          provider: snapshot.providerFamily, providerModelId: snapshot.providerModelId,
          userId: job.userId
        } });
        return {
          answerText: job.answerText, chatId: job.chatId, expectedTitle: job.expectedTitle,
          providerSnapshot: snapshot, questionText: job.questionText,
          reasoningEffort: job.reasoningEffort, runId: job.runId,
          titleRevision: job.titleRevision, userId: job.userId
        };
      });
    },

    async isCurrent(work: ChatTitleWork): Promise<boolean> {
      return Boolean(await client.chat.findFirst({ select: { id: true }, where: {
        archived: false, id: work.chatId, permanentDeletionAt: null, projectId: null,
        title: work.expectedTitle, titleRevision: work.titleRevision,
        userId: work.userId, user: { status: "active" },
        titleGeneration: { runId: work.runId, status: "dispatched", modelRun: { status: "complete" } }
      } }));
    },

    async recordUsage(work: ChatTitleWork, reported: ModelRunUsage): Promise<void> {
      const usage = normalizeTokenUsage(reported);
      if (usage.totalTokens === 0) return;
      await client.$transaction(async (tx) => {
        const [event] = await tx.$queryRaw<Array<{ id: string; inputTokens: number | null }>>(Prisma.sql`
          SELECT "id", "inputTokens" FROM "UsageEvent"
          WHERE "chatTitleGenerationId" = ${work.runId} FOR UPDATE
        `);
        if (!event || event.inputTokens !== null) return;
        const pricing = await tx.providerModel.findUnique({
          where: { id: work.providerSnapshot.providerModelId },
          select: { inputTokenPriceMicros: true, outputTokenPriceMicros: true }
        });
        const estimatedCostMicros = pricing &&
          (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0)
          ? estimateCostMicros(usage, pricing) : null;
        await tx.usageEvent.update({ where: { id: event.id }, data: { ...usage, estimatedCostMicros } });
        // The title receipt is separate from answer settlement. Enrichment can
        // neither reopen its terminal state nor replace the answer's events.
        await tx.modelRun.updateMany({ where: { id: work.runId, userId: work.userId, status: "complete" }, data: {
          inputTokens: { increment: usage.inputTokens }, cachedInputTokens: { increment: usage.cachedInputTokens },
          cacheWriteInputTokens: { increment: usage.cacheWriteInputTokens }, outputTokens: { increment: usage.outputTokens },
          reasoningTokens: { increment: usage.reasoningTokens }, totalTokens: { increment: usage.totalTokens },
          ...(estimatedCostMicros === null ? {} : { estimatedCostMicros: { increment: estimatedCostMicros } })
        } });
        await tx.chat.updateMany({ where: { id: work.chatId, userId: work.userId }, data: {
          totalInputTokens: { increment: usage.inputTokens }, totalOutputTokens: { increment: usage.outputTokens },
          totalReasoningTokens: { increment: usage.reasoningTokens }
        } });
      });
    },

    async finish(work: ChatTitleWork, title: string | null): Promise<void> {
      await client.$transaction(async (tx) => {
        const settled = await tx.chatTitleGeneration.updateMany({
          where: { runId: work.runId, status: "dispatched" },
          data: { ...clearedInput, finishedAt: new Date(), status: "settled" }
        });
        if (settled.count !== 1 || !title || title === work.expectedTitle) return;
        // Assignment changes affect future admission; revoking the exact
        // accepted credential also fences application of an in-flight result.
        if (!work.providerSnapshot.credentialId || !work.providerSnapshot.credentialVersionId ||
          !await tx.providerCredentialVersion.findFirst({ select: { id: true }, where: {
            credentialId: work.providerSnapshot.credentialId,
            id: work.providerSnapshot.credentialVersionId, revokedAt: null
          } })) return;
        await tx.chat.updateMany({ where: {
          archived: false, id: work.chatId, permanentDeletionAt: null, projectId: null,
          title: work.expectedTitle, titleRevision: work.titleRevision,
          userId: work.userId, user: { status: "active" }
        }, data: { title, titleRevision: { increment: 1 } } });
      });
    }
  };
}
