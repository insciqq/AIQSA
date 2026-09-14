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


describe("Knowledge upload enqueue diagnostics", () => {
  const input = {
    ...cancelInput, byteSize: 1, checksum: "checksum", fileName: "PRIVATE_FILENAME", mimeType: "text/plain",
    normalizedTextStorageKey: "PRIVATE_STORAGE_KEY", sourceArtifactId: "artifact-work", sourceId: "PRIVATE_SOURCE",
    sourceVersionId: "PRIVATE_VERSION"
  };

  it("publishes a created artifact receipt after the outer transaction and its retries complete", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let commit!: (value: { kind: "created"; sourceId: string; cleanupStorageKey: string }) => void;
    const transaction = vi.fn().mockRejectedValueOnce(rawSerializationFailure()).mockImplementationOnce(() =>
      new Promise((resolve) => { commit = resolve; }));
    const repo = createPrismaKnowledgeUploadRepository({ $transaction: transaction } as never,
      { serializationRetryDelay: async () => undefined });
    try {
      const pending = repo.settle(input);
      await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(2));
      expect(writer).not.toHaveBeenCalled();
      commit({ kind: "created", sourceId: input.sourceId, cleanupStorageKey: "PRIVATE_STORAGE" });
      await pending;
      expect(writer).toHaveBeenCalledOnce();
      expect(JSON.parse(String(writer.mock.calls[0]![0]))).toMatchObject({
        event: "job_enqueued", subsystem: "knowledge", job_id: "artifact-work"
      });
      expect(JSON.stringify(writer.mock.calls)).not.toContain("PRIVATE_");
    } finally { writer.mockRestore(); }
  });

  it("does not invent new work for reused or already settled artifacts or failed commits", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const failure = new Error("PRIVATE_DB");
    const transaction = vi.fn().mockResolvedValueOnce({ kind: "reused", sourceId: input.sourceId })
      .mockResolvedValueOnce({ kind: "already_settled", sourceId: input.sourceId }).mockRejectedValueOnce(failure);
    const repo = createPrismaKnowledgeUploadRepository({ $transaction: transaction } as never);
    try {
      await repo.settle(input);
      await repo.settle(input);
      await expect(repo.settle(input)).rejects.toBe(failure);
      expect(writer).not.toHaveBeenCalled();
    } finally { writer.mockRestore(); }
  });
});
