import { describe, expect, it, vi } from "vitest";
import { recordChatSearchUsage, type ChatSearchUsageDb } from "./usage";

vi.mock("../observability", () => ({ logEvent: vi.fn() }));

function fakeDb(model: Record<string, unknown> | null = null) {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    providerModel: { findUnique: vi.fn(async () => model) },
    usageEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; }) }
  } as unknown as ChatSearchUsageDb;
  return { created, db };
}

const base = { modelId: "text-embedding-3-small", provider: "openai", providerModelId: "embed-a", userId: "owner-1" } as const;

describe("past-chat search usage", () => {
  it("records a call's reported cost and tokens under its purpose, without a Memory binding", async () => {
    const { created, db } = fakeDb();
    expect(await recordChatSearchUsage(db, { ...base, costUsd: 0.0000123, purpose: "memory_indexing", requestCount: 2,
      usage: { inputTokens: 40, totalTokens: 40 } })).toBe("recorded");
    expect(created).toEqual([{
      cachedInputTokens: null, cacheWriteInputTokens: null, chatId: null, estimatedCostMicros: 12, inputTokens: 40,
      modelId: "text-embedding-3-small", modelRunId: null, operationCount: 2, outputTokens: null, provider: "openai",
      providerModelId: "embed-a", purpose: "memory_indexing", reasoningTokens: null, totalTokens: 40,
      usageCompleteness: "PARTIAL", userId: "owner-1"
    }]);
    expect(created[0]).not.toHaveProperty("memoryExecutionBindingId");
  });

  it("prices unreported cost from the model's stored input price, else leaves it unknown", async () => {
    const priced = fakeDb({ modelClass: "embedding", inputTokenPriceUsdPerMillion: 0.02, outputTokenPriceUsdPerMillion: null,
      cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null, webSearchPriceUsdPerThousand: null });
    await recordChatSearchUsage(priced.db, { ...base, purpose: "memory_retrieval", usage: { inputTokens: 1_000_000 } });
    expect(priced.created[0]).toMatchObject({ estimatedCostMicros: 20_000, purpose: "memory_retrieval" });
    const unknown = fakeDb();
    await recordChatSearchUsage(unknown.db, { ...base, purpose: "memory_retrieval", usage: { inputTokens: 10 } });
    expect(unknown.created[0]).toMatchObject({ estimatedCostMicros: null });
  });

  it("writes nothing for a call that reported nothing", async () => {
    const { created, db } = fakeDb();
    expect(await recordChatSearchUsage(db, { ...base, purpose: "memory_indexing", usage: {} })).toBe("skipped");
    expect(created).toEqual([]);
  });

  it("links a search's chat and run when given, and never throws when the write fails", async () => {
    const { created, db } = fakeDb();
    await recordChatSearchUsage(db, { ...base, chatId: "chat-1", modelRunId: "run-1", purpose: "memory_retrieval", usage: { totalTokens: 3 } });
    expect(created[0]).toMatchObject({ chatId: "chat-1", modelRunId: "run-1" });
    const failing = { providerModel: { findUnique: async () => null },
      usageEvent: { create: async () => { throw new Error("database down"); } } } as unknown as ChatSearchUsageDb;
    await expect(recordChatSearchUsage(failing, { ...base, purpose: "memory_indexing", usage: { inputTokens: 1 } })).resolves.toBe("failed");
  });
});
