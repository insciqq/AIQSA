import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaModelCheckUsageWriter } from "./modelCheckUsage";

afterAll(() => prisma.$disconnect());

const NOW = new Date("2026-10-07T01:00:00.000Z");

async function withFixture(run: (fixture: { userId: string; answerId: string; embeddingId: string }) => Promise<void>) {
  const marker = `model-check-usage-${randomUUID()}`;
  const connectionId = `${marker}-conn`;
  const config = { allowPrivateNetwork: false, apiRoot: "https://unreachable.example.test/v1", authenticationMode: "bearer",
    responseTimeoutMs: 5000 };
  const user = await prisma.user.create({ data: { displayName: "Checking admin", email: `admin@${marker}.example.com`,
    role: "admin", status: "active" } });
  const answerId = randomUUID(), embeddingId = randomUUID();
  try {
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Model check fixture", family: "openai_compatible",
      activeConfig: config, draftConfig: config, activeVersion: 1, draftVersion: 1, activatedAt: NOW, enabled: true } });
    for (const [id, modelClass, upstream, prices] of [
      [answerId, "answer", "fixture/answer", { inputTokenPriceUsdPerMillion: 1, outputTokenPriceUsdPerMillion: 4,
        webSearchPriceUsdPerThousand: 10 }],
      [embeddingId, "embedding", "fixture/embedding", { inputTokenPriceUsdPerMillion: 0.02 }]
    ] as const) {
      const model = { adapterKind: modelClass === "answer" ? "openai_responses_compatible" : "openai_embeddings_compatible",
        answerSelectable: modelClass === "answer", modelClass, upstreamModelId: upstream, defaultParams: {},
        capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false } };
      await prisma.providerModel.create({ data: { id, connectionId, provider: "openai_compatible", modelId: upstream,
        modelClass, displayName: upstream, activeConfig: model, draftConfig: model, activeVersion: 1, draftVersion: 1,
        capabilities: model.capabilities, defaultParams: model.defaultParams, activatedAt: NOW, enabled: true, ...prices } });
    }
    await run({ userId: user.id, answerId, embeddingId });
  } finally {
    await prisma.usageEvent.deleteMany({ where: { userId: user.id } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

describe("Prisma model-check usage writer", () => {
  it("writes one model_check row per call, charged to the administrator, with the shared cost rule", async () => withFixture(async (f) => {
    const write = createPrismaModelCheckUsageWriter(prisma);
    const identity = { userId: f.userId, provider: "openai_compatible" };
    // Stored answer prices: 1000 input tokens at $1/M and 500 output tokens at $4/M = 3000 micro-dollars.
    await write({ ...identity, modelId: "fixture/answer", providerModelId: f.answerId, modelClass: "answer",
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 }, reportedCostUsd: null });
    // A hosted Search check's two billed searches at the answer model's $10 per 1,000: 3000 + 20000 micro-dollars.
    await write({ ...identity, modelId: "fixture/answer", providerModelId: f.answerId, modelClass: "answer",
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, webSearchCount: 2 }, reportedCostUsd: null });
    // A reported cost wins over the embedding's stored input price.
    await write({ ...identity, modelId: "fixture/embedding", providerModelId: f.embeddingId, modelClass: "embedding",
      usage: { inputTokens: 4, totalTokens: 4 }, reportedCostUsd: 0.000123 });
    // The embedding's stored input price applies without a reported cost: 50000 tokens at $0.02/M = 1000 micro-dollars.
    await write({ ...identity, modelId: "fixture/embedding", providerModelId: f.embeddingId, modelClass: "embedding",
      usage: { inputTokens: 50_000, totalTokens: 50_000 }, reportedCostUsd: null });
    // A never-saved draft has no row and no prices: only a reported cost is known.
    const draftId = randomUUID();
    await write({ ...identity, modelId: "fixture/draft", providerModelId: draftId, modelClass: "answer",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, reportedCostUsd: null });
    await write({ ...identity, modelId: "fixture/draft", providerModelId: draftId, modelClass: "reranker",
      usage: {}, reportedCostUsd: 0.002 });

    const rows = await prisma.usageEvent.findMany({ where: { userId: f.userId } });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row).toMatchObject({ purpose: "model_check", chatId: null, modelRunId: null, projectId: null, provider: "openai_compatible" });
    }
    const byModel = (modelId: string) => rows.filter((row) => row.modelId === modelId);
    expect(byModel("fixture/answer")).toHaveLength(2);
    expect(byModel("fixture/answer")).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerModelId: f.answerId, inputTokens: 1_000, outputTokens: 500, usageCompleteness: "COMPLETE",
        webSearchCount: null, estimatedCostMicros: 3_000 }),
      expect.objectContaining({ providerModelId: f.answerId, webSearchCount: 2, estimatedCostMicros: 23_000 })
    ]));
    expect(byModel("fixture/embedding").map((row) => row.estimatedCostMicros).sort((a, b) => a! - b!)).toEqual([123, 1_000]);
    expect(byModel("fixture/draft")).toHaveLength(2);
    expect(byModel("fixture/draft")).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerModelId: null, estimatedCostMicros: null, usageCompleteness: "COMPLETE" }),
      expect.objectContaining({ providerModelId: null, estimatedCostMicros: 2_000, usageCompleteness: "UNAVAILABLE" })
    ]));
  }));
});
