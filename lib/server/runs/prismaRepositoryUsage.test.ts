// @vitest-environment node
import { describe, expect, it } from "vitest";
import { UsagePurpose } from "@prisma/client";
import { normalizeTokenUsage } from "../../domain/usage";
import { USAGE_PURPOSES } from "../../domain/usagePurpose";
import { runAttributionUsageRows, runAttributionUsageWhere } from "./prismaRepositoryUsage";

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
      purpose: { in: ["chat_answer", "web_search", "knowledge_retrieval", "subagent"] }
    });
  });

  it("writes each attribution with its own purpose and never a Project", () => {
    const rows = runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" }, [
      { modelId: "answer", operationCount: 2, provider: "openai", purpose: "chat_answer", usage, estimatedCostMicros: 9 },
      { modelId: "search", provider: "perplexity", purpose: "web_search", usage: normalizeTokenUsage({ inputTokens: 3 }) }
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ modelId: "answer", purpose: "chat_answer", operationCount: 2, estimatedCostMicros: 9,
        modelRunId: "run-1", chatId: "chat-1", userId: "user-1", usageCompleteness: "COMPLETE" }),
      expect.objectContaining({ modelId: "search", purpose: "web_search", operationCount: null, estimatedCostMicros: null,
        usageCompleteness: "PARTIAL" })
    ]);
    expect(rows[0]).not.toHaveProperty("projectId");
  });

  it("keeps a reported charge settled on answer and sub-agent rows only", () => {
    const rows = runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" }, [
      { costReported: true, estimatedCostMicros: 5, modelId: "answer", provider: "openrouter", purpose: "chat_answer", usage },
      { costReported: true, estimatedCostMicros: 3, modelId: "answer", provider: "openrouter", purpose: "subagent", usage },
      { costReported: true, estimatedCostMicros: 1, modelId: "sonar", provider: "openrouter", purpose: "web_search", usage }
    ]);
    expect(rows.map((row) => [row.purpose, row.costReported])).toEqual([["chat_answer", true], ["subagent", true], ["web_search", false]]);
  });

  it("stores the web searches a row paid for, and none when no search was reported", () => {
    const rows = runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" }, [
      { modelId: "answer", provider: "anthropic", purpose: "chat_answer", usage: { ...usage, webSearchCount: 2 }, estimatedCostMicros: 20_000 },
      { modelId: "sonar", provider: "openrouter", purpose: "web_search", usage, estimatedCostMicros: 14_200 }
    ]);
    expect(rows.map(({ webSearchCount, estimatedCostMicros }) => [webSearchCount, estimatedCostMicros])).toEqual([[2, 20_000], [null, 14_200]]);
  });

  it("records the deployment an attribution names, so a reranker row keeps its model", () => {
    const [rerank, answer] = runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" }, [
      { modelId: "voyageai/rerank-2.5", provider: "openrouter", providerModelId: "reranker-deployment",
        purpose: "knowledge_retrieval", usage: normalizeTokenUsage({ totalTokens: 2 }), estimatedCostMicros: 0 },
      { modelId: "answer", provider: "openai", purpose: "chat_answer", usage }
    ]);
    expect(rerank).toMatchObject({ providerModelId: "reranker-deployment", purpose: "knowledge_retrieval",
      estimatedCostMicros: 0, totalTokens: 2, usageCompleteness: "PARTIAL" });
    expect(answer).toMatchObject({ providerModelId: null, purpose: "chat_answer" });
  });

});

it("preserves guard accounting as a system purpose with the provider's own cost and unknown tokens", () => {
  const [row] = runAttributionUsageRows({ chatId: "chat-1", runId: "run-1", userId: "user-1" }, [{
    modelId: "guard", provider: "openrouter", purpose: "mcp_guard", usage: normalizeTokenUsage({ outputTokens: 4 }),
    estimatedCostMicros: 20, costReported: true
  }]);
  expect(row).toMatchObject({ purpose: "mcp_guard", inputTokens: null, outputTokens: 4, costReported: true, estimatedCostMicros: 20 });
});
