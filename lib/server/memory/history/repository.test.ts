import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobDescriptor } from "../coordinator/types";
import { createPrismaMemoryHistoryIndexRepository } from "./repository";

const invalidHistoryJob: MemoryJobDescriptor = Object.freeze({
  activeLeafMessageId: null,
  attemptCount: 0,
  branchGeneration: null,
  chatId: null,
  id: "invalid-history-job",
  idempotencyFingerprint: "invalid",
  kind: "INDEX_HISTORY",
  memoryGenerationSnapshot: 0,
  memoryRevisionSnapshot: 0,
  pipelineVersion: "invalid",
  sourceHash: null,
  sourceMessageId: null,
  sourceRevision: null,
  stage: null,
  targetFactVersionId: null,
  userId: "history-owner"
});

describe("Prisma memory history repository", () => {
  it("gives bounded history preparation an explicit transaction budget", async () => {
    const transaction = vi.fn(async (
      operation: (tx: object) => Promise<unknown>
    ) => operation({}));
    const repository = createPrismaMemoryHistoryIndexRepository({
      $transaction: transaction
    } as unknown as PrismaClient);

    await expect(repository.prepare(invalidHistoryJob)).resolves.toEqual({
      decision: {
        errorCode: "memory_history_job_invalid",
        status: "CANCELLED"
      }
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000
    });
  });
});
