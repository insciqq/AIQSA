import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createMcpGuardUsageCollector, registerMcpGuardUsage, writeLateMcpGuardUsage } from "./guardUsage";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";

const usage: RunUsageAttribution = { purpose: "mcp_guard", modelId: "guard-model", provider: "openrouter",
  usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, costReported: true, estimatedCostMicros: 42 };

describe("late MCP guard accounting", () => {
  it("uses the live ledger before release and a non-blocking writer after release", async () => {
    const add = vi.fn();
    const writeLate = vi.fn(async () => {});
    const collect = createMcpGuardUsageCollector(writeLate);
    const release = registerMcpGuardUsage("late-test", add);
    collect("late-test", usage);
    expect(add).toHaveBeenCalledExactlyOnceWith(usage);
    expect(writeLate).not.toHaveBeenCalled();
    release();
    expect(collect("late-test", usage)).toBeUndefined();
    await Promise.resolve();
    expect(writeLate).toHaveBeenCalledExactlyOnceWith("late-test", usage);
    writeLate.mockRejectedValue(new Error("private database content"));
    expect(() => collect("late-test", usage)).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
  });
  it("records only reported tokens and cost, after the answer, retrying the same receipt id", async () => {
    const scope = { chatId: "chat", userId: "owner", status: "complete", answerCompletedAt: new Date() };
    const findUnique = vi.fn().mockResolvedValueOnce({ ...scope, status: "streaming", answerCompletedAt: null }).mockResolvedValue(scope);
    const createMany = vi.fn().mockRejectedValueOnce(new Error("ack lost")).mockResolvedValue({ count: 1 });
    const db = { modelRun: { findUnique }, usageEvent: { createMany } } as unknown as PrismaClient;
    const wait = vi.fn(async () => {});
    await writeLateMcpGuardUsage(db, "run", { ...usage, usage: { outputTokens: 3 } }, wait);
    expect(wait).toHaveBeenCalledTimes(2); // Answer, then retry the local accounting write.
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[0][0]).toEqual(createMany.mock.calls[1][0]);
    expect(createMany.mock.calls[0][0]).toMatchObject({ data: [{ modelRunId: "run", userId: "owner", chatId: "chat",
      purpose: "mcp_guard", inputTokens: null, outputTokens: 3, totalTokens: null, estimatedCostMicros: 42, costReported: true }], skipDuplicates: true });
  });
  it("never estimates missing accounting or recreates a deleted run", async () => {
    const createMany = vi.fn();
    const findUnique = vi.fn(async (): Promise<{ chatId: string; userId: string; status: string; answerCompletedAt: Date } | null> =>
      ({ chatId: "chat", userId: "owner", status: "complete", answerCompletedAt: new Date() }));
    const db = { modelRun: { findUnique }, usageEvent: { createMany } } as unknown as PrismaClient;
    await writeLateMcpGuardUsage(db, "run", { ...usage, costReported: undefined, usage: {} });
    expect(createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ inputTokens: null, outputTokens: null,
      totalTokens: null, estimatedCostMicros: null, costReported: false })], skipDuplicates: true });
    findUnique.mockResolvedValue(null);
    await writeLateMcpGuardUsage(db, "gone", usage);
    expect(createMany).toHaveBeenCalledTimes(1);
  });
});
