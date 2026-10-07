// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { UsagePurpose, type Prisma, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { normalizeTokenUsage } from "../../domain/usage";
import { USAGE_PURPOSES } from "../../domain/usagePurpose";
import { createPrismaRunAnswerOperations, persistCompletedAnswerUsage } from "./prismaRepositoryAnswer";
import { runAttributionUsageRows, runAttributionUsageWhere, storedRunAttributionPurpose } from "./prismaRepositoryUsage";
import type { RunCompletionInput } from "./runRepositoryContract";

const usage = normalizeTokenUsage({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });

describe("run attribution usage rows", () => {
  it("stores exactly the vocabulary the domain names", () => {
    expect(Object.values(UsagePurpose)).toEqual([...USAGE_PURPOSES]);
  });

  it("owns only unflagged, unbound rows of the run's attribution purposes", () => {
    expect(runAttributionUsageWhere("run-1")).toEqual({
      chatPdfPreparation: false, chatTitleGeneration: false, imageGeneration: false, knowledgeRelevance: false,
      mcpHubDiscovery: false, optionalDecision: false, visionAnalysis: false,
      memoryExecutionBindingId: null, modelRunId: "run-1",
      purpose: { in: ["chat_answer", "web_search", "knowledge_retrieval"] }
    });
  });

  it("writes each attribution with its own purpose", () => {
    const rows = runAttributionUsageRows({ chatId: "chat-1", projectId: "project-1", runId: "run-1", userId: "user-1" }, [
      { modelId: "answer", operationCount: 2, provider: "openai", purpose: "chat_answer", usage, estimatedCostMicros: 9 },
      { modelId: "search", provider: "perplexity", purpose: "web_search", usage: normalizeTokenUsage({ inputTokens: 3 }) }
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ modelId: "answer", purpose: "chat_answer", operationCount: 2, estimatedCostMicros: 9,
        projectId: "project-1", modelRunId: "run-1", chatId: "chat-1", userId: "user-1", usageCompleteness: "COMPLETE" }),
      expect.objectContaining({ modelId: "search", purpose: "web_search", operationCount: null, estimatedCostMicros: null,
        usageCompleteness: "PARTIAL" })
    ]);
    expect(runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" },
      [{ modelId: "answer", provider: "openai", purpose: "chat_answer", usage }])[0]).not.toHaveProperty("projectId");
  });

  it("stores the web searches a row paid for, and none when no search was reported", () => {
    const rows = runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" }, [
      { modelId: "answer", provider: "anthropic", purpose: "chat_answer", usage: { ...usage, webSearchCount: 2 }, estimatedCostMicros: 20_000 },
      { modelId: "sonar", provider: "openrouter", purpose: "web_search", usage: { ...usage, costUsd: 0.0142 }, estimatedCostMicros: 14_200 }
    ]);
    expect(rows.map(({ webSearchCount, estimatedCostMicros }) => [webSearchCount, estimatedCostMicros])).toEqual([[2, 20_000], [null, 14_200]]);
    // The reported cost is the row's cost; it has no column of its own.
    expect(rows[1]).not.toHaveProperty("costUsd");
  });

  it("refuses a stored purpose that is not a run attribution", () => {
    expect(storedRunAttributionPurpose("knowledge_retrieval")).toBe("knowledge_retrieval");
    for (const value of ["chat_title", "memory_retrieval", null]) {
      expect(() => storedRunAttributionPurpose(value)).toThrow("run_usage_purpose_invalid");
    }
  });
});

describe("completed answer usage", () => {
  function transaction() {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const createMany = vi.fn(async () => ({ count: 0 }));
    const update = vi.fn(async () => ({}));
    return { deleteMany, createMany, tx: { usageEvent: { deleteMany, createMany }, chat: { update } } as unknown as Prisma.TransactionClient };
  }
  const input: RunCompletionInput = {
    assistantMessageId: "assistant-1", chatId: "chat-1", estimatedCostMicros: 5, finalText: "Answer",
    modelId: "answer", provider: "openai", runId: "run-1", usage, userId: "user-1"
  };

  it("rewrites only the run's attribution rows, keeping each attribution's purpose", async () => {
    const { tx, deleteMany, createMany } = transaction();
    await persistCompletedAnswerUsage(tx, { ...input, usageAttributions: [
      { modelId: "answer", provider: "openai", purpose: "chat_answer", usage },
      { modelId: "embed", provider: "openai", purpose: "knowledge_retrieval", usage: normalizeTokenUsage({ inputTokens: 8 }) }
    ] }, null);
    expect(deleteMany).toHaveBeenCalledWith({ where: runAttributionUsageWhere("run-1") });
    expect(createMany).toHaveBeenCalledWith({ data: [
      expect.objectContaining({ modelId: "answer", purpose: "chat_answer" }),
      expect.objectContaining({ modelId: "embed", purpose: "knowledge_retrieval" })
    ] });
  });

  it("records a completion without attributions as answer usage", async () => {
    const { tx, createMany } = transaction();
    await persistCompletedAnswerUsage(tx, input, "project-1");
    expect(createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ modelId: "answer", provider: "openai",
      purpose: "chat_answer", operationCount: 1, estimatedCostMicros: 5, projectId: "project-1" })] });
  });
});

describe("published answer snapshots", () => {
  function load(usageAttributions: readonly unknown[]) {
    const findFirst = vi.fn(async () => ({
      id: "run-1", chatId: "chat-1", userId: "user-1", modelId: "answer", provider: "openai", providerResponseId: null,
      followupRevision: 0,
      answerCompletionUsage: { version: 1, usage, estimatedCostMicros: null, usageAttributions },
      assistantMessage: { id: "assistant-1", content: textMessageContent("Answer"), status: "complete" }
    }));
    const operations = createPrismaRunAnswerOperations({ modelRun: { findFirst } } as unknown as PrismaClient);
    return operations.loadPublishedRunAnswer!({ runId: "run-1", userId: "user-1" });
  }

  it("reads attributions published before purposes as answer usage and keeps recorded purposes", async () => {
    const completion = await load([
      { modelId: "answer", provider: "openai", usage },
      { modelId: "search", provider: "perplexity", purpose: "web_search", usage }
    ]);
    expect(completion?.usageAttributions?.map(({ modelId, purpose }) => [modelId, purpose])).toEqual([
      ["answer", "chat_answer"], ["search", "web_search"]
    ]);
  });

  it("refuses a snapshot purpose that a run cannot attribute", async () => {
    await expect(load([{ modelId: "title", provider: "openai", purpose: "chat_title", usage }]))
      .rejects.toThrow("run_answer_publication_invalid");
  });
});
