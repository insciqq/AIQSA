import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
  DEFAULT_KNOWLEDGE_MAX_FILE_BYTES,
  DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS,
  DEFAULT_KNOWLEDGE_MAX_PAGES,
  getKnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";

describe("Knowledge extraction configuration", () => {
  it("uses bounded defaults for missing, malformed, and over-ceiling values", () => {
    expect(getKnowledgeExtractionConfig({})).toMatchObject({
      maxChunksPerDocument: DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
      maxFileBytes: DEFAULT_KNOWLEDGE_MAX_FILE_BYTES,
      maxNormalizedChars: DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS,
      maxPages: DEFAULT_KNOWLEDGE_MAX_PAGES
    });
    expect(getKnowledgeExtractionConfig({
      AIQSA_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT: "50001",
      AIQSA_KNOWLEDGE_MAX_FILE_BYTES: "0",
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
  });
});
