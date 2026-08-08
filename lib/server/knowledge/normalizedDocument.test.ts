import { describe, expect, it } from "vitest";
import type { ParsedDocument } from "../parsing";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import {
  decodeKnowledgeNormalizedDocument,
  encodeKnowledgeNormalizedDocument
} from "./normalizedDocument";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 100,
  maxFileBytes: 10_000,
  maxNormalizedChars: 10_000,
  maxNormalizedObjectBytes: 100_000,
  maxPages: 10
};

function parsed(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    blocks: [{ headingPath: [" Section\n"], index: 0, isTable: false, page: 1, text: "hello\r\nworld" }],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: 1,
    status: "complete",
    text: "hello world",
    ...overrides
  };
}

describe("Knowledge normalized document", () => {
  it("round-trips a bounded complete parse with canonical text", () => {
    const encoded = encodeKnowledgeNormalizedDocument(parsed(), config);
    expect(encoded.checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(decodeKnowledgeNormalizedDocument(encoded.body, config)).toEqual({
      blocks: [{ headingPath: ["Section"], page: 1, text: "hello\nworld" }],
      pageCount: 1,
      parserEngine: "docling",
      schemaVersion: 1
    });
  });

  it("rejects partial parses and blocks outside the declared page range", () => {
    expect(() => encodeKnowledgeNormalizedDocument(parsed({ status: "partial" }), config))
      .toThrowError(expect.objectContaining({ code: "parser_rejected" }));
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [{ headingPath: [], index: 0, isTable: false, page: 2, text: "outside" }]
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it("fails closed on page, text, and serialized-object limits", () => {
    expect(() => encodeKnowledgeNormalizedDocument(parsed({ pageCount: 11 }), config))
      .toThrowError(expect.objectContaining({ code: "knowledge_page_limit_exceeded" }));
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [{ headingPath: [], index: 0, isTable: false, page: 1, text: "x".repeat(10_001) }]
    }), config)).toThrowError(expect.objectContaining({ code: "knowledge_text_limit_exceeded" }));
  });
});
