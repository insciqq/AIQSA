import { enqueueMemoryJob } from "./jobs";
import { enqueueMemoryDeletion } from "./deletion";
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { withLockedMemoryTransaction } from "./transaction";

const lockedSettings = {
  acceptedUtilityEgressAt: null,
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  embeddingProviderModelId: null,
  learnAutomatically: true,
  memoryConsentRevision: 1,
  memoryGeneration: 2,
  memoryRevision: 3,
  ownerStatus: "active",
  referenceChatHistory: true,
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
  settingsRevision: 4,
  useMemoryFacts: true,
  userId: "user-1"
} as const;

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(code, {
    clientVersion: "test",
    code,
    meta
  });
}

describe("Memory transaction admission deadline", () => {
  it("fails before DB I/O when the absolute deadline is exhausted", async () => {
    const transaction = vi.fn();
    const client = { $transaction: transaction } as unknown as PrismaClient;

    await expect(withLockedMemoryTransaction(
      client,
      "user-1",
      async () => "unreachable",
      { clock: () => 1_001, deadlineAtMs: 1_000 }
    )).rejects.toMatchObject({
      code: "memory_admission_deadline_exceeded"
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("recomputes a smaller residual timeout before a serialization retry", async () => {
    let now = 900;
    const options: Array<{ maxWait?: number; timeout?: number }> = [];
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([lockedSettings])
    };
    const transaction = vi.fn(async (
      operation: (value: typeof tx) => Promise<unknown>,
      transactionOptions: { maxWait?: number; timeout?: number }
    ) => {
      options.push(transactionOptions);
      if (options.length === 1) {
        now = 960;
        throw prismaError("P2034");
      }
      return operation(tx);
    });
    const client = { $transaction: transaction } as unknown as PrismaClient;

    await expect(withLockedMemoryTransaction(
      client,
      "user-1",
      async () => "ok",
      {
        clock: () => now,
        deadlineAtMs: 1_000,
        serializationRetryDelay: async () => undefined
      }
    )).resolves.toBe("ok");
    expect(options).toEqual([
      expect.objectContaining({ maxWait: 100, timeout: 100 }),
      expect.objectContaining({ maxWait: 40, timeout: 40 })
    ]);
  });

  it("backs off and survives a sustained serializable conflict burst", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const tx = { $queryRaw: vi.fn().mockResolvedValue([lockedSettings]) };
    const client = {
      $transaction: vi.fn(async (
        operation: (value: typeof tx) => Promise<unknown>
      ) => {
        attempts += 1;
        if (attempts < 8) throw prismaError("P2034");
        return operation(tx);
      })
    } as unknown as PrismaClient;

    await expect(withLockedMemoryTransaction(
      client,
      "user-1",
      async () => "ok",
      {
        serializationRetryDelay: async (retryOrdinal) => {
          delays.push(retryOrdinal);
        }
      }
    )).resolves.toBe("ok");
    expect(attempts).toBe(8);
    expect(delays).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("treats a raw PostgreSQL deadlock as a rollback-safe conflict", async () => {
    let attempts = 0;
    const tx = { $queryRaw: vi.fn().mockResolvedValue([lockedSettings]) };
    const client = {
      $transaction: vi.fn(async (
        operation: (value: typeof tx) => Promise<unknown>
      ) => {
        attempts += 1;
        if (attempts === 1) throw prismaError("P2010", { code: "40P01" });
        return operation(tx);
      })
    } as unknown as PrismaClient;

    await expect(withLockedMemoryTransaction(
      client,
      "user-1",
      async () => "ok",
      { serializationRetryDelay: async () => undefined }
    )).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });

  it("normalizes database lock and transaction expiry to the safe deadline code", async () => {
    const client = {
      $transaction: vi.fn(async () => {
        throw prismaError("P2028");
      })
    } as unknown as PrismaClient;

    await expect(withLockedMemoryTransaction(
      client,
      "user-1",
      async () => "unreachable",
      { clock: () => 900, deadlineAtMs: 1_000 }
    )).rejects.toMatchObject({
      code: "memory_admission_deadline_exceeded"
    });
  });
});


describe("Memory post-commit enqueue diagnostics", () => {
  it("emits only the committed attempt's real jobs after rollback and keeps foreign transactions silent", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let attempts = 0;
    let committed = false;
    const tx = {
      $queryRaw: vi.fn(async () => [lockedSettings]),
      memoryJob: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({
        id: `job-${attempts}`, memoryGenerationSnapshot: 2, memoryRevisionSnapshot: 3, state: "QUEUED"
      })) },
      memoryDeletionOutbox: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({
        id: `deletion-${attempts}`, memoryGeneration: 2, state: "QUEUED"
      })) }
    };
    const client = { $transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => {
      attempts += 1;
      const value = await operation(tx);
      expect(writer).not.toHaveBeenCalled();
      if (attempts === 1) throw prismaError("P2034", { private: "PRIVATE_SQL" });
      committed = true;
      return value;
    }) } as unknown as PrismaClient;
    try {
      const result = await withLockedMemoryTransaction(client, "user-1", async (transaction, settings) => {
        const job = await enqueueMemoryJob(transaction, settings, {
          idempotencyFingerprint: "fingerprint", kind: "EMBED_ITEMS", pipelineVersion: "pipeline"
        });
        await enqueueMemoryDeletion(transaction, settings, {
          operation: "TEMPORARY_DELETE", targetId: "PRIVATE_TARGET", targetType: "CHAT"
        });
        return job.id;
      }, { serializationRetryDelay: async () => undefined });
      expect(committed).toBe(true);
      expect(result).toBe("job-2");
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(records).toEqual([
        expect.objectContaining({ event: "job_enqueued", subsystem: "memory", job_id: "job-2" }),
        expect.objectContaining({ event: "job_enqueued", subsystem: "memory", job_id: "deletion-2" })
      ]);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
      writer.mockClear();
      await enqueueMemoryJob(tx as never, lockedSettings as never, {
        idempotencyFingerprint: "fingerprint", kind: "EMBED_ITEMS", pipelineVersion: "pipeline"
      });
      expect(writer).not.toHaveBeenCalled();
    } finally { writer.mockRestore(); }
  });

  it("does not emit enqueue when the outer commit ultimately fails", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const failure = prismaError("P1001");
    const tx = {
      $queryRaw: vi.fn(async () => [lockedSettings]),
      memoryJob: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({
        id: "rolled-back-job", memoryGenerationSnapshot: 2, memoryRevisionSnapshot: 3, state: "QUEUED"
      })) }
    };
    const client = { $transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => {
      await operation(tx);
      throw failure;
    }) } as unknown as PrismaClient;
    try {
      await expect(withLockedMemoryTransaction(client, "user-1", (transaction, settings) =>
        enqueueMemoryJob(transaction, settings, {
          idempotencyFingerprint: "fingerprint", kind: "EMBED_ITEMS", pipelineVersion: "pipeline"
        }))).rejects.toBe(failure);
      expect(writer).not.toHaveBeenCalled();
    } finally { writer.mockRestore(); }
  });
});
