import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
  DEFAULT_KNOWLEDGE_MAX_FILE_BYTES,
  DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS,
  DEFAULT_KNOWLEDGE_MAX_PAGES,
  getKnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_MAX_BYTES
} from "../uploads/validation";

describe("Knowledge extraction configuration", () => {
  it("keeps the Knowledge default distinct from Chat and preserves every hard ceiling", () => {
    expect(DEFAULT_KNOWLEDGE_MAX_FILE_BYTES).toBe(50_000_000);
    expect(DEFAULT_UPLOAD_MAX_BYTES).toBe(25_000_000);
    expect(MAX_UPLOAD_MAX_BYTES).toBe(64 * 1_024 * 1_024);
    expect(DEFAULT_KNOWLEDGE_MAX_PAGES).toBe(2_000);
    expect(DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS).toBe(5_000_000);
    expect(DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT).toBe(10_000);
  });

  it("uses bounded defaults for missing, malformed, and over-ceiling values", () => {
    expect(getKnowledgeExtractionConfig({})).toMatchObject({
      maxChunksPerDocument: DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
      maxFileBytes: DEFAULT_KNOWLEDGE_MAX_FILE_BYTES,
      maxNormalizedChars: DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS,
      maxPages: DEFAULT_KNOWLEDGE_MAX_PAGES
    });
    expect(getKnowledgeExtractionConfig({
      AIQSA_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT: "50001",
      AIQSA_KNOWLEDGE_MAX_FILE_BYTES: String(MAX_UPLOAD_MAX_BYTES + 1),
      AIQSA_KNOWLEDGE_MAX_NORMALIZED_CHARS: "8000001",
      AIQSA_KNOWLEDGE_MAX_PAGES: "not-a-number"
    })).toMatchObject({
      maxChunksPerDocument: DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
      maxFileBytes: DEFAULT_KNOWLEDGE_MAX_FILE_BYTES,
      maxNormalizedChars: DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS,
      maxPages: DEFAULT_KNOWLEDGE_MAX_PAGES
    });
  });

  it("accepts positive values inside the Knowledge-owned ceilings", () => {
    expect(getKnowledgeExtractionConfig({
      AIQSA_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT: "123",
      AIQSA_KNOWLEDGE_MAX_FILE_BYTES: "456789",
      AIQSA_KNOWLEDGE_MAX_NORMALIZED_CHARS: "234567",
      AIQSA_KNOWLEDGE_MAX_PAGES: "321"
    })).toMatchObject({
      maxChunksPerDocument: 123,
      maxFileBytes: 456789,
      maxNormalizedChars: 234567,
      maxPages: 321
    });

    expect(getKnowledgeExtractionConfig({
      AIQSA_KNOWLEDGE_MAX_FILE_BYTES: String(MAX_UPLOAD_MAX_BYTES)
    }).maxFileBytes).toBe(MAX_UPLOAD_MAX_BYTES);
  });
});
