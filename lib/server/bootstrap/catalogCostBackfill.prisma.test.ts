import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { backfillCatalogCostBatch, runCatalogCostBackfill } from "./catalogCostBackfill";

afterAll(() => prisma.$disconnect());

describe("historical catalog accounting adoption", () => {
  it("uses frozen upgrade prices once, isolates a rejected row, keeps run timestamps and completes", async () => {
    const id = randomUUID(), userId = randomUUID(), chatId = randomUUID(), connectionId = randomUUID(), modelId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const messageIds = runIds.map(() => randomUUID());
    // Ordered ids: the title receipt sits between two ordinary receipts of one batch.
    const base = randomUUID();
    const [answerUsageId, titleUsageId, chatUsageId, pricedUsageId] = [1, 2, 3, 4].map(index => `${base}:${index}`) as [string, string, string, string];
    const summaryUsageId = `chat-summary:${randomUUID()}:${randomUUID()}:0`;
    const counts = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000, totalTokens: 11_000 };
    const createdAt = new Date("2026-01-01T00:00:00.000Z"), updatedAt = new Date("2026-01-01T00:00:05.000Z");
    try {
      await prisma.user.create({ data: { id: userId, displayName: "Synthetic pricing owner" } });
      await prisma.chat.create({ data: { id: chatId, userId, title: "Synthetic pricing" } });
      await prisma.providerConnection.create({ data: { id: connectionId, family: "openai", displayName: "Synthetic prices" } });
      await prisma.providerModel.create({ data: { id: modelId, connectionId, provider: connectionId, modelId,
        displayName: "Synthetic model", capabilities: {}, defaultParams: {}, inputTokenPriceUsdPerMillion: 99, outputTokenPriceUsdPerMillion: 99 } });
      for (let index = 0; index < runIds.length; index++) {
        await prisma.message.create({ data: { id: messageIds[index], chatId, role: "user", content: {} } });
        await prisma.modelRun.create({ data: { id: runIds[index], userId, chatId, userMessageId: messageIds[index]!,
          provider: connectionId, modelId, normalizedRequest: {}, status: "complete", ...counts, createdAt, updatedAt,
          usageCompleteness: index === 2 ? "PARTIAL" : "COMPLETE", estimatedCostMicros: index === 1 ? 123 : null } });
      }
      await prisma.providerRunBinding.create({ data: { modelRunId: runIds[0]!, role: "answer", bindingKey: "answer",
        connectionId, providerModelId: modelId, credentialSource: "default", executionSnapshot: {} } });
      // Ordinary answer receipts identify their model by provider/modelId; the
      // accepted run binding separately retains its exact deployment identity.
      await prisma.usageEvent.create({ data: { id: answerUsageId, userId, chatId, modelRunId: runIds[0], purpose: "chat_answer",
        provider: connectionId, modelId, ...counts, usageCompleteness: "COMPLETE" } });
      await prisma.chatTitleGeneration.create({ data: { runId: runIds[0]!, chatId, userId, expectedTitle: "Synthetic pricing",
        titleRevision: 0, questionText: "Synthetic question", answerText: "Synthetic answer",
        providerSnapshot: { providerModelId: modelId, providerFamily: connectionId, model: { upstreamModelId: modelId } },
        status: "dispatched", expiresAt: new Date(Date.now() + 60_000) } });
      // The title guard admits only the installation's own adoption state, so this
      // synthetic state's update is rejected by a real trigger.
      await prisma.usageEvent.create({ data: { id: titleUsageId, userId, chatId, modelRunId: runIds[0], chatTitleGeneration: true,
        chatTitleGenerationId: runIds[0], purpose: "chat_title", provider: connectionId, modelId, providerModelId: modelId, ...counts,
        usageCompleteness: "COMPLETE" } });
      await prisma.usageEvent.create({ data: { id: chatUsageId, userId, chatId, purpose: "chat_answer", provider: connectionId, modelId,
        ...counts, usageCompleteness: "COMPLETE" } });
      await prisma.usageEvent.create({ data: { id: pricedUsageId, userId, chatId, purpose: "chat_answer", provider: connectionId, modelId,
        ...counts, usageCompleteness: "COMPLETE", estimatedCostMicros: 7 } });
      // Chat-summary receipts store the exact ProviderModel id in modelId.
      await prisma.usageEvent.create({ data: { id: summaryUsageId, userId, chatId, purpose: "chat_summary", provider: "openai", modelId,
        ...counts, usageCompleteness: "COMPLETE" } });
      // The cutoff leads the database clock so default receipt timestamps stay inside it.
      await prisma.catalogCostBackfill.create({ data: { id, cutoffAt: new Date(Date.now() + 60_000), prices: [{ id: modelId, provider: connectionId, modelId,
        inputTokenPriceUsdPerMillion: 2, cachedInputTokenPriceUsdPerMillion: 0.2,
        cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: 10 }] } });

      let skipped = 0, batches = 0;
      for (;;) {
        const result = await backfillCatalogCostBatch(prisma, id);
        skipped += result.skipped;
        batches += 1;
        if (!result.more) {
          expect(result.completed).toBe(true);
          break;
        }
      }
      expect(batches).toBeGreaterThanOrEqual(2);
      expect(skipped).toBe(1);
      const usage = async (usageId: string) => (await prisma.usageEvent.findUniqueOrThrow({ where: { id: usageId } })).estimatedCostMicros;
      expect(await usage(answerUsageId)).toBe(15_600);
      expect(await usage(titleUsageId)).toBeNull();
      expect(await usage(chatUsageId)).toBe(15_600);
      expect(await usage(pricedUsageId)).toBe(7);
      expect(await usage(summaryUsageId)).toBe(15_600);
      const runs = await prisma.modelRun.findMany({ where: { id: { in: runIds } } });
      const run = (runId: string) => runs.find(row => row.id === runId)!;
      expect(run(runIds[0]!).estimatedCostMicros).toBe(15_600);
      expect(run(runIds[1]!).estimatedCostMicros).toBe(123);
      expect(run(runIds[2]!).estimatedCostMicros).toBeNull();
      expect(run(runIds[3]!).estimatedCostMicros).toBe(15_600);
      // The work duration of a terminal run without answer text ends at updatedAt.
      for (const row of runs) expect(row.updatedAt.getTime() - row.createdAt.getTime()).toBe(5_000);
      const state = await prisma.catalogCostBackfill.findUniqueOrThrow({ where: { id } });
      expect(state.completedAt).not.toBeNull();
      expect(state.prices).toEqual([]);

      // A second execution finds a completed state and changes nothing.
      const before = await prisma.usageEvent.findMany({ where: { userId }, orderBy: { id: "asc" } });
      await runCatalogCostBackfill(prisma, { id, sleep: async () => {} });
      expect(await backfillCatalogCostBatch(prisma, id)).toEqual({ more: false, skipped: 0, completed: false });
      expect(await prisma.usageEvent.findMany({ where: { userId }, orderBy: { id: "asc" } })).toEqual(before);
      expect(await prisma.modelRun.findMany({ where: { id: { in: runIds } } })).toEqual(expect.arrayContaining(runs));
    } finally {
      await prisma.catalogCostBackfill.deleteMany({ where: { id } });
      await prisma.usageEvent.deleteMany({ where: { userId } });
      await prisma.chatTitleGeneration.deleteMany({ where: { chatId } });
      await prisma.modelRun.deleteMany({ where: { id: { in: runIds } } });
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  });
});
