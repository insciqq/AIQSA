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
