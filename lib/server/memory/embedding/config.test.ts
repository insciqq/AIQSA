import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_EMBEDDING_BATCH_SIZE,
  MAX_MEMORY_EMBEDDING_BATCH_SIZE
} from "./contract";
import { loadMemoryEmbeddingBatchSize } from "./config";

describe("Memory embedding batch configuration", () => {
  it("defaults to sixteen and accepts the hard maximum", () => {
    expect(loadMemoryEmbeddingBatchSize({})).toBe(
      DEFAULT_MEMORY_EMBEDDING_BATCH_SIZE
    );
    expect(loadMemoryEmbeddingBatchSize({
      AIQSA_MEMORY_EMBEDDING_BATCH_SIZE: String(MAX_MEMORY_EMBEDDING_BATCH_SIZE)
    })).toBe(MAX_MEMORY_EMBEDDING_BATCH_SIZE);
  });

  it.each(["0", "129", "1.5", " 16", "16 ", "no"])(
    "fails closed for invalid size %s",
    (value) => {
      expect(() => loadMemoryEmbeddingBatchSize({
        AIQSA_MEMORY_EMBEDDING_BATCH_SIZE: value
      })).toThrow("memory_embedding_batch_size_environment_invalid");
    }
  );
});
