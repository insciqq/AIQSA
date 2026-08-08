import { describe, expect, it } from "vitest";
import {
  chunkKnowledgeDocument,
  KNOWLEDGE_CHUNK_MAX_CHARS,
  KNOWLEDGE_CHUNK_OVERLAP_CHARS,
  KNOWLEDGE_EMBEDDING_BATCH_SIZE,
  knowledgeEmbeddingBatches
} from "./chunking";

describe("Knowledge chunk profile v1", () => {
  it("keeps page and heading boundaries while producing deterministic overlap", () => {
    const long = Array.from({ length: 400 }, (_, index) => `word-${index}`).join(" ");
    const chunks = chunkKnowledgeDocument({
      blocks: [
        { headingPath: ["Guide"], page: 1, text: long },
        { headingPath: ["Guide"], page: 2, text: "second page" }
      ],
      maxChunks: 20,
      profileVersion: 1
    });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= KNOWLEDGE_CHUNK_MAX_CHARS)).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ headingPath: ["Guide"], page: 2, text: "second page" });
    const first = chunks[0]!.text;
    const second = chunks[1]!.text;
    expect(first.slice(-Math.floor(KNOWLEDGE_CHUNK_OVERLAP_CHARS / 2)).split(/\s+/u)
      .some((word) => second.includes(word))).toBe(true);
  });

  it("enforces the fixed profile, chunk ceiling, and embedding batch size", () => {
    expect(() => chunkKnowledgeDocument({
      blocks: [{ headingPath: [], page: 1, text: "valid" }],
      maxChunks: 1,
      profileVersion: 2
    })).toThrowError(expect.objectContaining({ code: "chunking_failed" }));
    expect(() => chunkKnowledgeDocument({
      blocks: [
        { headingPath: ["one"], page: 1, text: "one" },
        { headingPath: ["two"], page: 1, text: "two" }
      ],
      maxChunks: 1,
      profileVersion: 1
    })).toThrowError(expect.objectContaining({ code: "knowledge_chunk_limit_exceeded" }));

    const entries = Array.from({ length: KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1 }, (_, index) => ({
      headingPath: [] as readonly string[],
      index,
      page: 1,
      text: `chunk-${index}`
    }));
    expect(knowledgeEmbeddingBatches(entries).map((batch) => ({
      batchIndex: batch.batchIndex,
      size: batch.chunks.length
    }))).toEqual([
      { batchIndex: 0, size: KNOWLEDGE_EMBEDDING_BATCH_SIZE },
      { batchIndex: 1, size: 1 }
    ]);
  });
});
