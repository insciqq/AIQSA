import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaKnowledgeSourceIngestionRepository } from "./prismaSourceIngestionRepository";

const input = { claimToken: "worker-token", now: new Date("2040-01-01T00:00:00Z"),
  staleBefore: new Date("2039-12-31T23:55:00Z") };

describe("Source ingestion empty-queue polling", () => {
  it("does not acquire fairness locks or scan owners when no work is due", async () => {
    const findFirst = vi.fn(async () => null);
    const transaction = vi.fn(async () => { throw new Error("unexpected_fairness_transaction"); });
    const repository = createPrismaKnowledgeSourceIngestionRepository({
      knowledgeSourceIndexArtifact: { findFirst }, $transaction: transaction
    } as unknown as PrismaClient);
    await expect(repository.claim(input)).resolves.toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({ select: { id: true }, where: {
      state: { in: ["pending", "processing"] }, processingStage: { not: null },
      nextAttemptAt: { lte: input.now },
      OR: [{ claimedAt: null }, { claimedAt: { lt: input.staleBefore } }]
    } });
  });

  it("rechecks eligibility under the fairness lock after a positive existence probe", async () => {
    const findFirst = vi.fn(async () => ({ id: "pending-artifact" }));
    const query = vi.fn().mockResolvedValueOnce([{ lastGrantedOwnerUserId: null }])
      .mockResolvedValueOnce([]);
    const execute = vi.fn(async () => 0);
    const tx = { $queryRaw: query, $executeRaw: execute };
    const transaction = vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
    const repository = createPrismaKnowledgeSourceIngestionRepository({
      knowledgeSourceIndexArtifact: { findFirst }, $transaction: transaction
    } as unknown as PrismaClient);
    // Work can disappear, lose its lease eligibility or lose authority between
    // the probe and the transaction. The probe never grants a claim by itself.
    await expect(repository.claim(input)).resolves.toBeNull();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0].text).toContain('owner_user."status"');
    expect(query.mock.calls[1]![0].text).toContain('membership."removedAt" IS NULL');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
