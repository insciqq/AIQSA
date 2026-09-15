import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptanceDriver } from "./driver";

afterEach(() => vi.useRealTimers());

describe("acceptance background settlement", () => {
  it.each([false, true])("waits for prior background work before rebuild admission, failure=%s", async (failed) => {
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const failure = new Error("prior_background_work_failed");
    const settings = vi.fn().mockRejectedValue(new Error("test_stopped_before_admission"));
    const identity = { userId: "owner", cookie: "synthetic" };
    const driver = Object.assign(Object.create(AcceptanceDriver.prototype), {
      settle: vi.fn(async () => { await settled; if (failed) throw failure; }),
      prisma: { userMemorySettings: { findUniqueOrThrow: settings } }
    }) as AcceptanceDriver;
    const outcome = driver.rebuild(identity).catch((error: Error) => error);
    await Promise.resolve();
    expect(settings).not.toHaveBeenCalled();
    finish();
    expect(await outcome).toEqual(failed ? failure : new Error("test_stopped_before_admission"));
    expect(driver.settle).toHaveBeenCalledWith(identity);
    expect(settings).toHaveBeenCalledTimes(failed ? 0 : 1);
  });

  it.each([
    { items: 0, executions: 0, state: "STALE", code: "memory_embedding_batch_target_stale", healthy: true },
    { items: 1, executions: 0, state: "STALE", code: "memory_embedding_batch_target_stale", healthy: false },
    { items: 0, executions: 1, state: "STALE", code: "memory_embedding_batch_target_stale", healthy: false },
    { items: 0, executions: 0, state: "CANCELLED", code: "memory_embedding_batch_target_stale", healthy: false },
    { items: 0, executions: 0, state: "STALE", code: "memory_embedding_batch_invalid", healthy: false }
  ])("classifies retired batch work with $items items, $executions executions, $state/$code", async (testCase) => {
    vi.useFakeTimers();
    const prisma = {
      memoryJob: { findMany: vi.fn().mockResolvedValue([{ id: "batch-job", kind: "EMBED_ITEMS",
        state: testCase.state, errorCode: testCase.code, chatId: null, sourceMessageId: null }]) },
      memoryDeletionOutbox: { count: vi.fn().mockResolvedValue(0) },
      memoryLexicalProjectionEvent: { count: vi.fn().mockResolvedValue(0) },
      userMemorySettings: { findUniqueOrThrow: vi.fn().mockResolvedValue({ useMemoryFacts: true }) },
      memoryEmbeddingBatchItem: { count: vi.fn().mockResolvedValue(testCase.items) },
      memoryExecutionBinding: { count: vi.fn().mockResolvedValue(testCase.executions) }
    };
    const driver = Object.assign(Object.create(AcceptanceDriver.prototype), {
      prisma, excludedProbeIds: new Set()
    }) as AcceptanceDriver;
    const result = driver.settle({ userId: "owner", cookie: "synthetic" }).then(
      () => ({ healthy: true }),
      (error: Error) => ({ healthy: false, code: error.message })
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toMatchObject({ healthy: testCase.healthy });
    if (testCase.state === "STALE" && testCase.code === "memory_embedding_batch_target_stale") {
      expect(prisma.memoryEmbeddingBatchItem.count).toHaveBeenCalledWith({
        where: { userId: "owner", memoryJobId: "batch-job" }
      });
      expect(prisma.memoryExecutionBinding.count).toHaveBeenCalledWith({
        where: { userId: "owner", memoryJobId: "batch-job",
          state: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"] } }
      });
    } else {
      expect(prisma.memoryEmbeddingBatchItem.count).not.toHaveBeenCalled();
    }
  });
});
