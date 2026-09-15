import { describe, expect, it, vi } from "vitest";
import { AcceptanceDriver, type SendResult } from "./driver";

function fixture() {
  const answer: SendResult = { answer: "Synthetic answer", runId: "run", userMessageId: "message",
    memoryOutcome: "APPLIED", degradationCode: null, memoryItems: 1, ownerIsolation: true,
    deliveredMemoryEvidence: [], elapsedMs: 10, totalTokens: 5,
    userMessageCreatedAt: "2026-09-14T00:00:00.000Z" };
  const driver = Object.assign(Object.create(AcceptanceDriver.prototype), {
    conversation: () => ({ id: "probe", mode: "NORMAL", leaf: null }),
    send: vi.fn().mockResolvedValue(answer),
    request: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockRejectedValue(new Error("memory_acceptance_job_failed:rebuild_index:memory_embedding_unavailable")),
    excludedProbeIds: new Set(),
    prisma: { chat: { count: vi.fn().mockResolvedValue(1) } }
  });
  return { driver, answer };
}

describe("benchmark question isolation", () => {
  it("reports run, utility, and unlinked ancillary usage without double counting", async () => {
    const answers = [{ modelId: "answer", status: "complete", usageCompleteness: "COMPLETE", _count: 1, _sum: { totalTokens: 12 } }];
    const utilities = [{ logicalRole: "MEMORY_QUERY_EMBED", providerModelId: "embed", state: "SUCCEEDED", usageCompleteness: "COMPLETE", _count: 1, _sum: { totalTokens: 4 } }];
    const ancillaryUsageEvents = [{ chatTitleGeneration: true, modelId: "title", provider: "openai", providerModelId: "title-model", usageCompleteness: "UNAVAILABLE", _count: 1, _sum: { totalTokens: null } }];
    const driver = Object.assign(Object.create(AcceptanceDriver.prototype), {
      ownedUserIds: ["owner"],
      prisma: {
        memoryExecutionBinding: { groupBy: vi.fn().mockResolvedValue(utilities) },
        modelRun: { groupBy: vi.fn().mockResolvedValue(answers) },
        usageEvent: { groupBy: vi.fn().mockResolvedValue(ancillaryUsageEvents) }
      }
    });

    await expect(driver.usage()).resolves.toEqual({ answers, utilities, ancillaryUsageEvents });
    expect(driver.prisma.modelRun.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ["provider", "modelId", "status", "usageCompleteness"],
      _sum: expect.objectContaining({ cacheWriteInputTokens: true, cachedInputTokens: true,
        reasoningTokens: true, estimatedCostMicros: true })
    }));
    expect(driver.prisma.memoryExecutionBinding.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ["logicalRole", "providerModelId", "state", "usageCompleteness"]
    }));
    expect(driver.prisma.usageEvent.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: { in: ["owner"] }, memoryExecutionBindingId: null, modelRunId: null },
      _sum: expect.objectContaining({ cacheWriteInputTokens: true, cachedInputTokens: true,
        operationCount: true, reasoningTokens: true, estimatedCostMicros: true })
    }));
  });

  it("retains an obtained answer and its cleanup failure after exclusion is proven", async () => {
    const { driver, answer } = fixture();
    const result = await driver.probe({ userId: "owner", cookie: "synthetic" }, "Question");
    expect(result.answer).toBe(answer.answer);
    expect(result.cleanupFailureCode).toBe("memory_acceptance_job_failed:rebuild_index:memory_embedding_unavailable");
    expect(driver.request).toHaveBeenCalledWith(expect.anything(), "/api/me/chats/probe/memory-mode", { mode: "EXCLUDED" }, "PATCH");
  });
  it("fails closed when the question has not actually been excluded", async () => {
    const { driver } = fixture();
    driver.prisma.chat.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(driver.probe({ userId: "owner", cookie: "synthetic" }, "Question"))
      .rejects.toThrow("memory_acceptance_probe_not_isolated");
    expect(driver.settle).not.toHaveBeenCalled();
  });
  it("restores only a complete set of canonically excluded owner chats", async () => {
    const { driver } = fixture();
    const identity = { userId: "owner", cookie: "synthetic" };
    driver.prisma.chat.count.mockResolvedValue(2);
    await driver.restoreExcludedProbes(identity, ["first", "second"]);
    expect(driver.prisma.chat.count).toHaveBeenCalledWith({ where: {
      id: { in: ["first", "second"] }, userId: "owner", memoryMode: "EXCLUDED"
    } });
    expect([...driver.excludedProbeIds]).toEqual(["first", "second"]);
    driver.prisma.chat.count.mockResolvedValue(1);
    await expect(driver.restoreExcludedProbes(identity, ["third", "foreign-or-active"]))
      .rejects.toThrow("memory_acceptance_probe_not_isolated");
    expect([...driver.excludedProbeIds]).toEqual(["first", "second"]);
  });
});
