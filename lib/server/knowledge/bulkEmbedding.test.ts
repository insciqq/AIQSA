import { describe, expect, it, vi } from "vitest";
import {
  assertKnowledgeBulkEmbeddingBatch,
  createPrismaKnowledgeBulkEmbeddingRepository,
  KNOWLEDGE_BULK_EMBEDDING_MAX_INPUTS,
  type KnowledgeBulkEmbeddingPassageIdentity,
  type KnowledgeBulkEmbeddingTarget
} from "./bulkEmbedding";

const target: KnowledgeBulkEmbeddingTarget = Object.freeze({
  embeddingProviderModelId: "embedding-deployment",
  generationId: "11111111-1111-8111-8111-111111111111",
  knowledgeBaseId: "22222222-2222-8222-8222-222222222222",
  ownerUserId: "benchmark-owner",
  profileRevisionId: "33333333-3333-8333-8333-333333333333",
  targetDimension: 1_536,
  vectorSpaceFingerprint: "a".repeat(64)
});

function uuid(prefix: number, suffix: number): string {
  return `${prefix.toString(16).padStart(8, "0")}-4444-8444-8444-` +
    suffix.toString(16).padStart(12, "0");
}

function passage(index: number): KnowledgeBulkEmbeddingPassageIdentity {
  return Object.freeze({
    contentHash: (index + 1).toString(16).padStart(64, "0"),
    embeddingTextHash: (index + 2).toString(16).padStart(64, "0"),
    passageId: `kip_${(index + 1).toString(16).padStart(40, "0")}`,
    passageOrdinal: index,
    sourceArtifactId: uuid(11, 1),
    sourceVersionId: uuid(12, 1)
  });
}

describe("Knowledge held cross-Source embedding batches", () => {
  it("accepts the exact bounded product embedding batch size", () => {
    expect(() => assertKnowledgeBulkEmbeddingBatch(
      target,
      Array.from({ length: KNOWLEDGE_BULK_EMBEDDING_MAX_INPUTS }, (_, index) =>
        passage(index))
    )).not.toThrow();
  });

  it("rejects empty, oversized, duplicate, and malformed identities", () => {
    expect(() => assertKnowledgeBulkEmbeddingBatch(target, []))
      .toThrow("knowledge_bulk_embedding_input_invalid");
    expect(() => assertKnowledgeBulkEmbeddingBatch(
      target,
      Array.from({ length: KNOWLEDGE_BULK_EMBEDDING_MAX_INPUTS + 1 }, (_, index) =>
        passage(index))
    )).toThrow("knowledge_bulk_embedding_input_invalid");
    expect(() => assertKnowledgeBulkEmbeddingBatch(target, [passage(0), passage(0)]))
      .toThrow("knowledge_bulk_embedding_input_invalid");
    expect(() => assertKnowledgeBulkEmbeddingBatch(
      { ...target, vectorSpaceFingerprint: "invalid" },
      [passage(0)]
    )).toThrow("knowledge_bulk_embedding_input_invalid");
  });

  it("rejects invalid vectors before opening a transaction", async () => {
    const transaction = vi.fn();
    const repository = createPrismaKnowledgeBulkEmbeddingRepository({
      $transaction: transaction
    } as never);
    await expect(repository.persistBatch({
      ...target,
      modelId: "qwen/qwen3-embedding-8b",
      now: new Date("2026-09-04T14:00:00.000Z"),
      passages: [{ ...passage(0), vector: [1] }],
      provider: "openrouter",
      usage: { inputTokens: 1, totalTokens: 1 },
      usageEventId: "55555555-5555-8555-8555-555555555555"
    })).rejects.toThrow("knowledge_bulk_embedding_input_invalid");
    expect(transaction).not.toHaveBeenCalled();
  });
});
