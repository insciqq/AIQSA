import { describe, expect, it } from "vitest";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { ParsedDocumentBlock } from "../parsing";
import {
  approximateKnowledgeTokenCount,
  chunkKnowledgeDocument,
  KNOWLEDGE_CHUNK_MAX_CHARS,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  KNOWLEDGE_EMBEDDING_BATCH_SIZE,
  knowledgeEmbeddingBatches
} from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";

const config = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 1_000
};

function block(
  index: number,
  text: string,
  input: Partial<ParsedDocumentBlock> = {}
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Guide"],
    index,
    isTable: false,
    languageHints: ["und-Latn"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph",
    ...input
  };
}

function document(blocks: readonly ParsedDocumentBlock[], sourceDisplayName = "runbook.pdf") {
  return encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks,
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: Math.max(...blocks.map((item) => item.pageEnd), 1),
    status: "complete"
  }), config, { sourceDisplayName }).document;
}

describe("Knowledge chunk profile v2", () => {
  it("keeps a short logical section together across a page boundary with deterministic context", () => {
    const normalized = document([
      block(0, "Guide", { type: "title" }),
      block(1, "first page", { headingPath: ["Guide", "Setup"] }),
      block(2, "second page", {
        headingPath: ["Guide", "Setup"],
        page: 2,
        pageEnd: 2
      })
    ]);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({
      headingPath: ["Guide", "Setup"],
      page: 1,
      pageEnd: 2,
      sourceBlockStart: 1,
      sourceBlockEnd: 2,
      text: "first page\n\nsecond page"
    });
    expect(chunks[1]!.contextPrefix).toContain("Source: runbook.pdf");
    expect(chunks[1]!.contextPrefix).toContain("Section: Guide › Setup");
    expect(chunks[1]!.contextPrefix).toContain("Location: pages 1–2");
    expect(chunks[1]!.embeddingText).toBe(`${chunks[1]!.contextPrefix}\n\n${chunks[1]!.text}`);
  });

  it("splits long prose at token boundaries with bounded overlap and deterministic hashes", () => {
    const long = Array.from({ length: 1_000 }, (_, index) => `word-${index}`).join(" ");
    const normalized = document([block(0, long)]);
    const first = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });
    const second = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });

    expect(first.length).toBeGreaterThan(2);
    expect(first.every((chunk) => chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
    expect(first.map((chunk) => chunk.embeddingTextHash)).toEqual(
      second.map((chunk) => chunk.embeddingTextHash)
    );
    expect(first[1]!.text.split(/\s+/u).some((word) => first[0]!.text.endsWith(word))).toBe(true);
  });

  it("enforces hard token and character bounds even without whitespace", () => {
    const punctuation = chunkKnowledgeDocument({
      document: document([block(0, "!".repeat(1_000))]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });
    expect(punctuation.length).toBeGreaterThan(2);
    expect(punctuation.every((chunk) => chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS))
      .toBe(true);

    const longWord = chunkKnowledgeDocument({
      document: document([block(0, "a".repeat(KNOWLEDGE_CHUNK_MAX_CHARS + 100))]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });
    expect(longWord).toHaveLength(2);
    expect(longWord.every((chunk) => chunk.text.length <= KNOWLEDGE_CHUNK_MAX_CHARS))
      .toBe(true);
  });

  it("keeps table rows intact and carries exact block provenance", () => {
    const cells = Array.from({ length: 40 }, (_, row) => [
      { column: 0, columnSpan: 1, row, rowSpan: 1, text: `row-${row}` },
      { column: 1, columnSpan: 1, row, rowSpan: 1, text: "value ".repeat(20).trim() }
    ]).flat();
    const normalized = document([block(0, "", {
      isTable: true,
      table: { cells, columnCount: 2, rowCount: 40 },
      text: cells.reduce((rows, cell) => {
        rows[cell.row] ??= [];
        rows[cell.row]![cell.column] = cell.text;
        return rows;
      }, [] as string[][]).map((row) => row.join("\t")).join("\n"),
      type: "table"
    })]);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.sourceBlockStart === 0 && chunk.sourceBlockEnd === 0))
      .toBe(true);
    expect(chunks.every((chunk) => chunk.text.split("\n").every((row) => row.includes("\t"))))
      .toBe(true);
  });

  it("filters repeated page furniture by text even though each locator is distinct", () => {
    const normalized = document(Array.from({ length: 3 }, (_, pageIndex) => [
      block(pageIndex * 2, "Confidential", {
        page: pageIndex + 1,
        pageEnd: pageIndex + 1,
        readingOrder: pageIndex * 2
      }),
      block(pageIndex * 2 + 1, `Body page ${pageIndex + 1}`, {
        page: pageIndex + 1,
        pageEnd: pageIndex + 1,
        readingOrder: pageIndex * 2 + 1
      })
    ]).flat());
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });

    expect(chunks.map((chunk) => chunk.text).join("\n")).not.toContain("Confidential");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("Body page 3");
  });

  it("retains immutable profile 1 behavior while rejecting unknown profiles and chunk overflow", () => {
    const normalized = document([block(0, "valid")]);
    expect(chunkKnowledgeDocument({ document: normalized, maxChunks: 1, profileVersion: 1 }))
      .toHaveLength(1);
    expect(() => chunkKnowledgeDocument({ document: normalized, maxChunks: 1, profileVersion: 99 }))
      .toThrowError(expect.objectContaining({ code: "chunking_failed" }));

    const split = document([
      block(0, "one", { headingPath: ["one"] }),
      block(1, "two", { headingPath: ["two"] })
    ]);
    expect(() => chunkKnowledgeDocument({
      document: split,
      maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    })).toThrowError(expect.objectContaining({ code: "knowledge_chunk_limit_exceeded" }));
  });

  it("batches derived passages without changing their token or provenance evidence", () => {
    const normalized = document([block(0, "one passage")]);
    const [entry] = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });
    const entries = Array.from({ length: KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1 }, (_, index) => ({
      ...entry!,
      contentHash: `${entry!.contentHash}-${index}`,
      embeddingTextHash: `${entry!.embeddingTextHash}-${index}`,
      index
    }));
    expect(approximateKnowledgeTokenCount(entry!.text)).toBe(entry!.tokenCount);
    expect(knowledgeEmbeddingBatches(entries).map((batch) => ({
      batchIndex: batch.batchIndex,
      size: batch.chunks.length
    }))).toEqual([
      { batchIndex: 0, size: KNOWLEDGE_EMBEDDING_BATCH_SIZE },
      { batchIndex: 1, size: 1 }
    ]);
  });
});
