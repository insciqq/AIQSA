import { describe, expect, it, vi } from "vitest";
import { loadChatUsageTotals } from "./usageTotals";

describe("cumulative chat accounting", () => {
  it("projects an aggregate without exposing records or filtering out another Project actor", async () => {
    const query = vi.fn().mockResolvedValue([{ hasCompletedAnswer: true, recordCount: 4n, knownCostRecordCount: 2n,
      incompleteRecordCount: 1n, totalTokens: 9876n, estimatedCostMicros: 12500n }]);
    expect(await loadChatUsageTotals({ $queryRaw: query } as never, "allowed-chat")).toEqual({
      hasCompletedAnswer: true, recordCount: 4, knownCostRecordCount: 2, incompleteRecordCount: 1, totalTokens: 9876, estimatedCostMicros: 12500
    });
    expect(query.mock.calls[0]![0].values).toEqual(["allowed-chat", "allowed-chat", "allowed-chat", "allowed-chat"]);
  });
  it("opens spending on a completed answer or an answer attempt, never on pre-answer receipts alone", async () => {
    const query = vi.fn().mockResolvedValue([{ hasCompletedAnswer: true, recordCount: 1n, knownCostRecordCount: 1n,
      incompleteRecordCount: 0n, totalTokens: 940n, estimatedCostMicros: 12000n }]);
    await loadChatUsageTotals({ $queryRaw: query } as never, "stopped-chat");
    const sql = (query.mock.calls[0]![0].strings as string[]).join("?").replace(/\s+/gu, " ");
    expect(sql).toContain(`"role" = 'assistant' AND "status" = 'complete' ) OR EXISTS ( SELECT 1 FROM "UsageEvent" WHERE "chatId" = ? AND "modelRunId" IS NOT NULL`);
    for (const stage of ["chatPdfPreparation", "imageGeneration", "visionAnalysis", "chatTitleGeneration",
      "knowledgeRelevance", "optionalDecision", "mcpHubDiscovery"]) expect(sql).toContain(`AND NOT "${stage}"`);
  });
  it("preserves unavailable totals and rejects unsafe numeric overflow", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ hasCompletedAnswer: false, recordCount: 0n, knownCostRecordCount: 0n,
      incompleteRecordCount: 0n, totalTokens: null, estimatedCostMicros: null }])
      .mockResolvedValueOnce([{ hasCompletedAnswer: true, recordCount: 1n, knownCostRecordCount: 1n,
        incompleteRecordCount: 0n, totalTokens: 1n, estimatedCostMicros: BigInt(Number.MAX_SAFE_INTEGER) + 1n }]);
    expect(await loadChatUsageTotals({ $queryRaw: query } as never, "empty-chat")).toEqual({
      hasCompletedAnswer: false, recordCount: 0, knownCostRecordCount: 0, incompleteRecordCount: 0, totalTokens: null, estimatedCostMicros: null
    });
    await expect(loadChatUsageTotals({ $queryRaw: query } as never, "large-chat")).rejects.toThrow("chat_usage_total_out_of_range");
  });
});
