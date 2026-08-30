import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaKnowledgeUploadRepository } from "./uploadRepository";

const cancelInput = Object.freeze({
  attemptNumber: 1,
  batchId: "batch-1",
  itemId: "item-1",
  knowledgeBaseId: "base-1",
  now: new Date(0),
  userId: "user-1"
});

function rawSerializationFailure(code = "40001"): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("serialization", {
    clientVersion: "6.19.3",
    code: "P2010",
    meta: { code }
  });
}

describe("Prisma Knowledge upload serialization retries", () => {
  it("backs off through a sustained PostgreSQL serialization burst", async () => {
    const transaction = vi.fn();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      transaction.mockRejectedValueOnce(rawSerializationFailure());
    }
    transaction.mockResolvedValueOnce({ kind: "not_found" });
    const serializationRetryDelay = vi.fn(async (_retryOrdinal: number) => undefined);
    const repository = createPrismaKnowledgeUploadRepository({
      $transaction: transaction
    } as never, { serializationRetryDelay });

    await expect(repository.cancel(cancelInput)).resolves.toEqual({ kind: "not_found" });
    expect(transaction).toHaveBeenCalledTimes(9);
    expect(serializationRetryDelay.mock.calls.map(([ordinal]) => ordinal))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("also retries PostgreSQL deadlocks surfaced through raw-query P2010", async () => {
    const transaction = vi.fn()
      .mockRejectedValueOnce(rawSerializationFailure("40P01"))
      .mockResolvedValueOnce({ kind: "not_found" });
    const serializationRetryDelay = vi.fn(async (_retryOrdinal: number) => undefined);
    const repository = createPrismaKnowledgeUploadRepository({
      $transaction: transaction
    } as never, { serializationRetryDelay });

    await expect(repository.cancel(cancelInput)).resolves.toEqual({ kind: "not_found" });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(serializationRetryDelay).toHaveBeenCalledWith(1);
  });

  it("does not retry unrelated raw-query failures", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("raw query", {
      clientVersion: "6.19.3",
      code: "P2010",
      meta: { code: "42P01" }
    });
    const transaction = vi.fn().mockRejectedValue(failure);
    const repository = createPrismaKnowledgeUploadRepository({
      $transaction: transaction
    } as never, {
      serializationRetryDelay: vi.fn(async (_retryOrdinal: number) => undefined)
    });

    await expect(repository.cancel(cancelInput)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
