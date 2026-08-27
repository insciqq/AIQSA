import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AdminKnowledgeAnswerPolicyServiceError,
  createAdminKnowledgeAnswerPolicyService
} from "./answerPolicyService";

function transactionalPrisma(input: Readonly<{ version: number }>) {
  const update = vi.fn(async () => ({}));
  const transaction = vi.fn(async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn({
    $queryRaw: vi.fn(async () => [{ version: input.version }]),
    knowledgeAnswerPolicy: { update }
  }));
  return { prisma: { $transaction: transaction } as unknown as PrismaClient, transaction, update };
}

describe("administrator Knowledge answer-policy service", () => {
  it("projects the stored ingestion parallelism beside its fixed bounds", async () => {
    const prisma = {
      knowledgeAnswerPolicy: {
        findUnique: vi.fn(async () => ({
          ingestionParallelism: 5,
          maximumKnowledgeSearches: 12,
          updatedAt: new Date("2026-08-27T00:00:00.000Z"),
          updatedBy: null,
          version: 3
        }))
      }
    } as unknown as PrismaClient;

    await expect(createAdminKnowledgeAnswerPolicyService(prisma).list()).resolves.toMatchObject({
      ingestionParallelism: 5,
      maximumKnowledgeSearches: 12,
      parallelismMaximum: 16,
      parallelismMinimum: 1,
      version: 3
    });
  });

  it("rejects an out-of-bounds parallelism before any transaction", async () => {
    const { prisma, transaction } = transactionalPrisma({ version: 1 });
    const service = createAdminKnowledgeAnswerPolicyService(prisma);
    for (const ingestionParallelism of [0, 17, 2.5, Number.NaN]) {
      await expect(service.updateIngestionParallelism({
        expectedVersion: 1,
        ingestionParallelism,
        userId: "admin-1"
      })).rejects.toMatchObject({ code: "knowledge_ingestion_parallelism_invalid" });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("applies a bounded parallelism update under the row version it validated", async () => {
    const { prisma, update } = transactionalPrisma({ version: 4 });
    await createAdminKnowledgeAnswerPolicyService(prisma).updateIngestionParallelism({
      expectedVersion: 4,
      ingestionParallelism: 12,
      userId: "admin-1"
    });
    expect(update).toHaveBeenCalledWith({
      data: {
        ingestionParallelism: 12,
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("fails a stale parallelism update without writing", async () => {
    const { prisma, update } = transactionalPrisma({ version: 6 });
    await expect(createAdminKnowledgeAnswerPolicyService(prisma).updateIngestionParallelism({
      expectedVersion: 5,
      ingestionParallelism: 4,
      userId: "admin-1"
    })).rejects.toMatchObject({ code: "knowledge_ingestion_parallelism_stale" });
    expect(update).not.toHaveBeenCalled();
  });

  it("maps a serialization conflict to the stable stale code", async () => {
    const prisma = {
      $transaction: vi.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError("write conflict", {
          clientVersion: "test",
          code: "P2034"
        });
      })
    } as unknown as PrismaClient;
    await expect(createAdminKnowledgeAnswerPolicyService(prisma).updateIngestionParallelism({
      expectedVersion: 1,
      ingestionParallelism: 4,
      userId: "admin-1"
    })).rejects.toSatisfy((error) =>
      error instanceof AdminKnowledgeAnswerPolicyServiceError &&
      error.code === "knowledge_ingestion_parallelism_stale");
  });
});
