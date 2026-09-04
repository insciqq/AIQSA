import { describe, expect, it, vi } from "vitest";
import {
  assertKnowledgeBulkActivationInput,
  createPrismaKnowledgeBulkActivationRepository,
  KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES
} from "./bulkActivation";
import type { KnowledgeBulkEmbeddingTarget } from "./bulkEmbedding";

const target: KnowledgeBulkEmbeddingTarget = Object.freeze({
  embeddingProviderModelId: "11111111-1111-8111-8111-111111111111",
  generationId: "22222222-2222-8222-8222-222222222222",
  knowledgeBaseId: "33333333-3333-8333-8333-333333333333",
  ownerUserId: "benchmark-owner",
  profileRevisionId: "44444444-4444-8444-8444-444444444444",
  targetDimension: 1_536,
  vectorSpaceFingerprint: "a".repeat(64)
});

describe("Knowledge held bulk activation", () => {
  it("accepts the reviewed batch ceiling", () => {
    expect(() => assertKnowledgeBulkActivationInput(
      target,
      KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES,
      new Date("2026-09-04T15:00:00.000Z")
    )).not.toThrow();
  });

  it("rejects malformed targets, time, and limits before a transaction", async () => {
    expect(() => assertKnowledgeBulkActivationInput(
      target,
      KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES + 1,
      new Date("2026-09-04T15:00:00.000Z")
    )).toThrow("knowledge_bulk_activation_input_invalid");
    expect(() => assertKnowledgeBulkActivationInput(
      { ...target, vectorSpaceFingerprint: "invalid" },
      1,
      new Date("invalid")
    )).toThrow("knowledge_bulk_activation_input_invalid");

    const transaction = vi.fn();
    const repository = createPrismaKnowledgeBulkActivationRepository({
      $transaction: transaction
    } as never);
    await expect(repository.activateNextBatch({
      ...target,
      limit: 0,
      now: new Date("2026-09-04T15:00:00.000Z")
    })).rejects.toThrow("knowledge_bulk_activation_input_invalid");
    expect(transaction).not.toHaveBeenCalled();
  });
});
