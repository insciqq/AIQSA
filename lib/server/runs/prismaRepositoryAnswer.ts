import { Prisma, type ModelRunStatus, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { normalizeTokenUsage, reportedTokenCount } from "../../domain/usage";
import { settleKnowledgeGrounding } from "../knowledge/evidenceRepository";
import type { RunCompletionInput, RunRepository } from "./runRepositoryContract";
import { activeMessageStatuses, dispatchableModelRunStatuses, isRecord, json, lockRunSettlementScope } from "./prismaRepositoryShared";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { retainRunPrismaCode } from "./prismaRepositoryObservability";

/** The caller owns the run lock and invokes this only for the first answer
 * publication (or ordinary terminal completion without earlier publication). */
export async function persistCompletedAnswerUsage(
  tx: Prisma.TransactionClient, input: RunCompletionInput, projectId: string | null
): Promise<void> {
  const usage = normalizeTokenUsage(input.usage);
  const attributions = input.usageAttributions?.length ? input.usageAttributions : [{
    operationCount: 1, estimatedCostMicros: input.estimatedCostMicros,
    modelId: input.modelId, provider: input.provider, usage
  }];
  await tx.usageEvent.deleteMany({ where: {
    chatPdfPreparation: false, imageGeneration: false, chatTitleGeneration: false,
    knowledgeRelevance: false, optionalDecision: false, modelRunId: input.runId
  } });
  await tx.usageEvent.createMany({ data: attributions.map((attribution) => {
    const reported = normalizeTokenUsage(attribution.usage);
    return {
      chatId: input.chatId, operationCount: attribution.operationCount ?? null,
      cachedInputTokens: reported.cachedInputTokens, cacheWriteInputTokens: reported.cacheWriteInputTokens,
      estimatedCostMicros: attribution.estimatedCostMicros ?? null, inputTokens: reported.inputTokens,
      modelId: attribution.modelId, modelRunId: input.runId, outputTokens: reported.outputTokens,
      provider: attribution.provider, reasoningTokens: reported.reasoningTokens, totalTokens: reported.totalTokens,
      usageCompleteness: reported.completeness === "complete" ? "COMPLETE" as const :
        reported.completeness === "partial" ? "PARTIAL" as const : "UNAVAILABLE" as const,
      ...(projectId ? { projectId } : {}), userId: input.userId
    };
  }) });
  await tx.chat.update({ where: { id: input.chatId }, data: {
    totalInputTokens: { increment: usage.inputTokens ?? 0 },
    totalOutputTokens: { increment: usage.outputTokens ?? 0 },
    totalReasoningTokens: { increment: usage.reasoningTokens ?? 0 }
  } });
}

/** Text and its accounting commit together. Guest authority retires later. */
export function createPrismaRunAnswerOperations(prismaClient: PrismaClient): Pick<
  RunRepository, "publishRunAnswer" | "loadPublishedRunAnswer"
> {
  return {
    publishRunAnswer: async (input) => prismaClient.$transaction(async (tx) => {
      await lockRunSettlementScope(tx, input.runId);
      const [run] = await tx.$queryRaw<Array<{
        answerCompletedAt: Date | null;
        assistantMessageId: string | null;
        chatId: string;
        modelId: string;
        projectId: string | null;
        provider: string;
        status: ModelRunStatus;
      }>>(Prisma.sql`
        SELECT run."answerCompletedAt", run."assistantMessageId", run."chatId", run."modelId",
          run."provider", run."status", chat."projectId"
        FROM "ModelRun" AS run INNER JOIN "Chat" AS chat ON chat."id" = run."chatId"
        WHERE run."id" = ${input.runId} AND run."userId" = ${input.userId}
        FOR UPDATE OF run
      `);
      if (!run || run.answerCompletedAt || !dispatchableModelRunStatuses.includes(run.status) ||
        run.assistantMessageId !== input.assistantMessageId || run.chatId !== input.chatId ||
        run.modelId !== input.modelId || run.provider !== input.provider) return false;

      const message = await tx.message.updateMany({
        data: {
          content: json(textMessageContent(input.finalText)), errorMessage: null,
          outputTokens: input.usage.outputTokens, reasoningTokens: input.usage.reasoningTokens,
          status: "complete"
        },
        where: { id: input.assistantMessageId, chatId: input.chatId, role: "assistant",
          status: { in: activeMessageStatuses } }
      });
      if (message.count !== 1) throw new Error("run_answer_publication_conflict");
      if (input.knowledgeGrounding) await settleKnowledgeGrounding(tx, input.knowledgeGrounding);
      await appendRunOutputEvents(tx, input.runId, input.outputEvents ?? []);
      await persistCompletedAnswerUsage(tx, input, run.projectId);
      const usage = normalizeTokenUsage(input.usage);
      await tx.modelRun.update({ where: { id: input.runId }, data: {
        cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
        estimatedCostMicros: input.estimatedCostMicros, inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
        usageCompleteness: usage.completeness === "complete" ? "COMPLETE" :
          usage.completeness === "partial" ? "PARTIAL" : "UNAVAILABLE",
        answerCompletedAt: new Date(),
        answerCompletionUsage: json({ version: 1, usage: input.usage,
          estimatedCostMicros: input.estimatedCostMicros,
          usageAttributions: input.usageAttributions ?? [] }),
        ...(input.providerResponseId ? { providerResponseId: input.providerResponseId } : {})
      } });
      return true;
    }).catch(retainRunPrismaCode),
    loadPublishedRunAnswer: async ({ runId, userId }) => {
      const run = await prismaClient.modelRun.findFirst({
        select: { id: true, chatId: true, userId: true, modelId: true, provider: true,
          providerResponseId: true, answerCompletionUsage: true,
          assistantMessage: { select: { id: true, content: true, status: true } } },
        where: { id: runId, userId, answerCompletedAt: { not: null },
          status: { in: dispatchableModelRunStatuses } }
      }).catch(retainRunPrismaCode);
      if (!run) return null;
      const snapshot = run.answerCompletionUsage;
      const message = run.assistantMessage;
      if (!isRecord(snapshot) || snapshot.version !== 1 || !isRecord(snapshot.usage) ||
        !Array.isArray(snapshot.usageAttributions) || !message || message.status !== "complete" ||
        !isRecord(message.content)) throw new Error("run_answer_publication_invalid");
      const usageAttributions = snapshot.usageAttributions.map((value) => {
        if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string" ||
          !isRecord(value.usage)) throw new Error("run_answer_publication_invalid");
        return { provider: value.provider, modelId: value.modelId,
          estimatedCostMicros: reportedTokenCount(value.estimatedCostMicros),
          ...(value.operationCount !== undefined ? { operationCount: reportedTokenCount(value.operationCount) } : {}),
          usage: normalizeTokenUsage(value.usage) };
      });
      const estimatedCostMicros = reportedTokenCount(snapshot.estimatedCostMicros);
      const completion: RunCompletionInput = {
        assistantMessageId: message.id, chatId: run.chatId, estimatedCostMicros,
        finalText: textFromContentBlocks(message.content), modelId: run.modelId, provider: run.provider,
        ...(run.providerResponseId ? { providerResponseId: run.providerResponseId } : {}),
        runId: run.id, usage: { ...normalizeTokenUsage(snapshot.usage), estimatedCostMicros },
        usageAttributions, userId: run.userId
      };
      return completion;
    }
  };
}
