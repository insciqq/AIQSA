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

function rawSerializationFailure(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("serialization", {
    clientVersion: "6.19.3",
    code: "P2010",
    meta: { code: "40001" }
  });
}

describe("Prisma Knowledge upload serialization retries", () => {
  it("retries PostgreSQL 40001 failures surfaced through raw-query P2010", async () => {
    const transaction = vi.fn()
      .mockRejectedValueOnce(rawSerializationFailure())
      .mockRejectedValueOnce(rawSerializationFailure())
      .mockRejectedValueOnce(rawSerializationFailure())
      .mockRejectedValueOnce(rawSerializationFailure())
      .mockResolvedValueOnce({ kind: "not_found" });
    const repository = createPrismaKnowledgeUploadRepository({
      $transaction: transaction
    } as never);

    await expect(repository.cancel(cancelInput)).resolves.toEqual({ kind: "not_found" });
    expect(transaction).toHaveBeenCalledTimes(5);
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
    } as never);

    await expect(repository.cancel(cancelInput)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
